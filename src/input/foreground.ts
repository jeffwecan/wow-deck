// Tells whether World of Warcraft is the foreground window, so keys are only ever sent to the game.
import koffi from "koffi";
import path from "node:path";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const getForegroundWindow = user32.func("intptr_t GetForegroundWindow(void)");
const getWindowThreadProcessId = user32.func("uint GetWindowThreadProcessId(intptr_t hwnd, void *pid)");
const openProcess = kernel32.func("intptr_t OpenProcess(uint access, int inherit, uint pid)");
const queryImageName = kernel32.func("int QueryFullProcessImageNameW(intptr_t proc, uint flags, void *buffer, void *size)");
const closeHandle = kernel32.func("int CloseHandle(intptr_t handle)");

// Wow.exe, WowClassic.exe, WowT.exe, WowB.exe, ...
const WOW_EXECUTABLE = /^wow[a-z]*\.exe$/i;

let cachedPid = 0;
let cachedName: string | null = null;

function processName(pid: number): string | null {
    if (pid === cachedPid) {
        return cachedName;
    }
    const handle = openProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    let name: string | null = null;
    if (handle) {
        try {
            const buffer = Buffer.alloc(2048);
            const size = Buffer.alloc(4);
            size.writeUInt32LE(1024);
            if (queryImageName(handle, 0, buffer, size)) {
                name = path.win32.basename(buffer.toString("utf16le", 0, size.readUInt32LE(0) * 2));
            }
        }
        finally {
            closeHandle(handle);
        }
    }
    cachedPid = pid;
    cachedName = name;
    return name;
}

export function isWowForeground(): boolean {
    try {
        const window = getForegroundWindow();
        if (!window) {
            return false;
        }
        const pid = Buffer.alloc(4);
        if (!getWindowThreadProcessId(window, pid)) {
            return false;
        }
        const name = processName(pid.readUInt32LE(0));
        return !!name && WOW_EXECUTABLE.test(name);
    }
    catch {
        return false;
    }
}
