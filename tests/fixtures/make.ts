// Synthetic test documents. Every person, number and address here is invented.
// Nothing in this file comes from a real client document.

import * as mupdf from "mupdf";
import { PdfAssembler, type ByteSink } from "../../src/engine/assembler";
import type { RedactOptions } from "../../src/engine/types";

export const PERSON = {
	full: "Marisol Q. Vantreight",
	variants: ["Mari Vantreight", "Marisol Delacroix", "Marisol Vantrite"],
	initials: "MV",
	dob: "03/14/1979",
	ssn: "078-05-1120",
	dl: "B4419082",
	cii: "A12345678",
	mrn: "00482913",
	policy: "PLX-55-778201",
	member: "W83920014",
	claim: "2024 5518 7731",
	bank: "000123456789",
	acct: "88120034",
	address: "4821 Calloway Ridge Road, Apt 12B, Fresno, CA 93722",
	phone: "(559) 555-0143",
	other: "Thaddeus Okonkwo-Brill",
	otherPhone: "916-555-0199",
};

export const OPTIONS: RedactOptions = {
	fullName: PERSON.full,
	variants: PERSON.variants,
	initials: PERSON.initials,
	dob: "1979-03-14",
	addresses: [PERSON.address],
	phones: [PERSON.phone],
	otherNames: [PERSON.other],
	otherAddresses: [],
	otherPhones: [PERSON.otherPhone],
};

/** Strings that must not survive in the output text (compared without whitespace, case-insensitive). */
export const PROTECTED = [
	"Vantreight", "Marisol", "Delacroix", "Vantrite", "Vantre1ght", "Marlsol", "VANTREIGHT",
	"078-05-1120", "078051120", "O78-O5-ll2O", "03/14/1979", "March 14, 1979", "1979-03-14", "3/14/79",
	"4821 Calloway", "Calloway Ridge", "555-0143", "5550143", "00482913", "PLX-55-778201", "W83920014",
	"202455187731", "B4419082", "A12345678", "000123456789", "88120034", "Okonkwo", "Thaddeus", "916-555-0199",
	"07/04/1980",
];
/** Whole words that must not survive (e.g. the nickname). */
export const PROTECTED_WORDS = ["mari", "marisol", "vantreight"];

/** Third-party and clinical content that must survive. */
export const MUST_REMAIN = [
	"Thomas Nguyen", "1200 Medical Plaza Drive", "Fresno, CA 93721", "(559) 555-0100", "Priya Raman",
	"77 Shaw Avenue", "Clovis, CA 93612", "(559) 555-0177", "Lumbar radiculopathy", "M54.16", "Gabapentin 300 mg",
	"$185.00", "99213", "$1,240.00", "Physical therapy",
];

// ---------------------------------------------------------------------------

type TextLine = { x: number; y: number; size: number; text: string; bold?: boolean };

const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);

function textOps(lines: TextLine[], mode = 0): string {
	let s = `BT ${mode} Tr\n`;
	for (const l of lines) s += `/${l.bold ? "F2" : "F1"} ${l.size} Tf 1 0 0 1 ${l.x} ${l.y} Tm (${esc(l.text)}) Tj\n`;
	return s + "ET\n";
}

/** Lay out paragraphs top-down from y=740. */
function layout(paras: (string | [string, { bold?: boolean; size?: number; x?: number }])[]): TextLine[] {
	let y = 740;
	const out: TextLine[] = [];
	for (const p of paras) {
		const [text, o] = typeof p === "string" ? [p, {}] : p;
		const size = o.size ?? 11;
		if (text) out.push({ x: o.x ?? 60, y, size, text, bold: o.bold });
		y -= size * 1.55;
	}
	return out;
}

function fontsRes(doc: mupdf.PDFDocument, extra: Record<string, unknown> = {}) {
	return doc.addObject({
		Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")), F2: doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")) },
		...extra,
	});
}

function addTextPage(doc: mupdf.PDFDocument, lines: TextLine[], extraContent = "", extraRes: Record<string, unknown> = {}) {
	const page = doc.addPage([0, 0, 612, 792], 0, fontsRes(doc, extraRes), textOps(lines) + extraContent);
	doc.insertPage(-1, page);
	return page;
}

