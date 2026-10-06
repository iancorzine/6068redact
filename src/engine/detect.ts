import { NameModel } from "./names";
import {
	findAccounts,
	findAddresses,
	findDL,
	findDOB,
	findNCIC,
	findPhones,
	findSSN,
	dateSpans,
	parseUserDate,
	type YMD,
} from "./patterns";
import type { Hit, PageText, RedactOptions } from "./types";
import { tokenize } from "./words";

const clean = (xs: string[] | undefined) => (xs ?? []).map((s) => s.trim()).filter(Boolean);

/** Runs every detector over one page of text. Pure: no MuPDF calls. */
export class Detector {
	private names: NameModel;
	private others: NameModel;
	private dob: YMD | null;
	private o: RedactOptions;

	constructor(opts: RedactOptions) {
		this.o = {
			...opts,
			variants: clean(opts.variants),
			addresses: clean(opts.addresses),
			phones: clean(opts.phones),
			otherNames: clean(opts.otherNames),
			otherAddresses: clean(opts.otherAddresses),
			otherPhones: clean(opts.otherPhones),
		};
		const initials = (opts.initials || "").trim().toUpperCase();
		this.names = new NameModel([opts.fullName, ...this.o.variants].filter((s) => s && s.trim()), "name", initials);
		this.others = new NameModel(this.o.otherNames, "other");
		this.dob = parseUserDate(opts.dob);
	}

	detect(pt: PageText): { hits: Hit[]; close: string[] } {
		const words = tokenize(pt);
		const close: string[] = [];
		const dates = dateSpans(pt.text);
		const raw: Hit[] = [
			...this.names.findHits(pt, words, close),
			...this.others.findHits(pt, words, []),
			...findSSN(pt.text, dates),
			...findDL(pt, dates),
			...findNCIC(pt, dates),
			...findAccounts(pt),
			...findDOB(pt, this.dob),
			...findAddresses(pt, words, this.o.addresses, "address"),
			...findAddresses(pt, words, this.o.otherAddresses, "other"),
			...findPhones(pt.text, this.o.phones, "phone"),
			...findPhones(pt.text, this.o.otherPhones, "other"),
		];
		return { hits: mergeHits(raw), close };
	}
}

/**
 * Merge overlapping hits into one. A merged region keeps the initials only if every
 * part was a protected-person name; otherwise it becomes a plain black box (so an
 * address like "12 Smith St" stays one solid box).
 */
export function mergeHits(hits: Hit[]): Hit[] {
	const sorted = hits.filter((h) => h.end > h.start).sort((a, b) => a.start - b.start || b.end - a.end);
	const out: Hit[] = [];
	for (const h of sorted) {
		const last = out[out.length - 1];
		if (last && h.start < last.end) {
			last.end = Math.max(last.end, h.end);
			if (last.cat === "name" && h.cat !== "name") {
				last.cat = h.cat;
				delete last.initials;
			}
			continue;
		}
		out.push({ ...h });
	}
	return out;
}
