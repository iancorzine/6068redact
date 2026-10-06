// Joins chunk PDFs written by MuPDF into one PDF without loading them all into the
// WASM heap. Object dictionaries are parsed and renumbered; stream data is copied
// straight through to the output sink. Only MuPDF's own output is accepted (classic
// xref table, no object streams), which keeps the parser small and strict.

/** Where assembled bytes go: memory (tests, fallback) or a file on disk (browser OPFS). */
export interface ByteSink {
	/** Write bytes at the current end. `b` may be a view into WASM memory: copy it. */
	write(b: Uint8Array): void;
	/** Finish writing. Returns the output as a Blob, or undefined if it lives elsewhere. */
	finish(): Blob | undefined;
}

export class MemorySink implements ByteSink {
	private parts: Uint8Array<ArrayBuffer>[] = [];
	write(b: Uint8Array) {
		this.parts.push(b.slice() as Uint8Array<ArrayBuffer>);
	}
	finish() {
		return new Blob(this.parts, { type: "application/pdf" });
	}
}

const enc = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function latin1(b: Uint8Array, s: number, e: number): string {
	let out = "";
	const CH = 8192;
	for (let i = s; i < e; i += CH) out += String.fromCharCode(...b.subarray(i, Math.min(e, i + CH)));
	return out;
}

function indexOf(b: Uint8Array, needle: string, from: number, to = b.length): number {
	const n = enc(needle);
	outer: for (let i = from; i <= to - n.length; i++) {
		for (let k = 0; k < n.length; k++) if (b[i + k] !== n[k]) continue outer;
		return i;
	}
	return -1;
}
function lastIndexOf(b: Uint8Array, needle: string): number {
	const n = enc(needle);
	outer: for (let i = b.length - n.length; i >= Math.max(0, b.length - 4096); i--) {
		for (let k = 0; k < n.length; k++) if (b[i + k] !== n[k]) continue outer;
		return i;
	}
	return -1;
}

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: string) => "()<>[]{}/%".includes(c);

/** Replace every "n g R" reference outside strings using map (missing -> null). */
export function rewriteRefs(body: string, map: (n: number) => number | undefined): string {
	let out = "";
	let i = 0;
	const re = /(\d+)\s+(\d+)\s+R(?![^\s\/\[\]<>()%{}])/y;
	while (i < body.length) {
		const c = body[i];
		if (c === "(") {
			let depth = 0;
			const s = i;
			while (i < body.length) {
				const ch = body[i++];
				if (ch === "\\") i++;
				else if (ch === "(") depth++;
				else if (ch === ")" && --depth === 0) break;
			}
			out += body.slice(s, i);
			continue;
		}
		if ((c === "<" && body[i + 1] === "<") || (c === ">" && body[i + 1] === ">")) {
			out += c + c;
			i += 2;
			continue;
		}
		if (c === "<") {
			const e = body.indexOf(">", i);
			const end = e < 0 ? body.length : e + 1;
			out += body.slice(i, end);
			i = end;
			continue;
		}
		if (c === "%") {
			const e = body.slice(i).search(/[\r\n]/);
			const end = e < 0 ? body.length : i + e;
			out += body.slice(i, end);
			i = end;
			continue;
		}
		if (c >= "0" && c <= "9" && (i === 0 || isWs(body.charCodeAt(i - 1)) || isDelim(body[i - 1]))) {
			re.lastIndex = i;
			const m = re.exec(body);
			if (m) {
				const nn = map(parseInt(m[1], 10));
				out += nn === undefined ? "null" : `${nn} 0 R`;
				i += m[0].length;
				continue;
			}
		}
		out += c;
		i++;
	}
	return out;
}

interface ObjInfo {
	num: number;
	bodyStart: number;
	bodyEnd: number;
	streamStart?: number;
	streamEnd?: number;
}

export class PdfAssembler {
	private pos = 0;
	private offsets: number[] = [0, 0, 0];
	private nextNum = 3;
	private kids: number[] = [];

	constructor(private sink: ByteSink = new MemorySink()) {
		this.push(enc("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"));
	}

	get size() {
		return this.pos;
	}

	get pageCount() {
		return this.kids.length;
	}

	private push(p: Uint8Array) {
		this.sink.write(p);
		this.pos += p.length;
	}

