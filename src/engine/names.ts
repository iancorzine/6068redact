import { foldName, matchNameToken } from "./fuzzy";
import { COMMON_FIRST_NAMES, CREDENTIAL_AFTER, NAME_SUFFIXES, NAME_WORDS, PATIENT_CUES, PROVIDER_PREFIXES } from "./namelists";
import type { Category, Hit, PageText } from "./types";
import { joinable, type Word } from "./words";

type Role = "first" | "middle" | "last";

interface NameToken {
	key: string; // folded
	roles: Set<Role>;
	common: boolean; // common first name -> context rule applies when alone
}

interface WordMatch {
	tok: NameToken;
	exact: boolean;
	dist: number;
}

/** Split a user-entered name into first / middle / last tokens. */
export function parseName(entry: string): { first?: string; middles: string[]; last?: string } {
	let e = entry.trim().replace(/\s+/g, " ");
	if (!e) return { middles: [] };
	let parts: string[];
	let last: string | undefined;
	if (e.includes(",")) {
		const [l, ...rest] = e.split(",");
		last = l.trim();
		parts = rest.join(" ").trim().split(" ").filter(Boolean);
	} else {
		parts = e.split(" ");
	}
	parts = parts.filter((p) => !NAME_SUFFIXES.has(foldName(p)));
	if (last !== undefined) return { first: parts[0], middles: parts.slice(1), last };
	if (parts.length === 1) return { first: parts[0], middles: [] };
	return { first: parts[0], middles: parts.slice(1, -1), last: parts[parts.length - 1] };
}

/** Initials from a full name: first + last ("Jane Q. Smith" -> "JS"). */
export function initialsFor(fullName: string): string {
	const p = parseName(fullName);
	const f = p.first ? foldName(p.first)[0] ?? "" : "";
	const l = p.last ? foldName(p.last)[0] ?? "" : "";
	return (f + l).toUpperCase();
}

export class NameModel {
	private tokens = new Map<string, NameToken>();
	private firstLetters = new Set<string>();
	readonly empty: boolean;

	constructor(
		entries: string[],
		private cat: Category,
		private initials?: string,
	) {
		for (const entry of entries) {
			const p = parseName(entry);
			const single = !!p.first && !p.last && p.middles.length === 0;
			if (single) {
				// A one-word variant (nickname, maiden name). Common first names follow the
				// context rule; anything else is always redacted.
				const k = foldName(p.first!);
				this.add(k, COMMON_FIRST_NAMES.has(k) ? "first" : "last");
				continue;
			}
			if (p.first) this.add(foldName(p.first), "first");
			for (const m of p.middles) this.add(foldName(m), "middle");
			if (p.last) {
				const k = foldName(p.last);
				this.add(k, "last");
				if (k.includes("-")) for (const part of k.split("-")) this.add(part, "last");
			}
		}
		this.empty = this.tokens.size === 0;
	}

	private add(key: string, role: Role) {
		if (!key) return;
		if (key.length === 1) {
			this.firstLetters.add(key);
			return;
		}
		let t = this.tokens.get(key);
		if (!t) {
			t = { key, roles: new Set(), common: false };
			this.tokens.set(key, t);
		}
		t.roles.add(role);
		t.common = !t.roles.has("last") && COMMON_FIRST_NAMES.has(key);
		if (role !== "last") this.firstLetters.add(key[0]);
	}

	private matchWord(raw: string): WordMatch | null {
		const cands = [raw];
		if (raw.includes("-")) cands.push(...raw.split("-").filter((s) => s.length > 1));
		let best: WordMatch | null = null;
		for (const c of cands) {
			for (const tok of this.tokens.values()) {
				const m = matchNameToken(c, tok.key);
				if (!m) continue;
				if (!best || (m.exact && !best.exact) || (m.exact === best.exact && m.dist < best.dist)) best = { tok, ...m };
			}
		}
		return best;
	}

