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

  it("shows the filter beside the picker title with a placeholder, a count and a no-match line", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("down"), key("down"), key("enter"));
    const lines = render(ctx, opened.state);
    const typed = (text: string) => render(ctx, press(ctx, opened.state, ...[...text].map(char)).state);

    const top = lines.indexOf(" Skills  / type to filter");

    expect(lines.slice(top, top + 3)).toEqual([
      " Skills  / type to filter",
      "",
      " › [x] all  every skill of the agent's caller",
    ]);
    expect(lines.at(-2)).toBe(" esc to clear/back · ↑↓ to select · space to toggle · enter to confirm");
    expect(typed("do")).toContain(`${" Skills  / do▏".padEnd(194)}1 of 2`);
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

      expect(heights(ctx, tabs)).toEqual(new Set([21]));
    });
  });

  it("keeps one height with every picker closed or open", () => {
    const ctx = wide(true);
    const start = initialSetup(ctx);
    const model = press(ctx, start, key("enter")).state;
    const skills = press(ctx, start, key("down"), key("down"), key("enter")).state;
    const closed = [
      start,
      press(ctx, model, key("escape")).state,
      press(ctx, skills, key("enter")).state,
      { ...start, tab: 2 },
      press(ctx, { ...start, tab: 1 }, key("end"), key("enter")).state,
    ];
    const open = [
      model,
      press(ctx, model, ...Array.from({ length: 10 }, () => key("down"))).state,
      press(ctx, model, key("end")).state,
      press(ctx, model, char("1")).state,
      press(ctx, model, char("z"), char("z")).state,
      press(ctx, start, key("down"), key("enter")).state,
      skills,
      press(ctx, skills, key("end")).state,
      press(ctx, skills, key("down")).state,
      press(ctx, skills, char("r"), char("e")).state,
      press(ctx, skills, char("z"), char("z")).state,
    ];

    expect(heights(ctx, [...closed, ...open])).toEqual(new Set([21]));
    [40, 200].forEach((width) => {
      expect(heights(ctx, [...closed, ...open], width).size).toBe(1);
    });
  });

  it("fits an open picker into the rows of the fields, presets and info", () => {
    const ctx = wide(true);
    const lines = at80(ctx, press(ctx, initialSetup(ctx), key("enter")).state);

    expect(lines.slice(4, 9)).toEqual([
      " lead",
      " Leads things.",
      "",
      "",
      " Model (models with credentials)  / type to filter",
    ]);
    expect(lines.some((text) => text.includes("Thinking ") || text.includes("Tools:"))).toBe(false);
  });

  it("shows the scroll counts in fixed rows around the model list", () => {
    const ctx = wide(true);
    const model = press(ctx, initialSetup(ctx), key("enter")).state;
    const list = (state: SetupState) => {
      const lines = at80(ctx, state);
      const start = lines.findIndex((line) => line.startsWith(" Model (models with credentials)  ")) + 1;

      return lines.slice(start, start + 9);
    };

    expect(list(model)[0]).toBe("");
    expect(list(model)[8]).toBe(" ↓ 15 more");
    expect(list(press(ctx, model, key("end")).state)[0]).toBe(" ↑ 15 more");
    expect(list(press(ctx, model, key("end")).state)[8]).toBe("");
    expect(list(press(ctx, model, char("z")).state).slice(0, 3)).toEqual(["", ' no model matches "z"', ""]);
  });

  it("shows the scroll counts in fixed rows around the skills list", () => {
    const base = wide(true);
    const extra = Array.from({ length: 8 }, (_, index) => ({
      name: `extra-${index}`,
      description: `Extra skill ${index}`,
      scope: "user" as const,
      path: `/skills/extra-${index}/SKILL.md`,
    }));
    const ctx = { ...base, skills: [...base.skills, ...extra] };
    const skills = press(ctx, initialSetup(ctx), key("down"), key("down"), key("enter")).state;
    const states = [skills, press(ctx, skills, ...Array.from({ length: 6 }, () => key("down"))).state];
    const ends = [...states, press(ctx, skills, key("end")).state];
    const list = (state: SetupState) => {
      const lines = at80(ctx, state);
      const start = lines.indexOf(" Skills  / type to filter") + 1;

      return lines.slice(start, start + 7);
    };

    expect(ends.map((state) => [list(state)[0], list(state)[6]])).toEqual([
      ["", " ↓ 8 more"],
      [" ↑ 4 more", " ↓ 4 more"],
      [" ↑ 8 more", ""],
    ]);
    expect(heights(ctx, ends)).toEqual(new Set([21]));
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

  it("fits every line to 40 columns and keeps the marks and the esc hint", () => {
    const ref = "acme/an-extremely-long-model-reference-for-narrow-forms";
    const base = wide(true);
    const ctx = {
      ...base,
      agents: base.agents.map((agent) =>
        agent.proposed ? { ...agent, proposed: { ...agent.proposed, model: ref } } : agent,
      ),
      models: [
        ...base.models,
        { ref, contextWindow: 100_000, cost: { input: 1, output: 2 }, thinking: ["high"] },
      ],
    };
    const start = initialSetup(ctx);
    const applied = press(ctx, start, key("down"), key("down"), key("down"), key("enter")).state;
    const submit = { ...start, tab: ctx.agents.length };
    const picker = press(ctx, start, key("enter")).state;
    const narrow = (state: SetupState) => at80(ctx, state, 40);

    [start, applied, submit, picker].forEach((state) => {
      expect(narrow(state).every((line) => plainTheme.width(line) <= 40)).toBe(true);
      expect(narrow(state).at(-2)).toMatch(/^ esc /);
    });
    expect(narrow(start).some((line) => line.startsWith(" › Model ") && line.endsWith("... (changed)"))).toBe(
      true,
    );
    expect(
      narrow(start).some((line) => line.startsWith("   Suggested ") && line.endsWith("... (in use)")),
    ).toBe(true);
    expect(narrow(applied)).toContain(" › Previous  all · acme/big ... (in use)");
    expect(
      narrow(submit).some(
        (line) => line.startsWith(" lead: mo") && line.endsWith(" (suggested) (was acme/big)"),
      ),
    ).toBe(true);
  });
});
