// Parser for the Lua subset WoW writes to SavedVariables files:
//   Name = { ["key"] = value, [3] = value, value, -- [1]  ... }
// Values are tables, strings, numbers, booleans and nil. Positional entries get 1-based keys.

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
    [key: string]: LuaValue;
}

class Parser {
    private pos = 0;

    constructor(private readonly text: string) {}

    parseAssignments(): Record<string, LuaValue> {
        const result: Record<string, LuaValue> = {};
        this.skip();
        while (this.pos < this.text.length) {
            const name = this.identifier();
            this.skip();
            this.expect("=");
            result[name] = this.value();
            this.skip();
        }
        return result;
    }

    private fail(message: string): never {
        throw new Error(`${message} at offset ${this.pos}`);
    }

    // Skips whitespace and comments (`-- line` and `--[[ block ]]`).
    private skip() {
        for (;;) {
            const match = /^(?:\s+|--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*)/.exec(this.text.slice(this.pos, this.pos + 4096));
            if (!match || match[0].length === 0) {
                return;
            }
            this.pos += match[0].length;
        }
    }

    private expect(char: string) {
        if (this.text[this.pos] !== char) {
            this.fail(`Expected "${char}"`);
        }
        this.pos++;
    }

    private identifier(): string {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos, this.pos + 256));
        if (!match) {
            this.fail("Expected a name");
        }
        this.pos += match[0].length;
        return match[0];
    }

    private value(): LuaValue {
        this.skip();
        const char = this.text[this.pos];
        if (char === "{") {
            return this.table();
        }
        if (char === "\"" || char === "'") {
            return this.string();
        }
        const word = /^(?:true|false|nil)\b/.exec(this.text.slice(this.pos, this.pos + 5));
        if (word) {
            this.pos += word[0].length;
            return word[0] === "nil" ? null : word[0] === "true";
        }
        const number = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/.exec(
            this.text.slice(this.pos, this.pos + 64)
        );
        if (number) {
            this.pos += number[0].length;
            return Number(number[0]);
        }
        return this.fail("Unexpected value");
    }

    private string(): string {
        const quote = this.text[this.pos++];
        let out = "";
        while (this.pos < this.text.length) {
            const char = this.text[this.pos++];
            if (char === quote) {
                return out;
            }
            if (char !== "\\") {
                out += char;
                continue;
            }
            const next = this.text[this.pos++];
            const simple: Record<string, string> = { "n": "\n", "t": "\t", "r": "\r", "\\": "\\", "\"": "\"", "'": "'", "\n": "\n" };
            if (next in simple) {
                out += simple[next];
            }
            else if (/\d/.test(next)) {
                const digits = /^\d{1,3}/.exec(this.text.slice(this.pos - 1, this.pos + 2))![0];
                this.pos += digits.length - 1;
                out += String.fromCharCode(Number(digits));
            }
            else {
                out += next;
            }
        }
        return this.fail("Unterminated string");
    }

    private table(): LuaTable {
        this.expect("{");
        const table: LuaTable = {};
        let index = 1;
        for (;;) {
            this.skip();
            if (this.text[this.pos] === "}") {
                this.pos++;
                return table;
            }
            if (this.text[this.pos] === "[") {
                this.pos++;
                const key = this.value();
                this.skip();
                this.expect("]");
                this.skip();
                this.expect("=");
                table[String(key)] = this.value();
            }
            else {
                table[String(index++)] = this.value();
            }
            this.skip();
            if (this.text[this.pos] === "," || this.text[this.pos] === ";") {
                this.pos++;
            }
        }
    }
}

/** Parses a SavedVariables file into its top-level assignments. Throws on malformed input. */
export function parseSavedVariables(text: string): Record<string, LuaValue> {
    return new Parser(text.replace(/^﻿/, "")).parseAssignments();
}

export function isLuaTable(value: LuaValue | undefined): value is LuaTable {
    return typeof value === "object" && value !== null;
}
