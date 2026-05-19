import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/e2e/**"],
		coverage: {
			provider: "v8",
			include: [
				"src/shared/**/*.ts",
				"src/popup/settings-model.ts",
				"src/capture-orchestrator/**/*.ts",
				"src/shared/message-schemas.ts",
			],
			reporter: ["text", "lcov", "html"],
		},
	},
});
