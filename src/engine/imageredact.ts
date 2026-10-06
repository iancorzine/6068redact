import * as mupdf from "mupdf";
import { loadImage, withBuffer } from "./buffers";
import type { Rect } from "./types";

// Image pixel redaction. MuPDF's built-in REDACT_IMAGE_PIXELS erases pixels to white and
// re-encodes JPEG scans losslessly (Flate), which can triple the size of a 1.5 GB scanned
// record. Here the pixels under each box are set to black inside the image data, and the
// image is re-encoded in its original family (JPEG stays JPEG, bilevel stays 1-bit).
// Images we cannot handle this way (inline images, images inside form XObjects, stencil
// masks) are reported so the caller can fall back to MuPDF's method for that page.

const DEFAULT_JPEG_QUALITY = 85;

// IJG standard luminance quantization table (JPEG Annex K), in zigzag order as stored.
const STD_LUMA = [
	16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51,
	56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92,
	101, 103, 99,
];

/**
 * Estimate the IJG quality a JPEG was saved with, from its first quantization table, so
 * the redacted page can be re-encoded at about the same quality (and size).
 */
export function estimateJpegQuality(jpeg: Uint8Array): number {
	for (let i = 2; i + 4 < jpeg.length; ) {
		if (jpeg[i] !== 0xff) return DEFAULT_JPEG_QUALITY;
		const marker = jpeg[i + 1];
		const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
		if (marker === 0xdb) {
			const pq = jpeg[i + 4] >> 4;
			const q: number[] = [];
			for (let k = 0; k < 64; k++) q.push(pq ? (jpeg[i + 5 + 2 * k] << 8) | jpeg[i + 6 + 2 * k] : jpeg[i + 5 + k]);
			let best = DEFAULT_JPEG_QUALITY;
			let bestErr = Infinity;
			for (let quality = 10; quality <= 100; quality++) {
				const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
				let err = 0;
				for (let k = 0; k < 64; k++) err += Math.abs(Math.min(255, Math.max(1, Math.floor((STD_LUMA[k] * scale + 50) / 100))) - q[k]);
				if (err < bestErr) {
					bestErr = err;
					best = quality;
				}
			}
			return Math.min(95, Math.max(50, best));
		}
		if (marker === 0xda) break; // start of scan: no table found
		i += 2 + len;
	}
	return DEFAULT_JPEG_QUALITY;
}

interface Placement {
	image: mupdf.Image;
	ctm: mupdf.Matrix;
	mask: boolean;
}

function intersects(a: Rect, b: Rect) {
	return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function filterName(obj: mupdf.PDFObject): string {
	const f = obj.get("Filter");
	if (f.isName()) return f.asName();
	if (f.isArray() && f.length) return f.get(f.length - 1).asName();
	return "";
}

/** Pixel rectangles (in image pixel space) covered by the page-space boxes. */
function pixelRegions(ctm: mupdf.Matrix, w: number, h: number, boxes: Rect[]): [number, number, number, number][] {
	const inv = mupdf.Matrix.invert(ctm);
	const out: [number, number, number, number][] = [];
	for (const b of boxes) {
		const u = mupdf.Rect.transform(b, inv); // unit-square coordinates
		const x0 = Math.max(0, Math.floor(u[0] * w) - 1);
		const y0 = Math.max(0, Math.floor(u[1] * h) - 1);
		const x1 = Math.min(w, Math.ceil(u[2] * w) + 1);
		const y1 = Math.min(h, Math.ceil(u[3] * h) + 1);
		if (x1 > x0 && y1 > y0) out.push([x0, y0, x1, y1]);
	}
	return out;
}

function fill(pix: mupdf.Pixmap, regions: [number, number, number, number][], value: number) {
	const px = pix.getPixels();
	const n = pix.getNumberOfComponents() + pix.getAlpha();
	const stride = pix.getStride();
	for (const [x0, y0, x1, y1] of regions) {
		for (let y = y0; y < y1; y++) {
			const row = y * stride;
			for (let x = x0; x < x1; x++) {
				const p = row + x * n;
				for (let c = 0; c < pix.getNumberOfComponents(); c++) px[p + c] = value;
				if (pix.getAlpha()) px[p + n - 1] = 255;
			}
		}
	}
}

function pack1bit(pix: mupdf.Pixmap): Uint8Array {
	const w = pix.getWidth();
	const h = pix.getHeight();
	const px = pix.getPixels();
	const stride = pix.getStride();
	const rowBytes = (w + 7) >> 3;
	const out = new Uint8Array(rowBytes * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) if (px[y * stride + x] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
	}
	return out;
}

function rawSamples(pix: mupdf.Pixmap): Uint8Array {
	const w = pix.getWidth();
	const h = pix.getHeight();
	const n = pix.getNumberOfComponents();
	const stride = pix.getStride();
	const px = pix.getPixels();
	if (stride === w * n && !pix.getAlpha()) return new Uint8Array(px.buffer, px.byteOffset, w * h * n).slice();
	const out = new Uint8Array(w * h * n);
	const step = n + pix.getAlpha();
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < n; c++) out[(y * w + x) * n + c] = px[y * stride + x * step + c];
	return out;
}

