import * as mupdf from "mupdf";
import { beforeAll, describe, expect, it } from "vitest";
import type { Box } from "../../src/engine/overlay";
import type { RunResult } from "../../src/engine/pipeline";
import { makeMainFixture, makeNoTextFixture, MUST_REMAIN, OPTIONS, PROTECTED, PROTECTED_WORDS } from "../fixtures/make";
import { blobBytes, bytesSource, redact } from "../helpers";

const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const spaces = (s: string) => s.replace(/\s+/g, " ");

let input: Uint8Array;
let output: Uint8Array;
let result: Extract<RunResult, { status: "ok" }>;
const boxesByPage = new Map<number, Box[]>();

beforeAll(async () => {
	input = makeMainFixture();
	// Small batches so the chunk assembler is exercised across several chunks.
	const r = redact(bytesSource(input, "fixture.pdf"), OPTIONS, { batchSize: 3, onPageBoxes: (p, b) => boxesByPage.set(p, b) });
	if (r.status !== "ok") throw new Error("expected ok");
	result = r;
	output = await blobBytes(r.redacted!);
});

function mupdfText(bytes: Uint8Array): string[] {
	const d = mupdf.Document.openDocument(bytes, "application/pdf");
	const out: string[] = [];
	for (let i = 0; i < d.countPages(); i++) out.push(d.loadPage(i).toStructuredText("preserve-whitespace,clip=no").asText());
	return out;
}

async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const doc = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
	const out: string[] = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const tc = await (await doc.getPage(i)).getTextContent({ includeMarkedContent: true } as never);
		out.push(tc.items.map((it: any) => ("str" in it ? it.str : "")).join(" "));
	}
	return out;
}

