// Generates the synthetic 5,000-page performance fixture (streamed to disk).
import fs from "node:fs";
import { makeBigFixture } from "../fixtures/make";
import { FileSink } from "../helpers";

const [out = "/tmp/6068redact-perf-5000.pdf", pagesArg = "5000", dpi = "200", scanRatio = "0.6", grain = "0.08"] = process.argv.slice(2);
const t0 = Date.now();
makeBigFixture(+pagesArg, { dpi: +dpi, scanRatio: +scanRatio, grain: +grain, sink: new FileSink(out), onProgress: (n) => n % 500 === 0 && console.log(`generated ${n} pages (${((Date.now() - t0) / 1000).toFixed(0)} s)`) });
console.log(`wrote ${out}: ${(fs.statSync(out).size / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