/** Deterministic PRNG so fixtures are reproducible. */
function rng(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * A "Searchable Image" page like Acrobat produces: a JPEG scan of the page plus an
 * invisible (render mode 3) OCR text layer at the same positions. `ocrLines` may
 * differ from `lines` to simulate recognition errors.
 */
function addScannedPage(doc: mupdf.PDFDocument, lines: TextLine[], ocrLines: TextLine[] | null, dpi = 150, seed = 1, grain = 0.08) {
	// Render the clean page in a scratch document.
	const tmp = new mupdf.PDFDocument();
	tmp.insertPage(-1, tmp.addPage([0, 0, 612, 792], 0, fontsRes(tmp), textOps(lines)));
	const page = tmp.loadPage(0);
	const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceGray, false);
	// Speckle noise, like a photocopy.
	const px = pix.getPixels();
	const r = rng(seed);
	const step = grain > 0.08 ? 9 : 37;
	for (let i = 0; i < px.length; i += step) if (r() < grain) px[i] = Math.floor(150 + r() * 90);
	const jpeg = pix.asJPEG(70);
	pix.destroy();
	page.destroy();
	tmp.destroy();
	const img = doc.addImage(new mupdf.Image(jpeg));
	const content = "q 612 0 0 792 0 0 cm /Im0 Do Q\n" + (ocrLines ? textOps(ocrLines, 3) : "");
	doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, fontsRes(doc, { XObject: { Im0: img } }), content));
}

const P = PERSON;

const intake = () =>
	layout([
		["VALLEY ORTHOPEDIC ASSOCIATES - PATIENT INTAKE", { bold: true, size: 14 }],
		"",
		`Patient Name: ${P.full}`,
		`Date of Birth: ${P.dob}        Sex: F`,
		`SSN: ${P.ssn}`,
		`Driver's License: ${P.dl}       CII: ${P.cii}`,
		`Home Address: ${P.address}`,
		`Phone: ${P.phone}      Alt: 559.555.0143`,
		`MRN: ${P.mrn}`,
		`Insurance: Golden State Health   Policy No. ${P.policy}   Member ID ${P.member}`,
		`Bank account for refunds: Acct # ${P.bank}`,
		`Emergency contact: ${P.other}, brother-in-law, ${P.otherPhone}`,
		"",
		["Treating Physician", { bold: true }],
		"Dr. Thomas Nguyen, MD",
		"1200 Medical Plaza Drive, Fresno, CA 93721",
		"Office: (559) 555-0100",
		"",
		"Referring: Priya Raman, NP, 77 Shaw Avenue, Clovis, CA 93612, (559) 555-0177",
	]);

const note = () =>
	layout([
		["PROGRESS NOTE", { bold: true, size: 14 }],
		"",
		"Patient: VANTREIGHT, MARISOL Q.     DOB: 3/14/79",
		"Ms. Vantreight returns for follow-up of low back pain. Mari reports the pain",
		"is 6/10 and radiates to the left leg. Vantreight's husband drove her today. The",
		"patient Marisol",
		"Vantreight (nee Delacroix) also asked about Physical therapy.",
		"Assessment: Lumbar radiculopathy (M54.16). White blood cell count normal.",
		"Plan: Gabapentin 300 mg TID. Physical therapy 2x/week for 6 weeks.",
		"Seen with Priya Raman, NP. Electronically signed: Thomas Nguyen, MD",
		"Born March 14, 1979. Alternate DOB on file 1979-03-14.",
	]);

const billing = () => [
	...layout([
		["STATEMENT", { bold: true, size: 14 }],
		"",
		`Guarantor: Marisol Vantrite        Claim # ${P.claim}`,
		"Valley Orthopedic Associates, 1200 Medical Plaza Drive, Fresno, CA 93721",
	]),
	{ x: 60, y: 640, size: 10, text: "Account No.", bold: true },
	{ x: 180, y: 640, size: 10, text: "Date of Service", bold: true },
	{ x: 300, y: 640, size: 10, text: "CPT", bold: true },
	{ x: 360, y: 640, size: 10, text: "Description", bold: true },
	{ x: 500, y: 640, size: 10, text: "Charge", bold: true },
	{ x: 60, y: 624, size: 10, text: P.acct },
	{ x: 180, y: 624, size: 10, text: "01/15/2024" },
	{ x: 300, y: 624, size: 10, text: "99213" },
	{ x: 360, y: 624, size: 10, text: "Office visit" },
	{ x: 500, y: 624, size: 10, text: "$185.00" },
	{ x: 180, y: 608, size: 10, text: "02/02/2024" },
	{ x: 300, y: 608, size: 10, text: "97110" },
	{ x: 360, y: 608, size: 10, text: "Physical therapy" },
	{ x: 500, y: 608, size: 10, text: "$1,240.00" },
	{ x: 60, y: 570, size: 10, text: "Account Balance: $1,425.00   Please remit within 30 days." },
];

