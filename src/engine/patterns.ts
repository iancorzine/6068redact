// Pattern detectors for numbers, dates, phones and addresses. All of them work on the
// flattened page text and tolerate common OCR errors (l/I for 1, O for 0, S for 5,
// stray spaces). When in doubt they over-redact.

import { foldName, matchNameToken } from "./fuzzy";
import type { Category, Hit, PageText } from "./types";
import type { Word } from "./words";

/** One character that may be an OCR'd digit. */
const D = "[0-9OoQDIil|!SsBZzG]";
const OCR_DIGIT: Record<string, string> = {
	O: "0", o: "0", Q: "0", D: "0",
	I: "1", i: "1", l: "1", "|": "1", "!": "1",
	S: "5", s: "5", B: "8", Z: "2", z: "2", G: "6",
};

export function ocrDigits(s: string): string {
	let out = "";
	for (const c of s) {
		if (c >= "0" && c <= "9") out += c;
		else if (OCR_DIGIT[c]) out += OCR_DIGIT[c];
	}
	return out;
}

export function realDigits(s: string): number {
	let n = 0;
	for (const c of s) if (c >= "0" && c <= "9") n++;
	return n;
}

/** n OCR digits that may contain single stray spaces. */
const grp = (n: number) => `${D}(?: ?${D}){${n - 1}}`;
const NB = "(?<![\\p{L}\\p{N}])"; // not preceded by letter/digit
const NA = "(?![\\p{L}\\p{N}])"; // not followed by letter/digit

function* matchAll(text: string, re: RegExp) {
	re.lastIndex = 0;
	let m: RegExpExecArray | null;
	// Restart one character after each match start, so a bad early match (e.g. "O.B. 07"
	// inside "D.O.B. 07/04/1980") cannot hide a good overlapping one.
	while ((m = re.exec(text))) {
		yield m;
		re.lastIndex = m.index + 1;
	}
}

// ---------------------------------------------------------------------------
// Social Security numbers

