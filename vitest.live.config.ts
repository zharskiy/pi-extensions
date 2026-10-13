import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/*/test/**/*.live.test.ts", "core/test/adapter/**/*.live.test.ts"],
    environment: "node",
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
