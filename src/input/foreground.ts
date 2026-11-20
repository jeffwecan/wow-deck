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
export const WOW_EXECUTABLE = /^wow[a-z]*\.exe$/i;

const findWindowW = user32.func("intptr_t FindWindowW(str16 className, str16 title)");
const findWindowExW = user32.func("intptr_t FindWindowExW(intptr_t parent, intptr_t after, str16 className, str16 title)");
const isWindowVisible = user32.func("int IsWindowVisible(intptr_t hwnd)");
koffi.struct("WOWDECK_RECT", { left: "long", top: "long", right: "long", bottom: "long" });
koffi.struct("WOWDECK_POINT", { x: "long", y: "long" });
koffi.struct("WOWDECK_MONITORINFOEX", {
    cbSize: "uint32",
    rcMonitor: "WOWDECK_RECT",
    rcWork: "WOWDECK_RECT",
    dwFlags: "uint32",
    szDevice: koffi.array("char16_t", 32, "String")
});
const getClientRect = user32.func("int GetClientRect(intptr_t hwnd, _Out_ WOWDECK_RECT *rect)");
const clientToScreen = user32.func("int ClientToScreen(intptr_t hwnd, _Inout_ WOWDECK_POINT *point)");
const isIconic = user32.func("int IsIconic(intptr_t hwnd)");
const monitorFromWindow = user32.func("intptr_t MonitorFromWindow(intptr_t hwnd, uint flags)");
const getMonitorInfo = user32.func("int GetMonitorInfoW(intptr_t monitor, _Inout_ WOWDECK_MONITORINFOEX *info)");
const setDpiAwarenessContext = user32.func("int SetProcessDpiAwarenessContext(intptr_t value)");

/** Work in physical pixels (per-monitor DPI aware v2), so window coordinates match captures. */
export function enablePhysicalPixels() {
    try {
        setDpiAwarenessContext(-4);
    }
    catch {
        // older Windows, or already set by the host
    }
}

export interface ScreenRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A window's client area in screen coordinates, or null when it's gone or minimized. */
export function clientRectOnScreen(window: number): ScreenRect | null {
    try {
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        const origin = { x: 0, y: 0 };
        if (isIconic(window) || !getClientRect(window, rect) || !clientToScreen(window, origin)) {
            return null;
        }
        return { x: origin.x, y: origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top };
    }
    catch {
        return null;
    }
}

/** The monitor showing most of a window: its device name (e.g. \\.\DISPLAY1) and desktop position. */
export function monitorOfWindow(window: number): { deviceName: string; left: number; top: number } | null {
    try {
        const monitor = monitorFromWindow(window, 2); // MONITOR_DEFAULTTONEAREST
        const info = {
            cbSize: 104,
            rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
            rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
            dwFlags: 0,
            szDevice: ""
        };
        if (!monitor || !getMonitorInfo(monitor, info)) {
            return null;
        }
        return { deviceName: info.szDevice, left: info.rcMonitor.left, top: info.rcMonitor.top };
    }
    catch {
        return null;
    }
}

// Process names change only when a PID is reused, so cache them briefly.
const NAME_TTL_MS = 10_000;
const names = new Map<number, { name: string | null; at: number }>();

function processName(pid: number): string | null {
    const cached = names.get(pid);
    if (cached && Date.now() - cached.at < NAME_TTL_MS) {
        return cached.name;
    }
    const name = queryProcessName(pid);
    if (names.size > 64) {
        names.clear();
    }
    names.set(pid, { name, at: Date.now() });
    return name;
}

function queryProcessName(pid: number): string | null {
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
    return name;
}

/** Executable name of the process that owns a window, e.g. "Wow.exe". */
export function windowProcessName(window: number): string | null {
    const pid = Buffer.alloc(4);
    if (!window || !getWindowThreadProcessId(window, pid)) {
        return null;
    }
    return processName(pid.readUInt32LE(0));
}

function clientArea(window: number): number {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    return getClientRect(window, rect) ? (rect.right - rect.left) * (rect.bottom - rect.top) : 0;
}

/**
 * Finds the main window of a process whose executable matches `executable`: first by the given
 * window classes (fast), then by walking every top-level window and picking the largest visible
 * one that process owns. The walk uses FindWindowExW, which (unlike enumerating windows through
 * a callback) can't fail outright on windows we aren't allowed to inspect.
 */
export function findProcessWindow(executable: RegExp, classNames: readonly string[] = [], title: string | null = null): number | null {
    try {
        for (const className of classNames) {
            const window = findWindowW(className, title);
            const name = window ? windowProcessName(window) : null;
            if (name && executable.test(name)) {
                return window;
            }
        }
        let best: number | null = null;
        let bestArea = 0;
        let window = 0;
        for (let guard = 0; guard < 4096; guard++) {
            window = findWindowExW(0, window, null, title);
            if (!window) {
                break;
            }
            if (!isWindowVisible(window)) {
                continue;
            }
            const name = windowProcessName(window);
            if (name && executable.test(name)) {
                const area = clientArea(window);
                if (area > bestArea) {
                    best = window;
                    bestArea = area;
                }
            }
        }
        return best;
    }
    catch {
        return null;
    }
}

export function isWowForeground(): boolean {
    try {
        const name = windowProcessName(getForegroundWindow());
        return !!name && WOW_EXECUTABLE.test(name);
    }
    catch {
        return false;
    }
}
