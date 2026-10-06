import { initialsFor } from "../engine/names";
import { parseUserDate } from "../engine/patterns";
import type { Progress, Stats } from "../engine/pipeline";
import { CATEGORY_LABELS, type Category, type RedactOptions } from "../engine/types";
import type { FromWorker } from "../worker/protocol";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const lines = (id: string) =>
	$<HTMLTextAreaElement>(id)
		.value.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);

const form = $<HTMLFormElement>("form");
const fileInput = $<HTMLInputElement>("file");
const fullName = $<HTMLInputElement>("fullName");
const initials = $<HTMLInputElement>("initials");
const runBtn = $<HTMLButtonElement>("run");
const cancelBtn = $<HTMLButtonElement>("cancel");
const errors = $("errors");
const status = $("engine-status");

let worker: Worker | null = null;
let ready = false;
let busy = false;
let initialsEdited = false;
const objectUrls: string[] = [];
const engineStats = { peakWasmBytes: 0 };
(window as unknown as { __engineStats: typeof engineStats }).__engineStats = engineStats;

/** Start the worker now (at page load) so the engine is in memory before any file is chosen. */
function startWorker() {
	ready = false;
	worker = new Worker(new URL("../worker/worker.ts", import.meta.url), { type: "module", name: "6068redact-engine" });
	worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
	worker.onerror = (e) => fail(`The redaction engine failed to start (${e.message || "unknown error"}).`);
}

function onMessage(m: FromWorker) {
	switch (m.type) {
		case "ready":
			ready = true;
			status.textContent = "Engine ready. Everything runs locally in this tab; you may disconnect from the network.";
			status.classList.add("ok");
			runBtn.disabled = false;
			break;
		case "progress":
			showProgress(m.progress);
			// Peak engine memory, for the performance test harness (never leaves the page).
			engineStats.peakWasmBytes = Math.max(engineStats.peakWasmBytes, m.wasmBytes);
			break;
		case "blocked":
			finish();
			show("blocked");
			$("blocked-pages").textContent = `${m.noTextPages.length} of ${m.pageCount} page(s): ${ranges(m.noTextPages)}`;
			break;
		case "done":
			finish();
			showDone(m.redacted, m.report, m.stats);
			break;
		case "error":
			fail(m.message);
			break;
	}
}

const PHASES: Record<Progress["phase"], string> = {
	precheck: "Pre-check (text layer)",
	redact: "Redacting",
	assemble: "Assembling output",
	report: "Writing exceptions report",
};

function showProgress(p: Progress) {
	const bar = $<HTMLProgressElement>("progress");
	// Pre-check is ~25% of the work, redaction ~75%.
	const frac = p.phase === "precheck" ? 0.25 * (p.done / p.total) : p.phase === "redact" ? 0.25 + 0.73 * (p.done / p.total) : 0.99;
	bar.value = Math.round(frac * 100);
	$("progress-text").textContent =
		p.phase === "precheck" || p.phase === "redact" ? `${PHASES[p.phase]}: ${p.done.toLocaleString()} of ${p.total.toLocaleString()} pages` : `${PHASES[p.phase]}…`;
}

function ranges(pages: number[]): string {
	const out: string[] = [];
	for (let i = 0; i < pages.length; ) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
		out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
		i = j + 1;
	}
	return out.join(", ");
}

function baseName(name: string) {
	return name.replace(/\.pdf$/i, "");
}

function showDone(redacted: Blob, report: Blob, s: Stats) {
	show("done");
	for (const u of objectUrls.splice(0)) URL.revokeObjectURL(u);
	const base = baseName(s.fileName);
	const a = $<HTMLAnchorElement>("dl-redacted");
	const b = $<HTMLAnchorElement>("dl-report");
	a.href = track(URL.createObjectURL(redacted));
	a.download = `${base}_REDACTED.pdf`;
	b.href = track(URL.createObjectURL(report));
	b.download = `${base}_EXCEPTIONS.pdf`;
	downloads.set(a, redacted);
	downloads.set(b, report);
	$("dl-hint").hidden = true;
	const rows: [string, string][] = [
		["Pages", s.pageCount.toLocaleString()],
		...(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => [CATEGORY_LABELS[k], String(s.counts[k])] as [string, string]),
		["Close-match name forms", String(s.closeMatches.length)],
		["Low-text pages (likely poor scans)", s.lowTextPages.length ? ranges(s.lowTextPages) : "none"],
		["Time", `${(s.elapsedMs / 1000).toFixed(1)} s`],
		["Output size", `${(s.outputBytes / 1048576).toFixed(1)} MB`],
	];
	const table = $("summary");
	table.replaceChildren(
		...rows.map(([k, v]) => {
			const tr = document.createElement("tr");
			const th = document.createElement("th");
			const td = document.createElement("td");
			th.textContent = k;
			td.textContent = v;
			tr.append(th, td);
			return tr;
		}),
	);
}

