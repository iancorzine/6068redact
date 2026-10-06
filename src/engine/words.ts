import type { PageText } from "./types";

export interface Word {
	start: number;
	end: number;
	raw: string;
	line: number;
}

const WORD_RE = /[\p{L}\p{M}0-9|'’\-]+/gu;

/** Split page text into word tokens (letters, digits, OCR digit look-alikes, apostrophes, hyphens). */
export function tokenize(pt: PageText): Word[] {
	const out: Word[] = [];
	for (const m of pt.text.matchAll(WORD_RE)) {
		let s = m.index!;
		let e = s + m[0].length;
		while (s < e && /['’\-]/.test(pt.text[s])) s++;
		while (e > s && /['’\-]/.test(pt.text[e - 1])) e--;
		if (e <= s) continue;
		out.push({ start: s, end: e, raw: pt.text.slice(s, e), line: pt.lineOf[s] });
	}
	return out;
}

/** True if the text between two words is only spaces/commas/periods with at most one line break. */
export function joinable(text: string, from: number, to: number): boolean {
	if (to - from > 12) return false;
	const gap = text.slice(from, to);
	if (!/^[\s,.]*$/.test(gap)) return false;
	return (gap.match(/\n/g) || []).length <= 1;
}
