import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "pi-adapter/tests/**/*.test.ts",
      "extension-manager/tests/**/*.test.ts",
      "ui-kit/tests/**/*.test.ts",
      "shared/tests/**/*.test.ts",
      "extensions/*/tests/**/*.test.ts",
      "test-framework/tests/**/*.test.ts",
      "evals/**/tests/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: [...configDefaults.exclude, "**/*.live.test.ts", "**/*.eval.ts"],
    environment: "node",
    env: { PI_EVAL_RESULTS: "" },
  },
});
