import * as mupdf from "mupdf";
import { PdfAssembler, type ByteSink } from "./assembler";
import { withBuffer } from "./buffers";
import { filterContent, needsFilter, type FilterEnv } from "./contentfilter";
import { Detector } from "./detect";
import { redactPageImages } from "./imageredact";
import { addSubsetFont, drawBoxes, makeFontSubset, type Box } from "./overlay";
import { buildReport } from "./report";
import { buildPageText, quadBounds, rangeToRects } from "./textmap";
import type { Category, Rect, RedactOptions } from "./types";

export const APP_VERSION = "1.0.0";

export interface Source {
	name: string;
	size: number;
	/** Open a fresh MuPDF stream over the file (read on demand, never fully loaded). */
	open(): mupdf.Stream;
}

export interface Fonts {
	bold: Uint8Array;
	regular: Uint8Array;
}

export interface Progress {
	phase: "precheck" | "redact" | "assemble" | "report";
	done: number;
	total: number;
}

export interface Config {
	batchSize: number;
	lowTextThreshold: number;
	/** Called after each chunk; used by tests and the perf harness. */
	onChunk?: (info: { pagesDone: number }) => void;
	/** Output destination (default: memory). The browser streams to a file on disk. */
	sink?: ByteSink;
	/** Called with the boxes drawn on each page (tests verify pixels under them). */
	onPageBoxes?: (pageNo: number, boxes: Box[]) => void;
}

export interface CloseMatch {
	form: string;
	count: number;
	pages: number[];
}

export interface Stats {
	fileName: string;
	pageCount: number;
	lowTextPages: number[];
	blankPages: number[];
	counts: Record<Category, number>;
	closeMatches: CloseMatch[];
	formsFlattened: boolean;
	hiddenLayersRemoved: boolean;
	imageFallbackPages: number;
	inputBytes: number;
	outputBytes: number;
	elapsedMs: number;
	processedAt: string;
}

export type RunResult =
	| { status: "blocked"; pageCount: number; noTextPages: number[] }
	/** `redacted` is undefined when the output was written to an external sink. */
	| { status: "ok"; redacted: Blob | undefined; report: Blob; stats: Stats };

export const DEFAULT_CONFIG: Config = { batchSize: 100, lowTextThreshold: 40 };

const STEXT_OPTS = "preserve-whitespace,ignore-actualtext,clip=no";
const PAGE_KEYS_TO_STRIP = ["Annots", "B", "Thumb", "AA", "Metadata", "PieceInfo", "StructParents", "ID", "PZ", "SeparationInfo", "Tabs", "LastModified"];
const OBJECT_KEYS_TO_STRIP = ["Metadata", "PieceInfo", "LastModified", "StructParent", "StructParents", "OC"];

export class EngineError extends Error {}

/** mupdf.js streams pass file sizes and offsets as 32-bit integers. */
export const MAX_INPUT_BYTES = 2 ** 31 - 1;

function openPdf(src: Source): mupdf.PDFDocument {
	if (src.size > MAX_INPUT_BYTES)
		throw new EngineError(
			`This file is ${(src.size / 2 ** 30).toFixed(2)} GB. The PDF engine can open files up to 2 GB. Split it in Acrobat (Organize Pages → Split) and redact each part.`,
		);
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(src.open(), "application/pdf");
	} catch (e) {
		throw new EngineError(`This file could not be opened as a PDF (${(e as Error).message}).`);
	}
	if (doc.needsPassword()) throw new EngineError("This PDF is password-protected or encrypted. Remove the password in Acrobat and try again.");
	const pdf = doc.asPDF();
	if (!pdf) throw new EngineError("This file is not a PDF.");
	return pdf;
}

/** Pass 1: every page must have a text layer. */
export function precheck(doc: mupdf.PDFDocument, onProgress?: (p: Progress) => void) {
	const n = doc.countPages();
	const charCounts = new Int32Array(n);
	const noText: number[] = [];
	const blank: number[] = [];
	for (let i = 0; i < n; i++) {
		const page = doc.loadPage(i);
		const st = page.toStructuredText("preserve-whitespace");
		const count = st.asText().replace(/\s+/g, "").length;
		st.destroy();
		charCounts[i] = count;
		if (count === 0) {
			if (isBlank(page)) blank.push(i + 1);
			else noText.push(i + 1);
		}
		page.destroy();
		if (onProgress && (i % 10 === 9 || i === n - 1)) onProgress({ phase: "precheck", done: i + 1, total: n });
	}
	return { pageCount: n, charCounts, noText, blank };
}

