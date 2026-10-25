import { describe, expect, it } from "vitest";
import { char, key } from "../../../../../test/framework/index.ts";
import {
  initialSetup,
  modelOptions,
  scopeOptions,
  setupChanges,
  thinkingOptions,
} from "../../../ui/agent-setup/form.ts";
import { context, PATHS, press, proposedContext, render } from "../../support/setup-context.ts";

const toSkills = [key("down"), key("down"), key("enter")];

const skillRows = (lines: string[]) => lines.filter((line) => line.includes("[x]") || line.includes("[ ]"));

const typed = (text: string) => [...text].map((letter) => char(letter));

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

    expect(state.drafts[0]?.skills).toEqual(["search", "docs"]);
    expect(setupChanges(ctx, state)).toEqual([{ name: "lead", patch: { skills: ["search", "docs"] } }]);
    expect(render(ctx, state).slice(1, 3)).toEqual([
      " Leads   ■ lead  □ helper",
      " Chores  □ chore  ✓ Submit",
    ]);
    expect(render(ctx, state)).toContain("   Skills    search, docs (changed)");
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
    expect(press(ctx, toggled.state, key("enter")).state.drafts[0]?.skills).toEqual(["docs", "lint"]);
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

    expect(cleared.state.picker?.query).toBe("");
    expect(skillRows(render(ctx, cleared.state))).toHaveLength(4);
    expect(press(ctx, cleared.state, key("escape")).state.picker).toBeUndefined();
  });

  it("types a and n into the filter instead of checking all or none", () => {
    const ctx = context();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, char("n"), key("escape"), char("a"));

    expect(state.picker?.query).toBe("a");
    expect(press(ctx, state, key("escape"), key("enter")).state.drafts[0]?.skills).toBe("all");
  });

  it("keeps hidden checked skills and confirms in the order shown without a filter", () => {
    const ctx = proposedContext();
    const { state } = press(ctx, initialSetup(ctx), ...toSkills, ...typed("li"), key("space"), key("enter"));

    expect(state.drafts[0]?.skills).toEqual(["search", "docs", "lint"]);
  });

  it("filters the models and picks only a visible one", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("enter"), ...typed("small"));

    expect(press(ctx, opened.state, key("enter")).state.drafts[0]?.model).toBe("acme/small");

    const missing = press(ctx, opened.state, ...typed("zzq"), key("enter"));

    expect(missing.state.picker?.query).toBe("smallzzq");
    expect(missing.state.drafts[0]?.model).toBe("acme/big");
  });

  it("lists inherit, an initial model without credentials, then the models with credentials", () => {
    expect(modelOptions(context(), 0)).toEqual(["inherit", "acme/big", "acme/small"]);
    expect(modelOptions(context(), 2)).toEqual(["inherit", "gone/old", "acme/big", "acme/small"]);
  });

  it("offers the thinking levels of the chosen model, and every level for an unknown model", () => {
    expect(thinkingOptions(context(), { model: "acme/small", skills: [] })).toEqual(["off"]);
    expect(thinkingOptions(context(), { model: "inherit", skills: [] })).toContain("medium");
  });

  it("drops a thinking level the newly chosen model does not accept and keeps one it does", () => {
    const ctx = context();
    const small = press(ctx, initialSetup(ctx), key("enter"), key("end"), key("enter"));

    expect(small.state.drafts[0]).toEqual({ model: "acme/small", thinking: undefined, skills: "all" });
    expect(setupChanges(ctx, small.state)).toEqual([
      { name: "lead", patch: { model: "acme/small", thinking: undefined } },
    ]);

    const inherit = press(ctx, initialSetup(ctx), key("enter"), key("home"), key("enter"));

    expect(inherit.state.drafts[0]).toEqual({ model: "inherit", thinking: "high", skills: "all" });
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
    expect(press(ctx, opened.state, key("space"), key("enter")).state.drafts[1]?.skills).toBe("all");
  });

  it("never changes a chore's skills: the cursor skips the fixed Skills row", () => {
    const ctx = context();
    const chore = press(ctx, initialSetup(ctx), key("tab"), key("tab"), key("down"), key("down"));

    expect(chore.state.field).toBe(1);
    expect(render(ctx, chore.state)).toContain("   Skills    none · fixed for chores");
    expect(press(ctx, chore.state, key("enter")).state.picker?.field).toBe("thinking");

    const drafts = chore.state.drafts.map((draft, index) =>
      index === 2 ? { ...draft, skills: ["docs"] } : draft,
    );

    expect(setupChanges(ctx, { ...chore.state, drafts })).toEqual([]);
  });

  it("switches tabs with Tab and ←, wrapping to the submit tab, and cancels with Escape", () => {
    const ctx = context();
    const back = press(ctx, initialSetup(ctx), key("left"));

    expect(back.state.tab).toBe(3);
    expect(press(ctx, back.state, key("right")).state.tab).toBe(0);
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

    expect(lines).toContain(" chore: thinking max");
    expect(lines).toContain(` › 1. This project  ${PATHS.project}`);
    expect(lines).toContain(`   2. User  ${PATHS.user}`);
    expect(press(ctx, changed.state, key("enter")).done).toBe("save");
  });

  it("offers only the user file in an untrusted project and saves to it with Enter", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const submit = press(ctx, edited.state, key("left"), key("up"), key("down"));
    const lines = render(ctx, submit.state);

    expect(submit.state.scope).toBe(0);
    expect(scopeOptions(ctx)[submit.state.scope]).toBe("user");
    expect(lines).toContain(` › 1. User  ${PATHS.user}`);
    expect(lines.some((line) => line.includes("This project  "))).toBe(false);
    expect(press(ctx, submit.state, key("enter")).done).toBe("save");
  });
});