const scanLines = () =>
	layout([
		["DISCHARGE SUMMARY (scanned)", { bold: true, size: 14 }],
		"",
		"Patient: Marisol Vantreight    DOB: 03/14/1979",
		"SSN 078-05-1120    D.O.B. 07/04/1980 (as written on old chart)",
		"Address: 4821 Calloway Ridge Rd, Fresno, CA 93722",
		"Attending: Thomas Nguyen, MD, 1200 Medical Plaza Drive",
		"Dx: Lumbar radiculopathy (M54.16). Rx: Gabapentin 300 mg.",
	]);
// OCR text layer with recognition errors.
const scanOcr = () =>
	scanLines().map((l) => ({
		...l,
		text: l.text.replace("Marisol Vantreight", "Marlsol Vantre1ght").replace("078-05-1120", "O78-O5-ll2O").replace("03/14/1979", "O3/14/l979"),
	}));

const physicianLetter = () =>
	layout([
		["Thomas Nguyen, MD", { bold: true, size: 13 }],
		"1200 Medical Plaza Drive, Fresno, CA 93721  |  (559) 555-0100",
		"",
		"To whom it may concern:",
		"Our patient, Ms. Vantreight, has been under my care since 2022 for",
		"Lumbar radiculopathy (M54.16). Please direct records requests to my office",
		"or to Priya Raman, NP, 77 Shaw Avenue, Clovis, CA 93612, (559) 555-0177.",
		"Sincerely, Thomas Nguyen, MD",
	]);

/** Main fixture: every redaction category plus every metadata/hidden-content trap. */
export function makeMainFixture(): Uint8Array {
	const doc = new mupdf.PDFDocument();
	addTextPage(doc, intake());
	addTextPage(doc, note());
	addTextPage(doc, billing());
	addScannedPage(doc, scanLines(), scanOcr(), 150, 7);
	// Low-text scanned page (a mostly empty fax cover).
	addScannedPage(doc, layout([["FAX", { bold: true, size: 30 }]]), layout([["FAX", { bold: true, size: 30 }]]), 100, 9);

	// Hidden-content trap page.
	const ocg = doc.addObject({ Type: "OCG", Name: "Hidden notes" });
	const hiddenContent = [
		"/OC /OC1 BDC BT /F1 11 Tf 60 400 Td (HIDDEN LAYER: Marisol Vantreight SSN 078-05-1120) Tj ET EMC",
		"/Span <</ActualText (Marisol Vantreight)>> BDC BT /F1 11 Tf 60 380 Td (M. V.) Tj ET EMC",
		"BT /F1 11 Tf 640 300 Td (OFFPAGE Marisol Vantreight) Tj ET",
	].join("\n");
	const trap = addTextPage(
		doc,
		layout([["CORRESPONDENCE", { bold: true, size: 14 }], "", "Re: Marisol Vantreight, claim follow-up.", "Lumbar radiculopathy (M54.16) remains the working diagnosis."]),
		hiddenContent,
		{ Properties: { OC1: ocg } },
	);
	const root = doc.getTrailer().get("Root");
	root.put("OCProperties", { OCGs: [ocg], D: { OFF: [ocg] } });

	// Rotated page.
	const rot = doc.addPage([0, 0, 612, 792], 90, fontsRes(doc), textOps(layout(["Patient Marisol Vantreight  DOB 03/14/1979", "Seen by Thomas Nguyen, MD"])));
	doc.insertPage(-1, rot);

	addTextPage(doc, physicianLetter());

	// --- Metadata, XMP, bookmarks, JS, embedded file, annotations, form field, thumbnail.
	doc.setMetaData("info:Author", "Marisol Vantreight");
	doc.setMetaData("info:Title", "Records of Marisol Vantreight");
	doc.setMetaData("info:Subject", "SSN 078-05-1120");
	const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description dc:creator="Marisol Vantreight" xmlns:dc="http://purl.org/dc/elements/1.1/"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
	root.put("Metadata", doc.addStream(xmp, { Type: "Metadata", Subtype: "XML" }));
	const p0 = doc.findPage(0);
	const outlineItem = doc.addObject({ Title: "Vantreight intake", Dest: [p0, "Fit"] });
	const outlines = doc.addObject({ Type: "Outlines", First: outlineItem, Last: outlineItem, Count: 1 });
	outlineItem.put("Parent", outlines);
	root.put("Outlines", outlines);
	const js = doc.addObject({ S: "JavaScript", JS: "app.alert('Marisol Vantreight');" });
	root.put("OpenAction", js);
	root.put("Names", { JavaScript: { Names: ["open", js] } });
	doc.addEmbeddedFile("notes.txt", "text/plain", new TextEncoder().encode("Marisol Vantreight SSN 078-05-1120"), new Date(), new Date());
	root.put("PageLabels", { Nums: [0, { S: "D" }] });
	root.put("StructTreeRoot", doc.addObject({ Type: "StructTreeRoot", K: doc.addObject({ S: "P", Alt: "Marisol Vantreight" }) }));

	// Annotations: a sticky note, a link with JavaScript, and a filled form field.
	const pg1 = doc.loadPage(1) as mupdf.PDFPage;
	const note1 = pg1.createAnnotation("Text");
	note1.setRect([500, 700, 520, 720]);
	note1.setContents("Call Marisol Vantreight at 559-555-0143");
	note1.setAuthor("Marisol Vantreight");
	pg1.update();
	const p1 = doc.findPage(1);
	p1.get("Annots").push(doc.addObject({ Type: "Annot", Subtype: "Link", Rect: [60, 60, 200, 80], A: { S: "JavaScript", JS: "app.alert('Vantreight')" } }));
	const tf = doc.addObject({ Font: { Helv: doc.addSimpleFont(new mupdf.Font("Helvetica")) } });
	const ap = doc.addStream("/Tx BMC q BT /Helv 10 Tf 2 4 Td (Marisol Vantreight) Tj ET Q EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 18], Resources: tf });
	const widget = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: "patient_name", V: "Marisol Vantreight", Rect: [350, 60, 550, 78], AP: { N: ap }, F: 4, P: p1 });
	p1.get("Annots").push(widget);
	root.put("AcroForm", { Fields: [widget], DA: "/Helv 10 Tf 0 g", DR: tf });
	// Page thumbnail (an unredacted mini image of the page).
	const thumbPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 61, 79], false);
	thumbPix.clear(128);
	p0.put("Thumb", doc.addImage(new mupdf.Image(thumbPix)));
	p0.put("PieceInfo", { App: { Private: "Marisol Vantreight" } });
	void trap;

	return doc.saveToBuffer("compress=yes").asUint8Array().slice();
}

