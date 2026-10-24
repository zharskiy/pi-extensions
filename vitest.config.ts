import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const RESULTS_ENV = "PI_EVAL_RESULTS";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const results = process.env[RESULTS_ENV] ?? join(import.meta.dirname, "evals", ".results", stamp);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
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
          env: { [RESULTS_ENV]: "" },
        },
      },
      {
        test: {
          name: "live",
          include: ["extensions/*/tests/live/**/*.live.test.ts", "pi-adapter/tests/live/**/*.live.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "evals",
          include: ["evals/**/*.eval.ts"],
          environment: "node",
          pool: "forks",
          maxWorkers: 1,
          fileParallelism: false,
          testTimeout: 1_800_000,
          hookTimeout: 120_000,
          env: { [RESULTS_ENV]: results },
        },
      },
    ],
  },
});
