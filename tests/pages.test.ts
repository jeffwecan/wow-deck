import { describe, expect, it } from "vitest";
import { pageForBar, templateBar, WOW_BUTTON, type PageManifest } from "../src/tools/page-layout.js";

const bars = [
    { name: "Main bar", first: 1 },
    { name: "Bottom left bar", first: 61 },
    { name: "Action bar 8", first: 169 }
];

const wow = (slot: number) => ({ UUID: WOW_BUTTON, Settings: { shortcut: "", slot }, State: 0 });
const template: PageManifest = {
    Actions: {
        "0,0": { UUID: "com.hotspot.streamdock.page.previous", Settings: {} },
        "0,2": wow(1),
        "1,0": wow(11),
        "4,1": wow(10),
        "2,1": { UUID: WOW_BUTTON, Settings: { shortcut: "", slot: 0 } }
    },
    DeviceUUID: "VSDM18",
    Version: "1.0"
};

describe("page layout", () => {
    it("finds the bar the template page shows", () => {
        expect(templateBar(template, bars)).toEqual(bars[0]);
    });

    it("rejects a template whose buttons span bars", () => {
        const mixed = { Actions: { "0,0": wow(1), "0,1": wow(61) } };
        expect(() => templateBar(mixed, bars)).toThrow(/aren't all on one bar/);
    });

    it("moves each button to the same position on another bar", () => {
        const page = pageForBar(template, bars[0], bars[2]);
        expect(page.Actions["0,2"].Settings?.slot).toBe(169);
        expect(page.Actions["1,0"].Settings?.slot).toBe(179);
        expect(page.Actions["4,1"].Settings?.slot).toBe(178);
    });

    it("keeps other keys, unset buttons and the template itself unchanged", () => {
        const page = pageForBar(template, bars[0], bars[1]);
        expect(page.Actions["0,0"]).toEqual(template.Actions["0,0"]);
        expect(page.Actions["2,1"].Settings?.slot).toBe(0);
        expect(page.DeviceUUID).toBe("VSDM18");
        expect(template.Actions["0,2"].Settings?.slot).toBe(1);
    });
});
