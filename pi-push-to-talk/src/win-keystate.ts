/**
 * [omp-windows patch] Physical key state on Windows.
 *
 * OMP on Windows reads keys through win32-input-mode and drops key-up records
 * before extensions see them, and conhost has no kitty keyboard protocol, so a
 * terminal release never arrives. Once a hold is detected from key repeats, the
 * release is read from the OS instead: user32 GetAsyncKeyState reports whether
 * the physical key is down right now. Polled only while dictation is active.
 */
import { dlopen, FFIType } from "bun:ffi";

export const VK_SPACE = 0x20;

let read: ((vk: number) => boolean) | null | undefined;

/** True/false on Windows; undefined where the OS state is not available. */
export function keyDown(vk: number = VK_SPACE): boolean | undefined {
	if (process.platform !== "win32") return undefined;
	if (read === undefined) {
		try {
			const user32 = dlopen("user32.dll", {
				GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
			});
			read = (key) => (user32.symbols.GetAsyncKeyState(key) & 0x8000) !== 0;
		} catch {
			read = null;
		}
	}
	return read ? read(vk) : undefined;
}

let focused: (() => boolean) | null | undefined;

/**
 * Whether this OMP's terminal window has keyboard focus; undefined off Windows.
 * conhost: the console window is the foreground window. Windows Terminal: the
 * console is a hidden pseudo-window owned by the foreground terminal window.
 */
export function consoleFocused(): boolean | undefined {
	if (process.platform !== "win32") return undefined;
	if (focused === undefined) {
		try {
			const user32 = dlopen("user32.dll", {
				GetForegroundWindow: { args: [], returns: FFIType.ptr },
				GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
			});
			const kernel32 = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } });
			focused = () => {
				const fg = user32.symbols.GetForegroundWindow();
				const console = kernel32.symbols.GetConsoleWindow();
				return !!fg && !!console && (fg === console || fg === user32.symbols.GetAncestor(console, 3));
			};
		} catch {
			focused = null;
		}
	}
	return focused ? focused() : undefined;
}
