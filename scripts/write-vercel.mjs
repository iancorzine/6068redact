// Writes vercel.json from security-headers.mjs so the deployed CSP header and the
// <meta> CSP can never drift apart.
import fs from "node:fs";
import { SECURITY_HEADERS } from "../security-headers.mjs";

const config = {
	$schema: "https://openapi.vercel.sh/vercel.json",
	buildCommand: "npm run build",
	outputDirectory: "dist",
	framework: null,
	cleanUrls: false,
	headers: [
		{
			source: "/(.*)",
			headers: Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
		},
	],
};
fs.writeFileSync(new URL("../vercel.json", import.meta.url), JSON.stringify(config, null, 2) + "\n");
console.log("vercel.json written");
