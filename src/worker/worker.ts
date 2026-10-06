/// <reference lib="webworker" />
// Redaction worker. Everything heavy happens here so the page stays responsive.
// MuPDF's WebAssembly and the Arimo fonts are embedded in this script as data, so
// the worker never makes a network request.

// "binary:" imports are embedded as base64 by the inline-binary plugin in vite.config.ts
// (paths are relative to the project root).
import wasmData from "binary:./node_modules/mupdf/dist/mupdf-wasm.wasm";
import boldData from "binary:./src/assets/Arimo-Bold.ttf";
import regularData from "binary:./src/assets/Arimo-Regular.ttf";
import type { FromWorker, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

function base64Bytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const post = (m: FromWorker) => self.postMessage(m);

// Must be set before mupdf.js evaluates (it reads this when instantiating the WASM).
const wasmModule: { wasmBinary: Uint8Array; HEAPU8?: Uint8Array } = { wasmBinary: base64Bytes(wasmData) };
(globalThis as Record<string, unknown>).$libmupdf_wasm_Module = wasmModule;
/** Current size of the WASM heap (for the progress display and the perf test). */
const wasmBytes = () => wasmModule.HEAPU8?.buffer.byteLength ?? 0;

const [mupdf, engine] = await Promise.all([import("mupdf"), import("../engine/pipeline")]);
const fonts = { bold: base64Bytes(boldData), regular: base64Bytes(regularData) };

/**
 * MuPDF reads the file on demand through this stream. Reads go through a 4 MB block
 * cache backed by FileReaderSync, so the PDF is never copied into WASM memory whole.
 */
function fileSource(file: File) {
	const BLOCK = 4 << 20;
	const reader = new FileReaderSync();
	return {
		name: file.name,
		size: file.size,
		open() {
			let blockStart = -1;
			let block = new Uint8Array(0);
			return new mupdf.Stream({
				fileSize: () => file.size,
				read(mem: Uint8Array, off: number, len: number, pos: number) {
					if (pos >= file.size) return 0;
					if (pos < blockStart || pos >= blockStart + block.length) {
						blockStart = pos - (pos % BLOCK);
						block = new Uint8Array(reader.readAsArrayBuffer(file.slice(blockStart, blockStart + BLOCK)));
					}
					const s = pos - blockStart;
					const n = Math.min(len, block.length - s);
					mem.set(block.subarray(s, s + n), off);
					return n;
				},
				close() {
					block = new Uint8Array(0);
				},
			});
		},
	};
}

/**
 * The redacted output (up to ~1.5 GB) is written straight to a file in the browser's
 * origin-private file system (on this computer, never uploaded) as each chunk finishes,
 * so it never has to fit in memory. The download link points at that file. The file is
 * deleted when the next run starts and whenever the app is opened.
 */
const OUTPUT_NAME = "6068redact-output.pdf";

interface SyncHandle {
	write(b: Uint8Array, o: { at: number }): number;
	truncate(n: number): void;
	flush(): void;
	close(): void;
}

async function removeOutput() {
	try {
		const dir = await navigator.storage.getDirectory();
		await dir.removeEntry(OUTPUT_NAME);
	} catch {
		/* not present, or OPFS unavailable */
	}
}

const STORAGE_MESSAGE =
	"There is not enough browser storage on this computer to hold the redacted file. Use a regular (not private/incognito) browser window, free up disk space, or split the PDF in Acrobat and redact each part.";

/** Use on-disk staging only when the browser reports room for it (output ≈ input size). */
async function diskSink(inputBytes: number) {
	try {
		const { quota = 0, usage = 0 } = await navigator.storage.estimate();
		if (quota - usage < inputBytes * 1.5) return null;
		const dir = await navigator.storage.getDirectory();
		const fh = await dir.getFileHandle(OUTPUT_NAME, { create: true });
		const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
		h.truncate(0);
		let pos = 0;
		let open = true;
		const close = () => {
			if (open) h.close();
			open = false;
		};
		return {
			sink: {
				write(b: Uint8Array) {
					let off = 0;
					while (off < b.length) {
						let n = 0;
						try {
							n = h.write(b.subarray(off), { at: pos + off });
						} catch {
							n = 0;
						}
						if (n <= 0) throw new engine.EngineError(STORAGE_MESSAGE);
						off += n;
					}
					pos += b.length;
				},
				finish() {
					h.flush();
					close();
					return undefined;
				},
			},
			getFile: () => fh.getFile(),
			close,
		};
	} catch {
		return null; // OPFS unavailable: fall back to an in-memory Blob
	}
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
	const msg = e.data;
	if (msg.type !== "start") return;
	await removeOutput();
	const disk = await diskSink(msg.file.size);
	try {
		let last = 0;
		const r = engine.runRedaction(
			fileSource(msg.file),
			msg.options,
			fonts,
			(progress) => {
				const now = performance.now();
				if (now - last > 100 || progress.done === progress.total) {
					last = now;
					post({ type: "progress", progress, wasmBytes: wasmBytes() });
				}
			},
			{ ...engine.DEFAULT_CONFIG, sink: disk?.sink },
		);
		if (r.status === "blocked") {
			disk?.close();
			await removeOutput();
			post({ type: "blocked", pageCount: r.pageCount, noTextPages: r.noTextPages });
		} else {
			const redacted = r.redacted ?? (await disk!.getFile());
			// Never hand out an incomplete file.
			if (redacted.size !== r.stats.outputBytes) {
				await removeOutput();
				throw new engine.EngineError(STORAGE_MESSAGE);
			}
			post({ type: "done", redacted, report: r.report, stats: r.stats });
		}
	} catch (err) {
		disk?.close();
		await removeOutput();
		const message = err instanceof engine.EngineError ? err.message : `Processing failed: ${(err as Error)?.message ?? String(err)}`;
		post({ type: "error", message });
	}
};

await removeOutput();

post({ type: "ready" });
