import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import {
  mainSessionPrompt,
  type RunAgentParams,
  recordingTools,
} from "../../../../extensions/subagents/tests/support/routing-session.ts";
import { tempDir } from "../../../../extensions/subagents/tests/support/subagents-harness.ts";
import {
  evalRunCount,
  expectPassRate,
  gradeRun,
  gradeRuns,
  type PassThreshold,
  type Rubric,
  type RunRecord,
  repeatRuns,
  reportEval,
  reportRun,
} from "../../../framework/eval-runs/index.ts";
import {
  describeLive,
  openPiSession,
  PI_DEFAULT_TOOLS,
  runUsage,
  sessionEvents,
} from "../../../framework/pi/live/index.ts";
import { BRIEF_FIELDS, type RoutingCase, routingCases, SKILL } from "./routing-cases.ts";

type Outcome = { items: RunAgentParams["agents"]; record: RunRecord };

const EVERY_RUN: PassThreshold = { atLeast: 1 };

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const writeSkill = (root: string) => {
  const path = join(root, "skills", SKILL, "SKILL.md");

  mkdirSync(join(root, "skills", SKILL), { recursive: true });
  writeFileSync(
    path,
    [
      "---",
      `name: ${SKILL}`,
      "description: Test-driven development. Write a failing test first, then the smallest change that passes it.",
      "---",
      "",
      "1. Write a failing test.",
      "2. Make it pass with the smallest change.",
      "3. Refactor.",
      "",
    ].join("\n"),
  );

  return path;
};

const fieldPattern = (field: string) => new RegExp(`^[\\s>*_#-]*${field}\\b`, "im");

const missingFields = (task: string) => BRIEF_FIELDS.filter((field) => !fieldPattern(field).test(task));

const routeOnce = async (entry: RoutingCase): Promise<Outcome> => {
  const root = tempDir("pi-routing-live-");
  const calls: RunAgentParams[] = [];
  const startedAt = Date.now();

  const session = await openPiSession({
    root,
    systemPrompt: mainSessionPrompt(),
    builtinTools: PI_DEFAULT_TOOLS,
    customTools: recordingTools(calls),
    skillPaths: [writeSkill(root)],
  });

  writeFileSync(join(session.cwd, "screenshot.png"), PNG);

  try {
    await session.ask(entry.request);

    const events = sessionEvents(session.session.messages);

    return {
      items: calls[0]?.agents ?? [],
      record: {
        output: events.findLast((event) => event.type === "message")?.text ?? "",
        events,
        usage: runUsage(session.session),
        timings: { totalMs: Date.now() - startedAt },
        errors: [],
      },
    };
  } finally {
    session.close();
  }
};

const agentsOf = (outcome: Outcome) => outcome.items.map((item) => item.agent);

const skillsOf = (outcome: Outcome) => outcome.items.flatMap((item) => item.skills ?? []);

const briefGaps = (outcome: Outcome) =>
  outcome.items
    .filter((item) => missingFields(item.task).length > 0)
    .map((item) => `${item.agent} task lacks ${missingFields(item.task).join(", ")}`);

const rubricFor = (entry: RoutingCase): Rubric<Outcome> => [
  {
    name: "agent",
    passes: (outcome) =>
      entry.agent === undefined ||
      agentsOf(outcome).includes(entry.agent) ||
      (entry.direct === true && agentsOf(outcome).length === 0),
    explain: (outcome) =>
      `agents [${agentsOf(outcome).join(", ")}], expected ${entry.agent}${entry.direct ? " or a direct answer" : ""}`,
  },
  {
    name: "skill",
    passes: (outcome) => entry.skill === undefined || skillsOf(outcome).includes(entry.skill),
    explain: () => `no item passed skills [${entry.skill}]`,
  },
  {
    name: "no unasked skill",
    passes: (outcome) => entry.skill !== undefined || skillsOf(outcome).length === 0,
    explain: (outcome) => `skills [${skillsOf(outcome).join(", ")}] passed unasked`,
  },
  {
    name: "brief",
    passes: (outcome) => briefGaps(outcome).length === 0,
    explain: (outcome) => briefGaps(outcome).join("; "),
  },
];

const caseName = (entry: RoutingCase) =>
  `subagents/routing ${entry.agent ?? `skill ${entry.skill}`}: "${entry.request}"`;

const reportedRoute = async (entry: RoutingCase, index: number, total: number) => {
  const outcome = await routeOnce(entry);

  reportRun(caseName(entry), total, gradeRun(index, outcome, rubricFor(entry), outcome.record));

  return outcome;
};

describeLive("eval main-session routing", () => {
  it.each(routingCases)("routes: $request", async (entry) => {
    const runs = evalRunCount();
    const outcomes = await repeatRuns(runs, (index) => reportedRoute(entry, index, runs));
    const result = gradeRuns(caseName(entry), outcomes, rubricFor(entry), (outcome) => outcome.record);

    reportEval(result);
    expectPassRate(result, EVERY_RUN);
  });
});
