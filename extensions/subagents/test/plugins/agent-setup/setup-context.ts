import type { KeyPress } from "../../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { pressSetupKey, type SetupContext, type SetupState } from "../../../src/plugins/agent-setup/form.ts";
import { renderSetup } from "../../../src/plugins/agent-setup/render.ts";

export { char, key } from "../../helpers/overlay.ts";

const model = (ref: string, thinking: string[]) => ({
  ref,
  contextWindow: 100_000,
  cost: { input: 1, output: 2 },
  thinking,
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
  skills: [
    { name: "docs", description: "Writes docs" },
    { name: "search", description: "" },
  ],
  trusted,
});

export const PATHS = { project: "/repo/.pi/pi-subagents.json", user: "/home/.pi/agent/pi-subagents.json" };

export const press = (ctx: SetupContext, state: SetupState, ...keys: KeyPress[]) =>
  keys.reduce<{ state: SetupState; done?: string }>(
    (outcome, pressed) => (outcome.done ? outcome : pressSetupKey(ctx, outcome.state, pressed)),
    { state },
  );

export const render = (ctx: SetupContext, state: SetupState) =>
  renderSetup(ctx, state, PATHS, plainTheme, 200);
