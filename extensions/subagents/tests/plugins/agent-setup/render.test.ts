import { describe, expect, it } from "vitest";
import { char, key, plainTheme } from "../../../../../test/framework/index.ts";
import { initialSetup, type SetupContext, type SetupState } from "../../../ui/agent-setup/form.ts";
import { renderSetup } from "../../../ui/agent-setup/setup-render.ts";
import { context, PATHS, press, proposedContext, render } from "../../support/setup-context.ts";

const EVERY_PROJECT = " Project not trusted: only the user file applies, to every project.";

describe("agent setup rendering", () => {
  it("renders the agent tab with its fields, tools note and MCP line", () => {
    const lines = render(context(), initialSetup(context()));

    expect(lines.slice(1, 3)).toEqual([" Leads   □ lead  □ helper", " Chores  □ chore  ✓ Submit"]);
    expect(lines.slice(4, 8)).toEqual([" lead", " Leads things.", "", ""]);
    expect(lines).toContain(" › Model     acme/big");
    expect(lines).toContain("   Thinking  high");
    expect(lines).toContain("   Skills    all (every skill of the agent's caller)");
    expect(lines).toContain("   Previous  all · acme/big · high (in use)");
    expect(lines.some((line) => line.includes("Suggested"))).toBe(false);
    expect(lines.some((line) => line === " Tools: all; fixed per agent; /agents create makes your own")).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith(" MCP: on"))).toBe(true);
  });

  it("renders a chore tab with its skills as a fixed row after model and thinking", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("tab"), key("tab")).state);

    expect(lines[2]).toBe(" Chores  □ chore  ✓ Submit");
    expect(lines.slice(lines.indexOf(" chore") + 4).slice(0, 3)).toEqual([
      " › Model     gone/old",
      "   Thinking  default",
      "   Skills    none · fixed for chores",
    ]);
  });

  it("lists the changes and only the user file on the submit tab when untrusted, saying it applies everywhere", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const lines = render(ctx, press(ctx, edited.state, key("left")).state);

    expect(lines).toContain(" Changes");
    expect(lines).toContain(" lead: thinking off (was high)");
    expect(lines).toContain(` › 1. User  ${PATHS.user}`);
    expect(lines).toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.includes(PATHS.project))).toBe(false);
    expect(lines.some((line) => line.includes("enter to save"))).toBe(true);
  });

  it("shows no untrusted line and no project line in a plain trusted form", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("left")).state);

    expect(lines).not.toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.startsWith(" Project:"))).toBe(false);
    expect(lines.some((line) => line.startsWith(" Proposed:"))).toBe(false);
  });

  it("shows the reasons on a proposed agent's tab and the project kind on the submit tab", () => {
    const ctx = proposedContext();

    expect(render(ctx, initialSetup(ctx))).toContain(" Proposed: search finds code");
    expect(render(ctx, press(ctx, initialSetup(ctx), key("tab")).state)).not.toContain(
      " Proposed: search finds code",
    );
    expect(render(ctx, press(ctx, initialSetup(ctx), key("left")).state)).toContain(
      " Project: A TypeScript library",
    );
  });

  it("shows the filter under the picker title with a placeholder, a count and a no-match line", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("down"), key("down"), key("enter"));
    const lines = render(ctx, opened.state);
    const typed = (text: string) => render(ctx, press(ctx, opened.state, ...[...text].map(char)).state);

    expect(lines.slice(lines.indexOf(" Skills"), lines.indexOf(" Skills") + 4)).toEqual([
      " Skills",
      " / type to filter",
      "",
      " › [x] all  every skill of the agent's caller",
    ]);
    expect(lines.at(-2)).toBe(" esc to clear/back · ↑↓ to select · space to toggle · enter to confirm");
    expect(typed("do")).toContain(`${" / do▏".padEnd(194)}1 of 2`);
    expect(typed("zzq")).toContain(' no skill matches "zzq"');
    expect(typed("zzq").some((line) => line.includes("[ ]") || line.includes("[x]"))).toBe(false);
    expect(render(ctx, press(ctx, initialSetup(ctx), key("enter"), char("q")).state)).toContain(
      ' no model matches "q"',
    );
  });

  it("shows only the window of model options around the cursor", () => {
    const ctx = {
      ...context(),
      models: Array.from({ length: 20 }, (_, index) => ({
        ref: `acme/m${index}`,
        contextWindow: 100_000,
        cost: { input: 1, output: 2 },
        thinking: ["off"],
      })),
    };
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("enter")).state);

    expect(lines).toContain("   inherit (the main session's model)");
    expect(lines.some((line) => line.includes("more"))).toBe(true);
    expect(lines.some((line) => line.includes("acme/m19"))).toBe(false);
  });
});

