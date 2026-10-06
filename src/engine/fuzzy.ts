// Name normalization and OCR-aware fuzzy matching.

/** Case-fold, strip accents, drop apostrophes/periods and a trailing possessive. */
export function foldName(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[’'`´]s$/u, "")
		.replace(/[’'`´.]/gu, "");
}

/**
 * Collapse common OCR confusions so "Srnith", "5mith" and "Smith" share a key.
 * Applied to both the page token and the user's name, so it is symmetric.
 */
export function ocrKey(s: string): string {
	return foldName(s)
		.replace(/rn/g, "m")
		.replace(/vv/g, "w")
		.replace(/cl/g, "d")
		.replace(/[0]/g, "o")
		.replace(/[1|!]/g, "l")
		.replace(/[5$]/g, "s")
		.replace(/[8]/g, "b")
		.replace(/[6]/g, "g")
		.replace(/[2]/g, "z");
}

// Character pairs OCR engines commonly swap; substituting within a group is cheap.
const CONFUSABLE_GROUPS = ["li1|!jt", "o0qdc", "s5$", "b8h", "g9q", "z2", "ec", "uv", "nh", "ao", "ft"];
const confusable = new Map<string, Set<string>>();
for (const g of CONFUSABLE_GROUPS) {
	for (const a of g) {
		if (!confusable.has(a)) confusable.set(a, new Set());
		for (const b of g) if (a !== b) confusable.get(a)!.add(b);
	}
}

function subCost(a: string, b: string): number {
	if (a === b) return 0;
	return confusable.get(a)?.has(b) ? 0.4 : 1;
}

/** Weighted Damerau-Levenshtein distance; OCR-confusable substitutions cost 0.4. */
export function ocrDistance(a: string, b: string, max = Infinity): number {
	const n = a.length;
	const m = b.length;
	if (Math.abs(n - m) > max) return Infinity;
	let prev2 = new Array<number>(m + 1).fill(0);
	let prev = new Array<number>(m + 1);
	let cur = new Array<number>(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = cur[0];
		for (let j = 1; j <= m; j++) {
			let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > max) return Infinity;
		[prev2, prev, cur] = [prev, cur, prev2];
	}
	return prev[m];
}

/** Allowed weighted distance for a name of this length. */
export function nameThreshold(len: number): number {
	if (len <= 4) return 0.45; // one OCR-confusable substitution only
	if (len <= 7) return 1;
	return 2;
}

export type NameMatch = { exact: boolean; dist: number };

/** Compare a page token against a (folded) name token. */
export function matchNameToken(token: string, name: string): NameMatch | null {
	const ft = foldName(token);
	if (!ft) return null;
	if (ft === name) return { exact: true, dist: 0 };
	const kt = ocrKey(token);
	const kn = ocrKey(name);
	if (kt === kn) return { exact: false, dist: 0 };
	const thr = nameThreshold(name.length);
	// Never fuzz very short tokens against longer names, or vice versa.
	if (kt.length < 3) return null;
	const d = ocrDistance(kt, kn, thr);
	if (d <= thr) {
		// Guard against matching on a different first letter for short names
		// ("Mark" vs "Bark") unless the letters are OCR-confusable.
		if (name.length <= 5 && kt[0] !== kn[0] && subCost(kt[0], kn[0]) === 1) return null;
		return { exact: false, dist: d };
	}
	return null;
}
