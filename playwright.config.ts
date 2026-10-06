import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	timeout: 30 * 60_000,
	expect: { timeout: 60_000 },
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:4174",
		acceptDownloads: true,
		trace: "off",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// The production build, served with the same security headers as Vercel.
		command: "npm run build && npx vite preview --port 4174 --strictPort",
		url: "http://localhost:4174",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
