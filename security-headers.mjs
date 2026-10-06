// Single source of truth for the Content Security Policy and other security headers.
// Used by vite.config.ts (preview server + <meta> tag) and scripts/write-vercel.mjs.
//
// connect-src 'none' blocks fetch/XHR/WebSocket/beacon to every origin, including our
// own: after the page and its scripts load, the app cannot send anything anywhere.
// MuPDF's WebAssembly and the fonts are embedded in the worker script, so nothing
// needs to be fetched at runtime.

export const CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: blob:",
	"font-src 'none'",
	"connect-src 'none'",
	"media-src 'none'",
	"object-src 'none'",
	"frame-src 'none'",
	"child-src 'self'",
	"manifest-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

export const SECURITY_HEADERS = {
	"Content-Security-Policy": `${CSP}; frame-ancestors 'none'`,
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"X-Frame-Options": "DENY",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};
