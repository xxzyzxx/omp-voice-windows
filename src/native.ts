/**
 * [omp-windows patch] Load the native dependencies by absolute file path.
 *
 * Inside OMP on Windows, a runtime `require()` of a bare package name from
 * extension code fails with "Cannot find module" (the resolver does not search
 * the extension's node_modules). decibri's loader requires its platform binding
 * by package name and so reports "Cannot find native binding"; sherpa-onnx-node
 * cannot be required at all. Relative requires and imports of absolute files
 * do work, so both packages are located on disk and imported by path. decibri's
 * own NAPI_RS_NATIVE_LIBRARY_PATH hook points it at its binding.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest `node_modules/<name>` above this file, as Node would search. */
function packageDir(name: string): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = path.join(dir, "node_modules", ...name.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`${name} is not installed`);
		dir = parent;
	}
}

function mainFile(dir: string): string {
	const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { main?: string };
	return path.join(dir, pkg.main ?? "index.js");
}

const defaultExport = (mod: { default?: unknown }): unknown => mod.default ?? mod;

let decibri: Promise<unknown> | undefined;
let sherpa: Promise<unknown> | undefined;

/** The decibri constructor. */
export function loadDecibri(): Promise<unknown> {
	decibri ??= (async () => {
		const dir = packageDir("decibri");
		if (process.platform === "win32" && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
			const target = `win32-${process.arch}-msvc`;
			const binding = path.join(packageDir(`@decibri/decibri-${target}`), `decibri.${target}.node`);
			process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
			try {
				return defaultExport(await import(mainFile(dir)));
			} finally {
				delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
			}
		}
		return defaultExport(await import(mainFile(dir)));
	})();
	return decibri;
}

/** The sherpa-onnx-node module namespace. */
export function loadSherpa(): Promise<unknown> {
	sherpa ??= (async () => defaultExport(await import(mainFile(packageDir("sherpa-onnx-node")))))();
	return sherpa;
}