/** Re-encode a redacted pixmap as a new image XObject in the same family as `orig`. */
function encode(doc: mupdf.PDFDocument, orig: mupdf.PDFObject, pix: mupdf.Pixmap, bpc: number): mupdf.PDFObject {
	const n = pix.getNumberOfComponents();
	const dict: Record<string, unknown> = {
		Type: "XObject",
		Subtype: "Image",
		Width: pix.getWidth(),
		Height: pix.getHeight(),
		ColorSpace: n === 1 ? "DeviceGray" : "DeviceRGB",
	};
	if (!orig.get("Interpolate").isNull()) dict.Interpolate = orig.get("Interpolate");
	const filt = filterName(orig);
	let obj: mupdf.PDFObject;
	if (filt === "DCTDecode" || filt === "JPXDecode") {
		let quality = DEFAULT_JPEG_QUALITY;
		if (filt === "DCTDecode" && (orig.get("Filter").isName() || orig.get("Filter").length === 1)) {
			const raw = orig.readRawStream();
			quality = estimateJpegQuality(raw.asUint8Array().subarray(0, 4096));
			raw.destroy();
		}
		const jpeg = pix.asJPEG(quality, false);
		obj = withBuffer(jpeg, (b) => {
			const probe = new mupdf.Image(b);
			dict.ColorSpace = probe.getNumberOfComponents() === 1 ? "DeviceGray" : "DeviceRGB";
			probe.destroy();
			return doc.addRawStream(b, { ...dict, BitsPerComponent: 8, Filter: "DCTDecode" });
		});
	} else if (bpc === 1 && n === 1) {
		obj = withBuffer(pack1bit(pix), (b) => doc.addStream(b, { ...dict, BitsPerComponent: 1 })); // Flate-compressed on save
	} else {
		obj = withBuffer(rawSamples(pix), (b) => doc.addStream(b, { ...dict, BitsPerComponent: 8 }));
	}
	return obj;
}

/**
 * Black out image pixels under `boxes` for every image drawn directly on the page.
 * Returns true if some intersecting image could not be handled (caller must fall back).
 */
