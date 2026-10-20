import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { costOf, describeLive, waitUntil } from "../../../../core/test/adapter/live.ts";
import { type AgentRecord, chainLinks, chainTerminal, isClosed } from "../../src/model/types.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";
import { type PlanFile, planFiles, planStatus, relativeTo } from "../helpers/plan-rows.ts";

type Fixture = { sha: string; request: string; expected: string[]; unscored: string[] };

type Outcome = {
  status: string;
  named: number;
  unscored: string[];
  missing: string[];
  globs: string[];
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
      "extensions/session-limits/src/limits.ts",
      "extensions/session-limits/src/settings.ts",
      "extensions/session-limits/src/thresholds.ts",
    ],
    unscored: ["extensions/session-limits/src/index.ts"],
  },
];

const runs = Math.max(1, Math.floor(Number(process.env[RUNS_ENV] ?? "1")) || 1);

const subtree = (records: AgentRecord[], rootId: string): AgentRecord[] => {
  const children = records.filter((record) => record.callerId === rootId);

  return children.flatMap((child) => [child, ...subtree(records, child.id)]);
};

const projectRelative = (project: string, path: string) => relativeTo([project, realpathSync(project)], path);

const isMissing = (project: string, file: PlanFile) =>
  !file.isNew && !existsSync(join(project, file.path)) && !existsSync(join(project, dirname(file.path)));

const planOnce = async (live: LiveHarness, fixture: Fixture): Promise<Outcome> => {
  const plannerId = await live.run("planner", fixture.request);
  const terminal = () => {
    const first = live.registry.get(plannerId);

    return first && chainTerminal(live.registry, first);
  };

  await waitUntil(
    () => {
      const last = terminal();

      return last !== undefined && isClosed(last.state) && last.state !== "handoff";
    },
    RUN_TIMEOUT_MS,
    `planner ${plannerId} to close`,
  );

  const records = live.registry.list();
  const planner = terminal();
  const links = planner ? chainLinks(live.registry, planner) : [];
  const text = planner?.resultText ?? "";
  const files = planFiles(text).map((file) => ({ ...file, path: projectRelative(live.project, file.path) }));
  const paths = files.map((file) => file.path);
  const linkIds = links.map((link) => link.id);
  const tree = [...linkIds, ...linkIds.flatMap((id) => subtree(records, id).map((record) => record.id))];

  return {
    status: planner?.state === "done" ? (planStatus(text) ?? "no status") : (planner?.state ?? "missing"),
    named: fixture.expected.filter((path) => paths.includes(path)).length,
    unscored: fixture.unscored.filter((path) => paths.includes(path)),
    missing: files
      .filter((file) => !file.path.includes("*") && isMissing(live.project, file))
      .map((file) => file.path),
    globs: paths.filter((path) => path.includes("*")),
    scouts: records.filter((record) => linkIds.includes(record.callerId) && record.agent === "scout").length,
    cost: costOf(tree.flatMap((id) => live.usage.get(id) ?? [])),
  };
};

const MIN_NAMED = 2;

const MAX_MISSING = 2;

const recalls = (outcome: Outcome) => outcome.status === "done" && outcome.named >= MIN_NAMED;

const clean = (outcome: Outcome) => outcome.missing.length <= MAX_MISSING;

const listed = (label: string, paths: string[]) =>
  paths.length > 0 ? `, ${label} [${paths.join(", ")}]` : "";

const line = (fixture: Fixture, outcome: Outcome) =>
  [
    `${outcome.status}, recall ${outcome.named}/${fixture.expected.length}`,
    listed("unscored", outcome.unscored),
    `, missing ${outcome.missing.length}`,
    outcome.missing.length > 0 ? ` [${outcome.missing.join(", ")}]` : "",
    listed("globs", outcome.globs),
    `, scouts ${outcome.scouts}, cost $${outcome.cost.toFixed(2)}`,
  ].join("");

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
            const outcome = await planOnce(live, fixture);

            console.log(`[live plan] ${fixture.sha} run ${index + 1}/${runs}: ${line(fixture, outcome)}`);

            return [...done, outcome];
          },
          Promise.resolve([]),
        );

        const recalled = outcomes.filter(recalls).length;
        const cleanRuns = outcomes.filter(clean).length;
        const total = outcomes.reduce((sum, outcome) => sum + outcome.cost, 0);

        console.log(
          `[live plan] ${fixture.sha}: recall ok ${recalled}/${runs}, clean ${cleanRuns}/${runs}, mean cost $${(total / runs).toFixed(2)}`,
        );

        expect(recalled).toBeGreaterThan(runs / 2);
        expect(cleanRuns).toBeGreaterThan(runs / 2);
      } finally {
        await live.close();
      }
    },
    runs * (RUN_TIMEOUT_MS + 30_000),
  );
});
