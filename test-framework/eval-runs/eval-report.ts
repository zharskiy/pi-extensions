import { appendFileSync } from "node:fs";
import { formatDuration } from "../../shared/index.ts";
import type { EvalResult, GradedRun } from "./rubric.ts";

const REPORT_ENV = "PI_EVAL_REPORT";

const MODEL_ENV = "PI_LIVE_MODEL";

const costText = (cost: number | undefined) =>
  cost === undefined ? "cost unavailable" : `cost $${cost.toFixed(2)}`;

const percent = (rate: number, total: number) => `${Math.round(rate * total)}/${total}`;

const runLine = <O>(result: EvalResult<O>, run: GradedRun<O>) =>
  `[eval] ${result.name} run ${run.index + 1}/${result.runs.length}: ${
    run.passed ? "passed" : `failed (${run.failedChecks.join(", ")})`
  }, calls ${run.record.usage.toolCalls}, ${costText(run.record.usage.costUsd)}, ${formatDuration(run.record.timings.totalMs)}`;

const summaryLine = <O>(result: EvalResult<O>) => {
  const total = result.runs.length;
  const checks = Object.entries(result.checkPassRates).map(
    ([name, rate]) => `${name} ${percent(rate, total)}`,
  );

  return [
    `[eval] ${result.name}: ${percent(result.passRate, total)} passed`,
    ...checks,
    `mean ${costText(result.meanCost)}`,
    `mean ${formatDuration(result.meanDurationMs)}`,
  ].join(", ");
};

const reportJson = <O>(result: EvalResult<O>) =>
  JSON.stringify({
    name: result.name,
    model: process.env[MODEL_ENV],
    runs: result.runs.length,
    passRate: result.passRate,
    checkPassRates: result.checkPassRates,
    meanCost: result.meanCost,
    meanDurationMs: result.meanDurationMs,
    failedChecks: result.runs.flatMap((run) => run.failedChecks),
    records: result.runs.map((run) => run.record),
    at: new Date().toISOString(),
  });

export const reportEval = <O>(
  result: EvalResult<O>,
  describeRun: (run: GradedRun<O>) => string[] = () => [],
) => {
  const lines = [
    ...result.runs.flatMap((run) => [runLine(result, run), ...describeRun(run)]),
    summaryLine(result),
  ];

  console.log(lines.join("\n"));

  const file = process.env[REPORT_ENV];

  if (file) {
    appendFileSync(file, `${reportJson(result)}\n`);
  }
};