/** A page with no text is allowed only if it renders as (nearly) pure white. */
function isBlank(page: mupdf.Page): boolean {
	const b = page.getBounds();
	const scale = Math.min(1, 200 / Math.max(1, b[2] - b[0], b[3] - b[1]));
	const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false);
	const px = pix.getPixels();
	let dark = 0;
	for (let i = 0; i < px.length; i++) if (px[i] < 235) dark++;
	pix.destroy();
	return dark <= px.length * 0.001;
}

function emptyCounts(): Record<Category, number> {
	return { name: 0, ssn: 0, dl: 0, ncic: 0, account: 0, dob: 0, address: 0, phone: 0, other: 0 };
}

/** Evaluate an OCG or OCMD against the set of OCG object numbers that are off. */
function ocHidden(oc: mupdf.PDFObject, off: Set<number>): boolean {
	if (!oc || oc.isNull() || off.size === 0) return false;
	const type = oc.get("Type");
	if (!type.isNull() && type.asName() === "OCMD") {
		const ocgs = oc.get("OCGs");
		const list: mupdf.PDFObject[] = [];
		if (ocgs.isArray()) ocgs.forEach((v) => list.push(v));
		else if (!ocgs.isNull()) list.push(ocgs);
		if (!list.length) return false;
		const on = list.map((g) => !(g.isIndirect() && off.has(g.asIndirect())));
		const p = oc.get("P").isNull() ? "AnyOn" : oc.get("P").asName();
		if (p === "AllOn") return !on.every(Boolean);
		if (p === "AnyOff") return on.every(Boolean);
		if (p === "AllOff") return on.some(Boolean);
		return !on.some(Boolean); // AnyOn
	}
	return oc.isIndirect() && off.has(oc.asIndirect());
}

function offOCGs(ocprops: mupdf.PDFObject): Set<number> {
	const off = new Set<number>();
	if (ocprops.isNull()) return off;
	const d = ocprops.get("D");
	const nums = (arr: mupdf.PDFObject) => {
		const out: number[] = [];
		if (arr.isArray()) arr.forEach((v) => v.isIndirect() && out.push(v.asIndirect()));
		return out;
	};
	if (!d.get("BaseState").isNull() && d.get("BaseState").asName() === "OFF") {
		const on = new Set(nums(d.get("ON")));
		for (const n of nums(ocprops.get("OCGs"))) if (!on.has(n)) off.add(n);
	}
	for (const n of nums(d.get("OFF"))) off.add(n);
	return off;
}

/** Strip hidden text from a content stream (and nested form XObjects). */
function filterStreams(contents: mupdf.PDFObject, res: mupdf.PDFObject, off: Set<number>, seen: Set<number>) {
	const env: FilterEnv = {
		isHiddenOC: (name) => !res.isNull() && ocHidden(res.get("Properties").get(name), off),
		isHiddenXObject: (name) => !res.isNull() && ocHidden(res.get("XObject").get(name).get("OC"), off),
	};
	const streams: mupdf.PDFObject[] = [];
	if (contents.isArray()) contents.forEach((v) => streams.push(v));
	else if (!contents.isNull()) streams.push(contents);
	for (const s of streams) {
		if (!s.isStream()) continue;
		if (s.isIndirect()) {
			if (seen.has(s.asIndirect())) continue;
			seen.add(s.asIndirect());
		}
		const buf = s.readStream();
		const data = buf.asUint8Array().slice();
		buf.destroy();
		if (!needsFilter(data, off.size > 0)) continue;
		const out = filterContent(data, env);
		if (out) withBuffer(out, (b) => s.writeStream(b));
	}
	// Recurse into form XObjects.
	if (res.isNull()) return;
	const xo = res.get("XObject");
	if (!xo.isDictionary()) return;
	xo.forEach((v) => {
		if (!v.isStream() || v.get("Subtype").isNull() || v.get("Subtype").asName() !== "Form") return;
		if (v.isIndirect() && seen.has(v.asIndirect())) return;
		const r = v.get("Resources");
		filterStreams(v, r.isNull() ? res : r, off, seen);
	});
}

