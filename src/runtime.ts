import streamDeck from "@elgato/streamdeck";
import { WowAction, deck, keyboard } from "./actions/wow-action.js";
import { normalizeDeckSettings } from "./settings/deck-settings.js";

const action = new WowAction();
streamDeck.actions.registerAction(action);
streamDeck.settings.onDidReceiveGlobalSettings(ev => deck.configure(normalizeDeckSettings(ev.settings)));
streamDeck.devices.onDeviceDidDisconnect(() => keyboard.releaseAll());
const shutdown = () => {
    keyboard.releaseAll();
    deck.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => keyboard.releaseAll());
await streamDeck.connect();
deck.configure(normalizeDeckSettings(await streamDeck.settings.getGlobalSettings()));
deck.start();
