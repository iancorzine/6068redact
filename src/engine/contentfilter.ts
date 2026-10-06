// A small PDF content-stream filter. It removes hidden text that MuPDF's redaction
// leaves behind:
//   * marked-content property lists (ActualText, Alt, E, MCID) are dropped by
//     rewriting "/Tag <<...>> BDC" and "/Tag /Name BDC" as "/Tag BMC";
//   * content inside optional-content groups that are turned off is deleted, as are
//     XObjects that carry a hidden /OC entry.

export interface FilterEnv {
	/** /OC /Name BDC — is the referenced OCG/OCMD hidden? */
	isHiddenOC(propName: string): boolean;
	/** /Name Do — does this XObject carry a hidden /OC? */
	isHiddenXObject(name: string): boolean;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

type TokType = "num" | "op" | "name" | "str" | "hex" | "dict" | "array" | "other";
interface Tok {
	t: TokType;
	s: number;
	e: number;
	v?: string;
}

class Lexer {
	p = 0;
	constructor(private b: Uint8Array) {}

	private skipWs() {
		const b = this.b;
		while (this.p < b.length) {
			const c = b[this.p];
			if (WS[c]) this.p++;
			else if (c === 0x25) {
				while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
			} else break;
		}
	}

	/** Read one object or operator token; composite objects (dicts/arrays) are read whole. */
	next(): Tok | null {
		this.skipWs();
		const b = this.b;
		if (this.p >= b.length) return null;
		const s = this.p;
		const c = b[s];
		if (c === 0x28) {
			this.readString();
			return { t: "str", s, e: this.p };
		}
		if (c === 0x3c && b[s + 1] === 0x3c) {
			this.p += 2;
			this.readUntilClose(0x3e, true);
			return { t: "dict", s, e: this.p };
		}
		if (c === 0x3c) {
			while (this.p < b.length && b[this.p] !== 0x3e) this.p++;
			this.p++;
			return { t: "hex", s, e: this.p };
		}
		if (c === 0x5b) {
			this.p++;
			this.readUntilClose(0x5d, false);
			return { t: "array", s, e: this.p };
		}
		if (c === 0x2f) {
			this.p++;
			while (this.p < b.length && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
			return { t: "name", s, e: this.p, v: latin1(b, s + 1, this.p) };
		}
		if (DELIM[c]) {
			// stray ")" "]" ">" "{" "}" — treat as single-char token
			this.p++;
			return { t: "other", s, e: this.p };
		}
		while (this.p < b.length && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
		const v = latin1(b, s, this.p);
		return { t: /^[+\-.0-9]/.test(v) ? "num" : "op", s, e: this.p, v };
	}

	private readString() {
		const b = this.b;
		let depth = 0;
		while (this.p < b.length) {
			const c = b[this.p++];
			if (c === 0x5c) this.p++;
			else if (c === 0x28) depth++;
			else if (c === 0x29 && --depth === 0) return;
		}
	}

	/** Skip nested content until the matching close (">>" for dicts, "]" for arrays). */
	private readUntilClose(close: number, dbl: boolean) {
		const b = this.b;
		while (this.p < b.length) {
			this.skipWs();
			const c = b[this.p];
			if (dbl && c === 0x3e && b[this.p + 1] === 0x3e) {
				this.p += 2;
				return;
			}
			if (!dbl && c === close) {
				this.p++;
				return;
			}
			if (this.next() === null) return;
		}
	}

	/** After "ID": skip inline image data up to and including "EI". */
	skipInlineImage() {
		const b = this.b;
		this.p++; // single whitespace after ID
		while (this.p < b.length - 1) {
			if (b[this.p] === 0x45 && b[this.p + 1] === 0x49 && WS[b[this.p - 1]] && (this.p + 2 >= b.length || WS[b[this.p + 2]] || DELIM[b[this.p + 2]])) {
				this.p += 2;
				return;
			}
			this.p++;
		}
		this.p = b.length;
	}
}

function latin1(b: Uint8Array, s: number, e: number): string {
	let out = "";
	for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
	return out;
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Quick check so most streams skip tokenizing entirely. */
export function needsFilter(b: Uint8Array, checkDo: boolean): boolean {
	for (let i = 0; i < b.length - 2; i++) {
		if (b[i] === 0x42 && b[i + 1] === 0x44 && b[i + 2] === 0x43) return true; // BDC
		if (checkDo && b[i] === 0x44 && b[i + 1] === 0x6f && (i + 2 >= b.length || WS[b[i + 2]])) return true; // Do
	}
	return false;
}

/** Returns the filtered stream, or null if nothing changed. */
export function filterContent(data: Uint8Array, env: FilterEnv): Uint8Array | null {
	const lx = new Lexer(data);
	const out: Uint8Array[] = [];
	let operands: Tok[] = [];
	let opStart = -1;
	let changed = false;
	// Stack of marked-content entries; `hidden` counts open hidden OC sections.
	const stack: boolean[] = [];
	let hidden = 0;
	let copyFrom = 0; // start of not-yet-flushed original bytes

	const flushUntil = (pos: number) => {
		if (pos > copyFrom) out.push(data.subarray(copyFrom, pos));
		copyFrom = pos;
	};

	for (;;) {
		const t = lx.next();
		if (!t) break;
		if (opStart < 0) opStart = t.s;
		if (t.t !== "op") {
			operands.push(t);
			continue;
		}
		const op = t.v!;
		let action: "keep" | "drop" | Uint8Array = "keep";
		if (op === "BI") {
			// Inline image: operands are key/value pairs up to ID, then binary data.
			for (;;) {
				const k = lx.next();
				if (!k || (k.t === "op" && k.v === "ID")) break;
			}
			lx.skipInlineImage();
		}
		const end = lx.p;
		if (op === "BDC" || op === "BMC") {
			const tag = operands[0]?.t === "name" ? operands[0].v! : "Span";
			let isHidden = false;
			if (op === "BDC" && tag === "OC" && operands[1]?.t === "name") isHidden = env.isHiddenOC(operands[1].v!);
			if (hidden > 0 || isHidden) {
				hidden++;
				stack.push(true);
				action = "drop";
			} else {
				stack.push(false);
				if (op === "BDC") action = enc(`/${tag} BMC`);
			}
		} else if (op === "EMC") {
			const wasHidden = stack.pop();
			if (wasHidden) {
				hidden--;
				action = "drop";
			}
		} else if (hidden > 0) {
			action = "drop";
		} else if (op === "Do" && operands[0]?.t === "name" && env.isHiddenXObject(operands[0].v!)) {
			action = "drop";
		}
		if (action !== "keep") {
			changed = true;
			flushUntil(opStart);
			if (action !== "drop") out.push(action, enc(" "));
			copyFrom = end;
		}
		operands = [];
		opStart = -1;
	}
	if (!changed) return null;
	flushUntil(data.length);
	let n = 0;
	for (const o of out) n += o.length;
	const res = new Uint8Array(n);
	let p = 0;
	for (const o of out) {
		res.set(o, p);
		p += o.length;
	}
	return res;
}
