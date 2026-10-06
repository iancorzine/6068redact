// Writes the synthetic sample PDFs to samples/ for trying the app by hand.
import fs from "node:fs";
import { makeMainFixture, makeNoTextFixture } from "./make";
fs.mkdirSync("samples", { recursive: true });
fs.writeFileSync("samples/synthetic-records.pdf", makeMainFixture());
fs.writeFileSync("samples/synthetic-needs-ocr.pdf", makeNoTextFixture());
console.log("wrote samples/synthetic-records.pdf and samples/synthetic-needs-ocr.pdf");
