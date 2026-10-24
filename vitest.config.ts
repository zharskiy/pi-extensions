import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "extension-manager/tests/**/*.test.ts",
      "ui-kit/tests/**/*.test.ts",
      "shared/tests/**/*.test.ts",
      "core/test/**/*.test.ts",
      "extensions/*/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
    environment: "node",
  },
});
