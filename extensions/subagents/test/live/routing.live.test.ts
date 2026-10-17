import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AnyToolSpec } from "../../../../core/adapter/contract.ts";
import { describeLive, openMainLikeSession, PI_DEFAULT_TOOLS } from "../../../../core/test/adapter/live.ts";
import { defaultSettings } from "../../src/model/settings.ts";
import { loadDefinitions } from "../../src/plugins/agent-definitions/loader.ts";
import type { RunAgentParams } from "../../src/plugins/run-agent/render.ts";
import { describeRunAgent, messageAgentTool, runAgentTool } from "../../src/plugins/run-agent/tools.ts";
import { PACKAGE_ROOT, tempDir } from "../helpers/harness.ts";

type Case = { request: string; agent?: string; skill?: string; direct?: boolean };

const RUNS_ENV = "PI_LIVE_ROUTING_RUNS";

const BRIEF_FIELDS = ["Goal", "Scope", "Done when", "Return"];

const SKILL = "tdd";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const cases: Case[] = [
  { request: "where do we parse the settings file?", agent: "scout", direct: true },
  {
    request: "rename the `renderThrottleMs` setting to `redrawThrottleMs` in extensions/subagents",
    agent: "implementer",
  },
  { request: "review my last commit", agent: "reviewer" },
  { request: "make the subagents extension support cancelling a batch", agent: "planner" },
  { request: "what does https://example.com say?", agent: "fetch" },
  { request: "run npm run test and tell me what fails", agent: "shell" },
  { request: "what does screenshot.png show?", agent: "image" },
  { request: "draft release notes from the git log", agent: "general" },
  { request: `use my ${SKILL} skill to add a test for parseDuration in src/time.ts`, skill: SKILL },
];

const runs = Math.max(1, Number(process.env[RUNS_ENV] ?? "1") || 1);

const readPrompt = (file: string) => readFileSync(join(PACKAGE_ROOT, "prompts", file), "utf8").trim();

const roster = () => {
  const loaded = loadDefinitions([{ path: join(PACKAGE_ROOT, "agents"), source: "builtin" }]);

  return Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const runAgentDescription = () => {
  const settings = defaultSettings();

  return describeRunAgent(roster(), {
    callerDepth: 1,
    maxDepth: settings.maxDepth,
    maxConcurrent: settings.maxConcurrent,
  });
};

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

const startedText = (params: RunAgentParams, batch: number) => {
  const list = params.agents
    .map((item, index) => `- a${batch}-${index + 1} (${item.agent}, model n/a)`)
    .join("\n");

  return `Started batch b${batch}:\n${list}\nYou will be woken once when all agents are done. End your turn now.`;
};

const recordingTools = (calls: RunAgentParams[]): AnyToolSpec[] => {
  const runAgent = {
    ...runAgentTool({} as never, runAgentDescription()),
    execute: async (params: RunAgentParams) => {
      calls.push(params);

      return { text: startedText(params, calls.length) };
    },
  };

  const messageAgent = {
    ...messageAgentTool({} as never),
    execute: async () => ({ text: "Message delivered." }),
  };

  return [runAgent, messageAgent] as AnyToolSpec[];
};

const fieldPattern = (field: string) => new RegExp(`^[\\s>*_#-]*${field}\\b`, "im");

const missingFields = (task: string) => BRIEF_FIELDS.filter((field) => !fieldPattern(field).test(task));

const routeOnce = async (entry: Case) => {
  const root = tempDir("pi-routing-live-");
  const calls: RunAgentParams[] = [];

  const session = await openMainLikeSession({
    root,
    systemPrompt: readPrompt("main-session.md"),
    builtinTools: PI_DEFAULT_TOOLS,
    customTools: recordingTools(calls),
    skillPaths: [writeSkill(root)],
  });

  writeFileSync(join(session.cwd, "screenshot.png"), PNG);

  try {
    await session.ask(entry.request);
  } finally {
    session.close();
  }

  return calls[0]?.agents ?? [];
};

const verdict = (entry: Case, items: RunAgentParams["agents"]) => {
  const agents = items.map((item) => item.agent);
  const skills = items.flatMap((item) => item.skills ?? []);

  const checks: [boolean, string][] = [
    [
      entry.agent !== undefined && !agents.includes(entry.agent) && !(entry.direct && agents.length === 0),
      `agents [${agents.join(", ")}], expected ${entry.agent}${entry.direct ? " or a direct answer" : ""}`,
    ],
    [entry.skill !== undefined && !skills.includes(entry.skill), `no item passed skills [${entry.skill}]`],
    [entry.skill === undefined && skills.length > 0, `skills [${skills.join(", ")}] passed unasked`],
    ...items.map((item): [boolean, string] => [
      missingFields(item.task).length > 0,
      `${item.agent} task lacks ${missingFields(item.task).join(", ")}`,
    ]),
  ];

  return checks.filter(([failed]) => failed).map(([, problem]) => problem);
};

describeLive("live main-session routing", () => {
  it.each(cases)("routes: $request", async (entry) => {
    const outcomes = await Array.from({ length: runs }).reduce<Promise<string[][]>>(
      async (previous) => [...(await previous), verdict(entry, await routeOnce(entry))],
      Promise.resolve([]),
    );
    const hits = outcomes.filter((problems) => problems.length === 0).length;

    console.log(
      `[live routing] ${entry.agent ?? `skill ${entry.skill}`}: ${hits}/${runs} hits for "${entry.request}"`,
    );

    expect(outcomes.flat()).toEqual([]);
  });
});
