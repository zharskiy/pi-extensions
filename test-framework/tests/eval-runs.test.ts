import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  reportRun,
  snapshotSessions,
} from "../eval-runs/index.ts";
import { useTempDirs } from "../temp-dirs.ts";

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

const tempDirs = useTempDirs();

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

  it("names the failed checks of the failing runs", () => {
    const split = graded([outcome(true, true), outcome(false, false)]);

    expect(() => expectPassRate(split, MAJORITY)).toThrow("run 2: done, found: missed");
    expect(() => expectPassRate(split, { atLeast: 1 }, "found")).toThrow(
      "(needs ≥ 100%); run 2: found: missed:",
    );
  });
});

describe("reportEval", () => {
  it("prints each run with its details as it finishes and a summary with notes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = graded([outcome(true, true), outcome(false, true, record({ costUsd: undefined }))]);

    result.runs.forEach((run: GradedRun<Outcome>) => {
      reportRun(result.name, 2, run, [`    detail ${run.index}`]);
    });
    reportEval(result, ["mean findings 1.5"]);

    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
      "[eval] reviewer/planted run 1/2: passed, calls 2, cost $0.50, 1s\n    detail 0",
      "[eval] reviewer/planted run 2/2: failed (done), calls 2, cost unavailable, 1s\n    detail 1",
      "[eval] reviewer/planted: 1/2 passed, done 1/2, found 2/2, mean findings 1.5, mean cost unavailable, mean 1s",
    ]);
  });

  it("appends one observation per eval to the results dir and keeps only failed runs' snapshots", () => {
    const results = tempDirs.make("pi-eval-results-");
    const session = join(tempDirs.make("pi-eval-session-"), "session.jsonl");

    writeFileSync(session, "{}\n");
    vi.stubEnv("PI_EVAL_RESULTS", results);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const earlier = snapshotSessions("reviewer/planted run 1", [session]) ?? "";
    const kept = snapshotSessions("reviewer/planted run 2", [session, join(results, "absent.jsonl")]) ?? "";
    const dropped = snapshotSessions("reviewer/planted run 1", [session]) ?? "";
    const outside = tempDirs.make("pi-eval-outside-");

    reportEval(
      graded([
        outcome(true, true, { ...record(), snapshot: dropped }),
        outcome(false, true, { ...record(), snapshot: kept }),
        outcome(true, true, { ...record(), snapshot: outside }),
      ]),
    );

    const lines = readFileSync(join(results, "observations.jsonl"), "utf8").trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ name: "reviewer/planted", runs: 3 });
    expect(dropped).not.toBe(earlier);
    expect(existsSync(dropped)).toBe(false);
    expect(existsSync(earlier)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(join(kept, "1-session.jsonl"), "utf8")).toBe("{}\n");
  });

  it("writes nothing and snapshots nothing without a results dir", () => {
    const cwd = tempDirs.make("pi-eval-cwd-");

    vi.stubEnv("PI_EVAL_RESULTS", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    expect(snapshotSessions("reviewer/planted run 1", [])).toBeUndefined();

    reportEval(graded([outcome(true, true)]));

    expect(existsSync(join(cwd, "observations.jsonl"))).toBe(false);
    expect(existsSync(join(process.cwd(), "observations.jsonl"))).toBe(false);
  });
});
