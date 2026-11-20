// The pixel beacon: a small strip of colored blocks the WowDeck addon draws at the top-left of
// the game window, carrying each action slot's live state. This file mirrors the encoder in
// addon/WowDeck/WowDeck.lua; keep the two in sync.
//
// The game can change colors on the way to the screen (HDR, gamma), e.g. brightening them about
// 2x and clipping the top half. So the beacon is self-calibrating:
//   * data uses 8 levels per channel (3 bits), all drawn in the lower range (8-120);
//   * calibration blocks show each level, and the decoder matches every value to the nearest
//     level as it actually arrived;
//   * the start marker is pure magenta then pure green, found by contrast, not exact values.
//
// Layout: BLOCK x BLOCK pixel blocks, COLUMNS per row, left-to-right, top-to-bottom.
//   block 0: magenta (255, 0, 255); block 1: green (0, 255, 0)
//   block 2: header (VERSION, frame counter, checksum)
//   blocks 3-10: calibration, level n in all three channels
//   blocks 11 + 3(s-1) .. +2 for slot s (1..MAX_SLOT): remaining, flags, count; each 8-bit value
//     split into digits of 3, 3 and 2 bits across one block's R, G and B
// The checksum is the counter plus every slot digit, mod 8.

export const BLOCK = 3;
export const COLUMNS = 64;
export const MAX_SLOT = 180;
export const VERSION = 2;
export const LEVELS = 8;
const FIRST_SLOT_BLOCK = 11;
const CALIBRATION_BLOCK = 3;
const BLOCKS = FIRST_SLOT_BLOCK + MAX_SLOT * 3;
export const ROWS = Math.ceil(BLOCKS / COLUMNS);
export const WIDTH = COLUMNS * BLOCK;
export const HEIGHT = ROWS * BLOCK;

/** Channel value drawn for a level (0-7): 8, 24, ... 120. */
export const levelValue = (level: number) => 8 + 16 * level;

export const FLAG = {
    present: 1,
    usable: 2,
    noMana: 4,
    outOfRange: 8,
    glow: 16,
    globalCooldown: 32,
    active: 64
} as const;

export interface LiveSlot {
    /** Seconds of cooldown left (whole seconds under 200 s, whole minutes above). 0 when ready. */
    remaining: number;
    flags: number;
    /** Item/reagent count shown on the button, 0 when none. */
    count: number;
}

export interface BeaconFrame {
    counter: number;
    slots: Map<number, LiveSlot>;
}

/** A BGRA pixel buffer (what Windows capture returns), tightly packed. */
export interface Pixels {
    buffer: Uint8Array;
    width: number;
    height: number;
}

/** RGB channel values per block, as drawn (0-255). */
type Rgb = [number, number, number];

/**
 * Cooldown seconds to the 8-bit wire value: whole seconds (rounded up) below 200, then
 * 200 + minutes (rounded up, like WoW's own "4m").
 */
export function encodeRemaining(seconds: number): number {
    if (seconds <= 0) {
        return 0;
    }
    const whole = Math.ceil(seconds);
    if (whole < 200) {
        return whole;
    }
    return Math.min(255, 200 + Math.ceil(seconds / 60));
}

export function decodeRemaining(value: number): number {
    return value < 200 ? value : (value - 200) * 60;
}

/** An 8-bit value as level digits of 3, 3 and 2 bits. */
const digits = (value: number): Rgb => [value >> 5, (value >> 2) & 7, value & 3];
const fromDigits = ([a, b, c]: Rgb) => (a << 5) | (b << 2) | c;

/** Every block's drawn color for a frame. */
export function encodeBlocks(counter: number, slots: Map<number, LiveSlot>): Rgb[] {
    const level = (rgb: Rgb): Rgb => [levelValue(rgb[0]), levelValue(rgb[1]), levelValue(rgb[2])];
    const blocks: Rgb[] = [[255, 0, 255], [0, 255, 0], [0, 0, 0]];
    for (let n = 0; n < LEVELS; n++) {
        blocks.push([levelValue(n), levelValue(n), levelValue(n)]);
    }
    let sum = counter & 7;
    for (let slot = 1; slot <= MAX_SLOT; slot++) {
        const state = slots.get(slot);
        const values = [
            state ? encodeRemaining(state.remaining) : 0,
            state ? state.flags & 0xff : 0,
            state ? Math.min(255, Math.max(0, Math.floor(state.count))) : 0
        ];
        for (const value of values) {
            const d = digits(value);
            sum += d[0] + d[1] + d[2];
            blocks.push(level(d));
        }
    }
    blocks[2] = [levelValue(VERSION), levelValue(counter & 7), levelValue(sum & 7)];
    return blocks;
}

/** Draws a beacon into a BGRA buffer at (left, top); used by tests and the capture check. */
export function drawBeacon(target: Pixels, left: number, top: number, counter: number, slots: Map<number, LiveSlot>) {
    encodeBlocks(counter, slots).forEach(([r, g, b], index) => {
        const bx = left + (index % COLUMNS) * BLOCK;
        const by = top + Math.floor(index / COLUMNS) * BLOCK;
        for (let y = by; y < by + BLOCK; y++) {
            for (let x = bx; x < bx + BLOCK; x++) {
                const i = (y * target.width + x) * 4;
                target.buffer[i] = b;
                target.buffer[i + 1] = g;
                target.buffer[i + 2] = r;
                target.buffer[i + 3] = 255;
            }
        }
    });
}

