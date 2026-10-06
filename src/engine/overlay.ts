import * as mupdf from "mupdf";
import { withBuffer } from "./buffers";
import type { Rect } from "./types";

export interface Box {
	rect: Rect; // MuPDF page space (y down)
	initials?: string;
}

const FONT_KEY = "F6068R";
const ARIMO_CAP_HEIGHT = 0.716;

const n = (v: number) => (Math.abs(v) < 1e-4 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""));

/**
 * Draw solid black boxes (and white initials) on top of the page content. Called after
 * applyRedactions has removed the text and pixels underneath, so the boxes are only the
 * visible marker — the removal itself is already permanent.
 */
export function drawBoxes(doc: mupdf.PDFDocument, page: mupdf.PDFPage, boxes: Box[], font: mupdf.Font, fontObj: () => mupdf.PDFObject) {
	if (!boxes.length) return;
	const inv = mupdf.Matrix.invert(page.getTransform());
	let s = `Q\nq\n${inv.map(n).join(" ")} cm\n0 g\n`;
	for (const b of boxes) {
		const [x0, y0, x1, y1] = b.rect;
		s += `${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)} re\n`;
	}
	s += "f\n";
	const withText = boxes.filter((b) => b.initials);
	if (withText.length) {
		s += "1 g\nBT\n";
		for (const b of withText) {
			const [x0, y0, x1, y1] = b.rect;
			const w = x1 - x0;
			const h = y1 - y0;
			const gids = [...b.initials!].map((c) => font.encodeCharacter(c.codePointAt(0)!));
			const adv = gids.reduce((a, g) => a + font.advanceGlyph(g, 0), 0) || 1;
			const size = Math.max(0.5, Math.min(h * 0.85, (w * 0.78) / adv));
			const tx = x0 + (w - adv * size) / 2;
			const ty = y0 + h / 2 + (ARIMO_CAP_HEIGHT * size) / 2;
			const hex = gids.map((g) => g.toString(16).padStart(4, "0")).join("");
			// Text space is flipped (y down) to match the page-space matrix above.
			s += `/${FONT_KEY} 1 Tf ${n(size)} 0 0 ${n(-size)} ${n(tx)} ${n(ty)} Tm <${hex}> Tj\n`;
		}
		s += "ET\n";
		const pageObj = page.getObject();
		let res = pageObj.get("Resources");
		if (res.isNull()) {
			pageObj.put("Resources", doc.newDictionary());
			res = pageObj.get("Resources");
		}
		let fonts = res.get("Font");
		if (fonts.isNull()) {
			res.put("Font", doc.newDictionary());
			fonts = res.get("Font");
		}
		fonts.put(FONT_KEY, fontObj());
	}
	s += "Q\n";
	wrapContents(doc, page.getObject(), s);
}

/** Contents := [ "q", ...original, overlay ] so the overlay starts from a clean state. */
function wrapContents(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject, overlay: string) {
	const contents = pageObj.get("Contents");
	const arr = doc.newArray();
	arr.push(withBuffer("q\n", (b) => doc.addStream(b, {})));
	if (contents.isArray()) contents.forEach((v) => arr.push(v));
	else if (!contents.isNull()) arr.push(contents);
	arr.push(withBuffer(overlay, (b) => doc.addStream(b, {})));
	pageObj.put("Contents", arr);
}

/**
 * Build a subset of the initials font (printable Latin glyphs only) once per run.
 * MuPDF's subsetter keeps glyph ids, so the full font is still used for encoding and
 * metrics while each chunk embeds only these ~50 KB instead of the ~480 KB original.
 */
export function makeFontSubset(font: mupdf.Font): Uint8Array {
	const doc = new mupdf.PDFDocument();
	const fo = doc.addFont(font);
	let chars = "";
	for (let c = 0x20; c < 0x7f; c++) chars += String.fromCharCode(c);
	for (let c = 0xc0; c <= 0x17f; c++) chars += String.fromCharCode(c);
	const hex = [...chars].map((c) => font.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("");
	doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.addObject({ Font: { F: fo } }), `BT /F 10 Tf 10 10 Td <${hex}> Tj ET`));
	doc.subsetFonts();
	const buf = fo.get("DescendantFonts").get(0).get("FontDescriptor").get("FontFile2").readStream();
	const out = buf.asUint8Array().slice();
	buf.destroy();
	doc.destroy();
	return out;
}

/** Add the initials font to a chunk document, embedding only the subset bytes. */
export function addSubsetFont(doc: mupdf.PDFDocument, font: mupdf.Font, subset: Uint8Array): mupdf.PDFObject {
	const fo = doc.addFont(font);
	withBuffer(subset, (b) => fo.get("DescendantFonts").get(0).get("FontDescriptor").get("FontFile2").writeStream(b));
	return fo;
}
