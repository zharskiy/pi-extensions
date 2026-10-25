import type { KeyPress } from "../../../../platform/pi-adapter/index.ts";
import { plainTheme } from "../../../../test/framework/index.ts";
import { pressSetupKey, type SetupContext, type SetupState } from "../../ui/agent-setup/form.ts";
import { renderSetup } from "../../ui/agent-setup/setup-render.ts";

const model = (ref: string, thinking: string[]) => ({
  ref,
  contextWindow: 100_000,
  cost: { input: 1, output: 2 },
  thinking,
});

const skill = (name: string, description: string) => ({
  name,
  description,
  scope: "user" as const,
  path: `/skills/${name}/SKILL.md`,
});

export const context = (trusted = true): SetupContext => ({
  agents: [
    {
      name: "lead",
      description: "Leads things.",
      tools: "all",
      mcp: true,
      initial: { model: "acme/big", thinking: "high", skills: "all" },
    },
    {
      name: "chore",
      description: "Does chores.",
      tools: ["read", "grep"],
      mcp: false,
      initial: { model: "gone/old", skills: [] },
    },
  ],
  models: [model("acme/big", ["off", "low", "high"]), model("acme/small", ["off"])],
  skills: [skill("docs", "Writes docs"), skill("search", "")],
  trusted,
});

export const proposedContext = (trusted = true): SetupContext => {
  const base = context(trusted);

  return {
    ...base,
    agents: base.agents.map((agent) =>
      agent.name === "lead"
        ? { ...agent, proposed: { ...agent.initial, skills: ["search", "docs"] }, note: "search finds code" }
        : agent,
    ),
    skills: [...base.skills, skill("lint", "Checks style")],
    project: "A TypeScript library",
  };
};

export const PATHS = { project: "/repo/.pi/pi-subagents.json", user: "/home/.pi/agent/pi-subagents.json" };

export const press = (ctx: SetupContext, state: SetupState, ...keys: KeyPress[]) =>
  keys.reduce<{ state: SetupState; done?: string }>(
    (outcome, pressed) => (outcome.done ? outcome : pressSetupKey(ctx, outcome.state, pressed)),
    { state },
  );

export const render = (ctx: SetupContext, state: SetupState) =>
  renderSetup(ctx, state, PATHS, plainTheme, 200);
