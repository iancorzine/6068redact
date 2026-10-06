import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { CSP, SECURITY_HEADERS } from "./security-headers.mjs";

/**
 * MuPDF's loader would otherwise ask Vite to emit (and the browser to fetch)
 * mupdf-wasm.wasm. We hand it the bytes directly (wasmBinary), so drop the URL.
 */
function noWasmUrl(): Plugin {
	return {
		name: "6068redact:no-wasm-url",
		transform(code, id) {
			if (!id.includes("mupdf-wasm.js")) return null;
			return code.replace('new URL("mupdf-wasm.wasm",import.meta.url).href', '"mupdf-wasm.wasm"');
		},
	};
}

/**
 * `import data from "binary:<path>"` embeds a file as a base64 string, so the WASM engine
 * and fonts ship inside the worker script and are never fetched at runtime.
 */
function inlineBinary(): Plugin {
	const PREFIX = "\0binary:";
	return {
		name: "6068redact:inline-binary",
		enforce: "pre",
		resolveId(id) {
			if (id.startsWith("binary:")) return PREFIX + fileURLToPath(new URL(id.slice(7), import.meta.url));
			return null;
		},
		load(id) {
			if (!id.startsWith(PREFIX)) return null;
			const file = id.slice(PREFIX.length);
			this.addWatchFile(file);
			return `export default ${JSON.stringify(fs.readFileSync(file).toString("base64"))};`;
		},
	};
}

/** Put the CSP in a <meta> tag too (production build only — dev needs HMR sockets). */
function cspMeta(): Plugin {
	return {
		name: "6068redact:csp-meta",
		apply: "build",
		transformIndexHtml(html) {
			return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
		},
	};
}

export default defineConfig({
	plugins: [inlineBinary(), noWasmUrl(), cspMeta()],
	build: {
		target: "es2022",
		assetsInlineLimit: 0,
		chunkSizeWarningLimit: 20000,
		sourcemap: false,
	},
	worker: {
		format: "es",
		plugins: () => [inlineBinary(), noWasmUrl()],
	},
	optimizeDeps: { exclude: ["mupdf"] },
	preview: { headers: SECURITY_HEADERS },
});