const downloads = new Map<HTMLAnchorElement, Blob>();

interface SaveHandle {
	createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;

/**
 * Prefer the browser's Save dialog (Chrome/Edge): it streams the file to the chosen
 * location and works even where <a download> is ignored (some embedded browser views).
 * Elsewhere the plain download link is used, with a hint if nothing seems to happen.
 */
async function onDownloadClick(e: MouseEvent) {
	const a = e.currentTarget as HTMLAnchorElement;
	const blob = downloads.get(a);
	const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	if (blob && picker && e.isTrusted) {
		e.preventDefault();
		try {
			const handle = await picker({ suggestedName: a.download, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
			const w = await handle.createWritable();
			await w.write(blob);
			await w.close();
			return;
		} catch (err) {
			if ((err as DOMException)?.name === "AbortError") return; // user cancelled
			// Picker unavailable here (e.g. embedded view): fall back to the link.
			a.click();
			return;
		}
	}
	setTimeout(() => ($("dl-hint").hidden = false), 1500);
}
$("dl-redacted").addEventListener("click", onDownloadClick);
$("dl-report").addEventListener("click", onDownloadClick);

function track(u: string) {
	objectUrls.push(u);
	return u;
}

function show(id: "blocked" | "done" | "failed" | null) {
	for (const s of ["blocked", "done", "failed"]) $(s).hidden = s !== id;
}

function finish() {
	busy = false;
	$("progress-card").hidden = true;
	cancelBtn.hidden = true;
	runBtn.disabled = !ready;
	form.querySelectorAll("input, textarea").forEach((el) => ((el as HTMLInputElement).disabled = false));
}

function fail(message: string) {
	finish();
	show("failed");
	$("failed-text").textContent = message;
}

function validate(): RedactOptions | null {
	const problems: string[] = [];
	const file = fileInput.files?.[0];
	if (!file) problems.push("Choose a PDF file.");
	else if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") problems.push("The file must be a PDF.");
	else if (file.size > 2 ** 31 - 1) problems.push("The file is larger than 2 GB, the PDF engine's limit. Split it in Acrobat (Organize Pages → Split) and redact each part.");
	if (!fullName.value.trim()) problems.push("Enter the protected person's full name.");
	const variants = lines("variants");
	if (!variants.length) problems.push("Enter at least one name variant (nickname, maiden name or misspelling).");
	if (!initials.value.trim()) problems.push("Enter initials.");
	const dob = $<HTMLInputElement>("dob").value.trim();
	if (dob && !parseUserDate(dob)) problems.push("The date of birth was not recognized. Use MM/DD/YYYY.");
	errors.hidden = !problems.length;
	errors.textContent = problems.join(" ");
	if (problems.length) return null;
	return {
		fullName: fullName.value.trim(),
		variants,
		initials: initials.value.trim().toUpperCase(),
		dob: dob || undefined,
		addresses: lines("addresses"),
		phones: lines("phones"),
		otherNames: lines("otherNames"),
		otherAddresses: lines("otherAddresses"),
		otherPhones: lines("otherPhones"),
	};
}

fullName.addEventListener("input", () => {
	if (!initialsEdited) initials.value = initialsFor(fullName.value);
});
initials.addEventListener("input", () => {
	initialsEdited = initials.value.trim() !== "";
});

fileInput.addEventListener("change", () => {
	const f = fileInput.files?.[0];
	$("file-label").textContent = f ? `${f.name} — ${(f.size / 1048576).toFixed(1)} MB` : "Choose a PDF or drop it here";
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
	e.preventDefault();
	drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
	e.preventDefault();
	drop.classList.remove("over");
	if (e.dataTransfer?.files.length) {
		fileInput.files = e.dataTransfer.files;
		fileInput.dispatchEvent(new Event("change"));
	}
});

form.addEventListener("submit", (e) => {
	e.preventDefault();
	if (busy || !ready || !worker) return;
	const options = validate();
	if (!options) return;
	busy = true;
	show(null);
	runBtn.disabled = true;
	cancelBtn.hidden = false;
	form.querySelectorAll("input, textarea").forEach((el) => ((el as HTMLInputElement).disabled = true));
	$("progress-card").hidden = false;
	showProgress({ phase: "precheck", done: 0, total: 1 });
	worker.postMessage({ type: "start", file: fileInput.files![0], options });
});

cancelBtn.addEventListener("click", () => {
	worker?.terminate();
	finish();
	runBtn.disabled = true;
	status.textContent = "Cancelled. Restarting engine…";
	status.classList.remove("ok");
	startWorker();
});

startWorker();
