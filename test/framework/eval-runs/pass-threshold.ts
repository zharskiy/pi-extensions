import { expect } from "vitest";
import type { EvalResult } from "./rubric.ts";

export type PassThreshold = { moreThan: number } | { atLeast: number };

export const MAJORITY: PassThreshold = { moreThan: 0.5 };

const meetsThreshold = (passRate: number, threshold: PassThreshold) =>
  "moreThan" in threshold ? passRate > threshold.moreThan : passRate >= threshold.atLeast;

const thresholdText = (threshold: PassThreshold) =>
  "moreThan" in threshold
    ? `needs > ${Math.round(threshold.moreThan * 100)}%`
    : `needs ≥ ${Math.round(threshold.atLeast * 100)}%`;

const isCheck = (check: string | undefined) => (text: string) =>
  check === undefined || text === check || text.startsWith(`${check}: `);

const failureText = <O>(result: EvalResult<O>, check: string | undefined) => {
  const failures = result.runs.flatMap((run) => {
    const failed = run.failedChecks.filter(isCheck(check));

    return failed.length > 0 ? [`run ${run.index + 1}: ${failed.join(", ")}`] : [];
  });

  return failures.length > 0 ? `; ${failures.join("; ")}` : "";
};

export const expectPassRate = <O>(result: EvalResult<O>, threshold: PassThreshold, check?: string) => {
  const passRate = check === undefined ? result.passRate : (result.checkPassRates[check] ?? 0);
  const subject = check === undefined ? result.name : `${result.name} ${check}`;

  expect(
    meetsThreshold(passRate, threshold),
    `${subject}: ${Math.round(passRate * 100)}% (${thresholdText(threshold)})${failureText(result, check)}`,
  ).toBe(true);
};
