import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/test/**/*.test.ts", "extensions/*/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
    environment: "node",
  },
});
