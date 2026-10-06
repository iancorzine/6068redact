import type { Progress, Stats } from "../engine/pipeline";
import type { RedactOptions } from "../engine/types";

export type ToWorker = { type: "start"; file: File; options: RedactOptions };

export type FromWorker =
	| { type: "ready" }
	| { type: "progress"; progress: Progress; wasmBytes: number }
	| { type: "blocked"; pageCount: number; noTextPages: number[] }
	| { type: "done"; redacted: Blob; report: Blob; stats: Stats }
	| { type: "error"; message: string };
