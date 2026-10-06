// In-browser performance test on a large synthetic file. Skipped unless PERF_FILE is set:
//   PERF_FILE=/tmp/6068redact-perf-5000.pdf npx playwright test perf
// Reports wall time, pages/second, peak WASM heap (reported by the worker), peak total
// RSS of all Chromium processes (sampled with ps), and verifies the downloaded output.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import * as mupdf from "mupdf";
import { OPTIONS, PROTECTED } from "../fixtures/make";

const FILE = process.env.PERF_FILE;
test.skip(!FILE, "set PERF_FILE to run");

function chromiumRssMB(): number {
	const out = execSync("ps -axo rss=,command=", { encoding: "utf8", maxBuffer: 64 << 20 });
	let kb = 0;
	for (const line of out.split("\n")) if (/ms-playwright|Chromium|chrome-headless/i.test(line)) kb += parseInt(line.trim(), 10) || 0;
	return Math.round(kb / 1024);
}

test("5,000-page file in the browser", async ({ page }) => {
	test.setTimeout(60 * 60_000);
	await page.addInitScript(() => delete (window as any).showSaveFilePicker);
	await page.goto("/");
	await expect(page.locator("#engine-status")).toContainText("Engine ready", { timeout: 60_000 });
	await page.setInputFiles("#file", FILE!);
	await page.fill("#fullName", OPTIONS.fullName);
	await page.fill("#variants", OPTIONS.variants.join("\n"));
	await page.fill("#dob", "03/14/1979");
	await page.fill("#addresses", OPTIONS.addresses.join("\n"));
	await page.fill("#phones", OPTIONS.phones.join("\n"));
	await page.fill("#otherNames", OPTIONS.otherNames.join("\n"));
	await page.fill("#otherPhones", OPTIONS.otherPhones.join("\n"));

	let peakRss = chromiumRssMB();
	const t0 = Date.now();
	await page.click("#run");
	const timer = setInterval(() => (peakRss = Math.max(peakRss, chromiumRssMB())), 2000);
	let lastLog = 0;
	while (!(await page.locator("#done").isVisible()) && !(await page.locator("#failed").isVisible())) {
		await page.waitForTimeout(2000);
		if (Date.now() - lastLog > 30_000) {
			lastLog = Date.now();
			console.log(`  ${await page.locator("#progress-text").textContent()}  rss ${peakRss} MB`);
		}
	}
	const seconds = (Date.now() - t0) / 1000;
	clearInterval(timer);
	await expect(page.locator("#failed")).toBeHidden();
	const peakWasm = await page.evaluate(() => (window as any).__engineStats.peakWasmBytes);
	// Check the staged output file directly (before the download step).
	const staged = await page.evaluate(async () => {
		const dir = await navigator.storage.getDirectory();
		const f = await (await dir.getFileHandle("6068redact-output.pdf")).getFile();
		return { size: f.size, tail: await f.slice(f.size - 64).text() };
	});
	console.log("staged output:", staged.size, JSON.stringify(staged.tail.slice(-20)));
	expect(staged.tail).toContain("%%EOF");

	const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-redacted")]);
	const out = FILE!.replace(/\.pdf$/, "_browser_REDACTED.pdf");
	await dl.saveAs(out);
	const fd = fs.openSync(out, "r");
	const size = fs.fstatSync(fd).size;
	const d = mupdf.Document.openDocument(
		new mupdf.Stream({ fileSize: () => size, read: (m: Uint8Array, o: number, l: number, p: number) => fs.readSync(fd, m, o, l, p), close: () => {} }),
		"application/pdf",
	);
	const pages = d.countPages();
	let leaks = 0;
	for (let i = 0; i < pages; i += 97) {
		const t = d.loadPage(i).toStructuredText("").asText().replace(/\s+/g, "").toLowerCase();
		for (const s of PROTECTED) if (t.includes(s.replace(/\s+/g, "").toLowerCase())) leaks++;
	}
	const result = {
		inputMB: Math.round(fs.statSync(FILE!).size / 1048576),
		outputMB: Math.round(size / 1048576),
		pages,
		seconds: +seconds.toFixed(1),
		pagesPerSecond: +(pages / seconds).toFixed(1),
		peakWasmMB: Math.round(peakWasm / 1048576),
		peakChromiumRssMB: peakRss,
		sampledPagesWithLeaks: leaks,
	};
	console.log(JSON.stringify(result, null, 2));
	fs.writeFileSync(FILE!.replace(/\.pdf$/, "_perf-browser.json"), JSON.stringify(result, null, 2));
	expect(pages).toBe(5000);
	expect(leaks).toBe(0);
});
