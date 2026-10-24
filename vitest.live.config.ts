import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/*/tests/live/**/*.live.test.ts", "pi-adapter/tests/live/**/*.live.test.ts"],
    environment: "node",
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
