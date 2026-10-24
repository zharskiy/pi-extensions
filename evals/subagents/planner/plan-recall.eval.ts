import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "vitest";
import {
  createLiveHarness,
  type LiveHarness,
} from "../../../extensions/subagents/tests/support/live-harness.ts";
import { formatDuration } from "../../../shared/index.ts";
import {
  evalRunCount,
  expectPassRate,
  gradeRun,
  gradeRuns,
  MAJORITY,
  type Rubric,
  type RunRecord,
  repeatRuns,
  reportEval,
  reportRun,
} from "../../../test-framework/eval-runs/index.ts";
import { describeLive } from "../../../test-framework/pi/live/index.ts";
import {
  chainRecord,
  failureSuffix,
  handoverLines,
  helperCounts,
  runChain,
} from "../support/agent-chains.ts";
import { type PlanFile, planFiles, planStatus, relativeTo } from "../support/plan-rows.ts";
import { type PlannerCase, plannerCases } from "./planner-cases.ts";

type Outcome = {
  status: string;
  named: number;
  unscored: string[];
  missing: string[];
  globs: string[];
  helpers: string[];
  handover: string[];
  calls: number;
  cost: number;
  durationMs: number;
  failure: string | undefined;
  record: RunRecord;
};

const RUN_TIMEOUT_MS = 540_000;

const MIN_NAMED = 2;

const MAX_MISSING = 2;

const projectRelative = (project: string, path: string) => relativeTo([project, realpathSync(project)], path);

const isMissing = (project: string, file: PlanFile) =>
  !file.isNew && !existsSync(join(project, file.path)) && !existsSync(join(project, dirname(file.path)));

const planOnce = async (live: LiveHarness, entry: PlannerCase, label: string): Promise<Outcome> => {
  const chain = await runChain(live, "planner", entry.request, RUN_TIMEOUT_MS);
  const planner = chain.terminal;
  const text = planner?.resultText ?? "";
  const files = planFiles(text).map((file) => ({ ...file, path: projectRelative(live.project, file.path) }));
  const paths = files.map((file) => file.path);
  const state = chain.timedOut ? "timeout" : (planner?.state ?? "missing");

  return {
    status: state === "done" ? (planStatus(text) ?? "no status") : state,
    named: entry.expected.filter((path) => paths.includes(path)).length,
    unscored: entry.unscored.filter((path) => paths.includes(path)),
    missing: files
      .filter((file) => !file.path.includes("*") && isMissing(live.project, file))
      .map((file) => file.path),
    globs: paths.filter((path) => path.includes("*")),
    helpers: chain.helpers,
    handover: handoverLines(live, chain, false),
    calls: chain.calls,
    cost: chain.cost,
    durationMs: chain.durationMs,
    failure: chain.failure,
    record: chainRecord(label, chain),
  };
};

const rubricFor = (entry: PlannerCase): Rubric<Outcome> => [
  {
    name: "recall",
    passes: (outcome) =>
      outcome.status === "done" && outcome.named >= Math.min(MIN_NAMED, entry.expected.length),
  },
  { name: "clean", passes: (outcome) => outcome.missing.length <= MAX_MISSING },
  ...(entry.maxHelpers === undefined
    ? []
    : [{ name: "lean", passes: (outcome: Outcome) => outcome.helpers.length <= (entry.maxHelpers ?? 0) }]),
];

const listed = (label: string, paths: string[]) =>
  paths.length > 0 ? `, ${label} [${paths.join(", ")}]` : "";

const line = (entry: PlannerCase, outcome: Outcome) =>
  [
    `    ${outcome.status}, recall ${outcome.named}/${entry.expected.length}`,
    listed("unscored", outcome.unscored),
    `, missing ${outcome.missing.length}`,
    outcome.missing.length > 0 ? ` [${outcome.missing.join(", ")}]` : "",
    listed("globs", outcome.globs),
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, cost $${outcome.cost.toFixed(2)}, duration ${formatDuration(outcome.durationMs)}`,
    failureSuffix(outcome.failure),
  ].join("");

const caseName = (entry: PlannerCase) => `subagents/planner ${entry.sha}`;

const runOnce = async (entry: PlannerCase, index: number, total: number) => {
  const label = `plan ${entry.sha} run ${index + 1}`;
  const live = createLiveHarness(label, {
    agents: {
      planner: { from: "planner", fields: { limit: "120000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
      fetch: { from: "fetch" },
    },
  });

  try {
    live.seed(`${entry.sha}^`);

    const outcome = await planOnce(live, entry, label);

    reportRun(caseName(entry), total, gradeRun(index, outcome, rubricFor(entry), outcome.record), [
      line(entry, outcome),
      ...outcome.handover,
    ]);

    return outcome;
  } finally {
    await live.close();
  }
};

describeLive("eval planner plan recall", () => {
  it.each(plannerCases)(
    "plans $sha",
    async (entry) => {
      const runs = evalRunCount();
      const outcomes = await repeatRuns(runs, (index) => runOnce(entry, index, runs), { parallel: true });
      const rubric = rubricFor(entry);
      const result = gradeRuns(caseName(entry), outcomes, rubric, (outcome) => outcome.record);

      reportEval(result);
      rubric.forEach((check) => {
        expectPassRate(result, MAJORITY, check.name);
      });
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
