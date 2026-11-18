export interface Shortcut {
    keys: number[];
    label: string;
}

// Windows virtual-key codes for the key names WoW uses in bindings ("SHIFT-F6", "CTRL-NUMPAD3", ...)
// and the friendlier spellings accepted in the inspector ("Ctrl+Shift+F6").
const named: Record<string, number> = {
    "SPACE": 0x20,
    "ENTER": 0x0d,
    "TAB": 0x09,
    "ESC": 0x1b,
    "ESCAPE": 0x1b,
    "BACKSPACE": 0x08,
    "INSERT": 0x2d,
    "DELETE": 0x2e,
    "HOME": 0x24,
    "END": 0x23,
    "PAGEUP": 0x21,
    "PAGEDOWN": 0x22,
    "UP": 0x26,
    "DOWN": 0x28,
    "LEFT": 0x25,
    "RIGHT": 0x27,
    "NUMPADMULTIPLY": 0x6a,
    "NUMPADPLUS": 0x6b,
    "NUMPADMINUS": 0x6d,
    "NUMPADDECIMAL": 0x6e,
    "NUMPADDIVIDE": 0x6f,
    "-": 0xbd,
    "=": 0xbb,
    "`": 0xc0,
    "[": 0xdb,
    "]": 0xdd,
    "\\": 0xdc,
    ";": 0xba,
    "'": 0xde,
    ",": 0xbc,
    ".": 0xbe,
    "/": 0xbf
};

export function parseShortcut(text: string): Shortcut | null {
    let remaining = text.trim().toUpperCase();
    const parts: string[] = [];
    while (true) {
        const prefix = /^(CTRL|CONTROL|ALT|SHIFT)\s*[+-]\s*/.exec(remaining);
        if (!prefix) {
            break;
        }
        parts.push(prefix[1] === "CONTROL" ? "CTRL" : prefix[1]);
        remaining = remaining.slice(prefix[0].length);
    }
    const main = remaining.trim();
    let vk = named[main];
    if (/^[A-Z0-9]$/.test(main)) {
        vk = main.charCodeAt(0);
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(main)) {
        vk = 0x6f + Number(main.slice(1));
    }
    if (/^NUMPAD[0-9]$/.test(main)) {
        vk = 0x60 + Number(main.slice(6));
    }
    if (vk === undefined) {
        return null;
    }
    const mods = new Set(parts);
    if (mods.size !== parts.length) {
        return null;
    }
    const keys = [mods.has("CTRL") ? 0x11 : 0, mods.has("ALT") ? 0x12 : 0, mods.has("SHIFT") ? 0x10 : 0, vk].filter(
        Boolean
    );
    return { keys, label: text.trim() };
}
