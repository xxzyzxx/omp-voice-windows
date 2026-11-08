/**
 * [omp-windows patch] Physical key state and console focus on Windows.
 *
 * OMP on Windows reads keys through win32-input-mode and drops key-up records
 * before extensions see them, and conhost has no kitty keyboard protocol, so a
 * terminal release never arrives. Lock and modifier keys (Caps Lock, Right
 * Ctrl) produce no terminal input at all. Holds are therefore read from the
 * OS: user32 GetAsyncKeyState reports whether a physical key is down right now.
 */
import { dlopen, FFIType } from "bun:ffi";

export const VK_SPACE = 0x20;
export const VK_CAPITAL = 0x14;

type Win32 = {
	keyDown(vk: number): boolean;
	toggled(vk: number): boolean;
	consoleFocused(): boolean;
	tap(vk: number): void;
};
let win32: Win32 | null | undefined;

function load(): Win32 | null {
	if (win32 !== undefined) return win32;
	if (process.platform !== "win32") return (win32 = null);
	try {
		const user32 = dlopen("user32.dll", {
			GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
			GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
			GetForegroundWindow: { args: [], returns: FFIType.ptr },
			GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
			keybd_event: { args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64], returns: FFIType.void },
		});
		const kernel32 = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } });
		const GA_ROOTOWNER = 3;
		win32 = {
			keyDown: (vk) => (user32.symbols.GetAsyncKeyState(vk) & 0x8000) !== 0,
			toggled: (vk) => (user32.symbols.GetKeyState(vk) & 1) !== 0,
			// conhost: the console window is the foreground window. Windows
			// Terminal: the console is a hidden pseudo-window owned by the
			// terminal window, which is the foreground one.
			consoleFocused: () => {
				const fg = user32.symbols.GetForegroundWindow();
				const console = kernel32.symbols.GetConsoleWindow();
				if (!fg || !console) return false;
				return fg === console || fg === user32.symbols.GetAncestor(console, GA_ROOTOWNER);
			},
			tap: (vk) => {
				const KEYEVENTF_KEYUP = 0x2;
				user32.symbols.keybd_event(vk, 0x3a, 0, 0n);
				user32.symbols.keybd_event(vk, 0x3a, KEYEVENTF_KEYUP, 0n);
			},
		};
	} catch {
		win32 = null;
	}
	return win32;
}

/** True/false on Windows; undefined where the OS state is not available. */
export function keyDown(vk: number = VK_SPACE): boolean | undefined {
	return load()?.keyDown(vk);
}

/** Whether this process's console (its terminal window) has keyboard focus; undefined off Windows. */
export function consoleFocused(): boolean | undefined {
	return load()?.consoleFocused();
}

/** Caps Lock toggle state (its LED); undefined off Windows. */
export function capsLockOn(): boolean | undefined {
	return load()?.toggled(VK_CAPITAL);
}

/** Press and release a key (used to set the Caps Lock LED). */
export function tapKey(vk: number): void {
	load()?.tap(vk);
}
