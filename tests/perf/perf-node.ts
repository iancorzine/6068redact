// 5,000-page performance test, Node edition (same engine code as the browser worker).
// Reports wall time, pages/second, peak WASM heap, peak process RSS, input/output size,
// and verifies the output (page count + no protected strings on sampled pages).
export {};
const wasmModule: { HEAPU8?: Uint8Array } = {};
(globalThis as Record<string, unknown>).$libmupdf_wasm_Module = wasmModule;

const fs = await import("node:fs");
const mupdf = await import("mupdf");
const { OPTIONS, PROTECTED } = await import("../fixtures/make");
const { FileSink, fileSource, redact } = await import("../helpers");

const [input = "/tmp/6068redact-perf-5000.pdf", batch = "100"] = process.argv.slice(2);
const out = input.replace(/\.pdf$/, "_REDACTED.pdf");
let peakWasm = 0;
let peakRss = 0;
const sample = () => {
	peakWasm = Math.max(peakWasm, wasmModule.HEAPU8?.buffer.byteLength ?? 0);
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const t0 = performance.now();
let lastLog = 0;
const r = redact(fileSource(input), OPTIONS, { batchSize: +batch, sink: new FileSink(out) }, (p) => {
	sample();
	if (performance.now() - lastLog > 15000) {
		lastLog = performance.now();
		console.log(`  ${p.phase} ${p.done}/${p.total}  ${((performance.now() - t0) / 1000).toFixed(0)} s  wasm ${(peakWasm / 1048576).toFixed(0)} MB  rss ${(peakRss / 1048576).toFixed(0)} MB`);
	}
});
const elapsed = (performance.now() - t0) / 1000;
sample();
if (r.status !== "ok") throw new Error(JSON.stringify(r));
sample();

// Verify: page count and protected strings on a sample of pages.
const fd = fs.openSync(out, "r");
const d = mupdf.Document.openDocument(new mupdf.Stream({
	fileSize: () => fs.statSync(out).size,
	read: (m: Uint8Array, o: number, l: number, p: number) => fs.readSync(fd, m, o, l, p),
	close: () => {},
}), "application/pdf");
const n = d.countPages();
let leaks = 0;
for (let i = 0; i < n; i += 97) {
	const t = d.loadPage(i).toStructuredText("").asText().replace(/\s+/g, "").toLowerCase();
	for (const s of PROTECTED) if (t.includes(s.replace(/\s+/g, "").toLowerCase())) leaks++;
}
const result = {
	pages: r.stats.pageCount,
	outputPages: n,
	inputMB: +(r.stats.inputBytes / 1048576).toFixed(1),
	outputMB: +(r.stats.outputBytes / 1048576).toFixed(1),
	seconds: +elapsed.toFixed(1),
	pagesPerSecond: +(r.stats.pageCount / elapsed).toFixed(1),
	peakWasmMB: +(peakWasm / 1048576).toFixed(0),
	peakRssMB: +(peakRss / 1048576).toFixed(0),
	redactions: r.stats.counts,
	imageFallbackPages: r.stats.imageFallbackPages,
	sampledPagesWithLeaks: leaks,
};
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(input.replace(/\.pdf$/, "_perf-node.json"), JSON.stringify(result, null, 2));
