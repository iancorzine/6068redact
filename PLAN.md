# 6068redact — Implementation Plan

Status: **APPROVED 2026-10-06** (decisions recorded in §0).

## 0. Decisions (2026-10-06) and revisions after prototyping

| Q | Decision |
|---|---|
| Q1 Hidden text | Keep the invisible OCR layer (with protected text removed). Strip text in hidden optional-content layers, text outside the page area, and ActualText/Alt strings. |
| Q2 First names | **Common first names** (bundled list) are redacted alone only when they are *near the last name* (within 2 lines) or in *patient context* ("Patient", "Pt", "Mr./Ms.", "Name:", "claimant", …). They are never redacted alone when directly preceded by "Dr." or followed by a credential (MD, DO, NP, RN…). Uncommon first names and all last names are always redacted. |
| Q3–Q13 | Defaults accepted (black box for "other" names, "JS" initials, flatten form fields, no standalone initials, <40 characters = low text, blank pages allowed and listed, no service worker, strip page labels, California-format driver's licenses unless labeled). |
| Q8 Size | Typical file size is **about 1.5 GB**. |
| Q12 Host | **Vercel**. The CSP is sent as an HTTP header via `vercel.json` and repeated in a `<meta>` tag. |

**Revision: memory design (supersedes §7).** The published MuPDF.js WASM has a hard **2 GB** memory limit, not 4 GB. A 1.5 GB file cannot be loaded into it, let alone saved. The engine therefore:
1. **Never copies the input into WASM.** MuPDF reads the file through a `Stream` callback (`FileReaderSync` on `File.slice()` in the worker), so only the pages being worked on are in WASM memory.
2. **Writes output in chunks.** Every batch of pages (default 100) is grafted into a small chunk PDF, cleaned and redacted, then saved. The bytes leave WASM right away.
3. **Joins chunks in JavaScript.** A small PDF assembler renumbers objects, keeps stream data as `Blob` slices (no copying), and writes one catalog, one page tree, and one cross-reference table. The browser can keep large Blobs on disk, so neither the 1.5 GB input nor the output ever has to fit inside the WASM heap.

**Revision: hidden content.** Prototyping showed MuPDF's redaction leaves ActualText strings, and content in hidden layers, in the content stream. A small content-stream filter (JavaScript, runs before text extraction) deletes ActualText/Alt/E properties and removes content in optional-content layers that are off. Text outside the page is removed with redaction areas placed just outside the page edges.

**Revision: image pixels (supersedes §6 step 2).** MuPDF's built-in pixel redaction paints the pixels white and re-encodes JPEG scans losslessly (Flate), which would make a 1.5 GB scanned file several times larger. 6068redact blacks out the pixels inside the image data itself and re-encodes JPEG as JPEG, at the original file's estimated quality. MuPDF's method is still used as a fallback for images it cannot rewrite directly (inline images, images inside form XObjects, stencil masks).

**Revision: output to disk.** In the browser, the assembled output is written as it is produced to a file in the origin-private file system (browser storage on this computer, never uploaded), so a ~1.5–2 GB result never has to fit in memory. The download link points at that file. It is deleted when the next run starts or the app is reopened.

**Limit found: 2 GB input.** mupdf.js streams pass file sizes and offsets as 32-bit integers, so inputs of 2 GiB or more cannot be opened. Such files are rejected with a message to split them in Acrobat. Typical 1.5 GB files are within the limit.

**Fix: memory.** mupdf.js 1.28.1 leaks a reference in `loadImage()` and frees temporary buffers only on JS garbage collection. Both are handled explicitly (`src/engine/buffers.ts`), and a regression test guards against heap growth.

**Font note:** Arimo is now licensed under SIL OFL 1.1, not Apache-2.0. Bundling it is still fine.

**Environment note:** git does not work on this Mac because the Xcode Command Line Tools are x86 builds on Apple Silicon (`xcrun` fails). The project is not under version control until those tools are reinstalled (`xcode-select --install`).

## 1. What we're building

6068redact is a static web app. It takes one large PDF (up to 5,000 pages) and removes the protected person's identifying information. It also redacts SSNs, ID numbers, and account numbers. Everything runs in the browser, so the file never leaves the computer. The app produces two files:

- `[original name]_REDACTED.pdf`: the redacted document, with the same page count, page sizes, and layout as the original.
- `[original name]_EXCEPTIONS.pdf`: a one-page exceptions report.

It supports compliance with Cal. Bus. & Prof. Code § 6068.1 (effective January 1, 2027).

## 2. Architecture

```
index.html  (strict CSP, no outside resources)
 ├─ main thread: UI (plain TypeScript, no framework)
 │    form → validation → start job → progress bar → download links
 └─ Web Worker: redaction engine
      ├─ MuPDF.js (WebAssembly), bundled
      ├─ Arimo-Bold.ttf, bundled
      ├─ Pass 1: pre-check (text layer on every page)
      ├─ Pass 2: find matches → apply redactions → draw initials boxes  (in batches)
      ├─ Pass 3: sanitize document (metadata, annotations, JS, …)
      ├─ Save: full rewrite with garbage collection (never an incremental save)
      └─ Build the exceptions report PDF
```

- **Build tool:** Vite + TypeScript. The output in `dist/` is plain static files that any static host can serve.
- **No runtime dependencies from outside.** MuPDF's WASM file and the Arimo font are bundled into the worker as embedded bytes. The app therefore never makes a network request after `index.html` and its scripts load. This lets the CSP set `connect-src 'none'`, which is stricter than `'self'`.
- **Offline:** once the page has loaded, every asset is in memory. Disconnecting the network has no effect. (Optional: a service worker so the app also *reloads* offline. See Q9.)

### Content Security Policy

Set in a `<meta>` tag, and also in a `_headers` file for hosts that support it:

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
style-src 'self';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'none';
form-action 'none';
base-uri 'none';
object-src 'none';
```

Downloads use `blob:` URLs with `<a download>`. No network is involved.

There are no analytics, no telemetry, and no error reporting. Errors appear only on screen. We will also add a CI check that searches the built bundle for `http://`, `https://`, `fetch(`, `XMLHttpRequest`, `WebSocket`, and `sendBeacon`. Any hit that isn't on an allowlist (for example, license text) fails the build.

## 3. Input screen

| Field | Required | Notes |
|---|---|---|
| PDF file | Yes | One file. Encrypted or password-protected PDFs are rejected with a clear message. |
| Notice | — | Shown above the upload box: "Run Adobe Acrobat 'Recognize Text' with the 'Searchable Image' setting before uploading." |
| Full name | Yes | e.g. "Jane Q. Smith" |
| Name variants | Yes (≥1) | One per line: nicknames, maiden names, misspellings |
| Initials | Yes | Filled automatically from the full name ("Jane Q. Smith" → "JQS", or "JS"; see Q4). The user can edit it. |
| Date of birth | No | Date picker plus free text |
| Addresses | No | One per entry, multi-line |
| Phone numbers | No | One per line |
| Other names / addresses / phones | No | Redacted as **solid black, no initials** (see Q3) |

A **Redact** button starts the job. A progress bar shows "Pre-check: page X of N", then "Redacting: page X of N", then "Saving…". When the job finishes, the screen shows two download buttons and a short summary. There is no manual review screen.

## 4. Pre-check

- For every page, extract MuPDF structured text and count non-whitespace characters.
- If any page has zero characters, **stop**. The screen lists those page numbers (compressed into ranges, e.g. "4, 17–19, 230") and no output is produced.
- Pages with a little text but below a threshold (default: fewer than 40 non-whitespace characters, see Q7) are allowed through. They are listed in the exceptions report as likely poor scans.

## 5. Detection engine

All detection runs on MuPDF structured text. For each page I build a normalized string where every character maps back to its quad (bounding box) on the page. Regexes and fuzzy matchers run on that string. Each match becomes one or more rectangles, one per line it covers, padded by about 1 pt so the box fully covers the glyphs.

### OCR normalization (used for matching only, never shown)
- For digit fields: `O o Q D → 0`, `l I i | ! → 1`, `S s → 5`, `B → 8`, `Z z → 2`, `G → 6`. Stray spaces, dots, and dashes inside numbers are allowed.
- For names: case-folded, accents removed, `rn ↔ m`, `cl ↔ d`, `vv ↔ w`, `0 → o`, `1 → l`, `5 → s`.

### 5.1 Protected person's names → black box with white initials
Candidates are built from the full name and every variant:
- the full form; "First Last"; "First M. Last"; "First Middle Last"; "Last, First"; "Last, First M."; "LAST FIRST"
- **first name alone** and **last name alone** (each token of each variant)
- possessives ("Smith's") and hyphenated surnames, both whole and in parts

Matching rules:
- Exact match after case and accent folding.
- Fuzzy match on single words, using OCR-weighted edit distance:
  - words of 4 or fewer letters: exact (after OCR normalization) only
  - words of 5–7 letters: distance ≤ 1
  - words of 8 or more letters: distance ≤ 2
- Multi-word names that span a line break are matched across lines.
- Any fuzzy match that is **not** on the user's list is recorded for the exceptions report ("close match: 'Srnith' → Smith").

Appearance: the redaction is applied first (text and pixels removed), and then a solid black rectangle is drawn into the page content. The initials are centered on it in white **Arimo Bold**. The font size is the largest size that fits within about 85% of the box's width and 80% of its height. Arimo Bold is embedded as a subset font.

### 5.2 Solid black boxes (no text)
| Category | Detection |
|---|---|
| SSN | `ddd-dd-dddd` with OCR tolerance and any separators (space, dash, dot, none). Also any 9-digit run next to an "SSN / SS# / Social Security" label. Also a masked form such as `XXX-XX-1234` (the last 4 digits are redacted). |
| Driver's license | California format (1 letter + 7 digits) anywhere. Any alphanumeric ID token (5–15 characters, containing a digit) after a "DL / D.L. / Driver's License / CDL / License No." label. |
| NCIC / CII | Any ID token after an "NCIC", "CII", "FBI No.", or "SID" label. California CII format (`A` + 8 digits, OCR tolerant) anywhere. |
| Account numbers | Any ID token (4 or more characters, containing at least 3 digits) after labels such as: Account, Acct, A/C, MRN, Medical Record, Patient ID, Chart, Policy, Claim, Member, Subscriber, Group, Insured ID, Bank, Routing, Card, Case No., Invoice/Statement # (full list in code, easy to extend). Labels may sit on the line above or to the left in table layouts (searched within the same line and the next line). |
| DOB (user-entered) | The entered date in every common format: `01/02/1980`, `1/2/80`, `01-02-1980`, `1980-01-02`, `January 2, 1980`, `Jan 2 1980`, `2 Jan 1980`, `02JAN1980`, and others, all OCR tolerant. |
| DOB (labeled) | Any date-like token within the same line or the next line after "DOB", "D.O.B.", "Date of Birth", "Birthdate", or "Birth Date". |
| Addresses (user-entered) | Normalized with USPS abbreviations (Street↔St, Avenue↔Ave, Apartment↔Apt↔#, North↔N, …). A match requires the house number **and** the street name, fuzzy. Unit, city, state, and ZIP lines that follow a matched street line are redacted too. A standalone "City, ST ZIP" that matches the entered address is also redacted. |
| Phones (user-entered) | Digits normalized. Matches any formatting of the 10 digits, with or without a leading `1`/`+1`, and with "ext." if present. |
| Other names / addresses / phones | Same matchers as above, applied to the "other" entries. |

**Bias:** the rules lean toward over-redaction wherever the spec allows. Two examples: fuzzy single-word name matching, and label proximity that also checks the next line.

### 5.3 What is *not* redacted
- Physician and provider names, addresses, and phones, and any other third party not entered by the user. There is no NER or general name detection. Only the protected person's names and the user's entries are matched.
- Clinical content and billing amounts. Unlabeled numbers in money formats (`$1,234.56`), CPT/ICD codes, and dates without a DOB label are not touched.
- Known conflict: if a physician shares a first or last name with the protected person (e.g., "Dr. John Adams" when the client is "John Smith"), first-name-only matching **will** redact "John". This follows "prefer over-redaction" (see Q2).

## 6. Redaction method (true redaction)

For each page, in batches:
1. Add a MuPDF redaction annotation for every rectangle.
2. `page.applyRedactions(blackBoxes=false, imageMethod=PIXELS, lineArtMethod=REMOVE_IF_COVERED, textMethod=REMOVE)`. This:
   - removes every glyph whose bounding box overlaps a rectangle, including the invisible OCR text layer from "Searchable Image",
   - **sets the image pixels under each rectangle to black inside the image data itself**, so the scanned image no longer holds the original pixels,
   - removes vector line art that is fully covered.
3. Draw the boxes in the page content stream: solid black boxes for §5.2, and black boxes with white initials for §5.1.

Then, for the whole document:
- Remove `/Info` and the catalog `/Metadata` (XMP), plus every `/Metadata` stream on pages, images, and fonts.
- Remove `/Outlines` (bookmarks), `/PageLabels` (see Q10), `/Names` → `/JavaScript`, `/EmbeddedFiles`, `/Dests`.
- Remove `/OpenAction`, every `/AA` (additional actions), `/AcroForm`, `/StructTreeRoot`, `/MarkInfo`, and `/PieceInfo`. The structure tree can hold Alt/ActualText copies of names.
- Remove every annotation on every page: comments, links, stamps, widgets, and file attachments. Form fields are **flattened first** (their appearance is merged into the page content) so filled-in values stay visible and get redacted along with everything else (see Q5).
- Remove page `/Thumb` thumbnails, which hold small unredacted images of each page.
- Hidden text: remove content in optional-content layers that are turned off, and text placed entirely outside the page's crop box. The OCR invisible text layer **stays** (see Q1).
- Save with `garbage=4 (deduplicate), compress, clean, sanitize` as a **full rewrite**, so no old object versions survive in the file. Then re-open the output and verify: no Info/XMP, and the page count matches.

Not changed: page count, MediaBox/CropBox/Rotate, page order, and unredacted content (images we don't redact are copied byte for byte).

## 7. Memory and performance (5,000 pages)

- MuPDF opens the PDF without loading every page. Pages are processed in batches of 25 (configurable). Each page and its structured text are released (`destroy()`) right after use. The worker reports progress after each page.
- Peak memory is roughly the input file size plus the output file size plus a working set. MuPDF.js is a 32-bit WASM build, which caps it at **4 GB**, so the practical input limit is about **1.5 GB** per file. Scanned 5,000-page records usually run 300 MB–1.5 GB. Files above the limit are rejected up front with a clear message (see Q8).
- Images that need pixel redaction are decoded and re-encoded, which can make the output larger than the input. The report will note the input and output sizes.
- Target: under 15 minutes for 5,000 mixed pages on a recent Mac. The actual number will be measured and reported.

## 8. Exceptions report (one page, separate PDF)

Built with MuPDF in the worker, US Letter, Arimo:
- File name, page count, date/time processed, app version
- **Low-text pages** (likely poor scans): page numbers compressed into ranges
- **Redaction counts by category**: Names (initials), SSN, Driver's license, NCIC/CII, Account numbers, DOB, Addresses, Phones, Other user entries
- **Close-match name forms**: forms that were not on the user's list but were redacted as close matches, with occurrence counts and the first few pages for each
- If the lists don't fit on one page, the report shows "…and N more"

Note: this report contains name forms and is meant for the user. It is not for the AI system. A warning line on the report says so.

## 9. Project layout

```
6068redact/
  PLAN.md  README.md  LICENSE-NOTES.md
  package.json  vite.config.ts  tsconfig.json
  public/_headers
  index.html
  src/
    ui/            main.ts, form.ts, progress.ts, styles.css
    worker/        worker.ts (message protocol), pipeline.ts
    engine/        textmap.ts, normalize.ts, fuzzy.ts,
                   patterns/{names,ssn,dl,ncic,accounts,dob,address,phone}.ts,
                   redact.ts, sanitize.ts, initials.ts, report.ts
    assets/        Arimo-Bold.ttf (Apache-2.0), Arimo-Regular.ttf
  tests/
    fixtures/gen/  synthetic PDF generator (fake people only)
    unit/          pattern and fuzzy tests (Vitest)
    integration/   full pipeline in Node with the same engine code
    e2e/           Playwright: click-through, offline, network-block check
    perf/          5,000-page benchmark
```

The engine is plain TypeScript with no DOM access, so the same code runs in the browser worker and in Node tests.

## 10. Testing

**Synthetic data only.** A generator (MuPDF in Node) builds fake records for fake people (e.g., "Marisol Q. Vantreight", DOB 03/14/1979, SSN 078-05-1120-style fake numbers, fake addresses and phones). Doctors also get fake names and addresses. Page types:
- digital text pages (intake forms, billing statements with amounts and CPT codes, progress notes)
- **scanned-image pages with an OCR text layer**: the page is rendered to an image, noise and slight rotation are added, and invisible text (render mode 3) is laid over it, mimicking Acrobat "Searchable Image"
- OCR-error pages ("Srnith", "O78-O5-ll2O", "Vantre1ght")
- pages with **no text layer** (image only), to exercise the pre-check stop
- low-text pages, tables with labels above values, "Last, First" forms
- documents with metadata, XMP, bookmarks, annotations, a filled form, JavaScript, an embedded file, and thumbnails

**Automated tests (Vitest + Playwright):**
1. Text extracted from the output (MuPDF, plus a second extractor such as pdf.js in tests only) contains none of the protected strings or OCR variants. Comparison is case-insensitive and ignores whitespace.
2. **Pixels under every box are black:** render each output page at 150 dpi and check that every pixel in each solid box (inset 1 px) is black. For initials boxes, check that every pixel is black or white text with no other color. Also decode the redacted image XObjects directly and confirm the image's own pixels in those regions are black, which proves the original pixels are gone and not just covered.
3. Metadata is empty: no `/Info` keys, no XMP anywhere, no outlines, annotations, AcroForm, JavaScript, or EmbeddedFiles.
4. Physician names and addresses remain in the extracted text, and billing amounts and diagnoses remain.
5. Page count matches, and every page's MediaBox and Rotate match the original.
6. A file with no text layer produces no output and lists the correct page numbers.
7. Unit tests for every pattern: positive cases, OCR-garbled cases, and negative cases (money, CPT, physician phone).
8. Privacy: Playwright records every network request after the initial load during a full run, and the test asserts **zero**. Another run uses `context.setOffline(true)` after load and must still succeed. A bundle scan finds no outside URLs.

**Performance:** a generated 5,000-page mixed document (~60% scanned). The test runs the pipeline in headless Chrome and in Node and reports wall time, pages per second, peak JS heap, peak WASM memory, and input and output size.

**Manual click-through:** I'll open the built app in the browser, upload a synthetic file, fill in the form, run it, download both files, and confirm the results.

## 11. README

Covers: purpose, the privacy design, how to build and deploy (`npm run build` → upload `dist/`), how to verify the CSP, the Acrobat OCR prerequisite, and known limits (file size, fuzzy-match behavior). **Licensing:** MuPDF.js is AGPL-3.0. Commercial distribution requires a commercial license from Artifex Software. Under the AGPL, offering the app to others over a network also requires making the full source available. Arimo is Apache-2.0.

## 12. Environment setup needed

- **Node.js is not installed** on this Mac, and there is no Homebrew. I'd install Node 22 LTS from the official nodejs.org tarball into `~/.local/node`, with no sudo and no system changes (see Q11).
- Dev-time downloads only, never at runtime: npm packages (`mupdf`, `vite`, `typescript`, `vitest`, `@playwright/test`), the Playwright Chromium build, and Arimo from the Google Fonts GitHub repo.
- `git init` in the project folder. I won't commit unless you ask.

## 13. Build order (after approval)

1. Scaffolding, CSP, bundling of WASM and fonts, and the empty worker round trip, plus the network-block test.
2. Synthetic fixture generator.
3. Text map and normalization, then each pattern with unit tests.
4. Redaction, initials drawing, sanitizer, and save, plus integration tests (text, pixels, metadata, physicians, page count).
5. Pre-check and exceptions report.
6. UI and progress bar, plus the Playwright click-through and offline tests.
7. 5,000-page performance test, then tuning.
8. README, then the manual browser click-through and a report of results.

---

## Questions (please answer or accept the defaults)

1. **Hidden text vs. the OCR layer.** Acrobat "Searchable Image" stores its OCR text as *invisible* text, and the AI system needs that text to read the file. **Default:** keep the invisible OCR layer, with protected strings removed. Treat "hidden text" as text in hidden optional-content layers, text outside the page area, and Alt/ActualText in the structure tree. OK?
2. **First-name-only and last-name-only matching** will also redact a physician or third party who shares the client's first or last name (e.g., every "John"). **Default:** redact anyway, per "prefer over-redaction." Alternatively, for very common first names, I could redact the first name alone only when it is near the last name or appears in a patient context. Which do you want?
3. **"Other names" entered by the user:** solid black box with no text (default), or black box with *their* initials?
4. **Initials format:** first and last only ("JS"), or include middle initial ("JQS")? Your example shows "JS", so the default is first + last.
5. **Form fields:** flatten them into the page (values stay visible and get redacted, layout matches) or delete them entirely? Default: flatten.
6. **Standalone initials in the text** (e.g., "Pt. J.S. presented…"): should the protected person's initials found in the text also be redacted? Default: **no**, because initials match too many unrelated things. Tell me if you want them redacted.
7. **Low-text threshold** for the "likely poor scan" list: default fewer than 40 non-whitespace characters per page. Also, **truly blank pages** (separator sheets with no image and no content) have no text layer. Should they block output under the pre-check (strict reading of the spec), or be allowed and listed in the report? Default: allow blank pages if the page renders as fully white, and list them in the report.
8. **Maximum file size.** What file sizes are typical for your 5,000-page records? The 32-bit WASM limit means about 1.5 GB is the practical ceiling. Is that acceptable?
9. **Offline reload:** is "works offline once loaded" enough, or should the app also *reload* while offline (service worker)? Default: no service worker (simpler, nothing persists). Separately, should I also produce a **single-file `6068redact.html`** build that can run from a USB stick or file share with no web server?
10. **Page labels** (custom page numbering such as "i, ii, 1, 2"): strip them (default, treated as metadata) or keep them?
11. **OK to install Node.js 22** into `~/.local/node` (user folder only), plus npm packages and Playwright's Chromium? These are dev-time downloads only.
12. **Deployment target:** where will this be hosted (e.g., Netlify, Cloudflare Pages, GitHub Pages, internal IIS/SharePoint)? That decides whether the CSP can also be sent as an HTTP header, which is stronger than the meta tag alone.
13. **Other states' driver's licenses:** detect only California format unlabeled, and all formats when labeled (default), or add unlabeled patterns for other states? Unlabeled patterns for other states raise false positives on clinical codes.
