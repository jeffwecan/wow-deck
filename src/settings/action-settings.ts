export interface ActionSettings {
    [key: string]: string | number;
    /** WoW action slot (1-180) mirrored by this button; 0 when not chosen yet. */
    slot: number;
    /** Optional manual key, overriding the key the addon exported for the slot. */
    shortcut: string;
}

/** Highest action slot WoW uses (bars 6-8 live above the classic 1-120 range). */
export const MAX_SLOT = 180;

export const DEFAULT_ACTION: ActionSettings = {
    slot: 0,
    shortcut: ""
};

export function normalizeAction(value: unknown): ActionSettings {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const slot = Number(v.slot);
    return {
        slot: Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOT ? slot : 0,
        shortcut: typeof v.shortcut === "string" ? v.shortcut.slice(0, 64) : ""
    };
}

export interface Bar {
    name: string;
    /** Action slot of the bar's first button; buttons 1-12 are first..first+11. */
    first: number;
}

/** Bars every client numbers the same way; used when the export doesn't list its bars. */
export const BARS: readonly Bar[] = [
    { name: "Main bar", first: 1 },
    { name: "Main bar, page 2", first: 13 },
    { name: "Right bar", first: 25 },
    { name: "Right bar 2", first: 37 },
    { name: "Bottom right bar", first: 49 },
    { name: "Bottom left bar", first: 61 },
    { name: "Stance/form bar 1", first: 73 },
    { name: "Stance/form bar 2", first: 85 },
    { name: "Stance/form bar 3", first: 97 },
    { name: "Stance/form bar 4", first: 109 }
];

/** Bars with no button frame of their own, so the addon can't list them. */
const PAGED_BARS = BARS.filter(bar => bar.first === 13 || bar.first >= 73);

/**
 * The bars to offer: the ones the addon read from the game's bar frames (which knows where this
 * client puts bars 6-8), plus main bar page 2 and the stance/form bars.
 */
export function availableBars(exported: readonly Bar[] | undefined): Bar[] {
    if (!exported?.length) {
        return [...BARS];
    }
    const bars = [...exported];
    for (const paged of PAGED_BARS) {
        if (!bars.some(bar => paged.first >= bar.first && paged.first < bar.first + 12)) {
            bars.push(paged);
        }
    }
    return bars;
}

/** "Bottom left bar, button 3" for slot 63. */
export function describeSlot(slot: number, bars: readonly Bar[] = BARS): string {
    const bar = bars.find(b => slot >= b.first && slot < b.first + 12);
    if (bar) {
        return `${bar.name}, button ${slot - bar.first + 1}`;
    }
    return slot ? `Slot ${slot}` : "No slot chosen";
}
