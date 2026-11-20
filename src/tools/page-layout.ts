// Builds StreamDock pages for WoW action bars by repeating one template page's layout.
import type { Bar } from "../settings/action-settings.js";

export const WOW_BUTTON = "com.wow-deck.button";

export interface PageAction {
    UUID: string;
    Settings?: Record<string, unknown>;
    [key: string]: unknown;
}

/** A page's manifest.json: its keys by "column,row", plus device fields that are kept as-is. */
export interface PageManifest {
    Actions: Record<string, PageAction>;
    [key: string]: unknown;
}

function slotOf(action: PageAction): number {
    const slot = Number(action.Settings?.slot);
    return action.UUID === WOW_BUTTON && Number.isInteger(slot) && slot > 0 ? slot : 0;
}

/** The bar that holds every WoW button on the template page. */
export function templateBar(page: PageManifest, bars: readonly Bar[]): Bar {
    const slots = Object.values(page.Actions).map(slotOf).filter(slot => slot > 0);
    if (!slots.length) {
        throw new Error("The template page has no WoW buttons with a slot.");
    }
    const bar = bars.find(b => slots.every(slot => slot >= b.first && slot < b.first + 12));
    if (!bar) {
        throw new Error(`The template page's slots (${slots.sort((a, b) => a - b).join(", ")}) aren't all on one bar.`);
    }
    return bar;
}

/** A copy of the template page with each WoW button moved from button n of `from` to button n of `to`. */
export function pageForBar(template: PageManifest, from: Bar, to: Bar): PageManifest {
    const page = structuredClone(template);
    for (const action of Object.values(page.Actions)) {
        const slot = slotOf(action);
        if (slot) {
            action.Settings = { ...action.Settings, slot: to.first + (slot - from.first) };
        }
    }
    return page;
}
