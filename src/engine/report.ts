import * as mupdf from "mupdf";
import { withBuffer } from "./buffers";
import type { Fonts, Stats } from "./pipeline";
import { CATEGORY_LABELS, type Category } from "./types";

/** Compress [1,2,3,7,9,10] -> "1–3, 7, 9–10". */
export function pageRanges(pages: number[]): string {
	const out: string[] = [];
	for (let i = 0; i < pages.length; ) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
		out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
		i = j + 1;
	}
	return out.join(", ");
}

interface Line {
	text: string;
	bold?: boolean;
	size?: number;
	gap?: number; // extra space before
	indent?: number;
}

/** One-page exceptions report (US Letter), built with MuPDF and the bundled Arimo fonts. */
export function buildReport(s: Stats, fonts: Fonts, version: string): Uint8Array {
	const doc = new mupdf.PDFDocument();
	const fReg = withBuffer(fonts.regular, (b) => new mupdf.Font("Arimo", b));
	const fBold = withBuffer(fonts.bold, (b) => new mupdf.Font("Arimo-Bold", b));
	const res = doc.addObject({ Font: { R: doc.addFont(fReg), B: doc.addFont(fBold) } });

	const W = 612;
	const H = 792;
	const M = 54;
	const maxW = W - 2 * M;
	const width = (t: string, f: mupdf.Font, size: number) => [...t].reduce((a, c) => a + f.advanceGlyph(f.encodeCharacter(c.codePointAt(0)!), 0), 0) * size;

	const wrap = (t: string, f: mupdf.Font, size: number, w: number): string[] => {
		const words = t.split(" ");
		const lines: string[] = [];
		let cur = "";
		for (const word of words) {
			const next = cur ? `${cur} ${word}` : word;
			if (width(next, f, size) > w && cur) {
				lines.push(cur);
				cur = word;
			} else cur = next;
		}
		if (cur) lines.push(cur);
		return lines;
	};

	const lines: Line[] = [];
	const add = (text: string, o: Omit<Line, "text"> = {}) => {
		const f = o.bold ? fBold : fReg;
		const size = o.size ?? 9.5;
		wrap(text, f, size, maxW - (o.indent ?? 0)).forEach((t, i) => lines.push({ ...o, text: t, gap: i === 0 ? o.gap : 0 }));
	};

	add("6068redact — Exceptions Report", { bold: true, size: 16 });
	add("CONFIDENTIAL: this report lists name forms that were redacted. Keep it with the client file. Do not give it to the AI system.", { bold: true, size: 9, gap: 4 });
	add(`File: ${s.fileName}`, { gap: 8 });
	add(`Pages: ${s.pageCount}   Processed: ${new Date(s.processedAt).toLocaleString()}   App version: ${version}`);
	add(`Input ${(s.inputBytes / 1048576).toFixed(1)} MB, output ${(s.outputBytes / 1048576).toFixed(1)} MB, time ${(s.elapsedMs / 1000).toFixed(1)} s`);
	if (s.formsFlattened) add("Form fields were flattened into the page before redaction.");
	if (s.hiddenLayersRemoved) add("Hidden layers (optional content turned off) were removed.");

	add("Pages with very little recognized text (likely poor scans)", { bold: true, size: 11, gap: 12 });
	add(s.lowTextPages.length ? `${s.lowTextPages.length} page(s): ${truncate(pageRanges(s.lowTextPages), 600)}` : "None.", { indent: 10 });
	if (s.blankPages.length) add(`Blank pages (no text, allowed): ${truncate(pageRanges(s.blankPages), 300)}`, { indent: 10 });

	add("Redactions by category", { bold: true, size: 11, gap: 12 });
	let total = 0;
	for (const k of Object.keys(CATEGORY_LABELS) as Category[]) {
		total += s.counts[k];
		add(`${CATEGORY_LABELS[k]}: ${s.counts[k]}`, { indent: 10 });
	}
	add(`Total: ${total}`, { indent: 10, bold: true });

	add("Name forms redacted as close matches (not on the user's list)", { bold: true, size: 11, gap: 12 });
	if (!s.closeMatches.length) add("None.", { indent: 10 });
	// Fill the rest of the page, then summarize what did not fit.
	const lineH = (l: Line) => (l.size ?? 9.5) * 1.3 + (l.gap ?? 0);
	let used = lines.reduce((a, l) => a + lineH(l), 0);
	const avail = H - 2 * M - 20;
	let shown = 0;
	for (const c of s.closeMatches) {
		const t = `"${c.form}" — ${c.count}×, ${c.pages.length === 1 ? "page" : "pages"} ${truncate(pageRanges(c.pages), 80)}`;
		if (used + 9.5 * 1.3 > avail) break;
		add(t, { indent: 10 });
		used += 9.5 * 1.3;
		shown++;
	}
	if (shown < s.closeMatches.length) add(`…and ${s.closeMatches.length - shown} more close-match forms.`, { indent: 10 });

	let y = M;
	let content = "BT\n";
	for (const l of lines) {
		const size = l.size ?? 9.5;
		y += (l.gap ?? 0) + size * 1.3;
		if (y > H - M) break;
		const f = l.bold ? fBold : fReg;
		const hex = [...l.text].map((c) => f.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("");
		content += `/${l.bold ? "B" : "R"} ${size} Tf 1 0 0 1 ${M + (l.indent ?? 0)} ${(H - y).toFixed(2)} Tm <${hex}> Tj\n`;
	}
	content += "ET\n";
	content += `q 0.6 g BT /R 7.5 Tf 1 0 0 1 ${M} ${M - 20} Tm <${[..."Generated locally in the browser by 6068redact. No data left this computer."].map((c) => fReg.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("")}> Tj ET Q\n`;
	withBuffer(content, (b) => doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, b)));
	doc.getTrailer().delete("Info");
	doc.getTrailer().get("Root").delete("Info");
	const out = doc.saveToBuffer("garbage=compact,compress=yes").asUint8Array().slice();
	doc.destroy();
	fReg.destroy();
	fBold.destroy();
	return out;
}

function truncate(s: string, n: number) {
	return s.length <= n ? s : s.slice(0, s.lastIndexOf(",", n)) + ", …";
}
