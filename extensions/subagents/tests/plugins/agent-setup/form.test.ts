import { describe, expect, it } from "vitest";
import { char, key } from "../../../../../test/framework/index.ts";
import { typed as pressed } from "../../../../../test/framework/pi/index.ts";
import { initialSetup, scopeOptions, setupChanges } from "../../../ui/agent-setup/form.ts";
import { context, PATHS, press, proposedContext, render } from "../../support/setup-context.ts";

const toSkills = [key("down"), key("down"), key("enter")];

const skillRows = (lines: string[]) => lines.filter((line) => line.includes("[x]") || line.includes("[ ]"));

const typed = (text: string) => [...text].map((letter) => char(letter));

const pickerTitle = (lines: string[]) => lines.find((line) => / {2}\/ /.test(line));

const optionRows = (lines: string[]) => lines.filter((line) => /^ [› ] \S/.test(line));

const ALL_SKILLS = "all (every skill of the agent's caller)";

describe("agent setup form", () => {
  it("starts on the first agent and the first scope: the project when trusted, the user file otherwise", () => {
    expect(initialSetup(context()).scope).toBe(0);
    expect(scopeOptions(context())).toEqual(["project", "user"]);
    expect(scopeOptions(context(false))).toEqual(["user"]);
    expect(setupChanges(context(), initialSetup(context()))).toEqual([]);
  });

  it("opens with a proposed draft marked as changed against the current values", () => {
    const ctx = proposedContext();
    const state = initialSetup(ctx);

    expect(setupChanges(ctx, state)).toEqual([{ name: "lead", patch: { skills: ["search", "docs"] } }]);
    expect(render(ctx, state).slice(1, 3)).toEqual([
      " Leads   ■ lead  □ helper",
      " Chores  □ chore  ✓ Submit",
    ]);
    expect(render(ctx, state)).toContain("   Skills    search, docs (changed)");
    expect(render(ctx, state)).toContain("   Previous  all · acme/big · high");
    expect(render(ctx, state)).toContain("   Suggested search, docs · acme/big · high (in use)");
  });

  it("applies the previous settings with Enter, then the suggested ones, and edits either afterwards", () => {
    const ctx = proposedContext();
    const previous = press(ctx, initialSetup(ctx), key("down"), key("down"), key("down"), key("enter"));

    expect(render(ctx, previous.state)).toContain(
      " Tools: all; fixed per agent; /agents create makes your own",
    );
    expect(setupChanges(ctx, previous.state)).toEqual([]);
    expect(render(ctx, previous.state)).toContain(" › Previous  all · acme/big · high (in use)");
    expect(render(ctx, previous.state)).toContain("   Suggested search, docs · acme/big · high");

    const suggested = press(ctx, previous.state, key("down"), key("enter"));

    expect(render(ctx, suggested.state)).toEqual(
      expect.arrayContaining([
        "   Model     acme/big",
        "   Thinking  high",
        "   Skills    search, docs (changed)",
      ]),
    );
    expect(setupChanges(ctx, suggested.state)).toEqual([
      { name: "lead", patch: { skills: ["search", "docs"] } },
    ]);
    expect(render(ctx, suggested.state)).toContain(" › Suggested search, docs · acme/big · high (in use)");

    const edited = press(
      ctx,
      suggested.state,
      key("home"),
      key("down"),
      key("enter"),
      key("home"),
      key("enter"),
    );

    expect(setupChanges(ctx, edited.state)).toEqual([
      { name: "lead", patch: { thinking: "off", skills: ["search", "docs"] } },
    ]);
    expect(render(ctx, edited.state).some((line) => line.includes("(in use)"))).toBe(false);

    const restored = press(ctx, edited.state, key("end"), key("up"), key("enter"));

    expect(setupChanges(ctx, restored.state)).toEqual([]);
  });

  it("applies a previous model without a thinking level as the default level", () => {
    const ctx = context();
    const edited = press(
      ctx,
      initialSetup(ctx),
      key("tab"),
      key("down"),
      key("enter"),
      key("end"),
      key("enter"),
    );

    expect(render(ctx, edited.state).some((line) => /^ › Thinking {2}\S+ \(changed\)$/.test(line))).toBe(
      true,
    );

    const previous = press(ctx, edited.state, key("end"), key("enter"));

    expect(render(ctx, previous.state)).toEqual(
      expect.arrayContaining(["   Thinking  default", " › Previous  docs · inherit · default (in use)"]),
    );
    expect(setupChanges(ctx, previous.state)).toEqual([]);
  });

  it("counts a re-ordered skill list as a change", () => {
    const base = proposedContext();
    const ctx = {
      ...base,
      agents: base.agents.map((agent) =>
        agent.name === "lead"
          ? { ...agent, initial: { ...agent.initial, skills: ["docs", "search"] } }
          : agent,
      ),
    };
    const state = initialSetup(ctx);

    expect(setupChanges(ctx, state)).toEqual([{ name: "lead", patch: { skills: ["search", "docs"] } }]);
    expect(render(ctx, state)).toContain("   Skills    search, docs (changed)");
  });

  it("lists the draft's skills first in its order, then the rest, and keeps the rows while toggling", () => {
    const ctx = proposedContext();
    const opened = press(ctx, initialSetup(ctx), ...toSkills);

    expect(skillRows(render(ctx, opened.state))).toEqual([
      " › [ ] all  every skill of the agent's caller",
      "   [x] search",
      "   [x] docs  Writes docs",
      "   [ ] lint  Checks style",
    ]);

    const toggled = press(ctx, opened.state, key("down"), key("space"), key("end"), key("space"));

    expect(skillRows(render(ctx, toggled.state))).toEqual([
      "   [ ] all  every skill of the agent's caller",
      "   [ ] search",
      "   [x] docs  Writes docs",
      " › [x] lint  Checks style",
    ]);
    expect(setupChanges(ctx, press(ctx, toggled.state, key("enter")).state)).toEqual([
      { name: "lead", patch: { skills: ["docs", "lint"] } },
    ]);
  });

  it("writes the confirmed skills in the order shown", () => {
    const ctx = proposedContext();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, key("end"), key("space"), key("enter"));

    expect(setupChanges(ctx, state)).toEqual([
      { name: "lead", patch: { skills: ["search", "docs", "lint"] } },
    ]);
  });

  it("narrows the skills by typing, hides the all row and clears with Backspace, then Escape", () => {
    const ctx = proposedContext();
    const opened = press(ctx, initialSetup(ctx), ...toSkills);
    const narrowed = press(ctx, opened.state, ...typed("SE"));

    expect(skillRows(render(ctx, narrowed.state))).toEqual([" › [x] search"]);

    const widened = press(ctx, narrowed.state, key("backspace"));

    expect(skillRows(render(ctx, widened.state))).toEqual([" › [x] search", "   [x] docs  Writes docs"]);

    const cleared = press(ctx, widened.state, key("escape"));

    expect(pickerTitle(render(ctx, cleared.state))).toBe(" Skills  / type to filter");
    expect(skillRows(render(ctx, cleared.state))).toHaveLength(4);
    expect(pickerTitle(render(ctx, press(ctx, cleared.state, key("escape")).state))).toBeUndefined();
  });

  it("types a and n into the filter instead of checking all or none", () => {
    const ctx = context();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, char("n"), key("escape"), char("a"));

    expect(pickerTitle(render(ctx, state))?.trimEnd()).toMatch(/^ Skills {2}\/ a▏ +\d+ of 2$/);

    const confirmed = press(ctx, state, key("escape"), key("enter")).state;

    expect(render(ctx, confirmed)).toContain(` › Skills    ${ALL_SKILLS}`);
    expect(setupChanges(ctx, confirmed)).toEqual([]);
  });

  it("types a Cyrillic letter into the filter as it is", () => {
    const ctx = context();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, pressed("ч"), pressed("ф"));

    expect(pickerTitle(render(ctx, state))?.trimEnd()).toMatch(/^ Skills {2}\/ чф▏/);
  });

  it("keeps hidden checked skills and confirms in the order shown without a filter", () => {
    const ctx = proposedContext();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, ...typed("li"), key("space"), key("enter"));

    expect(setupChanges(ctx, state)).toEqual([
      { name: "lead", patch: { skills: ["search", "docs", "lint"] } },
    ]);
  });

  it("confirms the current selection on Enter while the filter matches nothing", () => {
    const ctx = proposedContext();
    const opened = press(ctx, initialSetup(ctx), ...toSkills, key("space"), ...typed("zzq"));

    expect(render(ctx, opened.state)).toContain(' no skill matches "zzq"');

    const confirmed = press(ctx, opened.state, key("enter"));

    expect(render(ctx, confirmed.state)).toContain(` › Skills    ${ALL_SKILLS}`);
    expect(setupChanges(ctx, confirmed.state)).toEqual([]);
  });

  it("shows none available without an all row and keeps the draft when there are no skills", () => {
    const ctx = { ...context(), skills: [] };
    const opened = press(ctx, initialSetup(ctx), ...toSkills);

    expect(skillRows(render(ctx, opened.state))).toEqual([]);
    expect(render(ctx, opened.state)).toContain(" (none available)");

    const confirmed = press(ctx, opened.state, key("space"), key("enter"));

    expect(render(ctx, confirmed.state)).toContain(` › Skills    ${ALL_SKILLS}`);
    expect(setupChanges(ctx, confirmed.state)).toEqual([]);
  });

  it("ignores control characters and multi-character input in the filter", () => {
    const ctx = context();
    const { state } = press(ctx, initialSetup(ctx), key("enter"), char("\x01"), char("ab"));

    expect(pickerTitle(render(ctx, state))).toBe(" Model (models with credentials)  / type to filter");
  });

  it("clears a model query with Escape before closing the picker", () => {
    const ctx = context();
    const typedQuery = press(ctx, initialSetup(ctx), key("enter"), ...typed("sm"));
    const cleared = press(ctx, typedQuery.state, key("escape"));

    expect(pickerTitle(render(ctx, cleared.state))).toBe(
      " Model (models with credentials)  / type to filter",
    );
    expect(optionRows(render(ctx, cleared.state))[0]).toBe(" › inherit (the main session's model)");
    expect(render(ctx, press(ctx, cleared.state, key("escape")).state)).toContain(" › Model     acme/big");
  });

  it("filters the models and picks only a visible one", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("enter"), ...typed("small"));

    expect(setupChanges(ctx, press(ctx, opened.state, key("enter")).state)).toEqual([
      { name: "lead", patch: { model: "acme/small", thinking: undefined } },
    ]);

    const missing = press(ctx, opened.state, ...typed("zzq"), key("enter"));

    expect(pickerTitle(render(ctx, missing.state))).toMatch(
      /^ Model \(models with credentials\) {2}\/ smallzzq▏/,
    );
    expect(setupChanges(ctx, missing.state)).toEqual([]);
  });

  it("lists inherit, an initial model without credentials, then the models with credentials", () => {
    const ctx = context();
    const lead = press(ctx, initialSetup(ctx), key("enter"));
    const chore = press(ctx, initialSetup(ctx), key("tab"), key("tab"), key("enter"));

    expect(optionRows(render(ctx, lead.state))).toEqual([
      "   inherit (the main session's model)",
      " › acme/big",
      "   acme/small",
    ]);
    expect(optionRows(render(ctx, chore.state))).toEqual([
      "   inherit (the main session's model)",
      " › gone/old",
      "   acme/big",
      "   acme/small",
    ]);
  });

  it("offers the thinking levels of the chosen model, and every level for an unknown model", () => {
    const ctx = context();
    const small = press(
      ctx,
      initialSetup(ctx),
      key("enter"),
      key("end"),
      key("enter"),
      key("down"),
      key("enter"),
    );
    const inherit = press(ctx, initialSetup(ctx), key("enter"), key("home"), key("enter"), key("down"));
    const levels = optionRows(render(ctx, press(ctx, inherit.state, key("enter")).state));

    expect(optionRows(render(ctx, small.state))).toEqual([" › off"]);
    expect(levels).toContain("   medium");
    expect(levels.length).toBeGreaterThan(3);
  });

  it("drops a thinking level the newly chosen model does not accept and keeps one it does", () => {
    const ctx = context();
    const small = press(ctx, initialSetup(ctx), key("enter"), key("end"), key("enter"));

    expect(render(ctx, small.state)).toEqual(
      expect.arrayContaining([" › Model     acme/small (changed)", "   Thinking  default (changed)"]),
    );
    expect(setupChanges(ctx, small.state)).toEqual([
      { name: "lead", patch: { model: "acme/small", thinking: undefined } },
    ]);

    const inherit = press(ctx, initialSetup(ctx), key("enter"), key("home"), key("enter"));

    expect(render(ctx, inherit.state)).toContain("   Thinking  high");
    expect(setupChanges(ctx, inherit.state)).toEqual([{ name: "lead", patch: { model: "inherit" } }]);
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
      key("down"),
      key("down"),
      key("space"),
      key("enter"),
    );

    expect(setupChanges(ctx, state)).toEqual([
      { name: "lead", patch: { model: "acme/small", thinking: "off", skills: ["search"] } },
    ]);
    expect(render(ctx, state)[1]).toBe(" Leads   ■ lead  □ helper");
    expect(render(ctx, state)).toContain(" › Skills    search (changed)");
  });

  it("opens all with its row ticked, and ticking a skill or all clears the other", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), ...toSkills);

    expect(skillRows(render(ctx, opened.state))).toEqual([
      " › [x] all  every skill of the agent's caller",
      "   [ ] docs  Writes docs",
      "   [ ] search",
    ]);
    expect(setupChanges(ctx, press(ctx, opened.state, key("enter")).state)).toEqual([]);

    const docs = press(ctx, opened.state, key("down"), key("space"));

    expect(skillRows(render(ctx, docs.state))).toEqual([
      "   [ ] all  every skill of the agent's caller",
      " › [x] docs  Writes docs",
      "   [ ] search",
    ]);
    expect(setupChanges(ctx, press(ctx, docs.state, key("enter")).state)).toEqual([
      { name: "lead", patch: { skills: ["docs"] } },
    ]);

    const back = press(ctx, docs.state, key("up"), key("space"));

    expect(skillRows(render(ctx, back.state))).toEqual([
      " › [x] all  every skill of the agent's caller",
      "   [ ] docs  Writes docs",
      "   [ ] search",
    ]);
    expect(setupChanges(ctx, press(ctx, back.state, key("enter")).state)).toEqual([]);
    expect(setupChanges(ctx, press(ctx, opened.state, key("space"), key("enter")).state)).toEqual([
      { name: "lead", patch: { skills: [] } },
    ]);
  });

  it("opens a list grant with the all row unticked and confirms the ticked skills", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("tab"), ...toSkills);

    expect(skillRows(render(ctx, opened.state))).toEqual([
      " › [ ] all  every skill of the agent's caller",
      "   [x] docs  Writes docs",
      "   [ ] search",
    ]);
    expect(setupChanges(ctx, press(ctx, opened.state, key("space"), key("enter")).state)).toEqual([
      { name: "helper", patch: { skills: "all" } },
    ]);
  });

  it("never changes a chore's skills: the cursor skips the fixed Skills row and offers only Previous", () => {
    const ctx = context();
    const thinking = press(ctx, initialSetup(ctx), key("tab"), key("tab"), key("down"));
    const chore = press(ctx, thinking.state, key("down"), key("down"));

    expect(pickerTitle(render(ctx, press(ctx, thinking.state, key("enter")).state))).toBe(
      " Thinking level  / type to filter",
    );
    expect(render(ctx, chore.state)).toContain("   Skills    none · fixed for chores");
    expect(render(ctx, chore.state)).toContain(" › Previous  gone/old · default (in use)");
    expect(render(ctx, chore.state).some((line) => line.includes("Suggested"))).toBe(false);
    expect(pickerTitle(render(ctx, press(ctx, chore.state, key("enter")).state))).toBeUndefined();
    expect(setupChanges(ctx, chore.state)).toEqual([]);
  });

  it("switches tabs with Tab and ←, wrapping to the submit tab, and cancels with Escape", () => {
    const ctx = context();
    const back = press(ctx, initialSetup(ctx), key("left"));

    expect(render(ctx, back.state)).toContain(" Save to:");
    expect(render(ctx, press(ctx, back.state, key("right")).state)).toContain(" › Model     acme/big");
    expect(press(ctx, back.state, key("escape")).done).toBe("cancel");
  });

  it("shows the changes and both files on the submit tab and saves with Enter", () => {
    const ctx = context();
    const { state } = press(
      ctx,
      initialSetup(ctx),
      key("tab"),
      key("tab"),
      key("down"),
      key("enter"),
      key("end"),
    );
    const changed = press(ctx, state, key("enter"), key("tab"));
    const lines = render(ctx, changed.state);

    expect(lines).toContain(" chore: thinking max (was default)");
    expect(lines).toContain(` › 1. This project  ${PATHS.project}`);
    expect(lines).toContain(`   2. User  ${PATHS.user}`);
    expect(press(ctx, changed.state, key("enter")).done).toBe("save");
  });

  it("lists one Submit row per changed field and marks the values that match the proposal", () => {
    const ctx = proposedContext();
    const { state } = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const lines = render(ctx, press(ctx, state, key("left")).state);

    expect(lines).toContain(" lead: thinking off (was high)");
    expect(lines).toContain(" lead: skills search, docs (suggested) (was all)");
  });

  it("offers only the user file in an untrusted project and saves to it with Enter", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const submit = press(ctx, edited.state, key("left"), key("up"), key("down"));
    const lines = render(ctx, submit.state);

    expect(lines).toContain(` › 1. User  ${PATHS.user}`);
    expect(lines.some((line) => line.includes("This project  "))).toBe(false);
    expect(press(ctx, submit.state, key("enter")).done).toBe("save");
  });
});