function rgbAt(pixels: Pixels, x: number, y: number): Rgb | null {
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) {
        return null;
    }
    const i = (y * pixels.width + x) * 4;
    return [pixels.buffer[i + 2], pixels.buffer[i + 1], pixels.buffer[i]];
}

/** True when the BLOCK x BLOCK pixels from (x, y) are one flat color (within a small tolerance). */
function flatBlock(pixels: Pixels, x: number, y: number): Rgb | null {
    const first = rgbAt(pixels, x, y);
    if (!first) {
        return null;
    }
    for (let dy = 0; dy < BLOCK; dy++) {
        for (let dx = 0; dx < BLOCK; dx++) {
            const p = rgbAt(pixels, x + dx, y + dy);
            if (!p || Math.abs(p[0] - first[0]) > 6 || Math.abs(p[1] - first[1]) > 6 || Math.abs(p[2] - first[2]) > 6) {
                return null;
            }
        }
    }
    return first;
}

const CONTRAST = 90;
const isMagenta = ([r, g, b]: Rgb) => r - g > CONTRAST && b - g > CONTRAST;
const isGreen = ([r, g, b]: Rgb) => g - r > CONTRAST && g - b > CONTRAST;

/** Finds the top-left pixel of the beacon's start marker (a magenta block, then a green one). */
export function findBeacon(pixels: Pixels): { x: number; y: number } | null {
    const maxX = pixels.width - WIDTH;
    const maxY = pixels.height - HEIGHT;
    for (let y = 0; y <= maxY; y++) {
        for (let x = 0; x <= maxX; x++) {
            if (!isMagenta(rgbAt(pixels, x, y)!)) {
                continue;
            }
            const magenta = flatBlock(pixels, x, y);
            const green = magenta && flatBlock(pixels, x + BLOCK, y);
            if (magenta && green && isMagenta(magenta) && isGreen(green)) {
                return { x, y };
            }
        }
    }
    return null;
}

export type DecodeResult
    = | { ok: true; frame: BeaconFrame }
        | { ok: false; reason: "no-marker" | "distorted" | "version" | "checksum" };

/** Decodes the beacon whose start marker is at `origin`. */
export function decodeBeacon(pixels: Pixels, origin: { x: number; y: number }): DecodeResult {
    const center = (index: number) =>
        rgbAt(pixels, origin.x + (index % COLUMNS) * BLOCK + 1, origin.y + Math.floor(index / COLUMNS) * BLOCK + 1);
    const magenta = center(0);
    const green = center(1);
    if (!magenta || !green || !isMagenta(magenta) || !isGreen(green)) {
        return { ok: false, reason: "no-marker" };
    }
    // How each level actually arrived, per channel; must stay in order and distinguishable.
    const calibration: number[][] = [[], [], []];
    for (let n = 0; n < LEVELS; n++) {
        const rgb = center(CALIBRATION_BLOCK + n);
        if (!rgb) {
            return { ok: false, reason: "no-marker" };
        }
        for (let c = 0; c < 3; c++) {
            // Strong gamma squeezes the darkest levels to ~4 apart; captures are otherwise exact.
            if (n > 0 && rgb[c] - calibration[c][n - 1] < 3) {
                return { ok: false, reason: "distorted" };
            }
            calibration[c].push(rgb[c]);
        }
    }
    const nearest = (channel: number, value: number) => {
        let best = 0;
        for (let n = 1; n < LEVELS; n++) {
            if (Math.abs(calibration[channel][n] - value) < Math.abs(calibration[channel][best] - value)) {
                best = n;
            }
        }
        return best;
    };
    const levelsAt = (index: number): Rgb | null => {
        const rgb = center(index);
        return rgb ? [nearest(0, rgb[0]), nearest(1, rgb[1]), nearest(2, rgb[2])] : null;
    };
    const header = levelsAt(2);
    if (!header || header[0] !== VERSION) {
        return { ok: false, reason: "version" };
    }
    const counter = header[1];
    let sum = counter;
    const slots = new Map<number, LiveSlot>();
    for (let slot = 1; slot <= MAX_SLOT; slot++) {
        const base = FIRST_SLOT_BLOCK + (slot - 1) * 3;
        const parts = [levelsAt(base), levelsAt(base + 1), levelsAt(base + 2)];
        if (parts.some(p => !p)) {
            return { ok: false, reason: "no-marker" };
        }
        const [remaining, flags, count] = parts.map((p) => {
            const d = p as Rgb;
            // The last digit carries only 2 bits; a level above 3 can only be a misread.
            sum += d[0] + d[1] + d[2];
            return fromDigits([d[0], d[1], Math.min(3, d[2])]);
        });
        if (flags & FLAG.present) {
            slots.set(slot, { remaining: decodeRemaining(remaining), flags, count });
        }
    }
    if ((sum & 7) !== header[2]) {
        return { ok: false, reason: "checksum" };
    }
    return { ok: true, frame: { counter, slots } };
}
