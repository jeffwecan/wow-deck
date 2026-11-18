import { ScreenCapture, isSupported, type Frame, type WindowInfo } from "@screen-capture/node";
import streamDeck from "@elgato/streamdeck";
import type { GridSettings } from "../settings/global-grid-settings.js";
import { normalizeGrid, sameGrid } from "../settings/global-grid-settings.js";
import { clientBounds, isMinimized, resolveWindow } from "./window-manager.js";
import {
    fallbackSvg,
    regionHash,
    renderCrop,
    renderPreview,
    sourceRegion,
    boundingRegion,
    regionWithin,
    type RawFrame,
    type ClientRect,
    type PixelRegion
} from "./image-processor.js";

type Subscriber = {
    position: string;
    live: boolean;
    update: (image: string, status: string) => Promise<void>;
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * How long a capture session is kept alive after nothing needs frames any more.
 *
 * Starting or stopping a Windows Graphics Capture session on a fullscreen game makes the
 * compositor switch how it presents that window, which shows up as a brief display-wide hitch.
 * Profile switches (e.g. alt-tabbing out of the game with an app-linked profile), page changes
 * and non-live button presses would otherwise stop and restart the session every time.
 */
export const IDLE_LINGER_MS = 20_000;

function cropToRaw(frame: Frame, area: PixelRegion): RawFrame {
    const cropped = frame.crop(area.left, area.top, area.left + area.width, area.top + area.height);
    // Read the native pixels once, after reducing the full window to the requested area.
    return {
        buffer: cropped.buffer,
        width: cropped.width,
        height: cropped.height,
        colorFormat: cropped.colorFormat
    };
}

export class CaptureManager {
    private subscribers = new Map<string, Subscriber>();
    private grid: GridSettings = normalizeGrid(null);
    private session: ScreenCapture | null = null;
    private selected: WindowInfo | null = null;
    private running = false;
    private generation = 0;
    private lastWarning = new Map<string, number>();
    private status = "Select a window";
    private latest: { frame: Frame; client: ClientRect } | null = null;
    private latestImages = new Map<string, string>();
    private wakeInterval: (() => void) | null = null;
    private pendingSnapshots = new Set<string>();
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;

    constructor(private readonly idleLingerMs = IDLE_LINGER_MS) {}

    get window() {
        return this.selected;
    }

    get currentStatus() {
        return this.status;
    }

    async preview() {
        const latest = this.latest;
        const window = this.selected;
        if (!latest || !window) {
            return null;
        }
        return {
            dataUrl: await renderPreview(latest.frame),
            frameWidth: latest.frame.width,
            frameHeight: latest.frame.height,
            client: { ...latest.client },
            windowHandle: window.handle
        };
    }

    setGrid(grid: GridSettings) {
        if (sameGrid(this.grid, grid)) {
            // Settings echoes (e.g. a host replying to getGlobalSettings) must not restart capture.
            return;
        }
        this.grid = grid;
        this.restartSession();
        if (this.subscribers.size) {
            this.ensureRunning();
        }
    }

    subscribe(id: string, subscriber: Subscriber) {
        this.cancelIdleStop();
        this.subscribers.set(id, subscriber);
        this.pendingSnapshots.add(id);
        void (async () => {
            try {
                const cached = subscriber.live && this.latest ? this.latestImages.get(subscriber.position) : undefined;
                if (cached) {
                    // Returning during the idle grace period: show the last image, not a status card.
                    await subscriber.update(cached, "Mirroring");
                    return;
                }
                await subscriber.update(fallbackSvg(this.status), this.status);
                if (this.subscribers.get(id) !== subscriber || !subscriber.live || !this.latest) {
                    return;
                }
                const { frame, client } = this.latest;
                const rect = sourceRegion(this.grid, subscriber.position, client, frame);
                if (!rect) {
                    await subscriber.update(fallbackSvg("Invalid cell"), "Invalid cell");
                    return;
                }
                const image = this.latestImages.get(subscriber.position);
                if (!image) {
                    // A newly mapped cell will be rendered from the next shared cropped frame.
                    return;
                }
                if (this.subscribers.get(id) === subscriber) {
                    await subscriber.update(image, "Mirroring");
                }
            }
            catch (error) {
                this.warn(String(error));
            }
        })();
        this.ensureRunning();
    }

    refresh(id: string) {
        const subscriber = this.subscribers.get(id);
        if (!subscriber || subscriber.live) {
            return;
        }
        this.cancelIdleStop();
        if (this.session && this.latest) {
            // A session is already running (live buttons or the idle grace period): its latest
            // frame is at most one interval old, and still exact for a static window. Restarting
            // the session here would interrupt every live button on each press.
            void this.snapshotFromLatest(id, subscriber);
            return;
        }
        this.pendingSnapshots.add(id);
        this.ensureRunning();
    }

    unsubscribe(id: string) {
        this.subscribers.delete(id);
        this.pendingSnapshots.delete(id);
        this.scheduleIdleStop();
    }

    private async snapshotFromLatest(id: string, subscriber: Subscriber) {
        try {
            const { frame, client } = this.latest!;
            const rect = sourceRegion(this.grid, subscriber.position, client, frame);
            const image = rect
                ? await renderCrop(cropToRaw(frame, rect), { left: 0, top: 0, width: rect.width, height: rect.height })
                : fallbackSvg("Invalid cell");
            if (this.subscribers.get(id) === subscriber) {
                await subscriber.update(image, rect ? "Mirroring" : "Invalid cell");
            }
        }
        catch (error) {
            this.warn(String(error));
        }
        finally {
            this.scheduleIdleStop();
        }
    }

    private hasDemand() {
        return this.hasLiveSubscribers() || this.pendingSnapshots.size > 0;
    }

    /** Stops the session after {@link idleLingerMs} unless something needs frames again. */
    private scheduleIdleStop() {
        if (this.idleTimer || this.hasDemand()) {
            return;
        }
        if (!this.running || this.closed) {
            this.stopSession();
            return;
        }
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (!this.hasDemand()) {
                this.stopSession();
            }
        }, this.idleLingerMs);
        this.idleTimer.unref?.();
    }

    private cancelIdleStop() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /** Ends the current session; the capture loop exits once nothing needs frames. */
    private stopSession() {
        this.cancelIdleStop();
        this.restartSession();
        this.selected = null;
    }

    private restartSession() {
        this.latest = null;
        this.latestImages.clear();
        this.generation++;
        this.wakeInterval?.();
        void this.session?.stop().catch(() => {});
        this.session = null;
    }

    private ensureRunning() {
        if (!this.running) {
            this.running = true;
            void this.loop();
        }
    }

    private hasLiveSubscribers() {
        return [...this.subscribers.values()].some(subscriber => subscriber.live);
    }

    private shouldCapture() {
        // Keep the loop (and its session) alive through the idle grace period.
        return this.hasDemand() || this.idleTimer !== null;
    }

    private warn(message: string) {
        const now = Date.now();
        if (now - (this.lastWarning.get(message) ?? 0) > 30_000) {
            streamDeck.logger.warn(message);
            this.lastWarning.set(message, now);
        }
    }

    private async publish(message: string) {
        this.status = message;
        const image = fallbackSvg(message);
        await Promise.allSettled([...this.subscribers.values()].map(s => s.update(image, message)));
    }

    private waitForInterval(started: number, token: number) {
        const remaining = this.grid.captureInterval - (performance.now() - started);
        if (remaining <= 0 || token !== this.generation || !this.shouldCapture()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                if (this.wakeInterval === finish) {
                    this.wakeInterval = null;
                }
                resolve();
            };
            const timer = setTimeout(finish, remaining);
            this.wakeInterval = finish;
        });
    }

    private async loop() {
        while (this.shouldCapture()) {
            const token = this.generation;
            let capture: ScreenCapture | null = null;
            try {
                if (!this.grid.windowProcess && !this.grid.windowTitle) {
                    await this.publish("Select a window");
                    await pause(1500);
                    continue;
                }
                const window = resolveWindow(this.grid);
                if (!window) {
                    this.selected = null;
                    await this.publish("Target not running");
                    await pause(1500);
                    continue;
                }
                if (isMinimized(window)) {
                    this.selected = null;
                    await this.publish("Window minimized");
                    await pause(1500);
                    continue;
                }
                let supported = false;
                try {
                    supported = isSupported();
                }
                catch (error) {
                    this.warn(String(error));
                }
                if (!supported) {
                    await this.publish("Capture unavailable");
                    await pause(3000);
                    continue;
                }
                this.selected = window;
                capture = new ScreenCapture({
                    windowHandle: window.handle,
                    cursorCapture: false,
                    minimumUpdateIntervalMs: this.grid.captureInterval
                });
                this.session = capture;
                await capture.start();
                let unavailableFrames = 0;
                const previous = new Map<string, { hash: string; image: string }>();
                while (this.shouldCapture() && token === this.generation) {
                    const frame = await capture.nextFrame();
                    const processedAt = performance.now();
                    if (!frame || token !== this.generation || !this.shouldCapture()) {
                        break;
                    }
                    const current = resolveWindow(this.grid);
                    if (!current || current.handle !== window.handle || isMinimized(current)) {
                        break;
                    }
                    const client = clientBounds(current, frame.width, frame.height);
                    if (!client) {
                        unavailableFrames++;
                        this.warn(
                            `Client area unavailable: frame=${frame.width}x${frame.height} window=${current.width}x${current.height} handle=${current.handle}`
                        );
                        if (unavailableFrames >= 3) {
                            this.latest = null;
                            await this.publish("Client area unavailable");
                        }
                        await this.waitForInterval(processedAt, token);
                        continue;
                    }
                    unavailableFrames = 0;
                    this.status = "Mirroring";
                    this.latest = { frame, client };
                    const cache = new Map<string, { image: string; status: string }>();
                    const valid = new Map<string, PixelRegion>();
                    const targets = [...this.subscribers.entries()].filter(
                        ([id, sub]) => sub.live || this.pendingSnapshots.has(id)
                    );
                    for (const [, sub] of targets) {
                        const pos = sub.position;
                        if (cache.has(pos) || valid.has(pos)) {
                            continue;
                        }
                        const rect = sourceRegion(this.grid, pos, client, frame);
                        if (!rect) {
                            cache.set(pos, {
                                image: fallbackSvg("Invalid cell"),
                                status: "Invalid cell"
                            });
                            continue;
                        }
                        valid.set(pos, rect);
                    }
                    const area = boundingRegion(valid.values());
                    const cellFrame = area ? cropToRaw(frame, area) : null;
                    for (const [pos, rect] of valid) {
                        const local = regionWithin(rect, area!);
                        const hash = regionHash(cellFrame!, local);
                        const prior = previous.get(pos);
                        const image = prior?.hash === hash ? prior.image : await renderCrop(cellFrame!, local);
                        previous.set(pos, { hash, image });
                        this.latestImages.set(pos, image);
                        cache.set(pos, { image, status: "Mirroring" });
                    }
                    const results = await Promise.allSettled(
                        targets.map(([, sub]) => {
                            const data = cache.get(sub.position);
                            return data ? sub.update(data.image, data.status) : Promise.resolve();
                        })
                    );
                    for (const result of results) {
                        if (result.status === "rejected") {
                            this.warn(`Button update failed: ${String(result.reason)}`);
                        }
                    }
                    for (const [id, sub] of targets) {
                        if (!sub.live) {
                            this.pendingSnapshots.delete(id);
                        }
                    }
                    // With only non-live buttons left this starts the grace period; the loop
                    // condition ends the session once it expires.
                    this.scheduleIdleStop();
                    await this.waitForInterval(processedAt, token);
                }
            }
            catch (error) {
                this.warn(String(error));
                await this.publish(
                    /access denied|0x80070005/i.test(String(error)) ? "Access denied" : "Capture failed"
                );
            }
            finally {
                this.selected = null;
                this.latest = null;
                this.latestImages.clear();
                if (capture) {
                    try {
                        await capture.stop();
                    }
                    catch {
                        /* closed already */
                    }
                }
                if (this.session === capture) {
                    this.session = null;
                }
            }
            if (this.shouldCapture() && token === this.generation) {
                await pause(1500);
            }
        }
        this.running = false;
    }

    async shutdown() {
        // Terminal: stops a loop that is mid-frame from re-arming the idle grace period.
        this.closed = true;
        this.cancelIdleStop();
        this.subscribers.clear();
        this.pendingSnapshots.clear();
        this.generation++;
        this.wakeInterval?.();
        await this.session?.stop().catch(() => {});
    }
}