describe("agent setup layout", () => {
  const LONG =
    "Reviews diffs for correctness, missing tests, risky changes and unclear naming, then reports every finding grouped by severity with file and line, and suggests the smallest fix for each.";

  const wide = (trusted: boolean): SetupContext => {
    const base = proposedContext(trusted);

    return {
      ...base,
      agents: base.agents.map((agent) =>
        agent.name === "helper"
          ? { ...agent, description: LONG, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] }
          : agent,
      ),
      models: Array.from({ length: 20 }, (_, index) => ({
        ref: `acme/model-${index}`,
        contextWindow: 100_000,
        cost: { input: 1, output: 2 },
        thinking: ["off", "low", "high"],
      })),
      skills: [
        ...base.skills,
        { name: "review", description: LONG, scope: "user" as const, path: "/skills/review/SKILL.md" },
      ],
    };
  };

  const at80 = (ctx: SetupContext, state: SetupState, width = 80) =>
    renderSetup(ctx, state, PATHS, plainTheme, width);

  const heights = (ctx: SetupContext, states: SetupState[], width = 80) =>
    new Set(states.map((state) => at80(ctx, state, width).length));

  it("renders every agent tab and the submit tab with the same number of lines", () => {
    [true, false].forEach((trusted) => {
      const ctx = wide(trusted);
      const tabs = Array.from({ length: ctx.agents.length + 1 }, (_, tab) => ({ ...initialSetup(ctx), tab }));

      expect(heights(ctx, tabs)).toEqual(new Set([34]));
    });
  });

  it("keeps the height while a picker opens, scrolls, filters and closes", () => {
    const ctx = wide(true);
    const start = initialSetup(ctx);
    const model = press(ctx, start, key("enter")).state;
    const skills = press(ctx, start, key("down"), key("down"), key("enter")).state;
    const states = [
      start,
      model,
      press(ctx, model, ...Array.from({ length: 10 }, () => key("down"))).state,
      press(ctx, model, key("end")).state,
      press(ctx, model, char("1")).state,
      press(ctx, model, char("z"), char("z")).state,
      press(ctx, model, key("escape")).state,
      press(ctx, start, key("down"), key("enter")).state,
      skills,
      press(ctx, skills, key("end")).state,
      press(ctx, skills, key("down")).state,
      press(ctx, skills, char("r"), char("e")).state,
      press(ctx, skills, char("z"), char("z")).state,
      press(ctx, { ...start, tab: 1 }, key("end"), key("enter")).state,
    ];

    expect(heights(ctx, states)).toEqual(new Set([34]));
    expect(heights(ctx, states, 40).size).toBe(1);
    expect(heights(ctx, states, 200).size).toBe(1);
  });

  it("shows the scroll counts in fixed rows around the model list", () => {
    const ctx = wide(true);
    const model = press(ctx, initialSetup(ctx), key("enter")).state;
    const list = (state: SetupState) => {
      const lines = at80(ctx, state);
      const start = lines.indexOf(" Model (models with credentials)") + 2;

      return lines.slice(start, start + 10);
    };

    expect(list(model)[0]).toBe("");
    expect(list(model)[9]).toBe(" ↓ 14 more");
    expect(list(press(ctx, model, key("end")).state)[0]).toBe(" ↑ 14 more");
    expect(list(press(ctx, model, key("end")).state)[9]).toBe("");
    expect(list(press(ctx, model, char("z")).state).slice(0, 3)).toEqual(["", ' no model matches "z"', ""]);
  });

  it("cuts the description to two rows under the name and the footer to one row", () => {
    const ctx = wide(true);
    const lines = at80(ctx, { ...initialSetup(ctx), tab: 1 });

    expect(lines.slice(4, 8)).toEqual([
      " helper",
      " Reviews diffs for correctness, missing tests, risky changes and unclear naming,",
      " then reports every finding grouped by severity with file and line, and sugge...",
      "",
    ]);

    const narrow = at80(ctx, press(ctx, initialSetup(ctx), key("down"), key("down"), key("enter")).state, 40);

    expect(narrow.at(-3)).toBe("");
    expect(narrow.at(-2)).toBe(" esc to clear/back · ↑↓ to select · s...");
    expect(narrow.at(-1)).toBe("─".repeat(40));
  });

  it("keeps the changed and in-use marks when the values are cut", () => {
    const ctx = wide(true);
    const lines = at80(ctx, initialSetup(ctx), 40);

    expect(lines).toContain("   Skills    search, docs (changed)");
    expect(lines.some((line) => line.startsWith("   Suggested ") && line.endsWith("... (in use)"))).toBe(
      true,
    );
  });
});
