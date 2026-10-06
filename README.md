# 6068redact

6068redact removes personal identifying information from large PDFs (up to 5,000 pages) before they are given to an enterprise AI system. It supports compliance with **California Business and Professions Code § 6068.1** (effective January 1, 2027).

Everything runs **in your browser**. The PDF, its text, and the results never leave the computer.

---

## Using it

1. In Adobe Acrobat, run **Recognize Text** with the **Searchable Image** setting.
2. Open 6068redact. Wait until it says *Engine ready*. You may now disconnect from the network.
3. Choose the PDF. Enter the protected person's full name and at least one name variant (nickname, maiden name, misspelling). The initials are filled in automatically and can be edited. Date of birth, addresses, phone numbers, and other names, addresses, or phones to redact are optional.
4. Click **Redact**. A progress bar shows the pages completed.
5. Download the two outputs:
   * `[original name]_REDACTED.pdf`: the redacted file for the AI system.
   * `[original name]_EXCEPTIONS.pdf`: a one-page exceptions report. **Keep this with the client file.** It lists name forms, so it is not for the AI system.

If any page has no text layer, processing stops and those page numbers are listed. No output is produced until the file is OCR'd.

### What gets redacted

| What | Appearance |
|---|---|
| The protected person's name and every variant: any capitalization, "Last, First", first-name-only, last-name-only, possessives, hyphenated parts, and close OCR misspellings | Black box with the initials centered in white Arimo Bold |
| Social Security numbers, driver's license numbers, NCIC/CII numbers, account numbers (medical record, policy, claim, member, bank, …), the entered DOB in any common format, any date next to a DOB / D.O.B. / Date of Birth / Birthdate label, and the entered addresses, phones, and other names | Solid black box |

* Patterns tolerate OCR errors (l/I for 1, O for 0, S for 5, extra spaces). Where a judgment call is needed, the app over-redacts.
* **Common first names** (for example "Mary" or "John") are redacted on their own only when they appear near the last name (within 2 lines) or in patient context ("Patient", "Ms.", "Name:", …). They are not redacted when directly preceded by "Dr." or followed by a credential (MD, NP, RN, …). Uncommon first names and all last names are always redacted.
* Surnames that are everyday words (White, Brown, Rose, …) must be capitalized to match, so "white blood cells" is left alone.
* **Not redacted:** physicians, other providers, and third parties (unless you enter them), clinical content, medications, billing amounts, CPT/ICD codes, and dates that aren't birth dates.

### How redaction works (true redaction)

* Text under each box is **deleted** from the content stream, including the invisible OCR layer.
* Image pixels under each box are **set to black inside the image data**, so the scanned image itself no longer contains them. JPEG scans are re-encoded as JPEG, so the output size stays close to the input.
* Removed from the whole file: document info and XMP metadata, bookmarks, comments and all other annotations, links, JavaScript, embedded files, page thumbnails, structure-tree text (Alt/ActualText), hidden optional-content layers, and text placed outside the page. Form fields are first **flattened** into the page, so their values are redacted like any other text.
* Page count, page sizes, rotation, layout, and unredacted content are unchanged. The invisible OCR text layer is kept (minus redacted words) so the AI system can still read the file.

---

## Privacy design

* **No backend.** The app is a static site.
* **No network after load.** The Content Security Policy sets `connect-src 'none'`, which blocks `fetch`, XHR, WebSocket, and `sendBeacon` to every origin, including the app's own server. The MuPDF WebAssembly engine and the Arimo fonts are embedded in the worker script, so nothing is fetched at runtime. The policy is sent as an HTTP header (`vercel.json`) and repeated in a `<meta>` tag.
* **No analytics, telemetry, error reporting, outside fonts, or outside scripts.** Every dependency is bundled. `npm run build` ends with `scripts/check-bundle.mjs`, which fails the build if the bundle contains an outside URL, a beacon or WebSocket API, a separately fetched asset, or a CSP that differs from `security-headers.mjs`.
* **Works offline.** Once the page says *Engine ready*, you can disconnect from the network. (Reloading the page requires the network.)
* **Output staging.** While you download it, the redacted PDF is kept in the browser's origin-private file system (browser storage on this computer, never uploaded). It is deleted when the next run starts or the app is reopened. Use a regular, not private/incognito, window for large files: private windows have small storage quotas. If there isn't room, the app reports an error and never produces an incomplete file.

To verify in Chrome: open DevTools → Network, run a redaction, and confirm that no requests appear after the initial page load. The automated test `tests/e2e/app.spec.ts` checks this, and also checks that `fetch`, images, and beacons to outside hosts are blocked by the CSP.

---

## Large files (5,000 pages / ~1.5 GB)

The published MuPDF.js WebAssembly build is limited to **2 GB** of memory, so a 1.5 GB PDF cannot simply be loaded and saved. 6068redact never needs it to fit:

1. MuPDF reads the file **on demand** through a stream (4 MB blocks via `FileReaderSync`). The PDF is never copied into WASM memory in full.
2. Pages are processed in **chunks of 100**. Each chunk becomes a small PDF that is redacted, cleaned, and saved, and its bytes leave WASM memory right away.
3. A small JavaScript assembler (`src/engine/assembler.ts`) joins the chunks into one PDF. Only object dictionaries are renumbered, and the output is written straight to disk (browser private storage) as it is produced.

**Limit:** input files must be **under 2 GB**, because mupdf.js uses 32-bit file offsets. Larger files are rejected with a message to split them in Acrobat (Organize Pages → Split).

Measured results are in [PERFORMANCE.md](PERFORMANCE.md).

---

## Development

Requires Node.js 22+.

```sh
npm install
npx playwright install chromium   # for end-to-end tests
npm run fixtures                  # write synthetic sample PDFs to samples/ for trying the app
npm run dev                       # dev server (no CSP, so hot reload works)
npm run build                     # production build in dist/ + privacy check
npm run preview                   # serve dist/ with the production security headers
npm test                          # unit + integration tests (Vitest)
npm run test:e2e                  # browser tests (Playwright): full click-through, offline, CSP
```

Performance tests (synthetic data, generated locally):

```sh
npx tsx tests/perf/make-big.ts /tmp/perf.pdf 5000 300 0.5 0.1   # ~1.5 GB, 50% scanned at 300 dpi
npx tsx tests/perf/perf-node.ts /tmp/perf.pdf                   # Node, same engine code
PERF_FILE=/tmp/perf.pdf npx playwright test perf                # in Chromium
```

### Tests use synthetic documents only

`tests/fixtures/make.ts` generates fake records for invented people. It includes digital pages, scanned-image pages with an OCR text layer (including OCR errors), low-text pages, pages with **no** text layer, a rotated page, and a page full of traps: hidden layers, ActualText, off-page text, comments, links with JavaScript, a filled form field, metadata, XMP, bookmarks, embedded files, and thumbnails. **Never add real client documents to this repository.**

The automated tests confirm that:

* text extracted from the output (by MuPDF **and** pdf.js) contains none of the protected strings, and no decompressed object anywhere in the file contains them
* pixels under every box are black, both in the rendered page and in the scanned image's own pixel data
* metadata is empty (no Info, XMP, annotations, forms, JavaScript, embedded files, outlines, or thumbnails)
* physician names, addresses, and clinical content remain
* page count, page sizes, and rotation match the original
* a file with untextable pages is stopped, with the correct page list
* the WASM heap stays flat from chunk to chunk (memory regression guard)
* files of 2 GB or more are rejected with a clear message
* in the browser: the full click-through works, there are zero network requests after load, it works with the network disconnected, and the CSP blocks fetch, images and beacons to outside hosts

### Project layout

```
index.html, src/ui/          UI (plain TypeScript, no framework)
src/worker/                  Web Worker; loads embedded WASM + fonts, streams the File
src/engine/                  Redaction engine (runs in the worker and in Node tests)
  pipeline.ts                pre-check → chunked redaction → assembly → report
  detect.ts, names.ts, patterns.ts, fuzzy.ts, namelists.ts   detection
  imageredact.ts             pixel redaction inside image data
  contentfilter.ts           strips ActualText and hidden-layer content
  overlay.ts                 black boxes + white initials (Arimo Bold)
  assembler.ts               joins chunk PDFs without loading them into WASM
  report.ts                  one-page exceptions report
security-headers.mjs         CSP and security headers (single source of truth)
vercel.json                  generated from security-headers.mjs by the build
```

### Deploying to Vercel

Live at https://6068redact.vercel.app. The Vercel project is connected to this GitHub repository: every push to `main` builds and deploys automatically. To set it up elsewhere, import the repository in Vercel. `vercel.json` sets the build command (`npm run build`), the output directory (`dist`), and the security headers (CSP with `connect-src 'none'` and `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and others). No environment variables or serverless functions are used. Turn off Vercel Web Analytics and Speed Insights for the project. They are off by default, and the CSP would block them anyway.

### Maintenance notes

* `mupdf` is pinned to **1.28.1**. `src/engine/buffers.ts` works around a reference leak in that version's `loadImage()`. When upgrading, run `npm test`. The memory regression test fails if the leak behavior changes.
* The common-first-name list, labels, and word lists are in `src/engine/namelists.ts` and `src/engine/patterns.ts`.

---

## Licensing

* **MuPDF.js is licensed under the GNU AGPL v3.** Commercial distribution of 6068redact, or of any product that includes MuPDF.js, **requires a commercial license from Artifex Software, Inc.** (https://artifex.com). Under the AGPL, making the app available to users over a network also obliges you to offer them the complete corresponding source code.
* This project's own code is released under AGPL-3.0-or-later to match (see `LICENSE`). Source: https://github.com/iancorzine/6068redact (linked in the app's footer).
* **Arimo** (bundled in `src/assets/`) is licensed under the SIL Open Font License 1.1. See `src/assets/LICENSE-Arimo.txt`.
* 6068redact is a tool to support compliance. It is not legal advice. Review the output and the exceptions report as your obligations require.
