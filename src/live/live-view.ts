// Turns decoded beacon frames into what each key should show.
import { FLAG, type BeaconFrame } from "./beacon-codec.js";
import { cooldownText, type LiveView } from "../deck/render.js";

const SWEEP_STEPS = 32;

export class LiveTracker {
    private frame: BeaconFrame | null = null;
    /** Longest remaining time seen for each slot's current cooldown, i.e. its duration. */
    private durations = new Map<number, number>();

    /** Records a new frame (or null when live state is unavailable). */
    update(frame: BeaconFrame | null) {
        this.frame = frame;
        if (!frame) {
            this.durations.clear();
            return;
        }
        for (const slot of [...this.durations.keys()]) {
            if (!frame.slots.get(slot)?.remaining) {
                this.durations.delete(slot);
            }
        }
        for (const [slot, state] of frame.slots) {
            const known = this.durations.get(slot) ?? 0;
            if (state.remaining > known) {
                // A cooldown starting, or restarting after a reset: its first value is its length.
                this.durations.set(slot, state.remaining);
            }
        }
    }

    /** The live view for a slot, or null when there is no live state to show. */
    view(slot: number): LiveView | null {
        const state = this.frame?.slots.get(slot);
        if (!state) {
            return null;
        }
        const duration = this.durations.get(slot) ?? state.remaining;
        const share = duration > 0 ? state.remaining / duration : 0;
        const usable = (state.flags & FLAG.usable) !== 0;
        const noMana = (state.flags & FLAG.noMana) !== 0;
        return {
            cooldown: cooldownText(state.remaining),
            sweep: Math.ceil(share * SWEEP_STEPS) / SWEEP_STEPS,
            // Out of mana is shown with a blue tint rather than dimming, as in WoW.
            unusable: !usable && !noMana,
            tint: state.flags & FLAG.outOfRange ? "range" : noMana ? "mana" : null,
            glow: (state.flags & FLAG.glow) !== 0,
            active: (state.flags & FLAG.active) !== 0,
            count: state.count
        };
    }
}
