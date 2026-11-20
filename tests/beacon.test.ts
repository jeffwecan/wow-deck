import { describe, expect, it } from "vitest";
import {
    BLOCK,
    COLUMNS,
    FLAG,
    HEIGHT,
    WIDTH,
    decodeBeacon,
    decodeRemaining,
    drawBeacon,
    encodeRemaining,
    findBeacon,
    type LiveSlot,
    type Pixels
} from "../src/live/beacon-codec.js";

function canvas(width: number, height: number): Pixels {
    const buffer = new Uint8Array(width * height * 4);
    // Busy, game-like background so the search can't succeed by accident.
    for (let i = 0; i < buffer.length; i++) {
        buffer[i] = (i * 37 + (i >> 7) * 11) & 0xff;
    }
    return { buffer, width, height };
}

/** Applies a color change to the beacon's pixels, as the game/HDR pipeline would. */
function transform(pixels: Pixels, left: number, top: number, curve: (v: number) => number) {
    for (let y = top; y < top + HEIGHT; y++) {
        for (let x = left; x < left + WIDTH; x++) {
            const i = (y * pixels.width + x) * 4;
            for (let c = 0; c < 3; c++) {
                pixels.buffer[i + c] = Math.max(0, Math.min(255, Math.round(curve(pixels.buffer[i + c]))));
            }
        }
    }
}

const slots = new Map<number, LiveSlot>([
    [1, { remaining: 0, flags: FLAG.present | FLAG.usable, count: 0 }],
    [7, { remaining: 12.2, flags: FLAG.present | FLAG.noMana, count: 0 }],
    [67, { remaining: 0, flags: FLAG.present | FLAG.usable, count: 14 }],
    [160, { remaining: 600, flags: FLAG.present | FLAG.outOfRange | FLAG.glow | FLAG.active, count: 255 }],
    [180, { remaining: 1.4, flags: FLAG.present | FLAG.usable | FLAG.globalCooldown, count: 3 }]
]);

function expectSlots(result: ReturnType<typeof decodeBeacon>) {
    expect(result.ok).toBe(true);
    const frame = result.ok ? result.frame : null;
    expect([...frame!.slots.keys()]).toEqual([1, 7, 67, 160, 180]);
    expect(frame!.slots.get(7)).toEqual({ remaining: 13, flags: FLAG.present | FLAG.noMana, count: 0 });
    expect(frame!.slots.get(67)?.count).toBe(14);
    expect(frame!.slots.get(160)).toEqual({
        remaining: 600,
        flags: FLAG.present | FLAG.outOfRange | FLAG.glow | FLAG.active,
        count: 255
    });
    expect(frame!.slots.get(180)?.flags).toBe(FLAG.present | FLAG.usable | FLAG.globalCooldown);
    return frame!;
}

describe("beacon encoding", () => {
    it("stores short cooldowns in seconds and long ones in minutes", () => {
        expect(encodeRemaining(0)).toBe(0);
        expect(encodeRemaining(0.2)).toBe(1);
        expect(encodeRemaining(198.5)).toBe(199);
        expect(encodeRemaining(199.5)).toBe(200 + 4); // rounds up past 199 s into minutes, never to 0
        expect(decodeRemaining(encodeRemaining(199.5))).toBe(240);
        expect(decodeRemaining(encodeRemaining(12.2))).toBe(13);
        expect(decodeRemaining(encodeRemaining(600))).toBe(600);
        expect(encodeRemaining(99999)).toBe(255);
    });

    it("finds and decodes a beacon drawn at an offset inside a busy frame", () => {
        const pixels = canvas(400, 200);
        drawBeacon(pixels, 9, 31, 5, slots); // e.g. below a window border and title bar
        const origin = findBeacon(pixels);
        expect(origin).toEqual({ x: 9, y: 31 });
        expect(expectSlots(decodeBeacon(pixels, origin!)).counter).toBe(5);
        expect(WIDTH).toBe(COLUMNS * BLOCK);
        expect(HEIGHT).toBe(9 * BLOCK);
    });

    it("decodes through the color change seen in WoW with HDR (about 1.9x brighter, clipped)", () => {
        // Measured from a real capture: 8 -> 24, 56 -> 106, 88 -> 164, 168 -> 255.
        const pixels = canvas(400, 200);
        drawBeacon(pixels, 1, 31, 3, slots);
        transform(pixels, 1, 31, v => 1.87 * v + 9);
        expectSlots(decodeBeacon(pixels, findBeacon(pixels)!));
    });

    it("decodes through a darkening gamma curve and small per-pixel noise", () => {
        const pixels = canvas(400, 200);
        drawBeacon(pixels, 0, 0, 6, slots);
        transform(pixels, 0, 0, v => 255 * Math.pow(v / 255, 1.6));
        for (let i = 0; i < pixels.width * HEIGHT * 4; i += 4) {
            pixels.buffer[i + 1] = Math.min(255, pixels.buffer[i + 1] + (i % 3)); // ±2 jitter
        }
        expectSlots(decodeBeacon(pixels, findBeacon(pixels)!));
    });

    it("says when colors are too distorted, or a frame is corrupted, instead of guessing", () => {
        const flattened = canvas(400, 200);
        drawBeacon(flattened, 0, 0, 1, slots);
        transform(flattened, 0, 0, v => (v < 128 ? Math.min(255, v * 6) : v)); // levels clip together
        expect(decodeBeacon(flattened, findBeacon(flattened)!)).toEqual({ ok: false, reason: "distorted" });

        const corrupted = canvas(400, 200);
        drawBeacon(corrupted, 0, 0, 1, slots);
        // Change one digit in slot 7's flags block: the checksum no longer matches.
        const index = 11 + 6 * 3 + 1;
        const x = (index % COLUMNS) * BLOCK + 1;
        const y = Math.floor(index / COLUMNS) * BLOCK + 1;
        corrupted.buffer[(y * corrupted.width + x) * 4 + 1] += 16;
        expect(decodeBeacon(corrupted, { x: 0, y: 0 })).toEqual({ ok: false, reason: "checksum" });

        expect(findBeacon(canvas(300, 100))).toBeNull();
    });
});
