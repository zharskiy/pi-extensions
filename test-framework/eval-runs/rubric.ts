import type { RunRecord } from "./run-record.ts";

export type Check<O> = { name: string; passes(outcome: O): boolean; explain?(outcome: O): string };

export type Rubric<O> = Check<O>[];

export type GradedRun<O> = {
  index: number;
  outcome: O;
  failedChecks: string[];
  passed: boolean;
  record: RunRecord;
};

export type EvalResult<O> = {
  name: string;
  runs: GradedRun<O>[];
  passRate: number;
  checkPassRates: Record<string, number>;
  meanCost: number | undefined;
  meanDurationMs: number;
};

export const gradeRun = <O>(
  index: number,
  outcome: O,
  rubric: Rubric<O>,
  record: RunRecord,
): GradedRun<O> => {
  const failedChecks = rubric
    .filter((check) => !check.passes(outcome))
    .map((check) => (check.explain ? `${check.name}: ${check.explain(outcome)}` : check.name));

  return { index, outcome, failedChecks, passed: failedChecks.length === 0, record };
};

const rate = (count: number, total: number) => (total === 0 ? 0 : count / total);

const mean = (values: number[]) =>
  rate(
    values.reduce((sum, value) => sum + value, 0),
    values.length,
  );

const meanCost = (records: RunRecord[]) => {
  const costs = records.flatMap((record) =>
    record.usage.costUsd === undefined ? [] : [record.usage.costUsd],
  );

  return costs.length === records.length && costs.length > 0 ? mean(costs) : undefined;
};

export const gradeRuns = <O>(
  name: string,
  outcomes: O[],
  rubric: Rubric<O>,
  recordOf: (outcome: O) => RunRecord,
): EvalResult<O> => {
  const runs = outcomes.map((outcome, index) => gradeRun(index, outcome, rubric, recordOf(outcome)));
  const records = runs.map((run) => run.record);

  return {
    name,
    runs,
    passRate: rate(runs.filter((run) => run.passed).length, runs.length),
    checkPassRates: Object.fromEntries(
      rubric.map((check) => [
        check.name,
        rate(outcomes.filter((outcome) => check.passes(outcome)).length, outcomes.length),
      ]),
    ),
    meanCost: meanCost(records),
    meanDurationMs: mean(records.map((record) => record.timings.totalMs)),
  };
};