const SEP = "(?:[ \\t]*[-–—.][ \\t]*|[ \\t]{1,3})";
const SSN_FORMATTED = new RegExp(`${NB}(?<![\\p{N}][-–—.])${grp(3)}${SEP}${grp(2)}${SEP}${grp(4)}${NA}(?![-–—.][\\p{N}])`, "gu");
const SSN_PLAIN = new RegExp(`${NB}${D}{9}${NA}`, "gu");
const SSN_MASKED = new RegExp(`${NB}[Xx*#•]{3}[ \\t]*[-–—.]?[ \\t]*[Xx*#•]{2}[ \\t]*[-–—.]?[ \\t]*${grp(4)}${NA}`, "gu");
const SSN_LABEL = /(?<![\p{L}])(?:SSN|S\.\s?S\.\s?N\.?|SS\s?#|SS\s*No\.?|Soc(?:ial)?\.?\s*Sec(?:urity)?\.?(?:\s*(?:#|No\.?|Num(?:ber)?))?)(?![\p{L}])/giu;
const SSN_AFTER_LABEL = new RegExp(`^[^\\n\\p{N}]{0,25}?((?:${D}[ \\t.\\-–—]{0,3}){8}${D})${NA}`, "u");

/**
 * Date-like spans, including OCR'd dates whose slashes were read as l, I, 1 or |
 * ("09l18l2024"). Unlabeled number patterns (SSN, CA driver's license, CII) must not
 * fire inside these, so service dates and times are not mistaken for identifiers.
 */
const OCR_DATE = new RegExp(`${NB}${D}{1,2}[ \\t]?[\\/\\-.lI1|][ \\t]?${D}{1,2}[ \\t]?[\\/\\-.lI1|][ \\t]?(?:19|20|[lI|]9|2[O0o])${D}{2}(?:[ \\t]+${D}{3,4})?`, "gu");
export function dateSpans(text: string): [number, number][] {
	const spans: [number, number][] = findDates(text, true).map((d) => [d.start, d.end]);
	for (const m of matchAll(text, OCR_DATE)) {
		// Extend over a trailing time ("09/18/2024 1256").
		spans.push([m.index, m.index + m[0].length]);
	}
	for (const d of findDates(text)) {
		const t = /^[ \t]+\d{3,4}(?!\d)/.exec(text.slice(d.end, d.end + 8));
		if (t) spans.push([d.start, d.end + t[0].length]);
	}
	return spans;
}
const inSpans = (spans: [number, number][], s: number, e: number) => spans.some(([a, b]) => s < b && e > a);

export function findSSN(text: string, dates: [number, number][] = dateSpans(text)): Hit[] {
	const hits: Hit[] = [];
	for (const re of [SSN_FORMATTED, SSN_PLAIN]) {
		for (const m of matchAll(text, re)) {
			if (inSpans(dates, m.index, m.index + m[0].length)) continue;
			if (realDigits(m[0]) >= 6 && ocrDigits(m[0]).length === 9) hits.push({ cat: "ssn", start: m.index, end: m.index + m[0].length });
		}
	}
	for (const m of matchAll(text, SSN_MASKED)) {
		if (realDigits(m[0]) >= 3) hits.push({ cat: "ssn", start: m.index, end: m.index + m[0].length });
	}
	for (const m of matchAll(text, SSN_LABEL)) {
		const after = m.index + m[0].length;
		const mm = SSN_AFTER_LABEL.exec(text.slice(after, after + 80));
		if (mm && realDigits(mm[1]) >= 4) {
			const s = after + mm.index + mm[0].length - mm[1].length;
			hits.push({ cat: "ssn", start: s, end: s + mm[1].length });
		}
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export interface YMD {
	y?: number; // 4-digit, or 2-digit (0-99) when the source had two digits
	y2?: boolean;
	m: number;
	d?: number;
}
export interface DateMatch {
	start: number;
	end: number;
	cands: YMD[];
	partial?: boolean; // month/year only
}

const DATE_NUMERIC = new RegExp(`${NB}(${grp(1)}${D}?)[ \\t]?([\\/\\-.])[ \\t]?(${D}{1,2})[ \\t]?\\2[ \\t]?(${D}{4}|${D}{2})${NA}`, "gu");
const DATE_ISO = new RegExp(`${NB}(${D}{4})([\\/\\-.])(${D}{1,2})\\2(${D}{1,2})${NA}`, "gu");
const DATE_MDY_NAME = new RegExp(`${NB}${MONTH}\\.?[ \\t]*(${D}{1,2})(?:st|nd|rd|th)?,?[ \\t]*('?${D}{4}|'?${D}{2})${NA}`, "giu");
const DATE_DMY_NAME = new RegExp(`${NB}(${D}{1,2})(?:st|nd|rd|th)?[ \\t-]*(?:of[ \\t]+)?${MONTH}\\.?,?[ \\t-]*(${D}{4}|${D}{2})${NA}`, "giu");
const DATE_COMPACT = new RegExp(`${NB}(${D}{8})${NA}`, "gu");
const DATE_PARTIAL = new RegExp(`${NB}(${D}{1,2})[ \\t]?[\\/\\-][ \\t]?(${D}{4})${NA}`, "gu");

function num(s: string): number {
	return parseInt(ocrDigits(s), 10);
}
function validMD(m: number, d?: number) {
	return m >= 1 && m <= 12 && (d === undefined || (d >= 1 && d <= 31));
}
function yearOf(s: string): { y: number; y2: boolean } {
	const digits = ocrDigits(s);
	return { y: parseInt(digits, 10), y2: digits.length === 2 };
}
function monthIdx(s: string): number {
	return MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
}

/** Find every date-like string on the page, with all plausible interpretations. */
export function findDates(text: string, includePartial = false): DateMatch[] {
	const out: DateMatch[] = [];
	const okDigits = (s: string, min: number) => realDigits(s) >= min;
	for (const m of matchAll(text, DATE_NUMERIC)) {
		if (!okDigits(m[0], Math.ceil(ocrDigits(m[0]).length * 0.6))) continue;
		const a = num(m[1]);
		const b = num(m[3]);
		const { y, y2 } = yearOf(m[4]);
		const cands: YMD[] = [];
		if (validMD(a, b)) cands.push({ y, y2, m: a, d: b });
		if (a !== b && validMD(b, a)) cands.push({ y, y2, m: b, d: a });
		if (cands.length) out.push({ start: m.index, end: m.index + m[0].length, cands });
	}
	for (const m of matchAll(text, DATE_ISO)) {
		if (!okDigits(m[0], 5)) continue;
		const y = num(m[1]);
		const mo = num(m[3]);
		const d = num(m[4]);
		if (validMD(mo, d)) out.push({ start: m.index, end: m.index + m[0].length, cands: [{ y, m: mo, d }] });
	}
	for (const m of matchAll(text, DATE_MDY_NAME)) {
		if (!okDigits(m[2] + m[3], 2)) continue;
		const mo = monthIdx(m[1]);
		const d = num(m[2]);
		const { y, y2 } = yearOf(m[3]);
		if (validMD(mo, d)) out.push({ start: m.index, end: m.index + m[0].length, cands: [{ y, y2, m: mo, d }] });
	}
	for (const m of matchAll(text, DATE_DMY_NAME)) {
		if (!okDigits(m[1] + m[3], 2)) continue;
		const mo = monthIdx(m[2]);
		const d = num(m[1]);
		const { y, y2 } = yearOf(m[3]);
		if (validMD(mo, d)) out.push({ start: m.index, end: m.index + m[0].length, cands: [{ y, y2, m: mo, d }] });
	}
	for (const m of matchAll(text, DATE_COMPACT)) {
		if (!okDigits(m[0], 6)) continue;
		const s = ocrDigits(m[0]);
		const cands: YMD[] = [];
		const [mm, dd, yyyy] = [+s.slice(0, 2), +s.slice(2, 4), +s.slice(4)];
		if (validMD(mm, dd)) cands.push({ y: yyyy, m: mm, d: dd });
		if (validMD(dd, mm)) cands.push({ y: yyyy, m: dd, d: mm });
		const [y2, m2, d2] = [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6)];
		if (validMD(m2, d2)) cands.push({ y: y2, m: m2, d: d2 });
		if (cands.length) out.push({ start: m.index, end: m.index + m[0].length, cands });
	}
	if (includePartial) {
		for (const m of matchAll(text, DATE_PARTIAL)) {
			const mo = num(m[1]);
			if (validMD(mo) && okDigits(m[0], 4)) out.push({ start: m.index, end: m.index + m[0].length, cands: [{ y: num(m[2]), m: mo }], partial: true });
		}
	}
	return out;
}

/** Parse the user's DOB entry (ISO from a date picker, or m/d/yyyy, or "March 14, 1979"). */
export function parseUserDate(s: string | undefined): YMD | null {
	if (!s || !s.trim()) return null;
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
	if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
	const ds = findDates(s);
	if (!ds.length) return null;
	const c = ds[0].cands[0];
	if (c.y !== undefined && c.y2) c.y = c.y + (c.y > (new Date().getFullYear() % 100) ? 1900 : 2000);
	c.y2 = false;
	return c;
}

export function sameDate(a: YMD, dob: YMD): boolean {
	if (a.m !== dob.m || a.d !== dob.d || a.y === undefined || dob.y === undefined) return false;
	return a.y2 ? a.y === dob.y % 100 : a.y === dob.y;
}

const DOB_LABEL = /(?<![\p{L}])(?:D\.?\s?[O0o]\.?\s?B\.?|Date\s*of\s*Birth|Birth\s*-?\s*date|Birth\s+Date|Born(?:\s+on)?|Fecha\s+de\s+Nacimiento)(?![\p{L}])/giu;

export function findDOB(pt: PageText, dob: YMD | null): Hit[] {
	const { text } = pt;
	const hits: Hit[] = [];
	const dates = findDates(text, true).sort((a, b) => a.start - b.start || b.end - a.end);
	if (dob) {
		for (const dm of dates) if (!dm.partial && dm.cands.some((c) => sameDate(c, dob))) hits.push({ cat: "dob", start: dm.start, end: dm.end });
	}
	for (const m of matchAll(text, DOB_LABEL)) {
		const after = m.index + m[0].length;
		const line = pt.lineOf[m.index];
		// The first date after the label on the same line, else on the next two lines.
		let found = dates.find((d) => d.start >= after && pt.lineOf[d.start] === line && d.start - after <= 60);
		if (!found) found = dates.find((d) => d.start >= after && pt.lineOf[d.start] > line && pt.lineOf[d.start] <= line + 2);
		if (found) hits.push({ cat: "dob", start: found.start, end: found.end });
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Phones

const PHONE = new RegExp(
	`${NB}(?:\\+?[ \\t]?1[ \\t]?[-.\\s]?[ \\t]?)?(?:\\([ \\t]?${grp(3)}[ \\t]?\\)|${grp(3)})[ \\t]?[-.\\s/]?[ \\t]?${grp(3)}[ \\t]?[-.\\s]?[ \\t]?${grp(4)}${NA}(?:[ \\t]*(?:ext\\.?|x|extension)[ \\t]*\\d{1,6})?`,
	"giu",
);
const PHONE_LOCAL = new RegExp(`${NB}(?<![\\p{N}][-.\\s)])${grp(3)}[ \\t]?[-.][ \\t]?${grp(4)}${NA}`, "gu");

export function phoneKey(s: string): string {
	let d = s.replace(/\D/g, "");
	if (d.length === 11 && d[0] === "1") d = d.slice(1);
	return d;
}

export function findPhones(text: string, phones: string[], cat: Category): Hit[] {
	const keys = new Set(phones.map(phoneKey).filter((k) => k.length >= 7));
	if (!keys.size) return [];
	const locals = new Set([...keys].map((k) => k.slice(-7)));
	const hits: Hit[] = [];
	for (const m of matchAll(text, PHONE)) {
		const core = m[0].replace(/(?:ext\.?|x|extension)[ \t]*\d{1,6}$/i, "");
		if (realDigits(core) < 7) continue;
		let d = ocrDigits(core);
		if (d.length === 11 && d[0] === "1") d = d.slice(1);
		if (keys.has(d)) hits.push({ cat, start: m.index, end: m.index + m[0].length });
	}
	for (const m of matchAll(text, PHONE_LOCAL)) {
		if (realDigits(m[0]) >= 5 && locals.has(ocrDigits(m[0]))) hits.push({ cat, start: m.index, end: m.index + m[0].length });
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Labeled identifiers (driver's license, NCIC/CII, account numbers)

const DL_LABEL = /(?<![\p{L}])(?:driver'?s?[\s-]*lic(?:ense|\.)?|operator'?s?\s*lic(?:ense)?|D\.?\s?L\.?(?=\s*(?:#|no\b|num|:|\s+\S*\d))|CDL|DLN|lic(?:ense)?\.?\s*(?:#|no\.?|num(?:ber)?))(?![\p{L}])/giu;
const NCIC_LABEL = /(?<![\p{L}])(?:NCIC|CII|FBI\s*(?:#|no\.?|num(?:ber)?)|SID\s*(?:#|no\.?|num(?:ber)?)?|state\s*id(?:entification)?\s*(?:#|no\.?|num(?:ber)?)|CDCR\s*(?:#|no\.?|num(?:ber)?)?|booking\s*(?:#|no\.?|num(?:ber)?)|inmate\s*(?:#|no\.?|num(?:ber)?|id))(?![\p{L}])/giu;
export const ACCOUNT_LABEL = new RegExp(
	"(?<![\\p{L}])(?:" +
		[
			"acc(?:oun)?t(?:\\s*holder)?",
			"acct",
			"a\\/c",
			"MRN",
			"M\\.R\\.N\\.?",
			"med(?:ical)?\\.?\\s*rec(?:ord)?s?\\.?",
			"patient\\s*(?:id|#|no\\.?|num(?:ber)?|acct|account)",
			"pt\\.?\\s*(?:id|#|no\\.?|acct)",
			"chart(?:\\s*(?:#|no\\.?|num(?:ber)?|id))?",
			"policy(?:\\s*holder)?",
			"pol\\.?\\s*(?:#|no\\.?)",
			"claim",
			"clm",
			"member(?:ship)?",
			"mbr",
			"subscriber",
			"sub\\.?\\s*id",
			"group\\s*(?:#|no\\.?|num(?:ber)?|id)",
			"grp\\.?\\s*(?:#|no\\.?|id)?",
			"insured\\s*id",
			"ins(?:urance)?\\.?\\s*id",
			"id\\s*card",
			"id\\s*#",
			"bank",
			"routing",
			"ABA",
			"card\\s*(?:#|no\\.?|num(?:ber)?)",
			"medi[-\\s]cal",
			"medicare",
			"medicaid",
			"MBI",
			"HICN",
			"CIN",
			"beneficiary\\s*(?:id|#|no\\.?)",
			"certificate\\s*(?:#|no\\.?|id)?",
			"encounter\\s*(?:#|no\\.?|num(?:ber)?|id)",
			"visit\\s*(?:#|no\\.?|id)",
			"accession\\s*(?:#|no\\.?)?",
			"invoice\\s*(?:#|no\\.?|num(?:ber)?)",
			"statement\\s*(?:#|no\\.?|num(?:ber)?)",
			"auth(?:orization)?\\s*(?:#|no\\.?|num(?:ber)?)",
			"case\\s*(?:#|no\\.?|num(?:ber)?)",
			"file\\s*(?:#|no\\.?|num(?:ber)?)",
			"employee\\s*(?:id|#|no\\.?)",
			"emp\\.?\\s*(?:id|#)",
			"TIN",
			"EIN",
			"ITIN",
			"passport",
			"guarantor\\s*(?:id|#|no\\.?)",
			"HAR",
			"FIN",
			"CSN",
			"EPI",
		].join("|") +
		")(?![\\p{L}])",
	"giu",
);

const FILLER = /^[\s:#.\-–=]*(?:(?:no|num|number|nbr|id|ident|identifier|numbers)\b\.?[\s:#.\-–=]*)*/i;

interface Group {
	start: number;
	end: number;
	s: string;
}

/** Read one identifier-like group (and space-separated digit groups) starting at p. */
function readGroup(text: string, p: number): Group | null {
	if (p >= text.length || !/[A-Za-z0-9*]/.test(text[p])) return null;
	let e = p;
	const take = () => {
		while (e < text.length && /[A-Za-z0-9\-\/.*]/.test(text[e])) e++;
	};
	take();
	// Continue across single spaces when the next group is digit-heavy ("1234 5678 9012").
	for (;;) {
		const m = /^ ([0-9OIl][0-9OIl\-]{1,})(?![A-Za-z])/.exec(text.slice(e, e + 30));
		if (!m || realDigits(m[1]) < 2) break;
		e += m[0].length;
	}
	while (e > p && /[\-\/.]/.test(text[e - 1])) e--;
	return e > p ? { start: p, end: e, s: text.slice(p, e) } : null;
}

const MONEY = /^\$|^\d{1,3}(?:,\d{3})*\.\d{2}$/;
// Dates, optionally followed by a time ("09/18/2024 1256"), are never account numbers.
const DATEISH = /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}(?:\s+\d{3,4})?$|^\d{4}-\d{2}-\d{2}(?:\s+\d{3,4})?$/;
const TIMEISH = /^\d{3,4}$/;

function validId(g: Group, minDigits: number): boolean {
	if (realDigits(g.s) < minDigits) return false;
	if (MONEY.test(g.s) || DATEISH.test(g.s)) return false;
	if (g.s.length > 40) return false;
	return true;
}

/**
 * For each label, redact the identifier that follows it on the same line or, for table
 * layouts, the identifier directly beneath it on the next two lines.
 */
export function findLabeled(pt: PageText, labelRe: RegExp, cat: Category, minDigits = 3): Hit[] {
	const { text } = pt;
	const hits: Hit[] = [];
	for (const m of matchAll(text, labelRe)) {
		const labelStart = m.index;
		const labelEnd = m.index + m[0].length;
		const line = pt.lineOf[labelStart];
		const f = FILLER.exec(text.slice(labelEnd, labelEnd + 40));
		let p = labelEnd + (f ? f[0].length : 0);
		const g = pt.lineOf[p] === line ? readGroup(text, p) : null;
		if (g && validId(g, minDigits)) {
			hits.push({ cat, start: g.start, end: g.end });
			continue;
		}
		// Look below the label (table header) — only when nothing follows the label on its
		// line, or the next text is far to the right (another column).
		const lq = pt.quads[labelStart];
		const lqe = pt.quads[labelEnd - 1];
		if (!lq || !lqe) continue;
		const restOfLine = text.slice(p, pt.lines[line].end).trim();
		if (restOfLine) {
			let q = p;
			while (q < pt.lines[line].end && /\s/.test(text[q])) q++;
			const nq = pt.quads[q];
			const h = Math.max(lqe[5], lqe[7]) - Math.min(lqe[1], lqe[3]);
			if (!nq || Math.min(nq[0], nq[4]) - Math.max(lqe[2], lqe[6]) < Math.max(15, h * 1.5)) continue;
		}
		const lx0 = Math.min(lq[0], lq[4]) - 12;
		const lx1 = Math.max(lqe[2], lqe[6]) + 48;
		const ly = Math.max(lqe[5], lqe[7]);
		// Candidate lines: anywhere on the page, starting just below the label, nearest first.
		// (Table cells are often separate text lines, so "next line" is not enough.)
		const below = pt.lines
			.map((L, li) => ({ L, li }))
			.filter(({ L, li }) => li !== line && L.bbox[1] >= ly - 2 && L.bbox[1] - ly <= 60)
			.sort((x, y) => x.L.bbox[1] - y.L.bbox[1]);
		let done = false;
		for (const { L } of below) {
			if (done) break;
			for (let q = L.start; q < L.end && !done; q++) {
				if (q > L.start && /[A-Za-z0-9]/.test(text[q - 1])) continue; // word starts only
				const gg = readGroup(text, q);
				if (!gg) continue;
				const qq = pt.quads[gg.start];
				const qe = pt.quads[gg.end - 1];
				if (!qq || !qe) continue;
				const gx0 = Math.min(qq[0], qq[4]);
				const gx1 = Math.max(qe[2], qe[6]);
				if (gx1 < lx0 || gx0 > lx1) continue;
				// Values found under a label (table layout) must look like a real identifier:
				// at least 5 digits, and not a bare time such as "1313".
				if (validId(gg, Math.max(minDigits, 5)) && !TIMEISH.test(gg.s)) {
					hits.push({ cat, start: gg.start, end: gg.end });
					done = true;
				}
			}
		}
	}
	return hits;
}

const CA_DL = new RegExp(`${NB}[A-Z][ ]?${D}{7}${NA}`, "gu");
const CA_CII = new RegExp(`${NB}A[ ]?${D}{8}${NA}`, "gu");

export function findDL(pt: PageText, dates: [number, number][] = dateSpans(pt.text)): Hit[] {
	const hits = findLabeled(pt, DL_LABEL, "dl", 4);
	for (const m of matchAll(pt.text, CA_DL))
		if (realDigits(m[0]) >= 5 && !inSpans(dates, m.index, m.index + m[0].length)) hits.push({ cat: "dl", start: m.index, end: m.index + m[0].length });
	return hits;
}

export function findNCIC(pt: PageText, dates: [number, number][] = dateSpans(pt.text)): Hit[] {
	const hits = findLabeled(pt, NCIC_LABEL, "ncic", 3);
	for (const m of matchAll(pt.text, CA_CII))
		if (realDigits(m[0]) >= 6 && !inSpans(dates, m.index, m.index + m[0].length)) hits.push({ cat: "ncic", start: m.index, end: m.index + m[0].length });
	return hits;
}

export function findAccounts(pt: PageText): Hit[] {
	return findLabeled(pt, ACCOUNT_LABEL, "account", 3);
}

// ---------------------------------------------------------------------------
// Addresses

const SUFFIXES: Record<string, string> = {
	street: "st", st: "st", str: "st", avenue: "ave", ave: "ave", av: "ave", boulevard: "blvd", blvd: "blvd",
	road: "rd", rd: "rd", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", circle: "cir",
	cir: "cir", place: "pl", pl: "pl", way: "way", wy: "way", terrace: "ter", ter: "ter", parkway: "pkwy",
	pkwy: "pkwy", highway: "hwy", hwy: "hwy", trail: "trl", trl: "trl", square: "sq", sq: "sq", loop: "loop",
	alley: "aly", aly: "aly", plaza: "plz", plz: "plz", crescent: "cres", cres: "cres", row: "row", run: "run",
	path: "path", pike: "pike", expressway: "expy", expy: "expy", freeway: "fwy", fwy: "fwy", center: "ctr",
	ctr: "ctr", point: "pt", pt: "pt", heights: "hts", hts: "hts", commons: "cmns", grove: "grv", grv: "grv",
};
const DIRECTIONS: Record<string, string> = {
	north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w",
	northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw",
};
const UNIT_WORDS = new Set(["apt", "apartment", "unit", "ste", "suite", "space", "spc", "lot", "rm", "room", "bldg", "building", "fl", "floor", "no", "trlr"]);
const STATES: Record<string, string> = {
	alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct",
	delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
	kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi",
	minnesota: "mn", mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", ohio: "oh",
	oklahoma: "ok", oregon: "or", pennsylvania: "pa", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
	virginia: "va", washington: "wa", wisconsin: "wi", wyoming: "wy", calif: "ca", cal: "ca",
};

export interface AddressModel {
	number?: string;
	street: string[]; // folded street-name words (no suffix/direction)
	poBox?: string;
	unit?: string;
	city: string[];
	state?: string;
	zip?: string;
}

const fold = (s: string) => foldName(s).replace(/[,#]/g, "");

export function parseAddress(raw: string): AddressModel {
	const s = raw.replace(/\s+/g, " ").trim();
	const a: AddressModel = { street: [], city: [] };
	const zip = /(\d{5})(?:-\d{4})?\s*$/.exec(s);
	if (zip) a.zip = zip[1];
	const po = /P\.?\s*O\.?\s*Box\s*(\w+)/i.exec(s);
	if (po) a.poBox = ocrDigits(po[1]) || po[1].toLowerCase();
	const parts = s.replace(/(\d{5})(?:-\d{4})?\s*$/, "").split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
	// Street line: the first part that starts with a number.
	const streetIdx = parts.findIndex((p) => /^\d+[A-Za-z]?\b/.test(p));
	if (streetIdx >= 0) {
		const words = parts[streetIdx].split(" ");
		a.number = ocrDigits(words[0]);
		for (let i = 1; i < words.length; i++) {
			const w = fold(words[i]);
			if (UNIT_WORDS.has(w)) {
				a.unit = fold(words[++i] || "");
				continue;
			}
			if (words[i].startsWith("#")) {
				a.unit = fold(words[i].slice(1) || words[++i] || "");
				continue;
			}
			if (SUFFIXES[w] || DIRECTIONS[w]) continue;
			if (w) a.street.push(w);
		}
	}
	const rest = parts.filter((_, i) => i !== streetIdx && !/P\.?\s*O\.?\s*Box/i.test(parts[i]));
	for (const p of rest) {
		const words = p.split(" ").map(fold).filter(Boolean);
		if (words.length && UNIT_WORDS.has(words[0])) {
			a.unit = words[1];
			continue;
		}
		for (const w of words) {
			if (w.length === 2 && Object.values(STATES).includes(w) && !a.state) a.state = w;
			else if (STATES[w]) a.state = STATES[w];
			else a.city.push(w);
		}
	}
	return a;
}

function isAddressWord(w: string, a: AddressModel, prevUnit: boolean): boolean {
	const f = fold(w);
	if (!f) return false;
	if (SUFFIXES[f] || DIRECTIONS[f] || UNIT_WORDS.has(f)) return true;
	if (prevUnit && /\d/.test(w) && w.length <= 6) return true;
	if (a.unit && f === a.unit) return true;
	if (a.street.some((s) => matchNameToken(w, s))) return true;
	if (a.city.some((c) => matchNameToken(w, c))) return true;
	if (a.state && (f === a.state || STATES[f] === a.state)) return true;
	const d = ocrDigits(w);
	if (/^[0-9OoIlSs\-]+$/.test(w) && (d.length === 5 || d.length === 9) && realDigits(w) >= 4) return true;
	if (f === "box" || f === "po" || f === "p") return true;
	return false;
}

/** Extend an address match forward over street/unit/city/state/ZIP words (crossing one line break). */
function extend(pt: PageText, words: Word[], from: number, a: AddressModel): number {
	let k = from;
	let breaks = 0;
	while (k + 1 < words.length) {
		const gap = pt.text.slice(words[k].end, words[k + 1].start);
		if (gap.length > 12 || !/^[\s,.#\-]*$/.test(gap)) break;
		const nl = (gap.match(/\n/g) || []).length;
		if (breaks + nl > 2) break;
		const prevUnit = UNIT_WORDS.has(fold(words[k].raw)) || gap.includes("#");
		if (!isAddressWord(words[k + 1].raw, a, prevUnit)) break;
		breaks += nl;
		k++;
	}
	return k;
}

export function findAddresses(pt: PageText, words: Word[], addresses: string[], cat: Category): Hit[] {
	const hits: Hit[] = [];
	for (const raw of addresses) {
		const a = parseAddress(raw);
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			// Street line: house number followed (within 3 words) by a street-name match.
			if (a.number && a.street.length && /\d/.test(w.raw) && ocrDigits(w.raw) === a.number && realDigits(w.raw) >= Math.ceil(a.number.length / 2)) {
				let ok = false;
				for (let k = i + 1; k <= i + 3 && k < words.length; k++) {
					if (a.street.some((s) => matchNameToken(words[k].raw, s))) ok = true;
				}
				if (ok) {
					const end = extend(pt, words, i, a);
					hits.push({ cat, start: w.start, end: words[end].end });
					continue;
				}
			}
			// PO Box
			if (a.poBox && /^box$/i.test(w.raw) && i + 1 < words.length && (ocrDigits(words[i + 1].raw) || words[i + 1].raw.toLowerCase()) === a.poBox) {
				let s = i;
				while (s > 0 && /^(p|o|po)$/i.test(words[s - 1].raw) && i - s < 2) s--;
				const end = extend(pt, words, i + 1, a);
				hits.push({ cat, start: words[s].start, end: words[end].end });
				continue;
			}
			// "City, ST ZIP" line matching the entered city and ZIP.
			if (a.zip && a.city.length && /^\d{5}/.test(w.raw) && w.raw.slice(0, 5) === a.zip) {
				let s = i;
				let cityOk = false;
				while (s > 0 && i - s < 5) {
					const prev = words[s - 1];
					const gap = pt.text.slice(prev.end, words[s].start);
					if (gap.includes("\n") || !/^[\s,.]*$/.test(gap)) break;
					const f = fold(prev.raw);
					const isCity = a.city.some((c) => matchNameToken(prev.raw, c));
					if (!isCity && !(a.state && (f === a.state || STATES[f] === a.state))) break;
					if (isCity) cityOk = true;
					s--;
				}
				if (cityOk) hits.push({ cat, start: words[s].start, end: w.end });
			}
		}
	}
	return hits;
}
