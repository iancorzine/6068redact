// Post-build privacy check. Fails the build if the bundle could talk to the network
// or if the CSP is missing/inconsistent.
import fs from "node:fs";
import path from "node:path";
import { CSP, SECURITY_HEADERS } from "../security-headers.mjs";

const dist = new URL("../dist/", import.meta.url).pathname;
const problems = [];
const files = [];
(function walk(d) {
	for (const f of fs.readdirSync(d)) {
		const p = path.join(d, f);
		if (fs.statSync(p).isDirectory()) walk(p);
		else files.push(p);
	}
})(dist);

// 1. No separately fetched runtime assets other than our own JS/CSS/HTML.
for (const f of files) {
	if (!/\.(html|js|css)$/.test(f)) problems.push(`unexpected asset in bundle: ${path.relative(dist, f)}`);
}

// 2. No absolute URLs in shipped code, except inert XML namespace / license strings.
const ALLOWED = [
	/^https?:\/\/www\.w3\.org\//,
	/^http:\/\/ns\.adobe\.com\//,
	/^http:\/\/purl\.org\//,
	/^https?:\/\/(www\.)?(gnu\.org|mozilla\.org\/MPL|apache\.org\/licenses|opensource\.org|openfontlicense\.org|scripts\.sil\.org)/,
	/^https?:\/\/mupdf\.(com|readthedocs\.io)/,
	/^https?:\/\/artifex\.com/,
	/^https?:\/\/(github\.com\/(emscripten|nicowillis)|emscripten\.org)/,
	/^http:\/\/localhost/,
	/^https:\/\/github\.com\/iancorzine\/6068redact$/, // footer source-code link (AGPL); a plain link, not a request
];
for (const f of files) {
	const text = fs.readFileSync(f, "latin1");
	for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.\-]+[^\s"'`)<>]*/g)) {
		if (!ALLOWED.some((re) => re.test(m[0]))) problems.push(`${path.relative(dist, f)}: external URL ${m[0].slice(0, 80)}`);
	}
	for (const api of ["navigator.sendBeacon", "new WebSocket", "EventSource(", "importScripts("]) {
		if (text.includes(api)) problems.push(`${path.relative(dist, f)}: uses ${api}`);
	}
}

// 3. CSP present in index.html and identical in vercel.json.
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
if (!html.includes(`content="${CSP}"`)) problems.push("index.html: CSP meta tag missing or different");
if (!CSP.includes("connect-src 'none'")) problems.push("CSP must contain connect-src 'none'");
const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const hdr = vercel.headers[0].headers.find((h) => h.key === "Content-Security-Policy");
if (!hdr || hdr.value !== SECURITY_HEADERS["Content-Security-Policy"]) problems.push("vercel.json: CSP header missing or different");

if (problems.length) {
	console.error("Bundle privacy check FAILED:\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log(`Bundle privacy check passed (${files.length} files, CSP: connect-src 'none').`);
