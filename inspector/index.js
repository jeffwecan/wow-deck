const $ = id => document.getElementById(id);

// Fallback until the plugin sends the bars the addon found (mirrors BARS in action-settings.ts).
let bars = [
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

let socket;
let uuid;
let action;
let settings = { slot: 0, shortcut: "" };
let deckSettings = { wowFolder: "", character: "" };

function send(event, payload) {
    if (socket?.readyState !== 1) {
        return false;
    }
    const message = { event, context: uuid };
    if (["getSettings", "setSettings", "sendToPlugin"].includes(event)) {
        message.action = action;
    }
    if (payload !== undefined) {
        message.payload = payload;
    }
    socket.send(JSON.stringify(message));
    return true;
}

function setStatus(text) {
    $("status").textContent = text;
}

function fillSelect(select, options, value) {
    select.replaceChildren();
    for (const [label, optionValue] of options) {
        select.add(new Option(label, String(optionValue)));
    }
    select.value = String(value);
}

function barFor(slot) {
    return bars.find(bar => slot >= bar.first && slot < bar.first + 12)?.first ?? 0;
}

function drawSlotPicker() {
    const first = settings.slot ? barFor(settings.slot) : 0;
    fillSelect($("bar"), [["Choose…", 0], ...bars.map(bar => [bar.name, bar.first])], first);
    const buttons = Array.from({ length: 12 }, (_, i) => [String(i + 1), i + 1]);
    fillSelect($("button"), buttons, settings.slot ? settings.slot - first + 1 : 1);
    $("button").disabled = !first;
    $("shortcut").value = settings.shortcut || "";
}

function saveSettings() {
    const first = Number($("bar").value);
    const button = Number($("button").value) || 1;
    settings = {
        slot: first ? first + button - 1 : 0,
        shortcut: $("shortcut").value.trim()
    };
    $("button").disabled = !first;
    if (send("setSettings", settings)) {
        setStatus("Button saved");
    }
}

function drawState(state) {
    setStatus(state.status || "");
    if (Array.isArray(state.bars) && state.bars.length && JSON.stringify(state.bars) !== JSON.stringify(bars)) {
        bars = state.bars;
        drawSlotPicker();
    }
    const characters = state.characters || [];
    const current = deckSettings.character || "";
    const lastPlayed = state.character && !current ? ` (${state.character})` : "";
    fillSelect(
        $("character"),
        [[`Last played${lastPlayed}`, ""], ...characters.map(c => [c, c])],
        characters.includes(current) ? current : ""
    );
    const info = $("slotInfo");
    if (!settings.slot) {
        info.textContent = "Choose a bar and button.";
        return;
    }
    const lines = [state.slotLabel || `Slot ${settings.slot}`];
    lines.push(state.slot ? `${state.slot.name || "Unnamed"} (${state.slot.kind})` : "Empty in the current export");
    if (state.effectiveKey) {
        const source = settings.shortcut
            ? "your override"
            : state.slot?.keySource === "deck"
                ? "deck chord set by the addon"
                : "your WoW keybind";
        const warning = state.keyValid ? "" : " (not a key the plugin can send)";
        lines.push(`Presses ${state.effectiveKey}, from ${source}${warning}`);
    }
    else if (state.slot) {
        lines.push("No key: bind this button in WoW or set an override");
    }
    info.textContent = lines.join("\n");
}

$("bar").onchange = () => {
    $("button").value = "1";
    saveSettings();
};
$("button").onchange = saveSettings;
$("shortcut").onchange = saveSettings;
$("saveDeck").onclick = () => {
    deckSettings = { wowFolder: $("wowFolder").value.trim(), character: $("character").value };
    if (send("setGlobalSettings", deckSettings)) {
        setStatus("Saved; reloading the export…");
    }
};
$("character").onchange = () => $("saveDeck").onclick();
$("refresh").onclick = () => {
    if (send("sendToPlugin", { type: "refresh" })) {
        setStatus("Reloading the export…");
    }
};

window.connectElgatoStreamDeckSocket = (port, pluginUuid, registerEvent, _info, actionInfo) => {
    uuid = pluginUuid;
    const data = JSON.parse(actionInfo);
    action = data.action;
    settings = { ...settings, ...data.payload?.settings };
    drawSlotPicker();
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onopen = () => {
        socket.send(JSON.stringify({ event: registerEvent, uuid }));
        send("getGlobalSettings");
        send("sendToPlugin", { type: "refresh" });
    };
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.event === "didReceiveGlobalSettings") {
            deckSettings = { ...deckSettings, ...message.payload?.settings };
            $("wowFolder").value = deckSettings.wowFolder || "";
        }
        if (message.event === "didReceiveSettings") {
            settings = { ...settings, ...message.payload?.settings };
            drawSlotPicker();
        }
        if (message.event === "sendToPropertyInspector" && message.payload?.type === "state") {
            drawState(message.payload);
        }
    };
};
