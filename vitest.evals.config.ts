import { join } from "node:path";
import { defineConfig } from "vitest/config";

const RESULTS_ENV = "PI_EVAL_RESULTS";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ["verbose"],
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    env: { [RESULTS_ENV]: process.env[RESULTS_ENV] ?? join(import.meta.dirname, "evals", ".results", stamp) },
  },
});