export function redactPageImages(doc: mupdf.PDFDocument, page: mupdf.PDFPage, boxes: Rect[]): boolean {
	if (!boxes.length) return false;
	const po = page.getObject();
	const res = po.get("Resources");
	const xobjs = res.isNull() ? null : res.get("XObject");

	// Map image pointers back to their XObject names (MuPDF caches loaded images, so the
	// device sees the same fz_image pointer as loadImage returns).
	const byPointer = new Map<number, { name: string; obj: mupdf.PDFObject; img: mupdf.Image }>();
	if (xobjs && xobjs.isDictionary()) {
		xobjs.forEach((v, k) => {
			// Note: isStream() needs the indirect reference, not the resolved dictionary.
			if (v.isStream() && !v.get("Subtype").isNull() && v.get("Subtype").asName() === "Image") {
				const img = loadImage(doc, v);
				byPointer.set(img.pointer, { name: String(k), obj: v, img });
			}
		});
	}

	const placements: Placement[] = [];
	const dev = new mupdf.Device({
		fillImage(image: mupdf.Image, ctm: mupdf.Matrix) {
			placements.push({ image, ctm, mask: false });
		},
		fillImageMask(image: mupdf.Image, ctm: mupdf.Matrix) {
			placements.push({ image, ctm, mask: true });
		},
		clipImageMask(image: mupdf.Image, ctm: mupdf.Matrix) {
			placements.push({ image, ctm, mask: true });
		},
	});
	page.runPageContents(dev, mupdf.Matrix.identity);
	dev.close();
	dev.destroy();

	let fallback = false;
	const work = new Map<string, { obj: mupdf.PDFObject; img: mupdf.Image; regions: [number, number, number, number][] }>();
	for (const p of placements) {
		const bbox = mupdf.Rect.transform([0, 0, 1, 1], p.ctm) as Rect;
		const hit = boxes.filter((b) => intersects(b, bbox));
		if (!hit.length) continue;
		const entry = byPointer.get(p.image.pointer);
		if (p.mask || !entry) {
			fallback = true;
			continue;
		}
		const w = p.image.getWidth();
		const h = p.image.getHeight();
		const regions = pixelRegions(p.ctm, w, h, hit);
		if (!regions.length) continue;
		const e = work.get(entry.name) ?? { obj: entry.obj, img: entry.img, regions: [] };
		e.regions.push(...regions);
		work.set(entry.name, e);
	}

	if (work.size) {
		// Copy-on-write the resource dictionaries: they may be shared with other pages.
		const newRes = doc.newDictionary();
		res.forEach((v, k) => newRes.put(k, v));
		const newXo = doc.newDictionary();
		xobjs!.forEach((v, k) => newXo.put(k, v));
		for (const [name, { obj, img, regions }] of work) {
			const orig = obj;
			let pix = img.toPixmap();
			const cs = pix.getColorSpace();
			const csName = cs?.getName() ?? "";
			cs?.destroy();
			// Normalize to plain DeviceGray/DeviceRGB (ICC-based gray would otherwise be
			// written as a 3-channel JPEG that disagrees with the dictionary).
			if ((csName !== "DeviceGray" && csName !== "DeviceRGB") || pix.getAlpha()) {
				const conv = pix.convertToColorSpace(pix.getNumberOfComponents() === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false);
				pix.destroy();
				pix = conv;
			}
			fill(pix, regions, 0);
			const bpc = orig.get("BitsPerComponent").isNull() ? 8 : orig.get("BitsPerComponent").asNumber();
			const replacement = encode(doc, orig, pix, bpc);
			pix.destroy();
			// Soft mask: make the redacted area opaque, so the black pixels show.
			const smask = orig.get("SMask");
			if (!smask.isNull()) {
				const mimg = loadImage(doc, smask);
				const mpix = mimg.toPixmap();
				mimg.destroy();
				const sx = mpix.getWidth() / img.getWidth();
				const sy = mpix.getHeight() / img.getHeight();
				fill(mpix, regions.map(([a, b, c, d]) => [Math.floor(a * sx), Math.floor(b * sy), Math.ceil(c * sx), Math.ceil(d * sy)]), 255);
				const maskObj = withBuffer(rawSamples(mpix), (b) =>
					doc.addStream(b, { Type: "XObject", Subtype: "Image", Width: mpix.getWidth(), Height: mpix.getHeight(), ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
				);
				replacement.put("SMask", maskObj);
				mpix.destroy();
			}
			newXo.put(name, replacement);
		}
		newRes.put("XObject", newXo);
		po.put("Resources", newRes);
	}
	for (const { img } of byPointer.values()) img.destroy();
	for (const p of placements) p.image.destroy();
	return fallback;
}