	/** Parse a MuPDF-written chunk PDF and append its pages. `b` may be a view into WASM memory. */
	addChunk(b: Uint8Array): void {
		const sx = lastIndexOf(b, "startxref");
		if (sx < 0) throw new Error("chunk: no startxref");
		const xrefPos = parseInt(latin1(b, sx + 9, Math.min(b.length, sx + 40)).trim(), 10);
		if (latin1(b, xrefPos, xrefPos + 4) !== "xref") throw new Error("chunk: unsupported xref (expected classic table)");
		const trailerPos = indexOf(b, "trailer", xrefPos);
		const xrefText = latin1(b, xrefPos + 4, trailerPos);
		const offsets = new Map<number, number>();
		const lines = xrefText.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
		let cur = 0;
		for (const l of lines) {
			const sub = /^(\d+)\s+(\d+)$/.exec(l);
			if (sub) {
				cur = parseInt(sub[1], 10);
				continue;
			}
			const ent = /^(\d{10})\s+(\d{5})\s+([nf])/.exec(l);
			if (ent) {
				if (ent[3] === "n") offsets.set(cur, parseInt(ent[1], 10));
				cur++;
			}
		}
		const trailer = latin1(b, trailerPos, sx);
		const rootNum = refIn(trailer, "Root");
		const infoNum = refIn(trailer, "Info");
		if (rootNum === undefined) throw new Error("chunk: no Root");

		const objs = new Map<number, ObjInfo>();
		const parse = (num: number): ObjInfo => {
			let o = objs.get(num);
			if (!o) {
				o = parseObject(b, offsets.get(num)!, num, (n) => {
					const lo = parse(n);
					return parseInt(latin1(b, lo.bodyStart, lo.bodyEnd).trim(), 10);
				});
				objs.set(num, o);
			}
			return o;
		};
		const bodyOf = (num: number) => {
			const o = parse(num);
			return latin1(b, o.bodyStart, o.bodyEnd);
		};

		const rootBody = bodyOf(rootNum);
		const pagesRoot = refIn(rootBody, "Pages");
		if (pagesRoot === undefined) throw new Error("chunk: no Pages");
		const dropped = new Set<number>([rootNum]);
		if (infoNum !== undefined) dropped.add(infoNum);
		const catalogInfo = refIn(rootBody, "Info");
		if (catalogInfo !== undefined) dropped.add(catalogInfo);
		const pageNodes = new Set<number>();
		const leaves: number[] = [];
		const walk = (n: number) => {
			const body = bodyOf(n);
			if (/\/Type\s*\/Pages\b/.test(body)) {
				pageNodes.add(n);
				dropped.add(n);
				const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
				if (kids) for (const m of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(parseInt(m[1], 10));
			} else leaves.push(n);
		};
		walk(pagesRoot);

		const map = new Map<number, number>();
		const kept = [...offsets.keys()].filter((n) => n > 0 && !dropped.has(n)).sort((x, y) => x - y);
		for (const n of kept) map.set(n, this.nextNum++);
		for (const n of pageNodes) map.set(n, 2);

		for (const n of kept) {
			const o = parse(n);
			const nn = map.get(n)!;
			this.offsets[nn] = this.pos;
			const body = rewriteRefs(latin1(b, o.bodyStart, o.bodyEnd), (r) => map.get(r));
			if (o.streamStart !== undefined) {
				this.push(enc(`${nn} 0 obj\n${body.trim()}\nstream\n`));
				this.push(b.subarray(o.streamStart, o.streamEnd));
				this.push(enc("\nendstream\nendobj\n"));
			} else {
				this.push(enc(`${nn} 0 obj\n${body.trim()}\nendobj\n`));
			}
		}
		for (const l of leaves) this.kids.push(map.get(l)!);
	}

	finish(): Blob | undefined {
		this.offsets[1] = this.pos;
		this.push(enc("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n"));
		this.offsets[2] = this.pos;
		const kids = this.kids.map((k) => `${k} 0 R`).join(" ");
		this.push(enc(`2 0 obj\n<</Type/Pages/Count ${this.kids.length}/Kids[${kids}]>>\nendobj\n`));
		const xrefPos = this.pos;
		const n = this.nextNum;
		const rows: string[] = [`xref\n0 ${n}\n0000000000 65535 f \n`];
		for (let i = 1; i < n; i++) rows.push(`${String(this.offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`);
		rows.push(`trailer\n<</Size ${n}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`);
		this.push(enc(rows.join("")));
		return this.sink.finish();
	}
}

function refIn(dictText: string, key: string): number | undefined {
	const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
	return m ? parseInt(m[1], 10) : undefined;
}

/** Locate the value (and stream data) of the indirect object starting at `off`. */
function parseObject(b: Uint8Array, off: number, num: number, resolveInt: (n: number) => number): ObjInfo {
	const head = latin1(b, off, Math.min(b.length, off + 40));
	const hm = /^(\d+)\s+(\d+)\s+obj/.exec(head);
	if (!hm || parseInt(hm[1], 10) !== num) throw new Error(`chunk: bad object header at ${off}`);
	const bodyStart = off + hm[0].length;
	const endobj = indexOf(b, "endobj", bodyStart);
	const streamKw = findStreamKeyword(b, bodyStart, endobj < 0 ? b.length : endobj);
	if (streamKw < 0) return { num, bodyStart, bodyEnd: endobj };
	const dict = latin1(b, bodyStart, streamKw);
	let p = streamKw + 6;
	if (b[p] === 13) p++;
	if (b[p] === 10) p++;
	const lm = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
	let len = lm ? (lm[2] !== undefined ? resolveInt(parseInt(lm[1], 10)) : parseInt(lm[1], 10)) : -1;
	let end = p + len;
	let q = end;
	while (q < b.length && isWs(b[q])) q++;
	if (len < 0 || latin1(b, q, q + 9) !== "endstream") {
		// Fall back to searching for endstream.
		const es = indexOf(b, "endstream", p);
		end = es;
		while (end > p && (b[end - 1] === 10 || b[end - 1] === 13)) end--;
	}
	return { num, bodyStart, bodyEnd: streamKw, streamStart: p, streamEnd: end };
}

/** Find the "stream" keyword after a dictionary, skipping over strings. */
function findStreamKeyword(b: Uint8Array, s: number, e: number): number {
	let depth = 0;
	for (let i = s; i < e; i++) {
		const c = b[i];
		if (c === 0x28) {
			// skip literal string
			let d = 0;
			for (; i < e; i++) {
				if (b[i] === 0x5c) i++;
				else if (b[i] === 0x28) d++;
				else if (b[i] === 0x29 && --d === 0) break;
			}
			continue;
		}
		if (c === 0x3c && b[i + 1] === 0x3c) {
			depth++;
			i++;
			continue;
		}
		if (c === 0x3e && b[i + 1] === 0x3e) {
			depth--;
			i++;
			continue;
		}
		if (depth === 0 && c === 0x73 && latin1(b, i, i + 6) === "stream" && (i === s || isWs(b[i - 1]) || b[i - 1] === 0x3e)) return i;
	}
	return -1;
}