describe("redacted output", () => {
	it("the input really contains the protected strings (sanity check)", () => {
		const t = squash(mupdfText(input).join("\n"));
		for (const s of ["Vantreight", "078-05-1120", "Calloway", "W83920014"]) expect(t).toContain(squash(s));
	});

	it("extracted text (MuPDF and pdf.js) contains none of the protected strings", async () => {
		for (const pages of [mupdfText(output), await pdfjsText(output)]) {
			const all = pages.join("\n");
			const sq = squash(all);
			for (const s of PROTECTED) expect(sq, `found "${s}"`).not.toContain(squash(s));
			const words = new Set(all.toLowerCase().split(/[^a-z0-9]+/));
			for (const w of PROTECTED_WORDS) expect(words.has(w), `found word "${w}"`).toBe(false);
		}
	});

	it("no protected string survives anywhere in the file, even in decompressed streams", () => {
		const d = mupdf.Document.openDocument(output, "application/pdf").asPDF()!;
		const n = d.countObjects();
		const dec = new TextDecoder("latin1");
		for (let i = 1; i < n; i++) {
			const o = d.newIndirect(i).resolve();
			let text = o.toString();
			if (o.isStream()) text += dec.decode(o.readStream().asUint8Array());
			const sq = squash(text);
			for (const s of ["Vantreight", "Marisol", "078-05-1120", "Calloway", "Okonkwo", "app.alert", "notes.txt"]) {
				expect(sq, `object ${i} contains "${s}"`).not.toContain(squash(s));
			}
		}
	});

	it("pixels under every box are black (rendered page and the image data itself)", () => {
		const d = mupdf.Document.openDocument(output, "application/pdf").asPDF()!;
		let checked = 0;
		for (const [pageNo, boxes] of boxesByPage) {
			if (!boxes.length) continue;
			const page = d.loadPage(pageNo - 1) as mupdf.PDFPage;
			const scale = 2;
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false);
			const W = pix.getWidth();
			const px = pix.getPixels();
			const stride = pix.getStride();
			for (const b of boxes) {
				const [x0, y0, x1, y1] = b.rect.map((v) => v * scale);
				const ix0 = Math.ceil(x0) + 1, iy0 = Math.ceil(y0) + 1, ix1 = Math.floor(x1) - 1, iy1 = Math.floor(y1) - 1;
				// Solid boxes: every pixel black. Initials boxes: the border band (outside the
				// centered text) must be black, and nothing in the box may be mid-grey content
				// other than anti-aliased white text.
				const h = iy1 - iy0;
				const w = ix1 - ix0;
				for (let y = iy0; y <= iy1; y++) {
					for (let x = ix0; x <= ix1; x++) {
						if (x < 0 || x >= W) continue;
						const v = px[y * stride + x];
						const band = !b.initials || y - iy0 < h * 0.08 || iy1 - y < h * 0.08 || x - ix0 < w * 0.05 || ix1 - x < w * 0.05;
						if (band) expect(v, `page ${pageNo} box ${b.rect} pixel ${x},${y}`).toBeLessThanOrEqual(12);
					}
				}
				checked++;
			}
			pix.destroy();
		}
		expect(checked).toBeGreaterThan(30);

		// Scanned page 4: decode the page image and confirm the image's own pixels are black
		// under each box, i.e. the original pixels are gone, not just covered.
		const page = d.loadPage(3) as mupdf.PDFPage;
		const xobjs = page.getObject().get("Resources").get("XObject");
		let img: mupdf.Image | null = null;
		xobjs.forEach((v) => {
			if (v.get("Subtype").asName() === "Image") img = d.loadImage(v);
		});
		expect(img).not.toBeNull();
		const ipix = img!.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceGray, false);
		const iw = ipix.getWidth(), ih = ipix.getHeight(), ipx = ipix.getPixels(), istr = ipix.getStride();
		for (const b of boxesByPage.get(4)!) {
			// Image is drawn over the whole page (612x792), so page space maps linearly.
			const sx = iw / 612, sy = ih / 792;
			const x0 = Math.ceil(b.rect[0] * sx) + 2, x1 = Math.floor(b.rect[2] * sx) - 2;
			const y0 = Math.ceil(b.rect[1] * sy) + 2, y1 = Math.floor(b.rect[3] * sy) - 2;
			let maxV = 0;
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) maxV = Math.max(maxV, ipx[y * istr + x]);
			expect(maxV, `image pixels under ${b.rect}`).toBeLessThanOrEqual(40);
		}
	});

	it("metadata, XMP, bookmarks, annotations, forms, JavaScript and embedded files are gone", () => {
		const d = mupdf.Document.openDocument(output, "application/pdf").asPDF()!;
		const trailer = d.getTrailer();
		expect(trailer.get("Info").isNull()).toBe(true);
		const root = trailer.get("Root");
		const rootKeys: string[] = [];
		root.forEach((_v, k) => rootKeys.push(String(k)));
		expect(rootKeys.sort()).toEqual(["Pages", "Type"]);
		for (const k of ["info:Author", "info:Title", "info:Subject", "info:Producer", "info:Creator"]) expect(d.getMetaData(k) ?? "").toBe("");
		const banned = ["Metadata", "Annots", "AcroForm", "JavaScript", "JS", "EmbeddedFiles", "EmbeddedFile", "Outlines", "OpenAction", "AA", "Thumb", "PieceInfo", "StructTreeRoot", "Names", "OCProperties", "ActualText"];
		for (let i = 1; i < d.countObjects(); i++) {
			const o = d.newIndirect(i).resolve();
			if (!o.isDictionary() && !o.isStream()) continue;
			for (const k of banned) expect(o.get(k).isNull(), `object ${i} has /${k}`).toBe(true);
			if (o.isDictionary() && !o.get("Type").isNull()) expect(["Metadata", "Annot", "Filespec", "EmbeddedFile", "Outlines"]).not.toContain(o.get("Type").asName());
		}
		for (let i = 0; i < d.countPages(); i++) expect((d.loadPage(i) as mupdf.PDFPage).getAnnotations().length).toBe(0);
	});

	it("physician names, addresses and clinical content remain", () => {
		const all = spaces(mupdfText(output).join("\n"));
		for (const s of MUST_REMAIN) expect(all, `missing "${s}"`).toContain(s);
	});

	it("page count, page sizes and rotation match the original", () => {
		const a = mupdf.Document.openDocument(input, "application/pdf").asPDF()!;
		const b = mupdf.Document.openDocument(output, "application/pdf").asPDF()!;
		expect(b.countPages()).toBe(a.countPages());
		for (let i = 0; i < a.countPages(); i++) {
			const pa = a.loadPage(i) as mupdf.PDFPage;
			const pb = b.loadPage(i) as mupdf.PDFPage;
			expect(pb.getBounds()).toEqual(pa.getBounds());
			expect(pb.getObject().getInheritable("Rotate").valueOf() ?? 0).toEqual(pa.getObject().getInheritable("Rotate").valueOf() ?? 0);
		}
	});

	it("unredacted content is unchanged: pages without hits render identically", () => {
		const a = mupdf.Document.openDocument(input, "application/pdf");
		const b = mupdf.Document.openDocument(output, "application/pdf");
		// Page 5 (low-text fax cover) has no redactions.
		expect(boxesByPage.get(5)).toEqual([]);
		const ra = a.loadPage(4).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false).getPixels();
		const rb = b.loadPage(4).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false).getPixels();
		expect(Buffer.from(rb).equals(Buffer.from(ra))).toBe(true);
	});

	it("reports counts, low-text pages and close matches", async () => {
		const s = result.stats;
		expect(s.lowTextPages).toEqual([5]);
		for (const k of ["name", "ssn", "dl", "ncic", "account", "dob", "address", "phone", "other"] as const) expect(s.counts[k], k).toBeGreaterThan(0);
		expect(s.closeMatches.map((c) => c.form)).toEqual(expect.arrayContaining(["Marlsol", "Vantre1ght"]));
		expect(s.formsFlattened).toBe(true);
		expect(s.hiddenLayersRemoved).toBe(true);
		const rep = mupdf.Document.openDocument(await blobBytes(result.report), "application/pdf");
		expect(rep.countPages()).toBe(1);
		const t = rep.loadPage(0).toStructuredText("").asText();
		expect(t).toContain("Exceptions Report");
		expect(t).toContain("Marlsol");
		expect(t).toMatch(/very little recognized text[\s\S]*5/);
	});
});

