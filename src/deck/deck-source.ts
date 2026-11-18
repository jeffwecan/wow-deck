// Keeps the latest WowDeck export loaded and notifies listeners when the game writes a new one.
import { DEFAULT_WOW_ROOTS, findExportFiles, newestFile, readExport, type DeckExport } from "./export-reader.js";

export interface DeckSourceOptions {
    /** Optional WoW folder (install root, flavor folder or WTF folder); empty to auto-detect. */
    wowFolder: string;
    /** Optional character ("Name-Realm"); empty for the last character played. */
    character: string;
}

const POLL_MS = 2000;
const RESCAN_MS = 30_000;

export class DeckSource {
    private options: DeckSourceOptions = { wowFolder: "", character: "" };
    private files: string[] = [];
    private scannedAt = 0;
    private loadedKey = "";
    private current: DeckExport | null = null;
    private statusText = "Looking for the WowDeck addon export…";
    private timer: ReturnType<typeof setInterval> | null = null;
    private listeners = new Set<() => void>();

    constructor(private readonly defaultRoots = DEFAULT_WOW_ROOTS) {}

    get export() {
        return this.current;
    }

    get status() {
        return this.statusText;
    }

    onChange(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    configure(options: DeckSourceOptions) {
        if (options.wowFolder === this.options.wowFolder && options.character === this.options.character) {
            return;
        }
        this.options = { ...options };
        this.scannedAt = 0;
        this.loadedKey = "";
        this.poll();
    }

    start() {
        if (!this.timer) {
            this.timer = setInterval(() => this.poll(), POLL_MS);
            this.timer.unref?.();
        }
        this.poll();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Forces a folder rescan and reload, e.g. when the user asks to refresh. */
    rescan() {
        this.scannedAt = 0;
        this.loadedKey = "";
        this.poll();
    }

    poll() {
        const now = Date.now();
        if (!this.files.length || now - this.scannedAt > RESCAN_MS) {
            const folders = this.options.wowFolder ? [this.options.wowFolder] : this.defaultRoots;
            this.files = findExportFiles(folders);
            this.scannedAt = now;
        }
        const newest = newestFile(this.files);
        if (!newest) {
            this.update(null, "WowDeck addon export not found. Install the addon, log in and type /reload.", "none");
            return;
        }
        const key = `${newest.file}|${newest.mtimeMs}|${this.options.character}`;
        if (key === this.loadedKey) {
            return;
        }
        try {
            const data = readExport(newest.file, this.options.character || undefined);
            this.update(
                data,
                data ? `Using ${data.character}` : "The WowDeck export has no characters yet. Log in and type /reload.",
                key
            );
        }
        catch (error) {
            // The game may be mid-write; keep the previous export and retry on the next poll.
            this.statusText = `Could not read the WowDeck export: ${String(error).slice(0, 120)}`;
        }
    }

    private update(data: DeckExport | null, status: string, key: string) {
        if (key === this.loadedKey) {
            return;
        }
        this.loadedKey = key;
        this.current = data;
        this.statusText = status;
        for (const listener of this.listeners) {
            listener();
        }
    }
}
