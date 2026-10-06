import type { PageText, Quad, Rect } from "./types";

/** Minimal shape of the MuPDF StructuredText walker we rely on. */
interface Walkable {
	walk(walker: {
		beginLine?(bbox: Rect, wmode: number, dir: [number, number]): void;
		onChar?(c: string, origin: [number, number], font: unknown, size: number, quad: Quad): void;
		endLine?(): void;
		endTextBlock?(): void;
	}): void;
}

/**
 * Flatten MuPDF structured text into one string where every character maps back to
 * its quad on the page. Lines are separated by "\n" (quad = null).
 */
export function buildPageText(stext: Walkable): PageText {
	const chars: string[] = [];
	const quads: (Quad | null)[] = [];
	const lineIdx: number[] = [];
	const lines: PageText["lines"] = [];
	let lineStart = 0;
	let bbox: Rect = [0, 0, 0, 0];
	stext.walk({
		beginLine(b) {
			lineStart = chars.length;
			bbox = [b[0], b[1], b[2], b[3]];
		},
		onChar(c, _origin, _font, _size, quad) {
			// Some glyphs map to multi-char strings (ligatures); keep one quad per UTF-16 unit.
			for (let k = 0; k < c.length; k++) {
				chars.push(c[k]);
				quads.push([...quad] as Quad);
				lineIdx.push(lines.length);
			}
		},
		endLine() {
			lines.push({ start: lineStart, end: chars.length, bbox });
			chars.push("\n");
			quads.push(null);
			lineIdx.push(lines.length - 1);
		},
	});
	return { text: chars.join(""), quads, lineOf: Int32Array.from(lineIdx), lines };
}

/** Build a PageText from plain lines with fake geometry (used by unit tests). */
export function pageTextFromString(s: string): PageText {
	const chars: string[] = [];
	const quads: (Quad | null)[] = [];
	const lineIdx: number[] = [];
	const lines: PageText["lines"] = [];
	s.split("\n").forEach((line, li) => {
		const start = chars.length;
		const y0 = 20 + li * 14;
		for (let k = 0; k < line.length; k++) {
			const x0 = 20 + k * 6;
			chars.push(line[k]);
			quads.push([x0, y0, x0 + 6, y0, x0, y0 + 12, x0 + 6, y0 + 12]);
			lineIdx.push(li);
		}
		lines.push({ start, end: chars.length, bbox: [20, y0, 20 + line.length * 6, y0 + 12] });
		chars.push("\n");
		quads.push(null);
		lineIdx.push(li);
	});
	return { text: chars.join(""), quads, lineOf: Int32Array.from(lineIdx), lines };
}

export function quadBounds(q: Quad): Rect {
	return [
		Math.min(q[0], q[2], q[4], q[6]),
		Math.min(q[1], q[3], q[5], q[7]),
		Math.max(q[0], q[2], q[4], q[6]),
		Math.max(q[1], q[3], q[5], q[7]),
	];
}

/** Bounding box of characters [start, end) — ignores newline entries. */
export function spanBounds(pt: PageText, start: number, end: number): Rect | null {
	let r: Rect | null = null;
	for (let i = start; i < end; i++) {
		const q = pt.quads[i];
		if (!q) continue;
		const b = quadBounds(q);
		r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b;
	}
	return r;
}

/**
 * Convert a character range to one padded rectangle per text line. Leading and trailing
 * whitespace is trimmed so boxes hug the glyphs. Padding favors over-coverage so the
 * scanned pixels of a word are fully blacked out.
 */
export function rangeToRects(pt: PageText, start: number, end: number): Rect[] {
	const out: Rect[] = [];
	let i = start;
	while (i < end) {
		const line = pt.lineOf[i];
		let j = i;
		while (j < end && pt.lineOf[j] === line && pt.text[j] !== "\n") j++;
		let a = i;
		let b = j;
		while (a < b && /\s/.test(pt.text[a])) a++;
		while (b > a && /\s/.test(pt.text[b - 1])) b--;
		const r = a < b ? spanBounds(pt, a, b) : null;
		if (r) {
			// Pad by a fraction of the glyph height (measured along the quad's left edge,
			// so rotated and vertical text get sensible padding too). Generous padding
			// covers OCR text layers that sit slightly off the scanned glyphs.
			let gh = 0;
			let cnt = 0;
			for (let k = a; k < b; k++) {
				const q = pt.quads[k];
				if (q) {
					gh += Math.hypot(q[4] - q[0], q[5] - q[1]);
					cnt++;
				}
			}
			// Generous padding along the text (covers OCR layers sitting slightly off the
			// scanned letters), but very little across it: MuPDF removes any glyph a box
			// touches, so tall boxes would delete text on the lines above and below.
			const h = cnt ? gh / cnt : 10;
			const along = Math.max(1, h * 0.2);
			const across = Math.max(0.3, h * 0.04);
			const q = pt.quads[a]!;
			const horizontal = Math.abs(q[2] - q[0]) >= Math.abs(q[3] - q[1]);
			const [px, py] = horizontal ? [along, across] : [across, along];
			out.push([r[0] - px, r[1] - py, r[2] + px, r[3] + py]);
		}
		i = j;
		while (i < end && pt.text[i] === "\n") i++;
	}
	return out;
}
