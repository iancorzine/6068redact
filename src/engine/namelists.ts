// Bundled word lists used by the name matcher.

/**
 * Common US first names. A first name on this list is only redacted on its own when it
 * appears near the protected person's last name or in a patient context, so that
 * physicians and other third parties who share it are left alone.
 */
export const COMMON_FIRST_NAMES = new Set(
	(
		"aaron abigail adam adrian aiden alan albert alex alexander alexandra alexis alfred alice alicia allen allison alma " +
		"alyssa amanda amber amy ana andrea andrew angel angela angelica anita ann anna anne annie anthony antonio april " +
		"arthur ashley audrey austin barbara barry ben benjamin bernard beth betty beverly bill billy bob bobby bonnie " +
		"brad bradley brandon brenda brian brittany bruce bryan caleb calvin cameron carl carla carlos carmen carol " +
		"caroline carolyn carrie catherine cathy charles charlie charlotte cheryl chloe chris christian christina " +
		"christine christopher cindy claire clara clarence connie craig crystal curtis cynthia dale dan dana daniel " +
		"danielle danny darlene darren dave david dawn dean debbie deborah debra denise dennis derek diana diane " +
		"dolores don donald donna doris dorothy douglas dylan earl eddie edith edward elaine eleanor elijah elizabeth " +
		"ella ellen emily emma eric erica erik erin ethan eugene eva evan evelyn frances francisco frank fred " +
		"frederick gabriel gail gary george gerald gina gladys glen glenn gloria grace greg gregory hailey hannah " +
		"harold harry hazel heather helen henry herbert holly howard ian irene isaac isabella jack jackie jacob " +
		"jacqueline james jamie jane janet janice jared jasmine jason javier jay jean jeff jeffrey jenna jennifer " +
		"jenny jeremy jerry jesse jessica jesus jill jim jimmy jo joan joann joanne joe joel john johnny jon " +
		"jonathan jordan jorge jose joseph josephine joshua joy joyce juan juanita judith judy julia julie justin " +
		"karen katherine kathleen kathryn kathy katie kayla keith kelly ken kenneth kevin kim kimberly kristen kyle " +
		"larry laura lauren lawrence leah lee leo leon leonard leslie liam lillian lily linda lisa logan lois " +
		"lori louis louise lucas lucy luis luke lynn madison manuel marcus margaret maria marie marilyn mario marion " +
		"mark martha martin marvin mary mason matt matthew maureen megan melanie melissa melvin michael michele " +
		"michelle miguel mike mildred misty mitchell monica morgan nancy natalie nathan nathaniel neil nicholas " +
		"nicole noah norma norman olivia oscar pamela pat patricia patrick paul paula pedro peggy peter philip " +
		"phillip phyllis rachel ralph ramon randall randy ray raymond rebecca regina renee rhonda ricardo richard " +
		"rick ricky rita robert roberta roberto robin rodney roger ron ronald rosa rose ruby russell ruth ryan sally " +
		"sam samantha samuel sandra sara sarah scott sean sergio seth shane shannon sharon shawn sheila shelby " +
		"sherry shirley sophia stacy stanley stephanie stephen steve steven sue susan suzanne sylvia tammy tanya " +
		"tara taylor ted teresa terri terry theodore theresa thomas tiffany tim timothy tina todd tom tommy tony " +
		"tracy travis troy tyler valerie vanessa vernon veronica vicki victor victoria vincent virginia walter " +
		"wanda wayne wendy william willie yolanda zachary"
	).split(/\s+/),
);

/**
 * Names that are also everyday English words (or clinical words). A standalone match on
 * one of these requires a capital first letter, so "white blood cells" or "a brown
 * discharge" is not redacted for a client named White or Brown.
 */
export const NAME_WORDS = new Set(
	(
		"abbott amber april archer art august baker banks bass bell berry bill bird bishop black blue bond brown " +
		"bush butler candy carol carter chance chase cherry church clay cole cook cooper cross crystal dale dash " +
		"dawn day dean dove drake duke earl early english faith fields fish fisher fletcher ford forest foster fox " +
		"frank freeman frost gale gardner ginger glass gold golden grace gray green grey guy hall hardy hart hazel " +
		"heather hill holly hope house hunter ivy jack jade joy judge june king knight lake lamb lane law " +
		"lee little long love major mark marsh mason may miles mill miller moon moore morgan nash noble north " +
		"olive page park parker parks pearl penny pierce pike pope porter potter powers price prince rain ray read " +
		"reed rice rich rivers robin rock rose ruby rush sage savage sharp shepherd short silver singer small " +
		"snow sparks spring stone storm strong summer swift taylor temple turner violet wall walker ward " +
		"warren waters weaver west white wilde will winter wise wolf wood woods wright young"
	).split(/\s+/),
);

/** Tokens that mark the protected person as the subject (for common first names). */
export const PATIENT_CUES = new Set(
	(
		"patient pt pt. patients mr mrs ms miss mx name client claimant plaintiff applicant insured member " +
		"subscriber dear hi hello employee decedent minor beneficiary resident inmate defendant petitioner " +
		"respondent injured worker guardian"
	).split(/\s+/),
);

/** Tokens that mark a nearby name as a provider rather than the protected person. */
export const PROVIDER_PREFIXES = new Set(["dr", "doctor", "dra", "nurse", "prof", "professor"]);
/** A credential within the next two words ("Jane Adams, M.D.", "Jane RN"). */
export const CREDENTIAL_AFTER =
	/^[\s,]*(?:\p{Lu}[\p{L}'’.\-]*[\s,]+){0,2}(?:M\.?\s?D|D\.?\s?O|N\.?\s?P|R\.?\s?N|P\.?\s?A(?:-C)?|LVN|LPN|D\.?C|Ph\.?\s?D|Psy\.?\s?D|DDS|DMD|O\.?D|DPM|LCSW|L?MFT|FACS|FACP|FAAP|DPT|OTR|CRNA|APRN|FNP|CNP|MSW)\.?(?![\p{L}])/u;

export const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "esq"]);