/** Pass 2+3: redact every page, in chunks, and assemble the output. */
export function runRedaction(src: Source, opts: RedactOptions, fonts: Fonts, onProgress: (p: Progress) => void, cfg: Config = DEFAULT_CONFIG): RunResult {
	const t0 = Date.now();
	const doc = openPdf(src);
	const pre = precheck(doc, onProgress);
	if (pre.noText.length) {
		doc.destroy();
		return { status: "blocked", pageCount: pre.pageCount, noTextPages: pre.noText };
	}

	const detector = new Detector(opts);
	const bold = withBuffer(fonts.bold, (b) => new mupdf.Font("Arimo-Bold", b));
	const boldSubset = makeFontSubset(bold);
	const counts = emptyCounts();
	const close = new Map<string, { count: number; pages: number[] }>();
	const n = pre.pageCount;

	// Flatten form fields into page content so their values are redacted like any text.
	const root = doc.getTrailer().get("Root");
	const acro = root.get("AcroForm");
	const formsFlattened = !acro.isNull() && acro.get("Fields").length > 0;
	if (formsFlattened) doc.bake(false, true);
	const srcOC = root.get("OCProperties");
	const hiddenLayersRemoved = !srcOC.isNull() && offOCGs(srcOC).size > 0;

	const asm = new PdfAssembler(cfg.sink);
	let imageFallbackPages = 0;
	for (let first = 0; first < n; first += cfg.batchSize) {
		const last = Math.min(n, first + cfg.batchSize);
		const chunk = new mupdf.PDFDocument();
		const gm = chunk.newGraftMap();
		for (let i = first; i < last; i++) {
			const po = doc.findPage(i);
			for (const k of PAGE_KEYS_TO_STRIP) po.delete(k);
			gm.graftPage(-1, doc, i);
		}
		let off = new Set<number>();
		if (hiddenLayersRemoved) off = offOCGs(gm.graftObject(srcOC));
		let fontObj: mupdf.PDFObject | null = null;
		const getFont = () => (fontObj ??= addSubsetFont(chunk, bold, boldSubset));
		const seen = new Set<number>();

		for (let j = 0; j < last - first; j++) {
			const pageNo = first + j + 1;
			const page = chunk.loadPage(j);
			const po = page.getObject();
			for (const k of PAGE_KEYS_TO_STRIP) po.delete(k);
			filterStreams(po.get("Contents"), po.get("Resources"), off, seen);

			const st = page.toStructuredText(STEXT_OPTS);
			const pt = buildPageText(st);
			st.destroy();
			const { hits, close: forms } = detector.detect(pt);

			// A page can carry the same words twice (e.g. original text plus an OCR layer),
			// so one name yields two nearly identical hits. Count it once, draw it once.
			const groups = dedupeHits(hits.map((h) => ({ cat: h.cat, initials: h.cat === "name" ? h.initials : undefined, rects: rangeToRects(pt, h.start, h.end) })));
			for (const g of groups) counts[g.cat]++;
			const boxes = mergeBoxes(groups.flatMap((g) => g.rects.map((rect) => ({ rect, initials: g.initials }))));
			for (const f of forms) {
				const e = close.get(f) ?? { count: 0, pages: [] };
				e.count++;
				if (e.pages[e.pages.length - 1] !== pageNo) e.pages.push(pageNo);
				close.set(f, e);
			}

			const outside = outsideRects(page.getBounds(), pt.quads);
			if (boxes.length || outside.length) {
				const rects = boxes.map((b) => b.rect);
				// Black out image pixels ourselves (keeps JPEG scans as JPEG); fall back to
				// MuPDF's pixel method only for images we cannot rewrite directly.
				const fallback = redactPageImages(chunk, page, rects);
				for (const r of [...rects, ...outside]) {
					// Destroy wrappers explicitly: each annotation holds a reference to the
					// chunk document, and WASM memory is invisible to the JS garbage collector.
					const a = page.createAnnotation("Redact");
					a.setRect(r);
					a.destroy();
				}
				page.applyRedactions(
					false,
					fallback ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : mupdf.PDFPage.REDACT_IMAGE_NONE,
					mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
					mupdf.PDFPage.REDACT_TEXT_REMOVE,
				);
				drawBoxes(chunk, page, boxes, bold, getFont);
				imageFallbackPages += fallback ? 1 : 0;
				// Decoded scan images are cached in MuPDF's store; drop them right away.
				mupdf.emptyStore();
			}
			cfg.onPageBoxes?.(pageNo, boxes);
			page.destroy();
			if (pageNo % 5 === 0 || pageNo === n) onProgress({ phase: "redact", done: pageNo, total: n });
		}

		sweepObjects(chunk);
		const root2 = chunk.getTrailer().get("Root");
		root2.delete("OCProperties");
		const buf = chunk.saveToBuffer("garbage=compact,compress=yes");
		asm.addChunk(buf.asUint8Array());
		buf.destroy();
		gm.destroy();
		chunk.destroy();
		mupdf.emptyStore();
		cfg.onChunk?.({ pagesDone: last });
	}
	doc.destroy();
	onProgress({ phase: "assemble", done: n, total: n });
	const redacted = asm.finish();

	const stats: Stats = {
		fileName: src.name,
		pageCount: n,
		lowTextPages: [...pre.charCounts].flatMap((c, i) => (c > 0 && c < cfg.lowTextThreshold ? [i + 1] : [])),
		blankPages: pre.blank,
		counts,
		closeMatches: [...close.entries()].map(([form, v]) => ({ form, ...v })).sort((a, b) => b.count - a.count),
		formsFlattened,
		hiddenLayersRemoved,
		imageFallbackPages,
		inputBytes: src.size,
		outputBytes: asm.size,
		elapsedMs: Date.now() - t0,
		processedAt: new Date().toISOString(),
	};
	onProgress({ phase: "report", done: n, total: n });
	const report = new Blob([buildReport(stats, fonts, APP_VERSION) as BlobPart], { type: "application/pdf" });
	bold.destroy();
	return { status: "ok", redacted, report, stats };
}

