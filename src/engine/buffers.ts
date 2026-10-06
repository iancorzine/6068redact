import * as mupdf from "mupdf";

/**
 * Run `fn` with a MuPDF Buffer holding `data`, then free it. mupdf.js otherwise wraps
 * Uint8Array/string arguments in temporary Buffers that are released only by the JS
 * garbage collector — which never sees WASM memory pressure, so large image buffers
 * would pile up until the 2 GB heap is exhausted.
 */
export function withBuffer<T>(data: Uint8Array | string, fn: (b: mupdf.Buffer) => T): T {
	const b = new mupdf.Buffer(data as Uint8Array);
	try {
		return fn(b);
	} finally {
		b.destroy();
	}
}

/**
 * doc.loadImage() without the reference leak in mupdf.js 1.28.x: the binding wraps an
 * already-owned fz_image pointer with `new Image(ptr)`, which keeps it a second time,
 * so destroy() never frees it and every scanned page image stays in WASM memory.
 * We drop the extra reference here. mupdf is pinned to 1.28.1 in package.json; the
 * "no WASM heap growth" test in tests/integration/memory.test.ts fails if a future
 * version changes this behavior (in either direction).
 */
export function loadImage(doc: mupdf.PDFDocument, obj: mupdf.PDFObject): mupdf.Image {
	const img = doc.loadImage(obj);
	mupdf.Image._drop(img.pointer);
	return img;
}
