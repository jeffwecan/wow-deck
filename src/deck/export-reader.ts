// Finds and reads the WowDeck addon's export (WTF/Account/<account>/SavedVariables/WowDeck.lua).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isLuaTable, parseSavedVariables, type LuaTable, type LuaValue } from "./lua-table.js";
import type { Bar } from "../settings/action-settings.js";

export interface SlotInfo {
    slot: number;
    kind: string;
    id: number | null;
    name: string;
    /** Spell whose icon represents the slot (spells, and macros that resolve to a spell). */
    spellId: number | null;
    /** Item whose icon represents the slot (items, and macros that resolve to an item). */
    itemId: number | null;
    /** Texture file ID the game shows on the button (mirrors macro, mount and pet icons). */
    iconId: number | null;
    /** For macros: the icon chosen in the macro UI (the question mark means "dynamic"). */
    macroIconId: number | null;
    /** WoW binding string, e.g. "SHIFT-F6", or null when the slot has no key. */
    key: string | null;
    keySource: "binding" | "deck" | null;
}

export interface DeckExport {
    file: string;
    character: string;
    /** Every character the addon has exported on this account. */
    characters: string[];
    updated: number;
    /** Bars as the addon found them in this client's UI (empty for exports before version 2). */
    bars: Bar[];
    slots: Map<number, SlotInfo>;
}

/** Default install locations; each holds one folder per game flavor (_retail_, _classic_, ...). */
export const DEFAULT_WOW_ROOTS = [
    "C:\\Program Files (x86)\\World of Warcraft",
    "C:\\Program Files\\World of Warcraft",
    "D:\\World of Warcraft",
    "D:\\Games\\World of Warcraft",
    "C:\\Games\\World of Warcraft"
];

function listDirs(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    }
    catch {
        return [];
    }
}

/**
 * Lists every WowDeck.lua below the given folders. A folder may be a WoW install root, a flavor
 * folder (e.g. `_retail_`) or a WTF folder.
 */
export function findExportFiles(folders: string[]): string[] {
    const files = new Set<string>();
    const accountDirs = (wtf: string) => listDirs(path.join(wtf, "Account"));
    for (const folder of folders) {
        const wtfFolders = [
            path.basename(folder).toLowerCase() === "wtf" ? folder : path.join(folder, "WTF"),
            ...listDirs(folder).map(flavor => path.join(flavor, "WTF"))
        ];
        for (const wtf of wtfFolders) {
            for (const account of accountDirs(wtf)) {
                const file = path.join(account, "SavedVariables", "WowDeck.lua");
                try {
                    if (statSync(file).isFile()) {
                        files.add(file);
                    }
                }
                catch {
                    // not exported for this account
                }
            }
        }
    }
    return [...files];
}

/** Picks the most recently written export file. */
export function newestFile(files: string[]): { file: string; mtimeMs: number } | null {
    let best: { file: string; mtimeMs: number } | null = null;
    for (const file of files) {
        try {
            const mtimeMs = statSync(file).mtimeMs;
            if (!best || mtimeMs > best.mtimeMs) {
                best = { file, mtimeMs };
            }
        }
        catch {
            // vanished between listing and stat
        }
    }
    return best;
}

const num = (v: LuaValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: LuaValue | undefined) => (typeof v === "string" ? v : null);

function toSlot(slot: number, entry: LuaTable): SlotInfo {
    const kind = str(entry.kind) ?? "unknown";
    const id = num(entry.id);
    const keySource = str(entry.keySource);
    return {
        slot,
        kind,
        id,
        name: str(entry.name) ?? "",
        spellId: kind === "spell" ? id : num(entry.spellId),
        itemId: kind === "item" ? id : num(entry.itemId),
        iconId: num(entry.icon),
        macroIconId: num(entry.macroIcon),
        key: str(entry.key),
        keySource: keySource === "binding" || keySource === "deck" ? keySource : null
    };
}

/** Parses an export file's text; `character` picks a character, defaulting to the last one played. */
export function parseExport(file: string, text: string, character?: string): DeckExport | null {
    const db = parseSavedVariables(text).WowDeckDB;
    if (!isLuaTable(db) || !isLuaTable(db.characters)) {
        return null;
    }
    const name = character && isLuaTable(db.characters[character]) ? character : str(db.lastCharacter);
    const data = name ? db.characters[name] : undefined;
    if (!name || !isLuaTable(data)) {
        return null;
    }
    const slots = new Map<number, SlotInfo>();
    if (isLuaTable(data.slots)) {
        for (const [key, entry] of Object.entries(data.slots)) {
            const slot = Number(key);
            if (Number.isInteger(slot) && slot > 0 && isLuaTable(entry)) {
                slots.set(slot, toSlot(slot, entry));
            }
        }
    }
    const bars: Bar[] = [];
    if (isLuaTable(data.bars)) {
        for (const entry of Object.values(data.bars)) {
            const first = isLuaTable(entry) ? num(entry.first) : null;
            if (isLuaTable(entry) && first && first > 0) {
                bars.push({ name: str(entry.name) ?? `Slots ${first}-${first + 11}`, first });
            }
        }
    }
    const all = db.characters;
    const characters = Object.keys(all).filter(key => isLuaTable(all[key])).sort();
    return { file, character: name, characters, updated: num(data.updated) ?? 0, bars, slots };
}

export function readExport(file: string, character?: string): DeckExport | null {
    return parseExport(file, readFileSync(file, "utf8"), character);
}
