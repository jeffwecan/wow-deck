import type { DeckSourceOptions } from "../deck/deck-source.js";

export const LIVE_INTERVALS = [100, 150, 200, 250, 500, 1000] as const;

/** Plugin-wide settings (stored as global settings). */
export interface DeckSettings extends DeckSourceOptions {
    /** Show live cooldowns, usability and range read from the addon's beacon. */
    live: boolean;
    /** How often the beacon is read, in milliseconds. */
    liveInterval: number;
}

export function normalizeDeckSettings(value: unknown): DeckSettings {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const interval = Number(v.liveInterval);
    return {
        wowFolder: typeof v.wowFolder === "string" ? v.wowFolder.trim().slice(0, 260) : "",
        character: typeof v.character === "string" ? v.character.trim().slice(0, 128) : "",
        live: typeof v.live === "boolean" ? v.live : true,
        liveInterval: (LIVE_INTERVALS as readonly number[]).includes(interval) ? interval : 200
    };
}
