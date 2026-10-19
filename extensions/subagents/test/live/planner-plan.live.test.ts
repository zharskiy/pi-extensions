import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { costOf, describeLive } from "../../../../core/test/adapter/live.ts";
import type { AgentRecord } from "../../src/model/types.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";
import { planFiles, planStatus } from "../helpers/plan-rows.ts";

// One past request from this repository: the planner sees the tree as it was
// before the commit and plans the change; the commit's source files are the
// ground truth.
type Fixture = { sha: string; request: string; expected: string[] };

type Outcome = {
  status: string;
  named: number;
  missing: string[];
  scouts: number;
  cost: number;
};

const RUNS_ENV = "PI_LIVE_PLAN_RUNS";

const RUN_TIMEOUT_MS = 540_000;

const fixtures: Fixture[] = [
  {
    sha: "686fc95",
    request:
      "In session-limits, the handoff thresholds are only fractions of the context window, so on a 1M-token model the handoff comes far too late. Add absolute token caps next to the ratios (defaults 150k soft and 200k hard) so the effective threshold is whichever is lower, configurable in the settings file, and show token counts in the footer segment when the cap is the one that applies.",
    expected: [
      "extensions/session-limits/src/index.ts",
      "extensions/session-limits/src/limits.ts",
      "extensions/session-limits/src/settings.ts",
      "extensions/session-limits/src/thresholds.ts",
    ],
  },
];

const runs = Math.max(1, Number(process.env[RUNS_ENV] ?? "1") || 1);

const subtree = (records: AgentRecord[], rootId: string): AgentRecord[] => {
  const children = records.filter((record) => record.callerId === rootId);

  return children.flatMap((child) => [child, ...subtree(records, child.id)]);
};

const planOnce = async (live: LiveHarness, fixture: Fixture, wakes: number): Promise<Outcome> => {
  const plannerId = await live.run("planner", fixture.request);

  await live.waitForWakes(wakes, RUN_TIMEOUT_MS);

  const records = live.registry.list();
  const planner = live.registry.get(plannerId);
  const text = planner?.resultText ?? "";
  const files = planFiles(text);
  const tree = [plannerId, ...subtree(records, plannerId).map((record) => record.id)];

  return {
    status: planner?.state === "done" ? (planStatus(text) ?? "no status") : (planner?.state ?? "missing"),
    named: fixture.expected.filter((path) => files.includes(path)).length,
    missing: files.filter((path) => !existsSync(join(live.project, path))),
    scouts: records.filter((record) => record.callerId === plannerId).length,
    cost: costOf(tree.flatMap((id) => live.usage.get(id) ?? [])),
  };
};

// Loose on purpose: model output varies between runs. A run passes when the
// plan is done and names at least half of the files the real commit changed.
// A plan may name new files (tests, a new module), so a few paths that do not
// exist yet are fine; more than two suggests invented paths.
const MIN_RECALL = 0.5;

const MAX_MISSING = 2;

const passes = (fixture: Fixture, outcome: Outcome) =>
  outcome.status === "done" && outcome.named / fixture.expected.length >= MIN_RECALL;

const line = (fixture: Fixture, outcome: Outcome) =>
  `${outcome.status}, recall ${outcome.named}/${fixture.expected.length}, missing ${outcome.missing.length}${outcome.missing.length > 0 ? ` [${outcome.missing.join(", ")}]` : ""}, scouts ${outcome.scouts}, cost $${outcome.cost.toFixed(2)}`;

describeLive("live planner plan quality", () => {
  it.each(fixtures)(
    "plans $sha",
    async (fixture) => {
      const live = createLiveHarness(`plan ${fixture.sha}`, {
        agents: {
          planner: { from: "planner", fields: { limit: "120000" } },
          scout: { from: "scout" },
        },
      });

      try {
        live.seed(`${fixture.sha}^`);

        const outcomes = await Array.from({ length: runs }).reduce<Promise<Outcome[]>>(
          async (previous, _, index) => {
            const done = await previous;
            const outcome = await planOnce(live, fixture, index + 1);

            console.log(`[live plan] ${fixture.sha} run ${index + 1}/${runs}: ${line(fixture, outcome)}`);

            return [...done, outcome];
          },
          Promise.resolve([]),
        );

        const passed = outcomes.filter((outcome) => passes(fixture, outcome)).length;
        const total = outcomes.reduce((sum, outcome) => sum + outcome.cost, 0);

        console.log(
          `[live plan] ${fixture.sha}: ${passed}/${runs} runs pass, mean cost $${(total / runs).toFixed(2)}`,
        );

        expect(passed).toBeGreaterThan(runs / 2);
        expect(outcomes.filter((outcome) => outcome.missing.length > MAX_MISSING)).toEqual([]);
      } finally {
        await live.close();
      }
    },
    runs * (RUN_TIMEOUT_MS + 30_000),
  );
});