/**
 * If any text lies outside the visible page, return redaction areas covering everything
 * outside the page (starting 1pt beyond the edge so full-page scans are untouched).
 */
function outsideRects(b: Rect | number[], quads: PageText["quads"]): Rect[] {
	const [x0, y0, x1, y1] = b;
	let outside = false;
	for (const q of quads) {
		if (!q) continue;
		const r = quadBounds(q);
		if (r[2] < x0 + 0.5 || r[0] > x1 - 0.5 || r[3] < y0 + 0.5 || r[1] > y1 - 0.5) {
			outside = true;
			break;
		}
	}
	if (!outside) return [];
	const B = 100000;
	return [
		[-B, -B, B, y0 - 1],
		[-B, y1 + 1, B, B],
		[-B, y0 - 1, x0 - 1, y1 + 1],
		[x1 + 1, y0 - 1, B, y1 + 1],
	];
}

type PageText = import("./types").PageText;

function overlapRatio(a: Rect, b: Rect): number {
	const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	if (w <= 0 || h <= 0) return 0;
	const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
	return (w * h) / Math.max(1e-6, Math.min(area(a), area(b)));
}

interface HitGroup {
	cat: Category;
	initials?: string;
	rects: Rect[];
}

/** Two boxes on the same text line that largely cover each other. */
function sameSpot(a: Rect, b: Rect): boolean {
	const vOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	const minH = Math.min(a[3] - a[1], b[3] - b[1]);
	return vOverlap >= 0.6 * minH && overlapRatio(a, b) >= 0.5;
}

/** Drop hits whose every box lies on a box of an earlier hit (duplicate text layers). */
export function dedupeHits(groups: HitGroup[]): HitGroup[] {
	const out: HitGroup[] = [];
	for (const g of groups) {
		const dup = out.find((o) => o.cat === g.cat && g.rects.length > 0 && g.rects.every((r) => o.rects.some((q) => sameSpot(r, q))));
		if (dup) dup.rects.push(...g.rects);
		else out.push({ ...g, rects: [...g.rects] });
	}
	return out;
}

/**
 * Union boxes of the same kind that sit on the same spot (duplicate text layers), so the
 * initials are drawn once. Boxes on neighbouring lines, or a name box touching a plain
 * box (e.g. the MRN below it), are kept separate so the name keeps its initials.
 */
export function mergeBoxes(boxes: Box[]): Box[] {
	const out: Box[] = boxes.map((b) => ({ ...b, rect: [...b.rect] as Rect }));
	for (let changed = true; changed; ) {
		changed = false;
		for (let i = 0; i < out.length && !changed; i++) {
			for (let j = i + 1; j < out.length && !changed; j++) {
				if (!!out[i].initials !== !!out[j].initials || !sameSpot(out[i].rect, out[j].rect)) continue;
				const a = out[i].rect;
				const b = out[j].rect;
				out[i] = {
					rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
					initials: out[i].initials,
				};
				out.splice(j, 1);
				changed = true;
			}
		}
	}
	return out;
}

/** Remove metadata-bearing keys from every object in the chunk. */
function sweepObjects(doc: mupdf.PDFDocument) {
	const count = doc.countObjects();
	for (let i = 1; i < count; i++) {
		const o = doc.newIndirect(i).resolve();
		if (!o.isDictionary() && !o.isStream()) continue;
		for (const k of OBJECT_KEYS_TO_STRIP) if (!o.get(k).isNull()) o.delete(k);
		const t = o.get("Type");
		if (!t.isNull() && t.asName() === "Page") for (const k of PAGE_KEYS_TO_STRIP) if (!o.get(k).isNull()) o.delete(k);
	}
}
