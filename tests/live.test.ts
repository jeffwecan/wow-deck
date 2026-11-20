import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { FLAG, drawBeacon, type BeaconFrame, type LiveSlot } from "../src/live/beacon-codec.js";
import { BeaconReader, type CaptureSession, type CapturedFrame } from "../src/live/beacon-reader.js";
import { LiveTracker } from "../src/live/live-view.js";
import { cooldownText, renderSlot } from "../src/deck/render.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A 640x400 "window" with the beacon below a title bar, as Windows capture would return it. */
function windowFrame(counter: number, slots: Map<number, LiveSlot>): CapturedFrame {
    const width = 640;
    const height = 400;
    const buffer = new Uint8Array(width * height * 4).map((_, i) => (i * 31) & 0xff);
    drawBeacon({ buffer, width, height }, 8, 31, counter, slots);
    return {
        width,
        height,
        crop(startX, startY, endX, endY) {
            const w = endX - startX;
            const h = endY - startY;
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) {
                out.set(buffer.subarray(((startY + y) * width + startX) * 4, ((startY + y) * width + endX) * 4), y * w * 4);
            }
            return { buffer: out, width: w, height: h };
        }
    };
}

function fakeGame() {
    const state = { running: true, frozen: false, repeating: false, counter: 0, starts: 0, stops: 0, remaining: 30 };
    const deps = {
        findWindow: () => (state.running ? 42 : null),
        capture: (): CaptureSession => {
            let stopped = false;
            return {
                start: async () => {
                    state.starts++;
                },
                stop: async () => {
                    if (!stopped) {
                        stopped = true;
                        state.stops++;
                    }
                },
                nextFrame: async () => {
                    await sleep(10);
                    while (state.frozen && !stopped) {
                        await sleep(10); // a minimized game delivers no frames
                    }
                    if (stopped) {
                        return undefined;
                    }
                    if (!state.frozen && !state.repeating) {
                        state.counter = (state.counter + 1) % 8;
                    }
                    return windowFrame(state.counter, new Map([
                        [3, { remaining: state.remaining, flags: FLAG.present | FLAG.usable, count: 0 }]
                    ]));
                }
            };
        }
    };
    return { state, deps };
}

describe("beacon reader", () => {
    it("finds the beacon in the game window and publishes decoded frames", async () => {
        const { state, deps } = fakeGame();
        const reader = new BeaconReader(deps, 100);
        const frames: (BeaconFrame | null)[] = [];
        reader.onFrame(frame => frames.push(frame));
        reader.configure(true, 20);
        reader.setDemand(true);
        await sleep(150);
        expect(reader.frame?.slots.get(3)?.remaining).toBe(30);
        expect(reader.status).toMatch(/Reading/);
        expect(state.starts).toBe(1);

        // Frozen game (minimized/paused): the data goes stale and is withdrawn.
        state.frozen = true;
        await sleep(2200);
        expect(reader.frame).toBeNull();
        expect(frames.at(-1)).toBeNull();
        state.frozen = false;
        await sleep(100);
        expect(reader.frame).not.toBeNull();

        // Frames keep arriving but the addon's counter stops (an unchanged screen): also stale.
        state.repeating = true;
        await sleep(2200);
        expect(reader.frame).toBeNull();
        state.repeating = false;

        // No demand: capture stops only after the grace period.
        reader.setDemand(false);
        await sleep(40);
        expect(state.stops).toBe(0);
        await sleep(150);
        expect(state.stops).toBe(1);
        reader.shutdown();
    });

    it("reports when the game isn't running, and stays off when live state is disabled", async () => {
        const { state, deps } = fakeGame();
        state.running = false;
        const reader = new BeaconReader(deps, 100);
        reader.configure(true, 20);
        reader.setDemand(true);
        await sleep(50);
        expect(reader.status).toBe("WoW is not running");
        reader.shutdown();

        const off = fakeGame();
        const disabled = new BeaconReader(off.deps, 100);
        disabled.configure(false, 20);
        disabled.setDemand(true);
        await sleep(50);
        expect(off.state.starts).toBe(0);
        disabled.shutdown();
    });
});

describe("live view", () => {
    const frame = (slots: [number, LiveSlot][]): BeaconFrame => ({ counter: 0, slots: new Map(slots) });

    it("learns each cooldown's length and turns flags into the WoW look", () => {
        const tracker = new LiveTracker();
        tracker.update(frame([[1, { remaining: 30, flags: FLAG.present | FLAG.usable, count: 0 }]]));
        tracker.update(frame([[1, { remaining: 15, flags: FLAG.present | FLAG.usable, count: 0 }]]));
        expect(tracker.view(1)).toMatchObject({ cooldown: "15", sweep: 0.5, unusable: false, tint: null });

        tracker.update(frame([
            [1, { remaining: 0, flags: FLAG.present | FLAG.usable, count: 0 }],
            [2, { remaining: 0, flags: FLAG.present | FLAG.noMana, count: 0 }],
            [3, { remaining: 0, flags: FLAG.present | FLAG.usable | FLAG.outOfRange | FLAG.glow, count: 4 }],
            [4, { remaining: 0, flags: FLAG.present, count: 0 }]
        ]));
        expect(tracker.view(1)).toMatchObject({ cooldown: null, sweep: 0 });
        expect(tracker.view(2)).toMatchObject({ unusable: false, tint: "mana" });
        expect(tracker.view(3)).toMatchObject({ tint: "range", glow: true, count: 4 });
        expect(tracker.view(4)).toMatchObject({ unusable: true, tint: null });
        expect(tracker.view(5)).toBeNull();

        // A new cooldown after the old one ended is measured afresh.
        tracker.update(frame([[1, { remaining: 8, flags: FLAG.present, count: 0 }]]));
        expect(tracker.view(1)?.sweep).toBe(1);
        tracker.update(null);
        expect(tracker.view(1)).toBeNull();
    });

    it("formats cooldowns like WoW and renders every overlay at 144px", async () => {
        expect(cooldownText(0)).toBeNull();
        expect(cooldownText(8.2)).toBe("9");
        expect(cooldownText(89)).toBe("89");
        expect(cooldownText(240)).toBe("4m");
        const icon = await sharp({ create: { width: 56, height: 56, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
        const view = { cooldown: "12", sweep: 0.4, unusable: true, tint: "range" as const, glow: true, active: true, count: 7 };
        for (const url of [await renderSlot(icon, "Rake", "SHIFT-F6", view), await renderSlot(null, "Rake", "1", view)]) {
            const meta = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
            expect([meta.format, meta.width, meta.height]).toEqual(["png", 144, 144]);
        }
    });
});
