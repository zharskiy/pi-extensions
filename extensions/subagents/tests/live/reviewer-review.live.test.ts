import { realpathSync } from "node:fs";
import { expect, it } from "vitest";
import { formatDuration } from "../../../../shared/index.ts";
import { repeatRuns } from "../../../../test-framework/eval-runs/index.ts";
import { applyCommitDiff, type ExactEdit, replaceExactlyOnce } from "../../../../test-framework/index.ts";
import { describeLive } from "../../../../test-framework/pi/live/index.ts";
import { citesFile, hitsLine, parseFindings } from "../support/findings.ts";
import { createLiveHarness, type LiveHarness } from "../support/live-harness.ts";
import { failureSuffix, handoverLines, helperCounts, liveRuns, runChain } from "../support/live-runs.ts";

type Plant = ExactEdit;

type Fixture = { sha: string; plant: Plant; edits?: Plant[]; callSites?: string[] };

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
};

const RUN_TIMEOUT_MS = 480_000;

const SLACK = 5;

const TASK =
  "I have uncommitted changes in this repo (see `git diff`). Review them before I commit: tell me what is wrong and whether it is good to ship.";

const fixtures: Fixture[] = [
  {
    sha: "686fc95",
    plant: {
      file: "extensions/session-limits/src/thresholds.ts",
      from: "hard: Math.min(window * limits.hardRatio, limits.hardTokens),",
      to: "hard: Math.max(window * limits.hardRatio, limits.hardTokens),",
    },
  },
  {
    sha: "0058777",
    plant: {
      file: "extensions/questionnaire/src/form.ts",
      from: 'if (!armed && (key.name === "enter" || digit !== undefined)) {',
      to: 'if (!armed && (key.name === "enter" && digit !== undefined)) {',
    },
  },
  {
    sha: "130e8d7",
    plant: {
      file: "extensions/spending/src/ledger.ts",
      from: "return cost >= 0 && tokens >= 0 && (cost > 0 || tokens > 0);",
      to: "return cost > 0 && tokens >= 0;",
    },
    edits: [
      {
        file: "extensions/spending/test/ledger.test.ts",
        from: 'expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.5, 200) })).toBe(true);',
        to: 'expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.6, 200) })).toBe(true);',
      },
      {
        file: "extensions/spending/README.md",
        from: "only when neither cost nor tokens go down and at least one goes up",
        to: "only when its cost goes up and its tokens do not go down",
      },
    ],
    callSites: ["extensions/subagents/src/plugins/usage-report/index.ts"],
  },
];

const runs = liveRuns();

const prepare = (live: LiveHarness, fixture: Fixture) => {
  live.seed(`${fixture.sha}^`);
  applyCommitDiff(live.project, fixture.sha);

  const line = replaceExactlyOnce(live.project, fixture.plant);

  (fixture.edits ?? []).forEach((edit) => {
    replaceExactlyOnce(live.project, edit);
  });

  return line;
};

const VERDICT = /verdict[*_]*\s*:?[*_]*\s*(do not ship|ship with fixes|ship)/i;

const reviewOnce = async (fixture: Fixture, index: number): Promise<Outcome> => {
  const live = createLiveHarness(`review ${fixture.sha} run ${index + 1}`, {
    agents: {
      reviewer: { from: "reviewer", fields: { limit: "80000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
    },
  });

  try {
    const line = prepare(live, fixture);
    const chain = await runChain(live, "reviewer", TASK, RUN_TIMEOUT_MS);
    const text = chain.terminal?.resultText ?? "";
    const findings = parseFindings(text);
    const roots = [live.project, realpathSync(live.project)];

    return {
      status: chain.timedOut ? "timeout" : (chain.terminal?.state ?? "missing"),
      found: hitsLine(findings, {
        file: fixture.plant.file,
        line,
        slack: SLACK,
        roots,
      }),
      site: fixture.callSites?.some((file) => citesFile(findings, file, roots)),
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
    };
  } finally {
    await live.close();
  }
};

const describeOutcome = (outcome: Outcome) =>
  [
    `${outcome.status}, ${outcome.found ? "found" : "missed"}`,
    outcome.site === undefined ? "" : `, call site ${outcome.site ? "cited" : "not cited"}`,
    `, findings ${outcome.findings}, verdict ${outcome.verdict}`,
    outcome.found ? "" : ` (refs [${outcome.refs.join(", ")}], planted line ${outcome.line})`,
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, cost $${outcome.cost.toFixed(2)}, duration ${formatDuration(outcome.durationMs)}`,
    failureSuffix(outcome.failure),
  ].join("");

describeLive("live reviewer review quality", () => {
  it.each(fixtures)(
    "reviews $sha",
    async (fixture) => {
      const outcomes = await repeatRuns(
        runs,
        async (index) => {
          const outcome = await reviewOnce(fixture, index);

          console.log(
            [
              `[live review] ${fixture.sha} run ${index + 1}/${runs}: ${describeOutcome(outcome)}`,
              ...outcome.handover,
            ].join("\n"),
          );

          return outcome;
        },
        { parallel: true },
      );

      const found = outcomes.filter((outcome) => outcome.status === "done" && outcome.found).length;
      const total = outcomes.reduce((sum, outcome) => sum + outcome.cost, 0);
      const sites = outcomes.filter((outcome) => outcome.site).length;
      const siteText = fixture.callSites ? `, call site cited ${sites}/${runs}` : "";
      const meanFindings = outcomes.reduce((sum, outcome) => sum + outcome.findings, 0) / runs;

      console.log(
        `[live review] ${fixture.sha}: found ${found}/${runs}${siteText}, mean findings ${meanFindings.toFixed(1)}, mean cost $${(total / runs).toFixed(2)}`,
      );

      expect(found).toBeGreaterThan(runs / 2);
    },
    RUN_TIMEOUT_MS + 90_000,
  );
});
