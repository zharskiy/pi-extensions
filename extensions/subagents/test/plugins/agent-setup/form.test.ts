import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import {
  initialSetup,
  modelOptions,
  pressSetupKey,
  type SetupContext,
  type SetupState,
  setupChanges,
  thinkingOptions,
  UNTRUSTED,
} from "../../../src/plugins/agent-setup/form.ts";
import { renderSetup } from "../../../src/plugins/agent-setup/render.ts";

const key = (name: KeyPress["name"]): KeyPress => ({ name });

const char = (value: string): KeyPress => ({ name: "other", char: value, raw: value });

const model = (ref: string, thinking: string[]) => ({
  ref,
  contextWindow: 100_000,
  cost: { input: 1, output: 2 },
  thinking,
});

const context = (trusted = true): SetupContext => ({
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
  skills: ["docs", "search"],
  trusted,
});

const PATHS = { project: "/repo/.pi/pi-subagents.json", user: "/home/.pi/agent/pi-subagents.json" };

const press = (ctx: SetupContext, state: SetupState, ...keys: KeyPress[]) =>
  keys.reduce<{ state: SetupState; done?: string }>(
    (outcome, pressed) => (outcome.done ? outcome : pressSetupKey(ctx, outcome.state, pressed)),
    { state },
  );

const render = (ctx: SetupContext, state: SetupState) => renderSetup(ctx, state, PATHS, plainTheme, 200);

describe("agent setup form", () => {
  it("starts on the first agent with the project scope when trusted and the user scope otherwise", () => {
    expect(initialSetup(context()).scope).toBe(0);
    expect(initialSetup(context(false)).scope).toBe(1);
    expect(setupChanges(context(), initialSetup(context()))).toEqual([]);
  });

  it("lists inherit, an initial model without credentials, then the models with credentials", () => {
    expect(modelOptions(context(), 0)).toEqual(["inherit", "acme/big", "acme/small"]);
    expect(modelOptions(context(), 1)).toEqual(["inherit", "gone/old", "acme/big", "acme/small"]);
  });

  it("offers the thinking levels of the chosen model, and every level for an unknown model", () => {
    expect(thinkingOptions(context(), { model: "acme/small", skills: [] })).toEqual(["off"]);
    expect(thinkingOptions(context(), { model: "inherit", skills: [] })).toContain("medium");
  });

  it("renders the agent tab with its fields, tools note and MCP line", () => {
    const lines = render(context(), initialSetup(context()));

    expect(lines[1]).toBe(" ← □ lead  □ chore  ✓ Submit →");
    expect(lines).toContain(" lead Leads things.");
    expect(lines).toContain(" › Model     acme/big");
    expect(lines).toContain("   Thinking  high");
    expect(lines).toContain("   Skills    all");
    expect(lines.some((line) => line.includes("create your own agent with /agents create."))).toBe(true);
    expect(lines.some((line) => line.startsWith(" MCP: on"))).toBe(true);
  });

  it("picks a model, a thinking level and skills, and marks the changed fields and tab", () => {
    const ctx = context();
    const { state } = press(
      ctx,
      initialSetup(ctx),
      key("enter"),
      key("down"),
      key("enter"),
      key("down"),
      key("enter"),
      key("enter"),
      key("down"),
      key("enter"),
      char("n"),
      key("down"),
      key("space"),
      key("enter"),
    );

    expect(setupChanges(ctx, state)).toEqual([
      { name: "lead", patch: { model: "acme/small", thinking: "off", skills: ["search"] } },
    ]);
    expect(render(ctx, state)[1]).toBe(" ← ■ lead  □ chore  ✓ Submit →");
    expect(render(ctx, state)).toContain(" › Skills    search (changed)");
  });

  it("stores all skills as all and leaves a field unchanged when its picker is left with Escape", () => {
    const ctx = context();
    const { state } = press(
      ctx,
      initialSetup(ctx),
      key("tab"),
      key("down"),
      key("down"),
      key("enter"),
      char("a"),
      key("enter"),
      key("up"),
      key("enter"),
      key("end"),
      key("escape"),
    );

    expect(setupChanges(ctx, state)).toEqual([{ name: "chore", patch: { skills: "all" } }]);
  });

  it("switches tabs with Tab and ←, wrapping to the submit tab, and cancels with Escape", () => {
    const ctx = context();
    const back = press(ctx, initialSetup(ctx), key("left"));

    expect(back.state.tab).toBe(2);
    expect(press(ctx, back.state, key("right")).state.tab).toBe(0);
    expect(press(ctx, back.state, key("escape")).done).toBe("cancel");
  });

  it("shows the changes and both files on the submit tab and saves with Enter", () => {
    const ctx = context();
    const { state } = press(ctx, initialSetup(ctx), key("tab"), key("down"), key("enter"), key("end"));
    const changed = press(ctx, state, key("enter"), key("tab"));
    const lines = render(ctx, changed.state);

    expect(lines).toContain(" chore: thinking max");
    expect(lines).toContain(` › 1. This project  ${PATHS.project}`);
    expect(lines).toContain(`   2. User  ${PATHS.user}`);
    expect(press(ctx, changed.state, key("enter")).done).toBe("save");
  });

  it("refuses the project scope in an untrusted project and saves to the user file instead", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const submit = press(ctx, edited.state, key("left"), key("up"), key("enter"));

    expect(submit.done).toBeUndefined();
    expect(submit.state.refused).toBe(UNTRUSTED);
    expect(render(ctx, submit.state)).toContain(
      ` › 1. This project  ${PATHS.project} (project not trusted)`,
    );
    expect(press(ctx, submit.state, key("down"), key("enter")).done).toBe("save");
  });
});