	findHits(pt: PageText, words: Word[], closeOut: string[]): Hit[] {
		if (this.empty) return [];
		const n = words.length;
		const matches: (WordMatch | null)[] = new Array(n).fill(null);
		const initial: boolean[] = new Array(n).fill(false);
		for (let i = 0; i < n; i++) {
			const w = words[i];
			if (w.raw.length === 1) {
				initial[i] = /\p{L}/u.test(w.raw) && this.firstLetters.has(foldName(w.raw));
				continue;
			}
			const m = this.matchWord(w.raw);
			if (!m) continue;
			// Everyday-word names ("White", "Rose") need a capital letter to count.
			if (NAME_WORDS.has(m.tok.key) && !/^\p{Lu}/u.test(w.raw)) continue;
			matches[i] = m;
		}

		// Lines containing a last-name match, for the common-first-name context rule.
		const lastLines = new Set<number>();
		for (let i = 0; i < n; i++) if (matches[i]?.tok.roles.has("last")) lastLines.add(words[i].line);

		const hits: Hit[] = [];
		let i = 0;
		while (i < n) {
			if (!matches[i] && !initial[i]) {
				i++;
				continue;
			}
			let j = i;
			// A run may cross a line break only while it is still an incomplete name.
			let matched = matches[i] ? 1 : 0;
			while (j + 1 < n && (matches[j + 1] || initial[j + 1]) && joinable(pt.text, words[j].end, words[j + 1].start)) {
				if (words[j + 1].line !== words[j].line && matched >= 2) break;
				j++;
				if (matches[j]) matched++;
			}
			// Trim initials at the edges unless the run also contains a matched word.
			let a = i;
			let b = j;
			const matchedCount = () => {
				let c = 0;
				for (let k = a; k <= b; k++) if (matches[k]) c++;
				return c;
			};
			if (matchedCount() === 0) {
				i = j + 1;
				continue;
			}
			while (a < b && !matches[a] && !this.edgeInitialOk(matches, a, b)) a++;
			while (b > a && !matches[b] && !this.edgeInitialOk(matches, a, b)) b--;
			const count = matchedCount();
			let redact = count >= 2;
			if (count === 1) {
				const k = matches.slice(a, b + 1).findIndex(Boolean) + a;
				redact = this.standaloneOk(pt, words, k, matches[k]!, lastLines);
			}
			if (redact) {
				let end = words[b].end;
				if (b > a && words[b].raw.length === 1 && pt.text[end] === ".") end++;
				hits.push({ cat: this.cat, start: words[a].start, end, initials: this.initials });
				for (let k = a; k <= b; k++) {
					const m = matches[k];
					if (m && !m.exact) closeOut.push(words[k].raw);
				}
			}
			i = j + 1;
		}
		return hits;
	}

	/** An initial at a run edge is kept only when the run contains a last-name match. */
	private edgeInitialOk(matches: (WordMatch | null)[], a: number, b: number): boolean {
		for (let k = a; k <= b; k++) if (matches[k]?.tok.roles.has("last")) return true;
		return false;
	}

	private standaloneOk(pt: PageText, words: Word[], k: number, m: WordMatch, lastLines: Set<number>): boolean {
		if (m.tok.roles.has("last") || !m.tok.common) return true;
		const fold = (s: string) => foldName(s).replace(/:$/, "");
		const prev = (d: number) => (k - d >= 0 ? fold(words[k - d].raw) : "");
		if (PROVIDER_PREFIXES.has(prev(1)) || PROVIDER_PREFIXES.has(prev(2))) return false;
		if (CREDENTIAL_AFTER.test(pt.text.slice(words[k].end, words[k].end + 40))) return false;
		const line = words[k].line;
		for (let l = line - 2; l <= line + 2; l++) if (lastLines.has(l)) return true;
		for (let d = 1; d <= 3; d++) if (PATIENT_CUES.has(prev(d))) return true;
		return false;
	}
}
