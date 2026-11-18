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
import { availableBars, describeSlot, normalizeAction, type ActionSettings } from "../settings/action-settings.js";

const UUID = "com.wow-deck.button";
export const deck = new DeckSource();
export const keyboard = new KeyboardManager();
const icons = new IconResolver(path.join(process.cwd(), "cache", "icons"));

@action({ UUID })
export class WowAction extends SingletonAction<ActionSettings> {
    private settings = new Map<string, ActionSettings>();
    private lastImage = new Map<string, string>();
    private renders = new Map<string, number>();

    constructor() {
        super();
        deck.onChange(() => {
            this.renderAll();
            this.sendInspector();
        });
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
        let image: string;
        try {
            if (!settings.slot) {
                image = await renderStatus("WoW", "Choose a slot");
            }
            else if (!data) {
                image = await renderStatus("WoW", "Install addon, then /reload");
            }
            else {
                const slot = data.slots.get(settings.slot);
                if (!slot) {
                    image = await renderStatus("Empty", `Slot ${settings.slot}`);
                }
                else {
                    const icon = await icons.get(slot);
                    image = await renderSlot(icon, slot.name, this.keyFor(settings));
                }
            }
        }
        catch (error) {
            streamDeck.logger.warn("Could not render key", error);
            return;
        }
        // A newer render for this key started while we waited for the icon.
        if (this.renders.get(key.id) !== token || this.lastImage.get(key.id) === image) {
            return;
        }
        this.lastImage.set(key.id, image);
        await key.setImage(image);
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
        if (ev.action.isKey()) {
            void this.render(ev.action);
        }
    }

    override onWillDisappear(ev: WillDisappearEvent<ActionSettings>) {
        keyboard.release(ev.action.id);
        this.settings.delete(ev.action.id);
        this.lastImage.delete(ev.action.id);
        this.renders.delete(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>) {
        keyboard.release(ev.action.id);
        this.settings.set(ev.action.id, normalizeAction(ev.payload.settings));
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
