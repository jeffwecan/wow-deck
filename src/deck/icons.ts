// Resolves the image for a slot's icon.
//
// The game only exposes icons as numeric texture file IDs, so the plugin asks Wowhead for the
// icon's name and downloads that icon once from Wowhead's image CDN:
//   * spells and items: the tooltip endpoint, using the WoW: Forever database first (it knows
//     Forever's own spell/item IDs), then retail;
//   * anything else (plain macros, mounts, pets) and as a fallback: the texture file ID the game
//     is showing, via Wowhead's icon page, which redirects to a URL containing the icon's name.
// Images are cached on disk. Only spell, item and icon IDs are sent.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SlotInfo } from "./export-reader.js";

interface FetchResponse {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}
type Fetch = (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" | "manual" }
) => Promise<FetchResponse>;

const TOOLTIP_URL = "https://nether.wowhead.com";
/** Wowhead databases to ask, in order ("" is retail). */
const DATABASES = ["forever", ""];
const ICON_PAGE_URL = "https://www.wowhead.com";
const ICON_URL = "https://wow.zamimg.com/images/wow/icons/large";
const RETRY_FAILED_MS = 10 * 60_000;
const TIMEOUT_MS = 8000;
const HEADERS = { "User-Agent": "wow-deck-icon-resolver" };
const ICON_NAME = /^[a-z0-9_-]+$/i;

type Source = `spell-${number}` | `item-${number}` | `file-${number}`;

/** Where to look for a slot's icon, best first. */
export function iconSources(slot: SlotInfo): Source[] {
    const spell = slot.spellId ? [`spell-${slot.spellId}` as const] : [];
    const item = slot.itemId ? [`item-${slot.itemId}` as const] : [];
    const file = slot.iconId ? [`file-${slot.iconId}` as const] : [];
    // A macro shows whatever icon the game displays for it (its chosen icon, or its spell's).
    return slot.kind === "macro" ? [...file, ...spell, ...item] : [...spell, ...item, ...file];
}

export class IconResolver {
    private pending = new Map<Source, Promise<Buffer | null>>();
    private failedAt = new Map<Source, number>();

    constructor(
        private readonly cacheDir: string,
        private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch
    ) {}

    /** Returns the slot's icon as JPEG bytes, or null when no source has one. */
    async get(slot: SlotInfo): Promise<Buffer | null> {
        for (const source of iconSources(slot)) {
            const image = await this.fromSource(source);
            if (image) {
                return image;
            }
        }
        return null;
    }

    private fromSource(source: Source): Promise<Buffer | null> {
        const failed = this.failedAt.get(source);
        if (failed !== undefined && Date.now() - failed < RETRY_FAILED_MS) {
            return Promise.resolve(null);
        }
        let request = this.pending.get(source);
        if (!request) {
            request = this.load(source).finally(() => this.pending.delete(source));
            this.pending.set(source, request);
        }
        return request;
    }

    private async load(source: Source): Promise<Buffer | null> {
        const file = path.join(this.cacheDir, `${source}.jpg`);
        try {
            return await readFile(file);
        }
        catch {
            // not cached yet
        }
        try {
            const [type, id] = source.split("-");
            const names = type === "file" ? await this.namesForFile(id) : await this.namesForEntity(type, id);
            const image = await this.download(names);
            await mkdir(this.cacheDir, { recursive: true });
            await writeFile(file, image);
            this.failedAt.delete(source);
            return image;
        }
        catch {
            this.failedAt.set(source, Date.now());
            return null;
        }
    }

    private async namesForEntity(type: string, id: string): Promise<string[]> {
        for (const database of DATABASES) {
            const base = database ? `${TOOLTIP_URL}/${database}/tooltip` : `${TOOLTIP_URL}/tooltip`;
            const response = await this.request(`${base}/${type}/${id}`);
            if (!response.ok) {
                continue;
            }
            const info = await response.json();
            const icon = typeof info === "object" && info !== null ? (info as { icon?: unknown }).icon : undefined;
            if (typeof icon === "string" && ICON_NAME.test(icon)) {
                return [icon.toLowerCase()];
            }
        }
        throw new Error(`no icon for ${type} ${id}`);
    }

    /**
     * Wowhead's icon page redirects /icon=135812 to /icon=135812/spell-fire-flamebolt (or to
     * /icons?notFound=… when that database doesn't have it; Forever-only icons are only known to
     * the Forever database).
     */
    private async namesForFile(id: string): Promise<string[]> {
        for (const database of DATABASES) {
            const page = database ? `${ICON_PAGE_URL}/${database}/icon=${id}` : `${ICON_PAGE_URL}/icon=${id}`;
            const response = await this.request(page, "manual");
            const slug = /\/icon=\d+\/([a-z0-9_-]+)/i.exec(response.headers.get("location") ?? "")?.[1]?.toLowerCase();
            if (slug) {
                // The slug swaps underscores for hyphens; real icon names almost always use underscores.
                const underscored = slug.replace(/-/g, "_");
                return underscored === slug ? [slug] : [underscored, slug];
            }
        }
        throw new Error(`no icon name for file ${id}`);
    }

    private async download(names: string[]): Promise<Buffer> {
        for (const name of names) {
            const response = await this.request(`${ICON_URL}/${name}.jpg`);
            if (response.ok) {
                return Buffer.from(await response.arrayBuffer());
            }
        }
        throw new Error(`no image for ${names.join(", ")}`);
    }

    private request(url: string, redirect: "follow" | "manual" = "follow") {
        return this.fetchImpl(url, { headers: HEADERS, redirect, signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
}
