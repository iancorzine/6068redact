import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
		testTimeout: 300_000,
		pool: "forks",
	},
});
