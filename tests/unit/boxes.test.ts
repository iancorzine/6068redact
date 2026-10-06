import { expect, it } from "vitest";
import { dedupeHits, mergeBoxes } from "../../src/engine/pipeline";

it("merges near-identical boxes from duplicate text layers into one initials box", () => {
	const groups = dedupeHits([
		{ cat: "name", initials: "AV", rects: [[349.6, 17.7, 453.8, 34.6]] },
		{ cat: "name", initials: "AV", rects: [[349.9, 14.8, 454.2, 33.4]] },
		{ cat: "account", rects: [[378.9, 29.4, 434.0, 46.7]] },
		{ cat: "account", rects: [[379.2, 26.3, 433.1, 44.9]] },
	]);
	expect(groups.map((g) => g.cat)).toEqual(["name", "account"]);
	const boxes = mergeBoxes(groups.filter((g) => g.cat === "name").flatMap((g) => g.rects.map((rect) => ({ rect, initials: g.initials }))));
	expect(boxes).toHaveLength(1);
	expect(boxes[0].initials).toBe("AV");
	expect(boxes[0].rect).toEqual([349.6, 14.8, 454.2, 34.6]);
});

it("keeps separate boxes that only touch", () => {
	expect(mergeBoxes([{ rect: [0, 0, 10, 10], initials: "AV" }, { rect: [9.5, 0, 20, 10], initials: "AV" }])).toHaveLength(2);
});

it("keeps a name box separate from a plain box on the next line (name keeps its initials)", () => {
	// Real case: patient name line directly above the MRN value; padding makes them overlap.
	const boxes = mergeBoxes([
		{ rect: [342.7, 37.2, 427.0, 55.0], initials: "AV" },
		{ rect: [342.7, 49.1, 420.0, 69.5] },
	]);
	expect(boxes).toHaveLength(2);
	expect(boxes[0].initials).toBe("AV");
	const groups = dedupeHits([
		{ cat: "name", initials: "AV", rects: [[342.7, 37.2, 427.0, 55.0]] },
		{ cat: "account", rects: [[342.7, 40.0, 427.0, 56.0]] },
	]);
	expect(groups).toHaveLength(2);
});
