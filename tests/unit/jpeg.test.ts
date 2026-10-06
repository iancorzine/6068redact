import * as mupdf from "mupdf";
import { expect, it } from "vitest";
import { estimateJpegQuality } from "../../src/engine/imageredact";

it("estimates the quality a JPEG was saved with", () => {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 64, 64], false);
	pix.clear(200);
	for (const q of [50, 70, 85, 92]) expect(Math.abs(estimateJpegQuality(pix.asJPEG(q, false)) - q)).toBeLessThanOrEqual(1);
});
