import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      clean: true,
      exclude: ["**/*.d.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reportOnFailure: true,
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
