import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/test/**/*.test.ts", "extensions/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
