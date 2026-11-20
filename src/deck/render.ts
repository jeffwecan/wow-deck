// Draws key images: the slot's icon with its keybind, or a text tile when there is no icon.
import sharp from "sharp";

const SIZE = 144;
const BACKGROUND = "#171923";

const escapeXml = (text: string) =>
    text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[c]!);

/** Short WoW-style keybind label: "CTRL-SHIFT-F7" → "cs-F7", "NUMPAD3" → "N3". */
export function keyLabel(key: string | null): string {
    if (!key) {
        return "";
    }
    let rest = key.toUpperCase();
    let mods = "";
    for (;;) {
        const match = /^(CTRL|ALT|SHIFT)-/.exec(rest);
        if (!match) {
            break;
        }
        mods += match[1][0].toLowerCase();
        rest = rest.slice(match[0].length);
    }
    rest = rest
        .replace(/^NUMPAD/, "N")
        .replace(/^PAGEUP$/, "PU")
        .replace(/^PAGEDOWN$/, "PD")
        .replace(/^SPACE$/, "Spc")
        .replace(/^BACKSPACE$/, "Bs")
        .replace(/^INSERT$/, "Ins")
        .replace(/^DELETE$/, "Del");
    return mods ? `${mods}-${rest}` : rest;
}

/** Splits a name into at most `lines` lines of roughly `width` characters. */
function wrap(text: string, width: number, lines: number): string[] {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line && (line + " " + word).length > width) {
            out.push(line);
            line = word;
        }
        else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) {
        out.push(line);
    }
    if (out.length > lines) {
        out.length = lines;
        out[lines - 1] = out[lines - 1].slice(0, width - 1) + "…";
    }
    return out.map(l => (l.length > width ? l.slice(0, width - 1) + "…" : l));
}

function keybindSvg(label: string, color = "#ffffff") {
    if (!label) {
        return "";
    }
    const size = label.length > 6 ? 22 : 28;
    return `<text x="${SIZE - 8}" y="${size + 4}" text-anchor="end" font-family="Arial" font-weight="bold" font-size="${size}" fill="${color}" stroke="#000000" stroke-width="5" paint-order="stroke">${escapeXml(label)}</text>`;
}

const toDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/** Live state to draw over a slot, already reduced to what changes the picture. */
export interface LiveView {
    /** Cooldown text ("12", "4m"), or null when ready. */
    cooldown: string | null;
    /** Share of the cooldown still remaining (0-1), drawn as a dark clockwise wedge. */
    sweep: number;
    /** Not usable right now (dimmed, like WoW's buttons). */
    unusable: boolean;
    tint: "mana" | "range" | null;
    glow: boolean;
    active: boolean;
    /** Item/reagent count, 0 to hide. */
    count: number;
}

/** "12" under a minute and a half, then "2m" like WoW (minutes rounded up). */
export function cooldownText(seconds: number): string | null {
    if (seconds <= 0) {
        return null;
    }
    return seconds < 90 ? String(Math.ceil(seconds)) : `${Math.ceil(seconds / 60)}m`;
}

/** Dark wedge for the remaining share of a cooldown, revealed clockwise from 12 o'clock. */
function sweepSvg(remaining: number) {
    if (remaining <= 0) {
        return "";
    }
    const shade = "fill=\"#000000\" fill-opacity=\"0.62\"";
    if (remaining >= 0.999) {
        return `<rect width="${SIZE}" height="${SIZE}" ${shade}/>`;
    }
    const c = SIZE / 2;
    const r = SIZE; // past the corners; the image edge clips it
    const angle = (1 - remaining) * 2 * Math.PI;
    const x = c + r * Math.sin(angle);
    const y = c - r * Math.cos(angle);
    const large = remaining > 0.5 ? 1 : 0;
    return `<path d="M ${c} ${c} L ${x.toFixed(2)} ${y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${c} ${c - r} Z" ${shade}/>`;
}

function overlaySvg(label: string, live: LiveView | null) {
    if (!live) {
        return keybindSvg(label);
    }
    const parts = [sweepSvg(live.sweep)];
    if (live.tint) {
        // Multiply-style tint: blue for out of mana, red for out of range (as WoW colors them).
        const color = live.tint === "mana" ? "#3a50ff" : "#ff2a2a";
        parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="${color}" fill-opacity="0.35"/>`);
    }
    if (live.glow) {
        parts.push(`<rect x="4" y="4" width="${SIZE - 8}" height="${SIZE - 8}" rx="8" fill="none" stroke="#ffd34d" stroke-width="8"/>`);
    }
    else if (live.active) {
        parts.push(`<rect x="3" y="3" width="${SIZE - 6}" height="${SIZE - 6}" rx="6" fill="none" stroke="#ffffff" stroke-width="5"/>`);
    }
    if (live.cooldown) {
        const size = live.cooldown.length > 2 ? 46 : 58;
        parts.push(`<text x="${SIZE / 2}" y="${SIZE / 2 + size * 0.36}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${size}" fill="#ffffff" stroke="#000000" stroke-width="6" paint-order="stroke">${escapeXml(live.cooldown)}</text>`);
    }
    if (live.count > 0) {
        parts.push(`<text x="${SIZE - 8}" y="${SIZE - 10}" text-anchor="end" font-family="Arial" font-weight="bold" font-size="28" fill="#ffffff" stroke="#000000" stroke-width="5" paint-order="stroke">${live.count}</text>`);
    }
    parts.push(keybindSvg(label, live.tint === "range" ? "#ff5a5a" : "#ffffff"));
    return parts.join("");
}

/**
 * Renders a slot: icon (when available) plus its keybind, falling back to the slot's name; with
 * live state, also its cooldown, usability, range, glow and count.
 */
export async function renderSlot(icon: Buffer | null, name: string, key: string | null, live: LiveView | null = null): Promise<string> {
    const label = keyLabel(key);
    if (icon) {
        const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${overlaySvg(label, live)}</svg>`);
        let image = sharp(icon).resize(SIZE, SIZE, { kernel: "lanczos3" });
        if (live?.unusable) {
            image = image.modulate({ brightness: 0.4 });
        }
        const png = await image.composite([{ input: overlay }]).png().toBuffer();
        return toDataUrl(png);
    }
    const lines = wrap(name || "Unknown", 11, 3);
    const top = 82 - (lines.length - 1) * 10;
    const fill = live?.unusable ? "#777777" : "#ffffff";
    const text = lines
        .map((line, i) => `<text x="72" y="${top + i * 22}" text-anchor="middle" font-family="Arial" font-size="18" fill="${fill}">${escapeXml(line)}</text>`)
        .join("");
    return renderSvg(`<rect width="${SIZE}" height="${SIZE}" rx="10" fill="${BACKGROUND}"/>${text}${overlaySvg(label, live)}`);
}

/** Renders a status tile, e.g. "Empty slot" or "Run /reload". */
export function renderStatus(title: string, detail = ""): Promise<string> {
    const lines = wrap(detail, 14, 3);
    const body = lines
        .map((line, i) => `<text x="72" y="${96 + i * 18}" text-anchor="middle" font-family="Arial" font-size="14" fill="#ffffff">${escapeXml(line)}</text>`)
        .join("");
    return renderSvg(
        `<rect width="${SIZE}" height="${SIZE}" rx="10" fill="${BACKGROUND}"/><text x="72" y="64" text-anchor="middle" font-family="Arial" font-size="18" fill="#f0b35d">${escapeXml(title)}</text>${body}`
    );
}

async function renderSvg(content: string): Promise<string> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${content}</svg>`;
    return toDataUrl(await sharp(Buffer.from(svg)).png().toBuffer());
}
