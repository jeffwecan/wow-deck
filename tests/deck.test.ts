import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { parseSavedVariables } from "../src/deck/lua-table.js";
import { findExportFiles, newestFile, parseExport, type SlotInfo } from "../src/deck/export-reader.js";
import { DeckSource } from "../src/deck/deck-source.js";
import { IconResolver } from "../src/deck/icons.js";
import { keyLabel, renderSlot, renderStatus } from "../src/deck/render.js";
import { availableBars, describeSlot, normalizeAction } from "../src/settings/action-settings.js";
import { normalizeDeckSettings } from "../src/settings/deck-settings.js";
import { parseShortcut } from "../src/input/shortcut.js";

// Shaped like what WoW writes: positional entries carry "-- [n]" comments, keys are bracketed.
const SAVED = String.raw`
WowDeckDB = {
    ["version"] = 1,
    ["lastCharacter"] = "Jeff-Forever",
    ["characters"] = {
        ["Jeff-Forever"] = {
            ["updated"] = 1763485000,
            ["class"] = "MAGE",
            ["bars"] = {
                {
                    ["name"] = "Main bar",
                    ["first"] = 1,
                }, -- [1]
                {
                    ["name"] = "Bottom left bar",
                    ["first"] = 61,
                }, -- [2]
                {
                    ["name"] = "Action bar 7",
                    ["first"] = 157,
                }, -- [3]
            },
            ["slots"] = {
                [160] = {
                    ["kind"] = "spell",
                    ["id"] = 116,
                    ["name"] = "Frostbolt",
                    ["key"] = "SHIFT-F4",
                    ["keySource"] = "binding",
                },
                {
                    ["kind"] = "spell",
                    ["id"] = 133,
                    ["icon"] = 135812,
                    ["name"] = "Fireball",
                    ["key"] = "1",
                    ["keySource"] = "binding",
                }, -- [1]
                [61] = {
                    ["kind"] = "macro",
                    ["id"] = 3,
                    ["name"] = "Poly \"focus\"",
                    ["spellId"] = 118,
                    ["icon"] = 136071,
                    ["macroIcon"] = 134400,
                    ["key"] = "CTRL-ALT-SHIFT-F1",
                    ["keySource"] = "deck",
                },
                [62] = {
                    ["kind"] = "item",
                    ["id"] = 6948,
                },
            },
        },
        ["Alt-Forever"] = {
            ["updated"] = 1763000000,
            ["slots"] = {
            },
        },
    },
}
OtherAddonDB = nil
`;

describe("SavedVariables parsing", () => {
    it("reads WoW's Lua table format, including positional entries and escapes", () => {
        expect(parseSavedVariables(SAVED).OtherAddonDB).toBeNull();
        const exported = parseExport("WowDeck.lua", SAVED)!;
        expect(exported.character).toBe("Jeff-Forever");
        expect(exported.characters).toEqual(["Alt-Forever", "Jeff-Forever"]);
        expect(exported.slots.get(1)).toMatchObject({ name: "Fireball", spellId: 133, key: "1", keySource: "binding" });
        expect(exported.slots.get(61)).toMatchObject({
            name: "Poly \"focus\"", spellId: 118, iconId: 136071, macroIconId: 134400, keySource: "deck"
        });
        expect(exported.slots.get(1)).toMatchObject({ iconId: 135812, macroIconId: null });
        expect(exported.slots.get(62)).toMatchObject({ kind: "item", itemId: 6948, key: null, keySource: null });
        expect(exported.slots.get(160)).toMatchObject({ name: "Frostbolt", key: "SHIFT-F4" });
        expect(exported.bars).toEqual([
            { name: "Main bar", first: 1 },
            { name: "Bottom left bar", first: 61 },
            { name: "Action bar 7", first: 157 }
        ]);
        expect(parseExport("f", SAVED, "Alt-Forever")?.bars).toEqual([]);
    });

    it("selects another character on request, and rejects malformed files", () => {
        expect(parseExport("f", SAVED, "Alt-Forever")?.character).toBe("Alt-Forever");
        expect(parseExport("f", SAVED, "Missing")?.character).toBe("Jeff-Forever");
        expect(parseExport("f", "WowDeckDB = nil")).toBeNull();
        expect(() => parseSavedVariables("WowDeckDB = { [\"a\"] = ")).toThrow();
    });
});

