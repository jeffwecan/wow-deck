// npm run make-pages -- [--scene "<name>"] [--template <page number>] [--character <Name-Realm>] [--dry-run]
//
// Gives a StreamDock scene one page per action bar the WowDeck addon recorded, each laid out like
// the template page (page 1 by default). Existing pages are reused in order and rewritten; extra
// bars get new pages. The scene folder is backed up first. StreamDock must be closed, because it
// rewrites its profile files from memory while running.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_WOW_ROOTS, findExportFiles, newestFile, readExport } from "../deck/export-reader.js";
import { pageForBar, templateBar, WOW_BUTTON, type PageManifest } from "./page-layout.js";

interface SceneManifest {
    Name: string;
    Pages: { Current: string; Pages: string[] };
    [key: string]: unknown;
}

const { values: args } = parseArgs({
    options: {
        "scene": { type: "string" },
        "template": { type: "string", default: "1" },
        "character": { type: "string" },
        "dry-run": { type: "boolean", default: false }
    }
});

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

const STREAMDOCK = path.join(process.env.APPDATA ?? "", "HotSpot", "StreamDock");
const PROFILES = path.join(STREAMDOCK, "profiles");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
// StreamDock writes its manifests with 4-space indentation.
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`);
const pageFile = (scene: string, page: string) => path.join(scene, "profiles", page, "manifest.json");

function streamDockRunning(): boolean {
    try {
        const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
        return /"(VSD Craft|StreamDock)\.exe"/i.test(out);
    }
    catch {
        return false;
    }
}

function newPageId(): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const part = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `${part(8)}-${part(4)}-${part(4)}-${part(4)}-${part(12)}.sdProfile`;
}

// --- The scene: named, or the only one with WoW buttons on its pages -----------------------
const scenes = readdirSync(PROFILES).filter(dir => existsSync(path.join(PROFILES, dir, "manifest.json")));
const wowScenes = scenes.filter((dir) => {
    const scene = readJson<SceneManifest>(path.join(PROFILES, dir, "manifest.json"));
    if (args.scene) {
        return scene.Name === args.scene;
    }
    return (scene.Pages?.Pages ?? []).some((page) => {
        const file = pageFile(path.join(PROFILES, dir), page);
        return existsSync(file) && readFileSync(file, "utf8").includes(WOW_BUTTON);
    });
});
if (wowScenes.length !== 1) {
    const names = wowScenes.map(dir => readJson<SceneManifest>(path.join(PROFILES, dir, "manifest.json")).Name);
    fail(wowScenes.length
        ? `Several scenes have WoW buttons (${names.join(", ")}); pick one with --scene "<name>".`
        : `No scene ${args.scene ? `named "${args.scene}"` : "with WoW buttons"} was found in ${PROFILES}.`);
}
const sceneDir = path.join(PROFILES, wowScenes[0]);
const scene = readJson<SceneManifest>(path.join(sceneDir, "manifest.json"));

// --- The bars the addon recorded -------------------------------------------------------------
const exportFile = newestFile(findExportFiles(DEFAULT_WOW_ROOTS));
const deck = exportFile ? readExport(exportFile.file, args.character) : null;
if (!deck?.bars.length) {
    fail("No WowDeck export with bars was found. Log in with the addon enabled, then /reload.");
}

// --- The template page -----------------------------------------------------------------------
const pages = scene.Pages.Pages;
const templateIndex = Number(args.template) - 1;
if (!Number.isInteger(templateIndex) || templateIndex < 0 || templateIndex >= pages.length) {
    fail(`--template must be a page number from 1 to ${pages.length}.`);
}
const template = readJson<PageManifest>(pageFile(sceneDir, pages[templateIndex]));
let from;
try {
    from = templateBar(template, deck.bars);
}
catch (error) {
    fail(`Page ${templateIndex + 1}: ${(error as Error).message}`);
}

// --- Plan: page n shows bar n, in the order the addon recorded them ---------------------------
console.log(`Scene "${scene.Name}", ${deck.character}'s bars, laid out like page ${templateIndex + 1} (${from.name}):`);
const plan = deck.bars.map((bar, index) => ({ bar, id: pages[index] ?? newPageId(), isNew: index >= pages.length }));
for (const [index, { bar, id, isNew }] of plan.entries()) {
    console.log(`  page ${index + 1}: ${bar.name} (slots ${bar.first}-${bar.first + 11})${isNew ? ", new page" : ""}  ${id}`);
}
for (const [index, id] of pages.slice(plan.length).entries()) {
    console.log(`  page ${plan.length + index + 1}: no bar left for it; left as it is  ${id}`);
}
if (args["dry-run"]) {
    console.log("Dry run: nothing was changed.");
    process.exit(0);
}
if (streamDockRunning()) {
    fail("StreamDock (VSD Craft) is running. Close it first: it rewrites these files from memory and would undo the change.");
}

// --- Back up, then write ----------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(STREAMDOCK, "wow-deck-backups", `${wowScenes[0]}-${stamp}`);
mkdirSync(path.dirname(backup), { recursive: true });
cpSync(sceneDir, backup, { recursive: true });
for (const { bar, id } of plan) {
    mkdirSync(path.join(sceneDir, "profiles", id), { recursive: true });
    writeJson(pageFile(sceneDir, id), pageForBar(template, from, bar));
}
scene.Pages.Pages = [...plan.map(p => p.id), ...pages.slice(plan.length)];
writeJson(path.join(sceneDir, "manifest.json"), scene);
console.log(`Done. Backup of the scene: ${backup}`);
