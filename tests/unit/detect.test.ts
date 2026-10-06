import { describe, expect, it } from "vitest";
import { Detector } from "../../src/engine/detect";
import { pageTextFromString } from "../../src/engine/textmap";
import type { RedactOptions } from "../../src/engine/types";

const base: RedactOptions = {
	fullName: "Marisol Q. Vantreight",
	variants: ["Mari Vantreight", "Marisol Delacroix-Vantreight", "Marisol Vantrite"],
	initials: "MV",
	dob: "1979-03-14",
	addresses: ["4821 Calloway Ridge Road, Apt 12B, Fresno, CA 93722"],
	phones: ["(559) 555-0143"],
	otherNames: ["Thaddeus Okonkwo-Brill"],
	otherAddresses: [],
	otherPhones: ["916-555-0199"],
};

function run(text: string, opts: Partial<RedactOptions> = {}) {
	const pt = pageTextFromString(text);
	const { hits, close } = new Detector({ ...base, ...opts }).detect(pt);
	return { hits: hits.map((h) => ({ cat: h.cat, s: pt.text.slice(h.start, h.end), initials: h.initials })), close };
}
const texts = (r: ReturnType<typeof run>, cat?: string) => r.hits.filter((h) => !cat || h.cat === cat).map((h) => h.s);

describe("names", () => {
	it("matches full, Last-First, case, possessive and partial names", () => {
		const r = run(
			"Patient: VANTREIGHT, MARISOL Q.\nMarisol Vantreight's chart. Seen with Mari.\nMs. Vantreight reports pain.\nvantreight marisol",
		);
		const s = texts(r, "name");
		expect(s).toContain("VANTREIGHT, MARISOL Q.");
		expect(s).toContain("Marisol Vantreight's");
		expect(s).toContain("Vantreight");
		expect(s.join("|")).toMatch(/vantreight marisol/);
		expect(r.hits.find((h) => h.cat === "name")!.initials).toBe("MV");
	});
	it("matches OCR misspellings and reports them as close matches", () => {
		const r = run("Name: Marlsol Vantre1ght\nthen Vantreigth was seen");
		expect(texts(r, "name")).toEqual(["Marlsol Vantre1ght", "Vantreigth"]);
		expect(r.close).toEqual(expect.arrayContaining(["Marlsol", "Vantre1ght", "Vantreigth"]));
	});
	it("applies the context rule to common first names", () => {
		const opts = { fullName: "Mary Vantreight", variants: [] };
		expect(texts(run("Referred by Dr. Mary Adams, MD.", opts), "name")).toEqual([]);
		expect(texts(run("Mary Adams, M.D. signed", opts), "name")).toEqual([]);
		expect(texts(run("Patient Mary arrived late.", opts), "name")).toEqual(["Mary"]);
		expect(texts(run("Mary was calm.\nVantreight family history", opts), "name")).toEqual(["Mary", "Vantreight"]);
		expect(texts(run("Mary was calm today.", opts), "name")).toEqual([]);
	});
	it("needs a capital for everyday-word surnames", () => {
		const opts = { fullName: "Jane White", variants: [] };
		expect(texts(run("white blood cells normal. Ms. White agrees.", opts), "name")).toEqual(["White"]);
	});
	it("leaves physicians alone", () => {
		expect(texts(run("Attending: Dr. Thomas Nguyen, MD\n1200 Medical Plaza Dr, Fresno, CA 93721\n(559) 555-0100"))).toEqual([]);
	});
	it("other names get plain boxes", () => {
		const r = run("Witness Thaddeus Okonkwo-Brill was present.");
		expect(r.hits).toEqual([{ cat: "other", s: "Thaddeus Okonkwo-Brill", initials: undefined }]);
	});
});

