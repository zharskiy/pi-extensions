import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeLive } from "../../../../core/test/adapter/live.ts";
import { citesFile, hitsLine, parseFindings } from "../helpers/findings.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";
import {
  concurrentRuns,
  failureSuffix,
  helperCounts,
  liveRuns,
  repoGit,
  runChain,
} from "../helpers/live-runs.ts";

// One past commit of this repository, applied uncommitted on top of its
// parent, with one defect planted inside a hunk of the real change by an exact
// string replacement. The reviewer is scored on naming the planted file and a
// line within SLACK lines of the planted one.
type Plant = { file: string; from: string; to: string };

// `edits` keep the rest of the diff (tests, docs) consistent with the plant,
// so the defect is not given away by a failing test or a contradicting doc.
// `callSites` are files outside the diff where the planted defect does its
// harm; whether a finding cites one is only logged.
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
  calls: number;
  cost: number;
  failure: string | undefined;
};

const RUN_TIMEOUT_MS = 480_000;

const SLACK = 5;

const TASK =
  "I have uncommitted changes in this repo (see `git diff`). Review them before I commit: tell me what is wrong and whether it is good to ship.";

const fixtures: Fixture[] = [
  {
    // 686fc95 adds absolute token caps next to the handoff ratios; the
    // threshold is meant to be whichever is lower. The plant turns the hard
    // threshold's min into a max, so on a large window the cap never applies;
    // soft keeps its min two lines above, and the README in the same diff says
    // "whichever is lower".
    sha: "686fc95",
    plant: {
      file: "extensions/session-limits/src/thresholds.ts",
      from: "hard: Math.min(window * limits.hardRatio, limits.hardTokens),",
      to: "hard: Math.max(window * limits.hardRatio, limits.hardTokens),",
    },
  },
  {
    // 0058777 makes the questionnaire ignore a typed-ahead Enter or digit for
    // the first 250 ms. The plant turns the guard's `||` into `&&`, which can
    // never hold (Enter is not a digit), so typed-ahead keys go through again.
    sha: "0058777",
    plant: {
      file: "extensions/questionnaire/src/form.ts",
      from: 'if (!armed && (key.name === "enter" || digit !== undefined)) {',
      to: 'if (!armed && (key.name === "enter" && digit !== undefined)) {',
    },
  },
  {
    // Harder: 130e8d7 spans core/adapter, spending and subagents (5 source
    // files, 4 test files, the spending README). The plant makes the ledger
    // keep an agent's usage report only when its cost grew, and the edits
    // change the one ledger test and the README sentence to match, so the
    // diff is consistent and every test passes. The harm shows only at the
    // publisher outside the diff: subagents' usage-report plugin sends each
    // agent's running total on every agent:usage event, and on a zero-cost
    // (subscription) model the cost never grows, so every report after the
    // first is dropped and the agent's tokens freeze. Finding it means
    // tracing who publishes on the usage channel and what they send.
    // Verified: with the plant and edits the seeded suite fails only the
    // unrelated `is pinned to pi 1.1.0` check, as it does unplanted.
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

const replaceOnce = (project: string, plant: Plant) => {
  const path = join(project, plant.file);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf(plant.from);

  if (at < 0 || text.indexOf(plant.from, at + 1) >= 0) {
    throw new Error(`the plant for ${plant.file} must match exactly once`);
  }

  writeFileSync(path, text.replace(plant.from, plant.to));

  return text.slice(0, at).split("\n").length;
};

const prepare = (live: LiveHarness, fixture: Fixture) => {
  const patch = join(live.project, "..", "change.patch");

  live.seed(`${fixture.sha}^`);
  writeFileSync(
    patch,
    repoGit(["diff-tree", "-p", "--binary", "--no-color", "--no-ext-diff", `${fixture.sha}^`, fixture.sha]),
  );
  execFileSync("/usr/bin/git", ["apply", patch], { cwd: live.project, stdio: ["ignore", "ignore", "pipe"] });

  const line = replaceOnce(live.project, fixture.plant);

  (fixture.edits ?? []).forEach((edit) => {
    replaceOnce(live.project, edit);
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
      calls: chain.calls,
      cost: chain.cost,
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
    `, calls ${outcome.calls}, cost $${outcome.cost.toFixed(2)}`,
    failureSuffix(outcome.failure),
  ].join("");

describeLive("live reviewer review quality", () => {
  it.each(fixtures)(
    "reviews $sha",
    async (fixture) => {
      const outcomes = await concurrentRuns(runs, async (index) => {
        const outcome = await reviewOnce(fixture, index);

        console.log(`[live review] ${fixture.sha} run ${index + 1}/${runs}: ${describeOutcome(outcome)}`);

        return outcome;
      });

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
