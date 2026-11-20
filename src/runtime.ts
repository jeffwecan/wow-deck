import streamDeck from "@elgato/streamdeck";
import { WowAction, beacon, deck, keyboard } from "./actions/wow-action.js";
import { normalizeDeckSettings, type DeckSettings } from "./settings/deck-settings.js";
import { enablePhysicalPixels } from "./input/foreground.js";

// Window positions must be in physical pixels to line up with the captured screen.
enablePhysicalPixels();
const action = new WowAction();
streamDeck.actions.registerAction(action);

function apply(settings: DeckSettings) {
    deck.configure(settings);
    beacon.configure(settings.live, settings.liveInterval);
    action.setLiveEnabled(settings.live);
}

streamDeck.settings.onDidReceiveGlobalSettings(ev => apply(normalizeDeckSettings(ev.settings)));
streamDeck.devices.onDeviceDidDisconnect(() => keyboard.releaseAll());
const shutdown = () => {
    keyboard.releaseAll();
    deck.stop();
    beacon.shutdown();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => keyboard.releaseAll());
await streamDeck.connect();
apply(normalizeDeckSettings(await streamDeck.settings.getGlobalSettings()));
deck.start();