describe("export discovery", () => {
    const roots: string[] = [];
    afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

    function install(root: string, flavor: string, account: string, mtime: number) {
        const dir = path.join(root, flavor, "WTF", "Account", account, "SavedVariables");
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "WowDeck.lua");
        writeFileSync(file, SAVED);
        utimesSync(file, mtime, mtime);
        return file;
    }

    it("finds exports under an install root or a flavor folder and picks the newest", () => {
        const root = mkdtempSync(path.join(tmpdir(), "wowdeck-"));
        roots.push(root);
        const older = install(root, "_classic_", "ACCOUNT1", 1_000_000);
        const newer = install(root, "_forever_", "ACCOUNT2", 2_000_000);
        expect(findExportFiles([root]).sort()).toEqual([older, newer].sort());
        expect(findExportFiles([path.join(root, "_forever_")])).toEqual([newer]);
        expect(newestFile([older, newer])?.file).toBe(newer);
    });

    it("loads the export and notifies when the game writes a new one", () => {
        const root = mkdtempSync(path.join(tmpdir(), "wowdeck-"));
        roots.push(root);
        const source = new DeckSource([root]);
        let changes = 0;
        source.onChange(() => changes++);
        source.poll();
        expect(source.export).toBeNull();
        expect(source.status).toMatch(/not found/);

        const file = install(root, "_forever_", "ACCOUNT", 1_000_000);
        source.rescan();
        expect(source.export?.character).toBe("Jeff-Forever");
        source.poll();
        expect(changes).toBe(2); // not found, then loaded; an unchanged file isn't reloaded

        writeFileSync(file, SAVED.replace("Fireball", "Frostbolt"));
        utimesSync(file, 1_000_100, 1_000_100);
        source.poll();
        expect(source.export?.slots.get(1)?.name).toBe("Frostbolt");
        expect(changes).toBe(3);
    });
});

describe("settings", () => {
    it("keeps valid slots and drops retired capture settings", () => {
        expect(normalizeAction({ slot: 61, shortcut: "F1", position: "2-3", live: false })).toEqual({ slot: 61, shortcut: "F1" });
        expect(normalizeAction({ slot: 168 }).slot).toBe(168);
        expect(normalizeAction({ slot: 181 }).slot).toBe(0);
        expect(normalizeAction({ slot: "7" }).slot).toBe(7);
        expect(normalizeDeckSettings({ wowFolder: "  D:\\WoW  ", windowProcess: "x" })).toEqual({
            wowFolder: "D:\\WoW", character: "", live: true, liveInterval: 200
        });
        expect(normalizeDeckSettings({ live: false, liveInterval: 100 })).toMatchObject({ live: false, liveInterval: 100 });
        expect(normalizeDeckSettings({ liveInterval: 7 }).liveInterval).toBe(200);
        expect(describeSlot(63)).toBe("Bottom left bar, button 3");
        expect(describeSlot(0)).toBe("No slot chosen");
    });

    it("offers the bars the addon found plus the paged bars, labelled by range", () => {
        const exported = [
            { name: "Main bar", first: 1 },
            { name: "Bottom left bar", first: 61 },
            { name: "Action bar 7", first: 157 }
        ];
        const bars = availableBars(exported);
        expect(bars.map(b => b.first)).toEqual([1, 61, 157, 13, 73, 85, 97, 109]);
        expect(describeSlot(160, bars)).toBe("Action bar 7, button 4");
        expect(describeSlot(160)).toBe("Slot 160"); // not a bar in the static fallback
        expect(availableBars([])).toEqual(availableBars(undefined));
        expect(availableBars(undefined).map(b => b.first)).toContain(25);
    });
});

describe("shortcuts", () => {
    it("parses inspector spellings and WoW binding strings", () => {
        expect(parseShortcut("Shift+1")?.keys).toEqual([0x10, 0x31]);
        expect(parseShortcut("Ctrl-Alt-Shift-F1")?.keys).toEqual([0x11, 0x12, 0x10, 0x70]);
        expect(parseShortcut("Ctrl--")?.keys).toEqual([0x11, 0xbd]);
        expect(parseShortcut("SHIFT-F6")?.keys).toEqual([0x10, 0x75]);
        expect(parseShortcut("CTRL-ALT-NUMPAD3")?.keys).toEqual([0x11, 0x12, 0x63]);
        expect(parseShortcut("F13")?.keys).toEqual([0x7c]);
        expect(parseShortcut("ALT-PAGEDOWN")?.keys).toEqual([0x12, 0x22]);
        expect(parseShortcut("SHIFT-;")?.keys).toEqual([0x10, 0xba]);
        expect(parseShortcut("BUTTON4")).toBeNull();
        expect(parseShortcut("Ctrl+Ctrl+1")).toBeNull();
    });
});

