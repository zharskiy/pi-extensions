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

export const expectPassRate = <O>(result: EvalResult<O>, threshold: PassThreshold, check?: string) => {
  const passRate = check === undefined ? result.passRate : (result.checkPassRates[check] ?? 0);
  const subject = check === undefined ? result.name : `${result.name} ${check}`;

  expect(
    meetsThreshold(passRate, threshold),
    `${subject}: ${Math.round(passRate * 100)}% (${thresholdText(threshold)})`,
  ).toBe(true);
};
