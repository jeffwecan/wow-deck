// Capture backends for the beacon reader.
//
// Desktop Duplication (default): copies the monitor's image on demand and crops the game's
// client area. It doesn't make Windows draw a "being captured" border over the window (which
// covered the beacon), and it costs much less CPU than window capture, which streams and copies
// every frame of the whole window. Window capture (Windows Graphics Capture) is the fallback, for
// when duplication isn't available (e.g. exclusive fullscreen, remote sessions).
import { DxgiDuplicationSession, ScreenCapture, enumerateMonitors } from "@screen-capture/node";
import { WOW_EXECUTABLE, clientRectOnScreen, findProcessWindow, monitorOfWindow } from "../input/foreground.js";
import type { BeaconReaderDeps, CaptureSession, CapturedFrame } from "./beacon-reader.js";

/** Main window classes of known WoW clients (Blizzard's, and WoW: Forever's); anything else is found by process. */
const WOW_WINDOW_CLASSES = ["GxWindowClass", "waApplication Window"];

export interface WindowTarget {
    executable: RegExp;
    classNames?: readonly string[];
    title?: string | null;
}

const monitorIndexes = new Map<string, number>();

/** Monitor index (1-based, as the capture library numbers them) for a window. */
function monitorIndexFor(window: number): { index: number; left: number; top: number } | null {
    const monitor = monitorOfWindow(window);
    if (!monitor) {
        return null;
    }
    const device = monitor.deviceName.toLowerCase();
    if (!monitorIndexes.has(device)) {
        try {
            const match = enumerateMonitors().find(m => m.deviceName.toLowerCase() === device);
            if (!match) {
                return null;
            }
            monitorIndexes.set(device, match.index);
        }
        catch {
            return null;
        }
    }
    return { index: monitorIndexes.get(device)!, left: monitor.left, top: monitor.top };
}

/**
 * A capture session that reads the window's client area out of the duplicated monitor image.
 * Frames are cropped relative to the client area's top-left.
 */
export class DesktopWindowSession implements CaptureSession {
    private session: DxgiDuplicationSession | null = null;
    private monitor: { index: number; left: number; top: number } | null = null;
    private stopped = false;

    constructor(
        private readonly window: number,
        private readonly intervalMs: number
    ) {}

    async start() {
        this.monitor = monitorIndexFor(this.window);
        if (!this.monitor) {
            throw new Error("Could not find the monitor showing the game window");
        }
        this.session = new DxgiDuplicationSession({ monitorIndex: this.monitor.index });
    }

    async nextFrame(): Promise<CapturedFrame | undefined> {
        while (!this.stopped) {
            const client = clientRectOnScreen(this.window);
            const monitor = monitorIndexFor(this.window);
            if (!client || !monitor) {
                return undefined; // window closed or minimized: let the reader look for it again
            }
            if (monitor.index !== this.monitor?.index) {
                // The window moved to another monitor.
                this.monitor = monitor;
                this.session = new DxgiDuplicationSession({ monitorIndex: monitor.index });
            }
            let frame;
            try {
                // Synchronous; a short timeout keeps the plugin responsive while waiting.
                frame = this.session!.acquireNextFrame(Math.min(50, this.intervalMs));
            }
            catch {
                // Access lost (display mode change, secure desktop): rebuild and try again shortly.
                try {
                    this.session!.recreate();
                }
                catch {
                    return undefined;
                }
            }
            if (frame) {
                const left = client.x - monitor.left;
                const top = client.y - monitor.top;
                const width = Math.max(0, Math.min(client.width, frame.width - left));
                const height = Math.max(0, Math.min(client.height, frame.height - top));
                if (left < 0 || top < 0 || width <= 0 || height <= 0) {
                    return undefined;
                }
                return {
                    width,
                    height,
                    crop: (startX, startY, endX, endY) => {
                        const cropped = frame.crop(left + startX, top + startY, left + endX, top + endY);
                        return { buffer: cropped.buffer, width: cropped.width, height: cropped.height };
                    }
                };
            }
            // Nothing on screen changed; wait a little before asking again.
            await new Promise(resolve => setTimeout(resolve, Math.min(50, this.intervalMs)));
        }
        return undefined;
    }

    async stop() {
        this.stopped = true;
        this.session = null;
    }
}

/** Window capture, used when desktop duplication fails to start. */
class FallbackSession implements CaptureSession {
    private active: CaptureSession;

    constructor(
        private readonly window: number,
        private readonly intervalMs: number
    ) {
        this.active = new DesktopWindowSession(window, intervalMs);
    }

    async start() {
        try {
            await this.active.start();
        }
        catch {
            this.active = new ScreenCapture({
                windowHandle: this.window,
                cursorCapture: false,
                drawBorder: false, // a border would cover the beacon in the corner
                minimumUpdateIntervalMs: this.intervalMs
            });
            await this.active.start();
        }
    }

    nextFrame() {
        return this.active.nextFrame();
    }

    stop() {
        return this.active.stop();
    }
}

/** Capture dependencies for one application's main window (WoW by default). */
export function windowCapture(
    target: WindowTarget = { executable: WOW_EXECUTABLE, classNames: WOW_WINDOW_CLASSES }
): BeaconReaderDeps {
    return {
        findWindow: () => findProcessWindow(target.executable, target.classNames, target.title ?? null),
        capture: (windowHandle: number, intervalMs: number): CaptureSession => new FallbackSession(windowHandle, intervalMs)
    };
}
