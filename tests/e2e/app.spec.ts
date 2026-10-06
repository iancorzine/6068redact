import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import * as mupdf from "mupdf";
import { makeMainFixture, makeNoTextFixture, MUST_REMAIN, OPTIONS, PROTECTED } from "../fixtures/make";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "6068redact-e2e-"));
const mainPdf = path.join(tmp, "Synthetic Records.pdf");
const noTextPdf = path.join(tmp, "needs-ocr.pdf");
fs.writeFileSync(mainPdf, makeMainFixture());
fs.writeFileSync(noTextPdf, makeNoTextFixture());

const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Load the app and record every request made after the engine is ready. */
async function openApp(page: Page) {
	const violations: string[] = [];
	await page.exposeFunction("__cspViolation", (v: string) => violations.push(v));
	await page.addInitScript(() => {
		// Headless tests capture downloads via the link, not the native Save dialog.
		delete (window as any).showSaveFilePicker;
		document.addEventListener("securitypolicyviolation", (e) => (window as any).__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
	});
	await page.goto("/");
	await expect(page.locator("#engine-status")).toContainText("Engine ready", { timeout: 60_000 });
	const requests: string[] = [];
	page.context().on("request", (r) => requests.push(r.url()));
	return { requests, violations };
}

async function fillForm(page: Page, file: string) {
	await page.setInputFiles("#file", file);
	await page.fill("#fullName", OPTIONS.fullName);
	await expect(page.locator("#initials")).toHaveValue("MV"); // auto-filled from the full name
	await page.fill("#variants", OPTIONS.variants.join("\n"));
	await page.fill("#dob", "03/14/1979");
	await page.fill("#addresses", OPTIONS.addresses.join("\n"));
	await page.fill("#phones", OPTIONS.phones.join("\n"));
	await page.fill("#otherNames", OPTIONS.otherNames.join("\n"));
	await page.fill("#otherPhones", OPTIONS.otherPhones.join("\n"));
}

function pdfText(file: string): string {
	const d = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
	let t = "";
	for (let i = 0; i < d.countPages(); i++) t += d.loadPage(i).toStructuredText("preserve-whitespace").asText() + "\n";
	return t;
}

test("full flow: upload, redact, download both files — with zero network requests after load", async ({ page }) => {
	const { requests, violations } = await openApp(page);
	await fillForm(page, mainPdf);
	await page.screenshot({ path: path.join("test-results", "01-form-filled.png"), fullPage: true });
	await page.click("#run");
	await expect(page.locator("#progress-card")).toBeVisible();
	await expect(page.locator("#done")).toBeVisible({ timeout: 120_000 });
	await page.screenshot({ path: path.join("test-results", "02-done.png"), fullPage: true });

	const [dl1] = await Promise.all([page.waitForEvent("download"), page.click("#dl-redacted")]);
	expect(dl1.suggestedFilename()).toBe("Synthetic Records_REDACTED.pdf");
	const out = path.join(tmp, dl1.suggestedFilename());
	await dl1.saveAs(out);
	const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#dl-report")]);
	expect(dl2.suggestedFilename()).toBe("Synthetic Records_EXCEPTIONS.pdf");
	await dl2.saveAs(path.join(tmp, dl2.suggestedFilename()));

	const text = pdfText(out);
	for (const s of PROTECTED) expect(squash(text), `found "${s}"`).not.toContain(squash(s));
	for (const s of MUST_REMAIN) expect(text.replace(/\s+/g, " ")).toContain(s);
	expect(mupdf.Document.openDocument(fs.readFileSync(out), "application/pdf").countPages()).toBe(8);

	// Only blob: downloads may appear; nothing over the network.
	expect(requests.filter((u) => !u.startsWith("blob:"))).toEqual([]);
	expect(violations).toEqual([]);
});

test("works with the network disconnected after load", async ({ page, context }) => {
	await openApp(page);
	await context.setOffline(true);
	await fillForm(page, mainPdf);
	await page.click("#run");
	await expect(page.locator("#done")).toBeVisible({ timeout: 120_000 });
	await expect(page.locator("#summary")).toContainText("Social Security numbers");
});

test("pages without a text layer stop processing and are listed", async ({ page }) => {
	await openApp(page);
	await fillForm(page, noTextPdf);
	await page.click("#run");
	await expect(page.locator("#blocked")).toBeVisible({ timeout: 60_000 });
	await expect(page.locator("#blocked-pages")).toHaveText("2 of 5 page(s): 2, 4");
	await expect(page.locator("#done")).toBeHidden();
	await page.screenshot({ path: path.join("test-results", "03-blocked.png"), fullPage: true });
});

test("the Content Security Policy blocks all outgoing requests", async ({ page }) => {
	const { violations } = await openApp(page);
	const results = await page.evaluate(async () => {
		const tryFetch = (u: string) => fetch(u).then(() => "allowed", () => "blocked");
		const img = await new Promise((res) => {
			const i = new Image();
			i.onload = () => res("allowed");
			i.onerror = () => res("blocked");
			i.src = "https://example.com/pixel.png";
		});
		return {
			external: await tryFetch("https://example.com/"),
			sameOrigin: await tryFetch("/"),
			// sendBeacon returns true when queued; the CSP blocks it when it is sent.
			beacon: (navigator.sendBeacon("https://example.com/beacon", "x"), "sent"),
			img,
		};
	});
	expect(results).toEqual({ external: "blocked", sameOrigin: "blocked", beacon: "sent", img: "blocked" });
	await expect.poll(() => violations.join("\n")).toContain("connect-src https://example.com/beacon");
	expect(violations.join("\n")).toContain("connect-src https://example.com/");
	expect(violations.join("\n")).toContain("img-src https://example.com/pixel.png");
});

test("required fields are validated", async ({ page }) => {
	await openApp(page);
	await page.click("#run");
	await expect(page.locator("#errors")).toContainText("Choose a PDF file.");
	await expect(page.locator("#errors")).toContainText("full name");
	await expect(page.locator("#errors")).toContainText("name variant");
	await page.fill("#fullName", "Jane Q. Smith");
	await expect(page.locator("#initials")).toHaveValue("JS");
	await page.fill("#initials", "JQS");
	await page.fill("#fullName", "Jane Smith");
	await expect(page.locator("#initials")).toHaveValue("JQS"); // user edit is kept
});
