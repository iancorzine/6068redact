// Guards against WASM heap growth across chunks (e.g. the mupdf.js loadImage reference
// leak worked around in src/engine/buffers.ts). A leak shows up as steady growth.
import { expect, it } from "vitest";

const wasmModule: { HEAPU8?: Uint8Array } = {};
(globalThis as Record<string, unknown>).$libmupdf_wasm_Module = wasmModule;

it("WASM heap does not grow from chunk to chunk", async () => {
	const { makeBigFixture, OPTIONS } = await import("../fixtures/make");
	const { blobBytes, bytesSource, redact } = await import("../helpers");
	const input = await blobBytes(makeBigFixture(400, { scanRatio: 1, dpi: 150 })!);
	const heap: number[] = [];
	const r = redact(bytesSource(input), OPTIONS, { batchSize: 40, onChunk: () => heap.push(wasmModule.HEAPU8!.buffer.byteLength) });
	expect(r.status).toBe("ok");
	const mb = heap.map((h) => Math.round(h / 1048576));
	// After warm-up (2 chunks) the heap must stay flat. Leaking each page's image would
	// add ~100 KB/page, i.e. ~30 MB over the remaining 320 pages.
	expect(mb[mb.length - 1] - mb[2], `heap MB per chunk: ${mb.join(", ")}`).toBeLessThanOrEqual(8);
});
