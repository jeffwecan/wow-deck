import { describe, expect, it, vi } from "vitest";
import { CaptureManager } from "../src/capture/capture-manager.js";
import { normalizeGrid } from "../src/settings/global-grid-settings.js";

// Sessions are tracked per instance: a previous test's session can finish stopping late.
const captureTrace = vi.hoisted(() => ({
    crops: [] as number[][],
    sessions: [] as { stopped: boolean }[],
    get starts() {
        return this.sessions.length;
    },
    get stops() {
        return this.sessions.filter(session => session.stopped).length;
    }
}));

vi.mock("@elgato/streamdeck", () => ({
    default: { logger: { info() {}, warn() {} } }
}));

vi.mock("../src/capture/window-manager.js", () => ({
    resolveWindow: () => ({ handle: 1 }),
    isMinimized: () => false,
    clientBounds: () => ({ x: 0, y: 0, width: 96, height: 48 })
}));

vi.mock("@screen-capture/node", () => {
    type Frame = {
        buffer: Buffer;
        width: number;
        height: number;
        colorFormat: string;
        crop(startX: number, startY: number, endX: number, endY: number): Frame;
    };
    class FakeCapture {
        private queue: Frame[] = [];
        private pending: ((frame: Frame | undefined) => void) | null = null;
        private push(frame: Frame) {
            if (this.pending) {
                const resolve = this.pending;
                this.pending = null;
                resolve(frame);
            }
            else {
                this.queue.push(frame);
            }
        }

        private record = { stopped: false };

        async start() {
            captureTrace.sessions.push(this.record);
            const makeFrame = (red: number): Frame => {
                const buffer = Buffer.alloc(96 * 48 * 4);
                for (let i = 0; i < buffer.length; i += 4) {
                    buffer[i + 2] = red;
                    buffer[i + 3] = 255;
                }
                return {
                    buffer,
                    width: 96,
                    height: 48,
                    colorFormat: "bgra8",
                    crop(startX, startY, endX, endY) {
                        captureTrace.crops.push([startX, startY, endX, endY]);
                        const width = endX - startX;
                        const height = endY - startY;
                        const pixels = Buffer.alloc(width * height * 4);
                        for (let y = 0; y < height; y++) {
                            buffer.copy(
                                pixels,
                                y * width * 4,
                                ((startY + y) * 96 + startX) * 4,
                                ((startY + y) * 96 + endX) * 4
                            );
                        }
                        return {
                            buffer: pixels,
                            width,
                            height,
                            colorFormat: "bgra8",
                            crop: () => {
                                throw new Error("Unexpected nested crop");
                            }
                        };
                    }
                };
            };
            this.push(makeFrame(50));
            setTimeout(() => this.push(makeFrame(200)), 40);
        }

        nextFrame(): Promise<Frame | undefined> {
            const queued = this.queue.shift();
            if (queued) {
                return Promise.resolve(queued);
            }
            return new Promise(resolve => (this.pending = resolve));
        }

        async stop() {
            this.record.stopped = true;
            this.pending?.(undefined);
            this.pending = null;
        }
    }
    return { ScreenCapture: FakeCapture, isSupported: () => true };
});

describe("capture interval", () => {
    it("shows a changed frame even if the window becomes static before the deadline", async () => {
        captureTrace.crops.length = 0;
        const manager = new CaptureManager();
        const images: string[] = [];
        const grid = {
            ...normalizeGrid(null),
            windowProcess: "test.exe",
            captureInterval: 250 as const
        };
        manager.setGrid(grid);
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Second frame was not shown")), 1200);
                manager.subscribe("button", {
                    position: "1-1",
                    live: true,
                    update: async (image) => {
                        if (image.startsWith("data:image/png")) {
                            images.push(image);
                        }
                        if (images.length === 2) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    }
                });
            });
            expect(images[0]).not.toBe(images[1]);
            expect(captureTrace.crops).toEqual([
                [0, 0, 48, 48],
                [0, 0, 48, 48]
            ]);
        }
        finally {
            await manager.shutdown();
        }
    });

    it("captures non-live buttons only when they load or are refreshed", async () => {
        captureTrace.crops.length = 0;
        const manager = new CaptureManager();
        manager.setGrid({ ...normalizeGrid(null), windowProcess: "test.exe" });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Initial frame was not shown")), 1200);
                manager.subscribe("button", {
                    position: "1-1",
                    live: false,
                    update: async (image) => {
                        if (image.startsWith("data:image/png")) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    }
                });
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(captureTrace.crops).toHaveLength(1);

            const refreshed = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Refreshed frame was not shown")), 1200);
                const updates = captureTrace.crops.length;
                const check = setInterval(() => {
                    if (captureTrace.crops.length > updates) {
                        clearInterval(check);
                        clearTimeout(timeout);
                        resolve();
                    }
                }, 10);
            });
            manager.refresh("button");
            await refreshed;
            expect(captureTrace.crops).toHaveLength(2);
        }
        finally {
            await manager.shutdown();
        }
    });
});

describe("capture session reuse", () => {
    const grid = { ...normalizeGrid(null), windowProcess: "test.exe", captureInterval: 100 as const };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const reset = () => {
        captureTrace.crops.length = 0;
        captureTrace.sessions.length = 0;
    };
    const firstImage = (manager: CaptureManager, id: string, live: boolean, images: string[] = []) =>
        new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`No frame for ${id}`)), 1200);
            manager.subscribe(id, {
                position: "1-1",
                live,
                update: async (image) => {
                    images.push(image);
                    if (image.startsWith("data:image/png")) {
                        clearTimeout(timeout);
                        resolve(image);
                    }
                }
            });
        });

    it("keeps the session through a brief disappearance, then stops it once idle", async () => {
        reset();
        const manager = new CaptureManager(300);
        manager.setGrid(grid);
        try {
            await firstImage(manager, "button", true);
            manager.unsubscribe("button");
            await sleep(50);

            const images: string[] = [];
            await firstImage(manager, "button", true, images);
            expect(images[0]).toMatch(/^data:image\/png/); // cached image, no status card
            expect(captureTrace.starts).toBe(1);
            expect(captureTrace.stops).toBe(0);

            manager.unsubscribe("button");
            await sleep(500);
            expect(captureTrace.stops).toBe(1);
        }
        finally {
            await manager.shutdown();
        }
    });

    it("does not restart capture when the same grid arrives again", async () => {
        reset();
        const manager = new CaptureManager(300);
        manager.setGrid(grid);
        try {
            await firstImage(manager, "button", true);
            manager.setGrid({ ...grid });
            manager.setGrid(normalizeGrid({ ...grid }));
            await sleep(100);
            expect(captureTrace.starts).toBe(1);
            expect(captureTrace.stops).toBe(0);
        }
        finally {
            await manager.shutdown();
        }
    });

    it("refreshes a non-live button from the running session without restarting it", async () => {
        reset();
        const manager = new CaptureManager(300);
        manager.setGrid(grid);
        try {
            await firstImage(manager, "live", true);
            await firstImage(manager, "static", false);
            const crops = captureTrace.crops.length;
            manager.refresh("static");
            await sleep(50);
            expect(captureTrace.crops.length).toBe(crops + 1);
            expect(captureTrace.starts).toBe(1);
            expect(captureTrace.stops).toBe(0);
        }
        finally {
            await manager.shutdown();
        }
    });
});
