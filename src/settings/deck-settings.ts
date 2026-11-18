import type { DeckSourceOptions } from "../deck/deck-source.js";

/** Plugin-wide settings (stored as global settings). Both fields are optional overrides. */
export type DeckSettings = DeckSourceOptions;

export function normalizeDeckSettings(value: unknown): DeckSettings {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
        wowFolder: typeof v.wowFolder === "string" ? v.wowFolder.trim().slice(0, 260) : "",
        character: typeof v.character === "string" ? v.character.trim().slice(0, 128) : ""
    };
}
