import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class FakeOption {
    constructor(
        public label: string,
        public value: string
    ) {}
}
class FakeElement {
    value = "";
    textContent = "";
    disabled = false;
    options: FakeOption[] = [];
    onchange?: () => void;
    onclick?: () => void;
    replaceChildren() {
        this.options = [];
    }

    add(option: FakeOption) {
        this.options.push(option);
    }
}
class FakeSocket {
    static last: FakeSocket;
    readyState = 1;
    messages: Record<string, unknown>[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
        FakeSocket.last = this;
    }

    send(text: string) {
        this.messages.push(JSON.parse(text));
    }
}

function load(settings: Record<string, unknown>) {
    const elements = new Map<string, FakeElement>();
    const get = (id: string) => {
        if (!elements.has(id)) {
            elements.set(id, new FakeElement());
        }
        return elements.get(id)!;
    };
    const browser: Record<string, unknown> = {};
    runInNewContext(readFileSync(new URL("../inspector/index.js", import.meta.url), "utf8"), {
        window: browser,
        document: { getElementById: get },
        WebSocket: FakeSocket,
        Option: FakeOption
    });
    (browser.connectElgatoStreamDeckSocket as (...args: string[]) => void)(
        "1234",
        "pi-uuid",
        "registerPropertyInspector",
        "{}",
        JSON.stringify({ action: "com.wow-deck.button", payload: { settings } })
    );
    const socket = FakeSocket.last;
    socket.onopen?.();
    const receive = (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
    return { get, socket, receive };
}

describe("Property Inspector protocol", () => {
    it("shows the saved slot and saves a newly picked bar button", () => {
        const { get, socket } = load({ slot: 63, shortcut: "" });
        expect(socket.messages[0]).toEqual({ event: "registerPropertyInspector", uuid: "pi-uuid" });
        expect(socket.messages.find(m => m.event === "sendToPlugin")).toMatchObject({
            context: "pi-uuid",
            payload: { type: "refresh" }
        });
        expect(get("bar").value).toBe("61");
        expect(get("button").value).toBe("3");

        get("bar").value = "25";
        get("bar").onchange?.();
        expect(socket.messages.at(-1)).toMatchObject({
            event: "setSettings",
            context: "pi-uuid",
            action: "com.wow-deck.button",
            payload: { slot: 25, shortcut: "" }
        });

        get("button").value = "12";
        get("shortcut").value = " SHIFT-F6 ";
        get("button").onchange?.();
        expect(socket.messages.at(-1)?.payload).toEqual({ slot: 36, shortcut: "SHIFT-F6" });
    });

    it("lists the bars the addon found, including bars 7 and 8", () => {
        const { get, socket, receive } = load({ slot: 160 });
        expect(get("bar").value).toBe("0"); // not in the fallback list until the plugin answers
        receive({
            event: "sendToPropertyInspector",
            payload: {
                type: "state",
                status: "Using Jeff-Forever",
                bars: [
                    { name: "Main bar", first: 1 },
                    { name: "Action bar 7", first: 157 },
                    { name: "Action bar 8", first: 169 }
                ],
                characters: []
            }
        });
        expect(get("bar").options.map(o => o.label)).toEqual(["Choose…", "Main bar", "Action bar 7", "Action bar 8"]);
        expect(get("bar").value).toBe("157");
        expect(get("button").value).toBe("4");

        get("bar").value = "169";
        get("bar").onchange?.();
        expect(socket.messages.at(-1)?.payload).toEqual({ slot: 169, shortcut: "" });
    });

    it("describes what the slot presses and saves the deck settings", () => {
        const { get, socket, receive } = load({ slot: 61 });
        receive({ event: "didReceiveGlobalSettings", payload: { settings: { wowFolder: "D:\\WoW", character: "" } } });
        expect(get("wowFolder").value).toBe("D:\\WoW");
        receive({
            event: "sendToPropertyInspector",
            payload: {
                type: "state",
                status: "Using Jeff-Forever",
                character: "Jeff-Forever",
                characters: ["Alt-Forever", "Jeff-Forever"],
                slotLabel: "Bottom left bar, button 1",
                slot: { name: "Polymorph", kind: "macro", key: "CTRL-ALT-SHIFT-F1", keySource: "deck" },
                effectiveKey: "CTRL-ALT-SHIFT-F1",
                keyValid: true
            }
        });
        expect(get("status").textContent).toBe("Using Jeff-Forever");
        expect(get("slotInfo").textContent).toContain("Polymorph (macro)");
        expect(get("slotInfo").textContent).toContain("Presses CTRL-ALT-SHIFT-F1, from deck chord set by the addon");
        expect(get("character").options.map(o => o.label)).toEqual([
            "Last played (Jeff-Forever)",
            "Alt-Forever",
            "Jeff-Forever"
        ]);

        get("character").value = "Alt-Forever";
        get("character").onchange?.();
        expect(socket.messages.at(-1)).toMatchObject({
            event: "setGlobalSettings",
            context: "pi-uuid",
            payload: { wowFolder: "D:\\WoW", character: "Alt-Forever" }
        });
    });
});
