import streamDeck, {
    action,
    SingletonAction,
    type KeyAction,
    type KeyDownEvent,
    type KeyUpEvent,
    type SendToPluginEvent,
    type DidReceiveSettingsEvent,
    type WillAppearEvent,
    type WillDisappearEvent
} from "@elgato/streamdeck";
import path from "node:path";
import { DeckSource } from "../deck/deck-source.js";
import { IconResolver } from "../deck/icons.js";
import { renderSlot, renderStatus } from "../deck/render.js";
import { parseShortcut } from "../input/shortcut.js";
import { KeyboardManager } from "../input/keyboard-manager.js";
import { BeaconReader } from "../live/beacon-reader.js";
import { LiveTracker } from "../live/live-view.js";
import { windowCapture } from "../live/wow-window.js";
import { availableBars, describeSlot, normalizeAction, type ActionSettings } from "../settings/action-settings.js";

const UUID = "com.wow-deck.button";
export const deck = new DeckSource();
export const keyboard = new KeyboardManager();
export const beacon = new BeaconReader(windowCapture());
const icons = new IconResolver(path.join(process.cwd(), "cache", "icons"));

@action({ UUID })
export class WowAction extends SingletonAction<ActionSettings> {
    private settings = new Map<string, ActionSettings>();
    private lastImage = new Map<string, string>();
    /** What each key last drew, so live updates only redraw keys whose picture changed. */
    private drawn = new Map<string, string>();
    private renders = new Map<string, number>();
    private live = new LiveTracker();
    private liveEnabled = true;

    constructor() {
        super();
        deck.onChange(() => {
            this.renderAll();
            this.sendInspector();
        });
        let lastStatus = beacon.status;
        beacon.onFrame((frame) => {
            this.live.update(frame);
            this.renderAll();
            if (beacon.status !== lastStatus) {
                lastStatus = beacon.status;
                this.sendInspector();
            }
        });
    }

    setLiveEnabled(enabled: boolean) {
        this.liveEnabled = enabled;
        if (!enabled) {
            this.live.update(null);
        }
        this.updateDemand();
        this.renderAll();
    }

    /** Capture only runs while live state is on and some key shows a slot. */
    private updateDemand() {
        const wanted = this.liveEnabled && [...this.settings.values()].some(s => s.slot > 0);
        beacon.setDemand(wanted);
    }

    /** The key a button presses: its manual shortcut, else the key the addon exported for its slot. */
    private keyFor(settings: ActionSettings): string | null {
        if (settings.shortcut) {
            return settings.shortcut;
        }
        return deck.export?.slots.get(settings.slot)?.key ?? null;
    }

    private renderAll() {
        for (const key of this.actions) {
            if (key.isKey()) {
                void this.render(key);
            }
        }
    }

    private async render(key: KeyAction<ActionSettings>) {
        const token = (this.renders.get(key.id) ?? 0) + 1;
        this.renders.set(key.id, token);
        const settings = this.settings.get(key.id) ?? normalizeAction(null);
        const data = deck.export;
        const slot = settings.slot && data ? data.slots.get(settings.slot) : undefined;
        let image: string;
        let signature: string;
        try {
            if (!settings.slot || !data || !slot) {
                signature = JSON.stringify(["status", settings.slot, !!data]);
                if (this.drawn.get(key.id) === signature) {
                    return;
                }
                image = !settings.slot
                    ? await renderStatus("WoW", "Choose a slot")
                    : !data
                        ? await renderStatus("WoW", "Install addon, then /reload")
                        : await renderStatus("Empty", `Slot ${settings.slot}`);
            }
            else {
                const icon = await icons.get(slot);
                const view = this.liveEnabled ? this.live.view(settings.slot) : null;
                const pressKey = this.keyFor(settings);
                signature = JSON.stringify([settings.slot, slot.name, slot.iconId, !!icon, pressKey, view]);
                if (this.drawn.get(key.id) === signature) {
                    return;
                }
                image = await renderSlot(icon, slot.name, pressKey, view);
            }
        }
        catch (error) {
            streamDeck.logger.warn("Could not render key", error);
            return;
        }
        // A newer render for this key started while we waited for the icon; it draws instead.
        // `drawn` is only recorded here, once an image is really sent: recording it before the
        // await let that newer render skip as "unchanged" while this one was dropped, leaving
        // the key on its default image.
        if (this.renders.get(key.id) !== token) {
            return;
        }
        this.drawn.set(key.id, signature);
        if (this.lastImage.get(key.id) === image) {
            return;
        }
        this.lastImage.set(key.id, image);
        try {
            await key.setImage(image);
        }
        catch (error) {
            this.forget(key.id);
            streamDeck.logger.warn("Could not set key image", error);
        }
    }

    private forget(id: string) {
        this.lastImage.delete(id);
        this.drawn.delete(id);
        this.renders.delete(id);
    }

    private sendInspector() {
        const id = streamDeck.ui.action?.id;
        if (!id) {
            return;
        }
        const settings = this.settings.get(id) ?? normalizeAction(null);
        const data = deck.export;
        const slot = data?.slots.get(settings.slot);
        const key = this.keyFor(settings);
        const bars = availableBars(data?.bars);
        void streamDeck.ui.sendToPropertyInspector({
            type: "state",
            status: deck.status,
            liveStatus: this.liveEnabled ? beacon.status : "Live state off",
            character: data?.character ?? "",
            characters: data?.characters ?? [],
            updated: data?.updated ?? 0,
            bars: bars.map(bar => ({ name: bar.name, first: bar.first })),
            slotLabel: describeSlot(settings.slot, bars),
            slot: slot
                ? { name: slot.name, kind: slot.kind, key: slot.key, keySource: slot.keySource }
                : null,
            effectiveKey: key,
            keyValid: !key || !!parseShortcut(key)
        });
    }

    override onWillAppear(ev: WillAppearEvent<ActionSettings>) {
        this.settings.set(ev.action.id, normalizeAction(ev.payload.settings));
        this.forget(ev.action.id);
        this.updateDemand();
        if (ev.action.isKey()) {
            void this.render(ev.action);
        }
    }

    override onWillDisappear(ev: WillDisappearEvent<ActionSettings>) {
        keyboard.release(ev.action.id);
        this.settings.delete(ev.action.id);
        this.forget(ev.action.id);
        this.updateDemand();
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>) {
        keyboard.release(ev.action.id);
        this.settings.set(ev.action.id, normalizeAction(ev.payload.settings));
        this.updateDemand();
        if (ev.action.isKey()) {
            void this.render(ev.action);
        }
        this.sendInspector();
    }

    override onKeyDown(ev: KeyDownEvent<ActionSettings>) {
        const settings = this.settings.get(ev.action.id) ?? normalizeAction(ev.payload.settings);
        const key = this.keyFor(settings);
        if (key) {
            keyboard.press(ev.action.id, key);
        }
    }

    override onKeyUp(ev: KeyUpEvent<ActionSettings>) {
        keyboard.release(ev.action.id);
    }

    override onPropertyInspectorDidAppear() {
        this.sendInspector();
    }

    override onSendToPlugin(ev: SendToPluginEvent<{ type: string }, ActionSettings>) {
        if (ev.payload && typeof ev.payload === "object" && ev.payload.type === "refresh") {
            deck.rescan();
            this.sendInspector();
        }
    }
}
