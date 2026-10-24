import { realpathSync } from "node:fs";
import { it } from "vitest";
import {
  createLiveHarness,
  type LiveHarness,
} from "../../../../extensions/subagents/tests/support/live-harness.ts";
import { formatDuration } from "../../../../platform/shared/index.ts";
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
} from "../../../framework/eval-runs/index.ts";
import { applyCommitDiff, replaceExactlyOnce } from "../../../framework/index.ts";
import { describeLive } from "../../../framework/pi/live/index.ts";
import {
  chainRecord,
  failureSuffix,
  handoverLines,
  helperCounts,
  runChain,
} from "../support/agent-chains.ts";
import { citesFile, hitsLine, parseFindings } from "../support/reviewer-findings.ts";
import { REVIEW_TASK, type ReviewerCase, reviewerCases } from "./reviewer-cases.ts";

type Outcome = {
  status: string;
  found: boolean;
  site: boolean | undefined;
  findings: number;
  refs: string[];
  line: number;
  verdict: string;
  helpers: string[];
  handover: string[];
  calls: number;
  cost: number;
  durationMs: number;
  failure: string | undefined;
  record: RunRecord;
};

const RUN_TIMEOUT_MS = 480_000;

const SLACK = 5;

const VERDICT = /verdict[*_]*\s*:?[*_]*\s*(do not ship|ship with fixes|ship)/i;

const prepare = (live: LiveHarness, entry: ReviewerCase) => {
  live.seed(`${entry.sha}^`);
  applyCommitDiff(live.project, entry.sha);

  const line = replaceExactlyOnce(live.project, entry.plant);

  (entry.edits ?? []).forEach((edit) => {
    replaceExactlyOnce(live.project, edit);
  });

  return line;
};

const reviewOnce = async (entry: ReviewerCase, index: number): Promise<Outcome> => {
  const label = `review ${entry.sha} run ${index + 1}`;
  const live = createLiveHarness(label, {
    agents: {
      reviewer: { from: "reviewer", fields: { limit: "80000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
    },
  });

  try {
    const line = prepare(live, entry);
    const chain = await runChain(live, "reviewer", REVIEW_TASK, RUN_TIMEOUT_MS);
    const text = chain.terminal?.resultText ?? "";
    const findings = parseFindings(text);
    const roots = [live.project, realpathSync(live.project)];

    return {
      status: chain.timedOut ? "timeout" : (chain.terminal?.state ?? "missing"),
      found: hitsLine(findings, {
        file: entry.plant.file,
        line,
        slack: SLACK,
        roots,
      }),
      site: entry.callSites?.some((file) => citesFile(findings, file, roots)),
      findings: findings.length,
      refs: findings.flatMap((finding) => finding.refs.map((ref) => `${ref.path}:${ref.start}`)),
      line,
      verdict: VERDICT.exec(text)?.[1]?.toLowerCase() ?? "none",
      helpers: chain.helpers,
      handover: handoverLines(live, chain, true),
      calls: chain.calls,
      cost: chain.cost,
      durationMs: chain.durationMs,
      failure: chain.failure,
      record: chainRecord(label, chain),
    };
  } finally {
    await live.close();
  }
};

const rubricFor = (entry: ReviewerCase): Rubric<Outcome> => [
  {
    name: "found",
    passes: (outcome) => outcome.status === "done" && outcome.found,
    explain: (outcome) => `missed, state ${outcome.status}`,
  },
  ...(entry.callSites === undefined
    ? []
    : [{ name: "call site cited", passes: (outcome: Outcome) => outcome.site === true }]),
];

const describeOutcome = (outcome: Outcome) =>
  [
    `    ${outcome.status}, ${outcome.found ? "found" : "missed"}`,
    outcome.site === undefined ? "" : `, call site ${outcome.site ? "cited" : "not cited"}`,
    `, findings ${outcome.findings}, verdict ${outcome.verdict}`,
    outcome.found ? "" : ` (refs [${outcome.refs.join(", ")}], planted line ${outcome.line})`,
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, cost $${outcome.cost.toFixed(2)}, duration ${formatDuration(outcome.durationMs)}`,
    failureSuffix(outcome.failure),
  ].join("");

const caseName = (entry: ReviewerCase) => `subagents/reviewer ${entry.sha}`;

const reportedReview = async (entry: ReviewerCase, index: number, total: number) => {
  const outcome = await reviewOnce(entry, index);

  reportRun(caseName(entry), total, gradeRun(index, outcome, rubricFor(entry), outcome.record), [
    describeOutcome(outcome),
    ...outcome.handover,
  ]);

  return outcome;
};

const meanFindings = (outcomes: Outcome[]) =>
  outcomes.reduce((sum, outcome) => sum + outcome.findings, 0) / Math.max(1, outcomes.length);

describeLive("eval reviewer planted defects", () => {
  it.each(reviewerCases)(
    "reviews $sha",
    async (entry) => {
      const runs = evalRunCount();
      const outcomes = await repeatRuns(runs, (index) => reportedReview(entry, index, runs), {
        parallel: true,
      });
      const result = gradeRuns(caseName(entry), outcomes, rubricFor(entry), (outcome) => outcome.record);

      reportEval(result, [`mean findings ${meanFindings(outcomes).toFixed(1)}`]);
      expectPassRate(result, MAJORITY, "found");
    },
    RUN_TIMEOUT_MS + 90_000,
  );
});
