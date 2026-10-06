// Shared types for the redaction engine. The engine has no DOM dependencies so the
// same code runs in the browser worker and in Node tests.

export type Quad = [number, number, number, number, number, number, number, number];
export type Rect = [number, number, number, number]; // x0, y0, x1, y1 (MuPDF page space, y down)

export type Category =
	| "name"
	| "ssn"
	| "dl"
	| "ncic"
	| "account"
	| "dob"
	| "address"
	| "phone"
	| "other";

export const CATEGORY_LABELS: Record<Category, string> = {
	name: "Protected person's name (initials box)",
	ssn: "Social Security numbers",
	dl: "Driver's license numbers",
	ncic: "NCIC / CII numbers",
	account: "Account numbers (MRN, policy, claim, member, bank, ...)",
	dob: "Dates of birth",
	address: "Addresses",
	phone: "Phone numbers",
	other: "Other names entered by user",
};

export interface RedactOptions {
	fullName: string;
	variants: string[];
	initials: string;
	dob?: string; // free text; parsed by parseUserDate
	addresses: string[];
	phones: string[];
	otherNames: string[];
	otherAddresses: string[];
	otherPhones: string[];
}

/** A match in page text, as a half-open character range [start, end). */
export interface Hit {
	cat: Category;
	start: number;
	end: number;
	/** Draw these initials in the box (protected-person names only). */
	initials?: string;
	/** Surface form, when the match was a fuzzy (not user-listed) name form. */
	closeMatch?: string;
}

export interface PageText {
	text: string;
	/** quad for each character of text; null for synthetic newlines */
	quads: (Quad | null)[];
	/** line index for each character */
	lineOf: Int32Array;
	lines: { start: number; end: number; bbox: Rect }[];
}

export interface PageResult {
	counts: Partial<Record<Category, number>>;
	closeMatches: string[];
}