/** A file where page 2 is a scan with no OCR text layer. */
export function makeNoTextFixture(): Uint8Array {
	const doc = new mupdf.PDFDocument();
	addTextPage(doc, intake());
	addScannedPage(doc, note(), null, 100, 3);
	addTextPage(doc, physicianLetter());
	addScannedPage(doc, billing(), null, 100, 4);
	// A truly blank separator page is allowed.
	doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
	return doc.saveToBuffer("compress=yes").asUint8Array().slice();
}

/**
 * Large mixed document for performance tests, built in chunks so it never has to fit
 * in the 2 GB WASM heap. Returns a Blob (stream it to disk).
 */
export function makeBigFixture(pages: number, opts: { scanRatio?: number; dpi?: number; grain?: number; sink?: ByteSink; onProgress?: (n: number) => void } = {}): Blob | undefined {
	const scanRatio = opts.scanRatio ?? 0.6;
	const dpi = opts.dpi ?? 200;
	const asm = new PdfAssembler(opts.sink);
	const templates = [intake, note, billing, physicianLetter];
	const CH = 50;
	for (let first = 0; first < pages; first += CH) {
		const doc = new mupdf.PDFDocument();
		for (let i = first; i < Math.min(pages, first + CH); i++) {
			const lines = templates[i % templates.length]();
			lines.push({ x: 500, y: 40, size: 9, text: `Page ${i + 1}` });
			if (i % 10 < scanRatio * 10) {
				const ocr = lines.map((l) => ({ ...l, text: i % 3 === 0 ? l.text.replace("Vantreight", "Vantre1ght") : l.text }));
				addScannedPage(doc, lines, ocr, dpi, i + 1, opts.grain ?? 0.08);
			} else addTextPage(doc, lines);
		}
		const buf = doc.saveToBuffer("compress=yes");
		asm.addChunk(buf.asUint8Array());
		buf.destroy();
		doc.destroy();
		mupdf.emptyStore();
		opts.onProgress?.(Math.min(pages, first + CH));
	}
	return asm.finish();
}
