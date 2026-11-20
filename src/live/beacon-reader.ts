// Reads the WowDeck beacon from the game window: one capture session, kept alive while keys
// need live state (plus a grace period), cropped to the top-left corner where the beacon lives.
import { decodeBeacon, findBeacon, type BeaconFrame, type Pixels } from "./beacon-codec.js";

export interface CapturedFrame {
    width: number;
    height: number;
    crop(startX: number, startY: number, endX: number, endY: number): { buffer: Uint8Array; width: number; height: number };
}
export interface CaptureSession {
    start(): Promise<void>;
    nextFrame(): Promise<CapturedFrame | undefined>;
    stop(): Promise<void>;
}
export interface BeaconReaderDeps {
    /** Handle of the game window to read, or null when the game isn't running. */
    findWindow(): number | null;
    capture(windowHandle: number, intervalMs: number): CaptureSession;
}

/** Region searched for the beacon: covers a window border and title bar above it. */
const SEARCH_WIDTH = 512;
const SEARCH_HEIGHT = 160;
const STALE_MS = 1500;
const RETRY_MS = 3000;
export const LINGER_MS = 20_000;

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class BeaconReader {
    private enabled = true;
    private interval = 200;
    private demand = false;
    private lingerTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private generation = 0;
    private session: CaptureSession | null = null;
    private latest: BeaconFrame | null = null;
    private lastValidAt = 0;
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private statusText = "Live state off";
    private listeners = new Set<(frame: BeaconFrame | null) => void>();

    constructor(
        private readonly deps: BeaconReaderDeps,
        private readonly lingerMs = LINGER_MS
    ) {}

    /** The latest decoded beacon, or null when there is no fresh one. */
    get frame() {
        return this.latest;
    }

    get status() {
        return this.statusText;
    }

    onFrame(listener: (frame: BeaconFrame | null) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    configure(enabled: boolean, intervalMs: number) {
        const restart = this.running && intervalMs !== this.interval;
        this.enabled = enabled;
        this.interval = intervalMs;
        if (!enabled) {
            this.stopSession("Live state off");
            return;
        }
        if (restart) {
            this.stopSession("Restarting");
        }
        this.ensureRunning();
    }

    /** Whether any key currently wants live state. Losing demand stops capture after a grace period. */
    setDemand(active: boolean) {
        this.demand = active;
        if (active) {
            if (this.lingerTimer) {
                clearTimeout(this.lingerTimer);
                this.lingerTimer = null;
            }
            this.ensureRunning();
        }
        else if (this.running && !this.lingerTimer) {
            this.lingerTimer = setTimeout(() => {
                this.lingerTimer = null;
                if (!this.demand) {
                    this.stopSession("Idle");
                }
            }, this.lingerMs);
            this.lingerTimer.unref?.();
        }
    }

    shutdown() {
        this.enabled = false;
        this.demand = false;
        if (this.lingerTimer) {
            clearTimeout(this.lingerTimer);
            this.lingerTimer = null;
        }
        this.stopSession("Stopped");
    }

    private shouldRun() {
        return this.enabled && (this.demand || this.lingerTimer !== null);
    }

    private ensureRunning() {
        if (this.running || !this.shouldRun()) {
            return;
        }
        this.running = true;
        this.watchdog ??= setInterval(() => this.checkStale(), 500);
        this.watchdog.unref?.();
        void this.loop().finally(() => {
            this.running = false;
            if (this.watchdog) {
                clearInterval(this.watchdog);
                this.watchdog = null;
            }
            // Demand may have returned while the loop was winding down.
            this.ensureRunning();
        });
    }

    private stopSession(status: string) {
        this.generation++;
        this.statusText = status;
        void this.session?.stop().catch(() => {});
        this.session = null;
        this.publish(null);
    }

    private publish(frame: BeaconFrame | null) {
        if (frame === null && this.latest === null) {
            return;
        }
        this.latest = frame;
        for (const listener of this.listeners) {
            listener(frame);
        }
    }

    private checkStale() {
        if (this.latest && Date.now() - this.lastValidAt > STALE_MS) {
            this.statusText = "Beacon not updating (is WoW minimized or paused?)";
            this.publish(null);
        }
    }

    private async loop() {
        while (this.shouldRun()) {
            const token = this.generation;
            const handle = this.deps.findWindow();
            if (!handle) {
                this.statusText = "WoW is not running";
                this.publish(null);
                await pause(RETRY_MS);
                continue;
            }
            const session = this.deps.capture(handle, this.interval);
            this.session = session;
            try {
                await session.start();
                this.statusText = "Looking for the beacon…";
                let origin: { x: number; y: number } | null = null;
                let lastCounter = -1;
                while (this.shouldRun() && token === this.generation) {
                    const started = Date.now();
                    const captured = await session.nextFrame();
                    if (!captured || token !== this.generation) {
                        break;
                    }
                    const crop = captured.crop(0, 0, Math.min(SEARCH_WIDTH, captured.width), Math.min(SEARCH_HEIGHT, captured.height));
                    const pixels: Pixels = { buffer: crop.buffer, width: crop.width, height: crop.height };
                    let result = origin ? decodeBeacon(pixels, origin) : null;
                    if (!result?.ok) {
                        origin = findBeacon(pixels);
                        result = origin ? decodeBeacon(pixels, origin) : null;
                    }
                    if (result?.ok) {
                        // Fresh only when the addon's frame counter moved on: a paused game or
                        // an unchanged duplicate frame keeps showing the same counter.
                        if (result.frame.counter !== lastCounter) {
                            lastCounter = result.frame.counter;
                            this.lastValidAt = Date.now();
                        }
                        if (Date.now() - this.lastValidAt <= STALE_MS) {
                            this.statusText = "Reading live state from the beacon";
                            this.publish(result.frame);
                        }
                    }
                    else if (!result) {
                        this.statusText = "Beacon not found: in game, type /wowdeck beacon to turn it on";
                    }
                    else if (result.reason === "distorted") {
                        this.statusText = "Beacon found, but the game changes its colors too much to read (try turning HDR off)";
                    }
                    else if (result.reason === "version") {
                        this.statusText = "Beacon found, but the WowDeck addon is a different version: update it and /reload";
                    }
                    const wait = this.interval - (Date.now() - started);
                    if (wait > 0) {
                        await pause(wait);
                    }
                }
            }
            catch (error) {
                this.statusText = `Capture failed: ${String(error).slice(0, 100)}`;
            }
            finally {
                await session.stop().catch(() => {});
                if (this.session === session) {
                    this.session = null;
                }
            }
            if (this.shouldRun() && token === this.generation) {
                await pause(RETRY_MS); // window closed or capture failed; look for the window again
            }
        }
    }
}