describe("key images", () => {
    it("abbreviates keybinds like WoW", () => {
        expect(keyLabel("CTRL-SHIFT-F7")).toBe("cs-F7");
        expect(keyLabel("NUMPAD3")).toBe("N3");
        expect(keyLabel("SHIFT-F6")).toBe("s-F6");
        expect(keyLabel(null)).toBe("");
    });

    it("renders 144px keys with and without an icon", async () => {
        const icon = await sharp({ create: { width: 56, height: 56, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
        const urls = [
            await renderSlot(icon, "Fireball", "SHIFT-F6"),
            await renderSlot(null, "A Very Long Spell Name Indeed", null),
            await renderStatus("Empty", "Slot 3")
        ];
        for (const url of urls) {
            const meta = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
            expect([meta.format, meta.width, meta.height]).toEqual(["png", 144, 144]);
        }
    });
});

describe("icon resolver", () => {
    const base: SlotInfo = {
        slot: 1, kind: "spell", id: 0, name: "", spellId: null, itemId: null,
        iconId: null, macroIconId: null, key: null, keySource: null
    };

    // Fake Wowhead: the Forever database knows spell 1328618 and item 280740, retail knows spell
    // 133, icon page 132090 redirects to its name, and every icon image exists except "missing".
    function fakeWowhead(calls: string[]) {
        return async (url: string) => {
            calls.push(url);
            const json = (body: unknown, ok = true) => ({
                ok, status: ok ? 200 : 404, headers: { get: () => null },
                json: async () => body, arrayBuffer: async () => new ArrayBuffer(0)
            });
            const known: Record<string, string> = {
                "https://nether.wowhead.com/forever/tooltip/spell/1328618": "ability_druid_ferociousbite",
                "https://nether.wowhead.com/forever/tooltip/item/280740": "ability_skyreach_four_wind",
                "https://nether.wowhead.com/tooltip/spell/133": "spell_fire_flamebolt"
            };
            if (url.includes("/tooltip/")) {
                return known[url] ? json({ icon: known[url] }) : json({ error: "Entity not found" }, false);
            }
            if (url.startsWith("https://www.wowhead.com/")) {
                const id = url.split("=")[1];
                const forever = url.includes("/forever/");
                // 132090 is known to both databases; 7749904 (a Forever mount) only to Forever.
                const location = id === "132090"
                    ? `${forever ? "/forever" : ""}/icon=132090/ability-backstab`
                    : id === "7749904" && forever
                        ? "/forever/icon=7749904/inv-catskybornemount-c60-blue"
                        : `/icons?notFound=${id}`;
                return { ...json(null, false), status: 301, headers: { get: () => location } };
            }
            const ok = !url.includes("missing");
            return { ...json(null, ok), arrayBuffer: async () => new TextEncoder().encode(url.split("/").pop()).buffer };
        };
    }
    const text = (image: Buffer | null) => (image ? image.toString() : null);

    it("asks the WoW: Forever database first, then retail", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "wowdeck-icons-"));
        const calls: string[] = [];
        try {
            const resolver = new IconResolver(dir, fakeWowhead(calls));
            expect(text(await resolver.get({ ...base, spellId: 1328618 }))).toBe("ability_druid_ferociousbite.jpg");
            expect(calls[0]).toBe("https://nether.wowhead.com/forever/tooltip/spell/1328618");
            expect(text(await resolver.get({ ...base, kind: "item", itemId: 280740 }))).toBe("ability_skyreach_four_wind.jpg");

            calls.length = 0;
            expect(text(await resolver.get({ ...base, spellId: 133 }))).toBe("spell_fire_flamebolt.jpg");
            expect(calls.slice(0, 2)).toEqual([
                "https://nether.wowhead.com/forever/tooltip/spell/133",
                "https://nether.wowhead.com/tooltip/spell/133"
            ]);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("mirrors a macro's displayed icon by its file ID, and caches it on disk", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "wowdeck-icons-"));
        const calls: string[] = [];
        try {
            const macro = { ...base, kind: "macro", spellId: 133, iconId: 132090, macroIconId: 132090 };
            const resolver = new IconResolver(dir, fakeWowhead(calls));
            // The displayed icon wins over the macro's spell.
            expect(text(await resolver.get(macro))).toBe("ability_backstab.jpg");
            expect(calls).toEqual([
                "https://www.wowhead.com/forever/icon=132090",
                "https://wow.zamimg.com/images/wow/icons/large/ability_backstab.jpg"
            ]);
            // A new resolver (plugin restart) reads the disk cache without any request.
            expect(text(await new IconResolver(dir, fakeWowhead(calls)).get(macro))).toBe("ability_backstab.jpg");
            expect(calls).toHaveLength(2);
            // Mounts, pets and plain macros only have a file ID; Forever-only icons resolve too.
            expect(text(await resolver.get({ ...base, kind: "summonmount", iconId: 7749904 }))).toBe(
                "inv_catskybornemount_c60_blue.jpg"
            );
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to the next source, and backs off after a failure", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "wowdeck-icons-"));
        const calls: string[] = [];
        try {
            const resolver = new IconResolver(dir, fakeWowhead(calls));
            // Unknown spell: falls back to the displayed icon's file ID.
            expect(text(await resolver.get({ ...base, spellId: 999, iconId: 132090 }))).toBe("ability_backstab.jpg");

            const unknown = { ...base, kind: "item", itemId: 5 };
            expect(await resolver.get(unknown)).toBeNull();
            const count = calls.length;
            expect(await resolver.get(unknown)).toBeNull();
            expect(calls).toHaveLength(count); // a failed lookup isn't retried straight away
            expect(await resolver.get(base)).toBeNull();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