describe("numbers", () => {
	it("finds SSNs with OCR errors and odd spacing", () => {
		const r = run("SSN: 078-05-1120\nSS# O78 O5 ll20\n078051120\nSocial Security No. 078 - 05 - 1120\nXXX-XX-1120");
		expect(texts(r, "ssn").length).toBe(5);
	});
	it("does not treat phones, ZIP+4, money or CPT as SSNs", () => {
		const r = run("Call 559-555-0100. ZIP 93721-1234. Charge $1,234.56 CPT 99213", { phones: [] });
		expect(texts(r, "ssn")).toEqual([]);
	});
	it("finds labeled account numbers and leaves amounts", () => {
		const r = run("MRN: 00482913\nPolicy No. ABC-123-456-789\nClaim # 2024 5518 7731\nAccount Balance: $1,234.56\nMember ID W83920014");
		expect(texts(r, "account")).toEqual(["00482913", "ABC-123-456-789", "2024 5518 7731", "W83920014"]);
	});
	it("finds driver's license and CII numbers", () => {
		const r = run("CA DL B4419082\nDriver's License #: N7720031\nCII: A12345678\nNCIC No. W123456789");
		expect(texts(r, "dl")).toEqual(expect.arrayContaining(["B4419082", "N7720031"]));
		expect(texts(r, "ncic")).toEqual(expect.arrayContaining(["A12345678", "W123456789"]));
	});
});

describe("dates", () => {
	it("finds the DOB in many formats and labeled dates", () => {
		const r = run("03/14/1979; 3/14/79; 1979-03-14; March 14, 1979; 14 Mar 1979; 14MAR1979; O3/l4/l979\nDOB: 07/04/1980\nDate of Birth\n12-25-1975\nVisit 03/15/1979");
		const s = texts(r, "dob");
		expect(s).toEqual(expect.arrayContaining(["03/14/1979", "3/14/79", "1979-03-14", "March 14, 1979", "14 Mar 1979", "14MAR1979", "O3/l4/l979", "07/04/1980", "12-25-1975"]));
		expect(s).not.toContain("03/15/1979");
	});
});

describe("addresses and phones", () => {
	it("finds the entered address in other formats, across lines", () => {
		const r = run("Home: 4821 Calloway Ridge Rd., #12B\nFresno, California 93722\nMailing 4821 CALLOWAY RIDGE ROAD APT 12B FRESNO CA 93722");
		const s = texts(r, "address");
		expect(s[0]).toBe("4821 Calloway Ridge Rd., #12B\nFresno, California 93722");
		expect(s[1]).toBe("4821 CALLOWAY RIDGE ROAD APT 12B FRESNO CA 93722");
	});
	it("finds phones in any format", () => {
		const r = run("Cell 559.555.0143, home (559)555-0143, +1 559 555 0143 ext. 12, 5595550143, 555-0143\nDr office 559-555-0100");
		expect(texts(r, "phone").length).toBe(5);
		expect(texts(r, "other")).toEqual([]);
	});
});

describe("dates are not identifiers", () => {
	it("does not treat service dates/times (even OCR-garbled) as SSN, DL or CII", () => {
		const r = run("Arrival Date/Time: 09/18/2024 1256\nAdm: 9/18/2024, D/C: 9/18/2024\nArrival 09l18l2024 1256\nSeen O9/18/2O24 1351", { dob: undefined });
		expect(r.hits).toEqual([]);
	});
	it("still finds a real SSN next to a date", () => {
		const r = run("09/18/2024 SSN 078-05-1120", { dob: undefined });
		expect(texts(r, "ssn")).toEqual(["078-05-1120"]);
	});
});

describe("table-header label search", () => {
	it("does not take a date/time or a bare time from the line below a label", () => {
		// "initial encounter" is a diagnosis, not a label; the line below holds a date/time.
		const r = run("Contusion of right hip, initial encounter\nArrival Date/Time: 09/18/2024 1256\nThis order may be acted on in another encounter.\nAuthorized by: Ruth Aguilar-Urrea, PA on 09/18/24 1313", { dob: undefined });
		expect(r.hits).toEqual([]);
	});
	it("still finds an encounter number with a # label", () => {
		const r = run("Encounter #: 400012345678", { dob: undefined });
		expect(texts(r, "account")).toEqual(["400012345678"]);
	});
});
