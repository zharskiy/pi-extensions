import { describe, expect, it } from "vitest";
import { char, key } from "../../../../../test-framework/index.ts";
import {
  initialSetup,
  modelOptions,
  setupChanges,
  thinkingOptions,
  UNTRUSTED,
} from "../../../src/plugins/agent-setup/form.ts";
import { context, PATHS, press, render } from "../../support/setup-context.ts";

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

  it("opens all with no box ticked and keeps all unless a box is changed, even to none", () => {
    const ctx = context();
    const toSkills = [key("down"), key("down"), key("enter")];
    const kept = press(ctx, initialSetup(ctx), ...toSkills);

    expect(render(ctx, kept.state).filter((line) => line.includes("[ ]"))).toHaveLength(2);
    expect(setupChanges(ctx, press(ctx, kept.state, key("down"), key("enter")).state)).toEqual([]);
    expect(setupChanges(ctx, press(ctx, kept.state, char("a"), key("enter")).state)).toEqual([
      { name: "lead", patch: { skills: ["docs", "search"] } },
    ]);
    expect(setupChanges(ctx, press(ctx, kept.state, char("n"), key("enter")).state)).toEqual([
      { name: "lead", patch: { skills: [] } },
    ]);
  });

  it("stores every checked skill by name and leaves a field unchanged when its picker is left with Escape", () => {
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

    expect(setupChanges(ctx, state)).toEqual([{ name: "chore", patch: { skills: ["docs", "search"] } }]);
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
    expect(render(ctx, submit.state)).toContain(` › 1. This project  ${PATHS.project} (project not trusted)`);
    expect(press(ctx, submit.state, key("down"), key("enter")).done).toBe("save");
  });
});
