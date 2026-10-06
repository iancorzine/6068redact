import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { DEFAULT_CONFIG, runRedaction, type Config, type Fonts, type Progress, type Source } from "../src/engine/pipeline";
import type { ByteSink } from "../src/engine/assembler";
import type { RedactOptions } from "../src/engine/types";

const ROOT = path.resolve(import.meta.dirname, "..");

export function loadFonts(): Fonts {
	return {
		bold: new Uint8Array(fs.readFileSync(path.join(ROOT, "src/assets/Arimo-Bold.ttf"))),
		regular: new Uint8Array(fs.readFileSync(path.join(ROOT, "src/assets/Arimo-Regular.ttf"))),
	};
}

export function bytesSource(bytes: Uint8Array, name = "test.pdf"): Source {
	return {
		name,
		size: bytes.length,
		open: () =>
			new mupdf.Stream({
				fileSize: () => bytes.length,
				read: (mem, off, len, pos) => {
					const n = Math.max(0, Math.min(len, bytes.length - pos));
					mem.set(bytes.subarray(pos, pos + n), off);
					return n;
				},
				close: () => {},
			}),
	};
}

export function fileSource(file: string): Source {
	const size = fs.statSync(file).size;
	return {
		name: path.basename(file),
		size,
		open: () => {
			const fd = fs.openSync(file, "r");
			return new mupdf.Stream({
				fileSize: () => size,
				read: (mem, off, len, pos) => fs.readSync(fd, mem, off, len, pos),
				close: () => fs.closeSync(fd),
			});
		},
	};
}

export function redact(src: Source, opts: RedactOptions, cfg: Partial<Config> = {}, onProgress: (p: Progress) => void = () => {}) {
	return runRedaction(src, opts, loadFonts(), onProgress, { ...DEFAULT_CONFIG, ...cfg });
}

export async function blobBytes(b: Blob): Promise<Uint8Array> {
	return new Uint8Array(await b.arrayBuffer());
}

/** Writes assembled output straight to a file (keeps Node memory flat in perf runs). */
export class FileSink implements ByteSink {
	private fd: number;
	constructor(file: string) {
		this.fd = fs.openSync(file, "w");
	}
	write(b: Uint8Array) {
		let off = 0;
		while (off < b.length) off += fs.writeSync(this.fd, b, off, b.length - off);
	}
	finish() {
		fs.closeSync(this.fd);
		return undefined;
	}
}
