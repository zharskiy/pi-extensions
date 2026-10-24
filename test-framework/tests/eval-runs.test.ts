import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Check,
  type EvalResult,
  evalRunCount,
  expectPassRate,
  type GradedRun,
  gradeRun,
  gradeRuns,
  MAJORITY,
  type PassThreshold,
  type Rubric,
  type RunEvent,
  type RunRecord,
  repeatRuns,
  reportEval,
} from "../eval-runs/index.ts";

type Outcome = { done: boolean; found: boolean; record: RunRecord };

const events: RunEvent[] = [{ type: "message", role: "assistant", text: "ok" }];

const record = (patch: Partial<RunRecord["usage"]> = {}, totalMs = 1_000): RunRecord => ({
  output: "",
  events,
  usage: { inputTokens: 10, outputTokens: 5, toolCalls: 2, costUsd: 0.5, ...patch },
  timings: { totalMs },
  errors: [],
});

const found: Check<Outcome> = { name: "found", passes: (outcome) => outcome.found, explain: () => "missed" };

const rubric: Rubric<Outcome> = [{ name: "done", passes: (outcome) => outcome.done }, found];

const outcome = (done: boolean, isFound: boolean, run = record()): Outcome => ({
  done,
  found: isFound,
  record: run,
});

const graded = (outcomes: Outcome[]): EvalResult<Outcome> =>
  gradeRuns("reviewer/planted", outcomes, rubric, (entry) => entry.record);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("evalRunCount", () => {
  it("reads PI_EVAL_RUNS and falls back to one run", () => {
    vi.stubEnv("PI_EVAL_RUNS", "3");

    expect(evalRunCount()).toBe(3);

    vi.stubEnv("PI_EVAL_RUNS", "nope");

    expect(evalRunCount()).toBe(1);
  });
});

describe("repeatRuns", () => {
  it("runs serially in order by default", async () => {
    const started: number[] = [];

    const results = await repeatRuns(3, async (index) => {
      started.push(index);

      return index * 2;
    });

    expect(results).toEqual([0, 2, 4]);
    expect(started).toEqual([0, 1, 2]);
  });

  it("waits for every parallel run before rethrowing the first failure", async () => {
    const finished: number[] = [];

    const runs = repeatRuns(
      2,
      async (index) => {
        if (index === 0) {
          throw new Error("first failed");
        }

        finished.push(index);

        return index;
      },
      { parallel: true },
    );

    await expect(runs).rejects.toThrow("first failed");
    expect(finished).toEqual([1]);
  });
});

describe("gradeRun", () => {
  it("lists failed checks with their explanation", () => {
    expect(gradeRun(0, outcome(true, false), rubric, record()).failedChecks).toEqual(["found: missed"]);
  });
});

describe("gradeRuns", () => {
  it("computes the pass rate, per-check rates, mean cost and mean duration", () => {
    const result = graded([outcome(true, true, record({}, 1_000)), outcome(true, false, record({}, 3_000))]);

    expect(result.passRate).toBe(0.5);
    expect(result.checkPassRates).toEqual({ done: 1, found: 0.5 });
    expect(result.meanCost).toBe(0.5);
    expect(result.meanDurationMs).toBe(2_000);
  });

  it("leaves the mean cost unavailable when a run has no pricing", () => {
    const result = graded([outcome(true, true), outcome(true, true, record({ costUsd: undefined }))]);

    expect(result.meanCost).toBeUndefined();
  });
});

describe("expectPassRate", () => {
  it("passes a majority and fails an even split", () => {
    const atLeastHalf: PassThreshold = { atLeast: 0.5 };
    const split = graded([outcome(true, true), outcome(true, false)]);

    expect(() => expectPassRate(graded([outcome(true, true)]), MAJORITY)).not.toThrow();
    expect(() => expectPassRate(split, MAJORITY)).toThrow();
    expect(() => expectPassRate(split, atLeastHalf)).not.toThrow();
    expect(() => expectPassRate(split, MAJORITY, "done")).not.toThrow();
  });
});

describe("reportEval", () => {
  it("prints one line per run and a summary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    reportEval(
      graded([outcome(true, true), outcome(false, true, record({ costUsd: undefined }))]),
      (run: GradedRun<Outcome>) => [`    detail ${run.index}`],
    );

    expect(String(log.mock.calls[0]?.[0]).split("\n")).toEqual([
      "[eval] reviewer/planted run 1/2: passed, calls 2, cost $0.50, 1s",
      "    detail 0",
      "[eval] reviewer/planted run 2/2: failed (done), calls 2, cost unavailable, 1s",
      "    detail 1",
      "[eval] reviewer/planted: 1/2 passed, done 1/2, found 2/2, mean cost unavailable, mean 1s",
    ]);
  });
});
