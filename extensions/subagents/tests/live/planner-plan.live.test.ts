import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { formatDuration } from "../../../../shared/index.ts";
import { repeatRuns } from "../../../../test-framework/eval-runs/index.ts";
import { describeLive } from "../../../../test-framework/pi/live/index.ts";
import { createLiveHarness, type LiveHarness } from "../support/live-harness.ts";
import { failureSuffix, handoverLines, helperCounts, liveRuns, runChain } from "../support/live-runs.ts";
import { type PlanFile, planFiles, planStatus, relativeTo } from "../support/plan-rows.ts";

type Fixture = { sha: string; request: string; expected: string[]; unscored: string[]; maxHelpers?: number };

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
};

const RUN_TIMEOUT_MS = 540_000;

const fixtures: Fixture[] = [
  {
    sha: "686fc95",
    request:
      "In session-limits, the handoff thresholds are only fractions of the context window, so on a 1M-token model the handoff comes far too late. Add absolute token caps next to the ratios (defaults 150k soft and 200k hard) so the effective threshold is whichever is lower, configurable in the settings file, and show token counts in the footer segment when the cap is the one that applies.",
    expected: [
      "extensions/session-limits/src/limits.ts",
      "extensions/session-limits/src/settings.ts",
      "extensions/session-limits/src/thresholds.ts",
    ],
    unscored: ["extensions/session-limits/src/index.ts"],
  },
  {
    sha: "00103e4",
    request:
      "In the footer, the thinking line reads `thinking high` with only the level in bold gold and the word `thinking` in the default colour. It is one mode indicator, so paint the whole `thinking <level>` label in the same bold gold; leave `thinking unavailable` and the cycle hint as they are.",
    expected: ["extensions/footer/src/render.ts"],
    unscored: ["extensions/footer/README.md"],
    maxHelpers: 0,
  },
  {
    sha: "aafb579",
    request:
      "When the composer or subagents install their custom editor, ↑ prompt history is lost on /reload and /new, and after /resume or /fork the earlier prompts of that session cannot be recalled either. pi's own editor keeps its history across all of these. Make our editor behave the same: keep the input history across reload and new, and on resume and fork seed it with the session's user messages.",
    expected: ["pi-adapter/editor/pi-editor.ts"],
    unscored: ["pi-adapter/runtime/pi-adapter.ts", "ARCHITECTURE.md"],
  },
];

const runs = liveRuns();

const projectRelative = (project: string, path: string) => relativeTo([project, realpathSync(project)], path);

const isMissing = (project: string, file: PlanFile) =>
  !file.isNew && !existsSync(join(project, file.path)) && !existsSync(join(project, dirname(file.path)));

const planOnce = async (live: LiveHarness, fixture: Fixture): Promise<Outcome> => {
  const chain = await runChain(live, "planner", fixture.request, RUN_TIMEOUT_MS);
  const planner = chain.terminal;
  const text = planner?.resultText ?? "";
  const files = planFiles(text).map((file) => ({ ...file, path: projectRelative(live.project, file.path) }));
  const paths = files.map((file) => file.path);
  const state = chain.timedOut ? "timeout" : (planner?.state ?? "missing");

  return {
    status: state === "done" ? (planStatus(text) ?? "no status") : state,
    named: fixture.expected.filter((path) => paths.includes(path)).length,
    unscored: fixture.unscored.filter((path) => paths.includes(path)),
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
  };
};

const MIN_NAMED = 2;

const MAX_MISSING = 2;

const recalls = (fixture: Fixture, outcome: Outcome) =>
  outcome.status === "done" && outcome.named >= Math.min(MIN_NAMED, fixture.expected.length);

const clean = (outcome: Outcome) => outcome.missing.length <= MAX_MISSING;

const lean = (fixture: Fixture, outcome: Outcome) =>
  fixture.maxHelpers === undefined || outcome.helpers.length <= fixture.maxHelpers;

const listed = (label: string, paths: string[]) =>
  paths.length > 0 ? `, ${label} [${paths.join(", ")}]` : "";

const line = (fixture: Fixture, outcome: Outcome) =>
  [
    `${outcome.status}, recall ${outcome.named}/${fixture.expected.length}`,
    listed("unscored", outcome.unscored),
    `, missing ${outcome.missing.length}`,
    outcome.missing.length > 0 ? ` [${outcome.missing.join(", ")}]` : "",
    listed("globs", outcome.globs),
    `, helpers ${outcome.helpers.length}${helperCounts(outcome.helpers)}`,
    `, calls ${outcome.calls}, cost $${outcome.cost.toFixed(2)}, duration ${formatDuration(outcome.durationMs)}`,
    failureSuffix(outcome.failure),
  ].join("");

const runOnce = async (fixture: Fixture, index: number) => {
  const live = createLiveHarness(`plan ${fixture.sha} run ${index + 1}`, {
    agents: {
      planner: { from: "planner", fields: { limit: "120000" } },
      scout: { from: "scout" },
      shell: { from: "shell" },
      fetch: { from: "fetch" },
    },
  });

  try {
    live.seed(`${fixture.sha}^`);

    const outcome = await planOnce(live, fixture);

    console.log(
      [
        `[live plan] ${fixture.sha} run ${index + 1}/${runs}: ${line(fixture, outcome)}`,
        ...outcome.handover,
      ].join("\n"),
    );

    return outcome;
  } finally {
    await live.close();
  }
};

describeLive("live planner plan quality", () => {
  it.each(fixtures)(
    "plans $sha",
    async (fixture) => {
      const outcomes = await repeatRuns(runs, (index) => runOnce(fixture, index), { parallel: true });

      const recalled = outcomes.filter((outcome) => recalls(fixture, outcome)).length;
      const cleanRuns = outcomes.filter(clean).length;
      const leanRuns = outcomes.filter((outcome) => lean(fixture, outcome)).length;
      const leanText = fixture.maxHelpers === undefined ? "" : `, lean ${leanRuns}/${runs}`;
      const total = outcomes.reduce((sum, outcome) => sum + outcome.cost, 0);

      console.log(
        `[live plan] ${fixture.sha}: recall ok ${recalled}/${runs}, clean ${cleanRuns}/${runs}${leanText}, mean cost $${(total / runs).toFixed(2)}`,
      );

      expect(recalled).toBeGreaterThan(runs / 2);
      expect(cleanRuns).toBeGreaterThan(runs / 2);
      expect(leanRuns).toBeGreaterThan(runs / 2);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