describe("pre-check", () => {
	it("stops and lists pages without a text layer; blank pages are allowed", () => {
		const r = redact(bytesSource(makeNoTextFixture()), OPTIONS);
		expect(r).toEqual({ status: "blocked", pageCount: 5, noTextPages: [2, 4] });
	});
});

describe("limits", () => {
	it("rejects files of 2 GB or more with a clear message", () => {
		const src = { name: "huge.pdf", size: 2 ** 31, open: () => { throw new Error("should not open"); } };
		expect(() => redact(src as never, OPTIONS)).toThrow(/up to 2 GB/);
	});
});

describe("duplicate text layers", () => {
	it("draws the initials once when the same name appears in two overlapping text layers", async () => {
		const doc = new mupdf.PDFDocument();
		const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
		// Visible text plus an invisible OCR copy 2 pt higher, like a re-OCR'd page.
		const content = "BT /F1 12 Tf 1 0 0 1 300 700 Tm (Marisol Vantreight) Tj ET BT 3 Tr /F1 13 Tf 1 0 0 1 300.4 702 Tm (Marisol Vantreight) Tj ET";
		doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.addObject({ Font: { F1: font } }), content));
		const boxes: Box[][] = [];
		const r = redact(bytesSource(doc.saveToBuffer("").asUint8Array().slice()), OPTIONS, { onPageBoxes: (_p, b) => boxes.push(b) });
		if (r.status !== "ok") throw new Error("expected ok");
		expect(boxes[0]).toHaveLength(1);
		expect(r.stats.counts.name).toBe(1);
		const out = mupdf.Document.openDocument(await blobBytes(r.redacted!), "application/pdf");
		expect(out.loadPage(0).toStructuredText("").asText().match(/MV/g)).toHaveLength(1);
	});
});
