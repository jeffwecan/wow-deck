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

function keybindSvg(label: string) {
    if (!label) {
        return "";
    }
    const size = label.length > 6 ? 22 : 28;
    return `<text x="${SIZE - 8}" y="${size + 4}" text-anchor="end" font-family="Arial" font-weight="bold" font-size="${size}" fill="#ffffff" stroke="#000000" stroke-width="5" paint-order="stroke">${escapeXml(label)}</text>`;
}

const toDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/** Renders a slot: icon (when available) plus its keybind; falls back to the slot's name. */
export async function renderSlot(icon: Buffer | null, name: string, key: string | null): Promise<string> {
    const label = keyLabel(key);
    if (icon) {
        const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${keybindSvg(label)}</svg>`);
        const png = await sharp(icon)
            .resize(SIZE, SIZE, { kernel: "lanczos3" })
            .composite([{ input: overlay }])
            .png()
            .toBuffer();
        return toDataUrl(png);
    }
    const lines = wrap(name || "Unknown", 11, 3);
    const top = 82 - (lines.length - 1) * 10;
    const text = lines
        .map((line, i) => `<text x="72" y="${top + i * 22}" text-anchor="middle" font-family="Arial" font-size="18" fill="#ffffff">${escapeXml(line)}</text>`)
        .join("");
    return renderSvg(`<rect width="${SIZE}" height="${SIZE}" rx="10" fill="${BACKGROUND}"/>${text}${keybindSvg(label)}`);
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
