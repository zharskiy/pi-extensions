import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../platform/pi-adapter/index.ts";
import { char, key, plainTheme } from "../../../test/framework/index.ts";
import { answerText, type FormOutcome, type FormState, initialForm, pressKey } from "../ui/form.ts";
import { renderForm } from "../ui/render.ts";
import { PRIORITY, questions, SCOPE } from "./support/questions.ts";

const NOTES = {
  id: "notes",
  label: "Notes",
  prompt: "Anything else?",
  options: [{ value: "none", label: "None" }],
};

const press = (state: FormState, ...keys: KeyPress[]) =>
  keys.reduce<FormOutcome>((outcome, next) => pressKey(outcome.state, next), { state });

const lines = (state: FormState) => renderForm(state, plainTheme, 80, ["[input]"]);

const pointer = (state: FormState) => lines(state).find((line) => line.startsWith(" ›"));

const tabBar = (state: FormState) => lines(state)[1];

describe("single question", () => {
  it("submits at once on Enter, with the option number", () => {
    const outcome = press(initialForm(questions(SCOPE)), key("down"), key("enter"));

    expect(outcome.done).toBe("submit");
    expect(outcome.state.answers).toEqual([
      { id: "scope", value: "backend", label: "Backend only", wasCustom: false, index: 2 },
    ]);
  });

  it("has no tabs: Tab and arrows left and right leave the screen as it was", () => {
    const state = initialForm(questions(SCOPE));
    const outcome = press(state, key("tab"), key("right"), key("backTab"));

    expect(lines(outcome.state)).toEqual(lines(state));
    expect(lines(state)).not.toContain(expect.stringContaining("Submit"));
  });

  it("picks an option with a digit, unless answers are not armed yet", () => {
    const state = initialForm(questions(SCOPE));

    expect(pressKey(state, char("2"), { armed: false }).done).toBeUndefined();
    expect(pressKey(state, char("2"), { armed: false }).state.answers).toEqual([]);
    expect(pressKey(state, char("2")).state.answers[0]?.value).toBe("backend");
    expect(pressKey(state, char("9")).done).toBeUndefined();
    expect(pressKey(state, char("9")).state.answers).toEqual([]);
  });

  it("ignores Enter until answers are armed, but still moves the selection", () => {
    const moved = pressKey(initialForm(questions(SCOPE)), key("down"), { armed: false }).state;

    expect(pointer(moved)).toBe(" › 2. Backend only");

    const early = pressKey(moved, key("enter"), { armed: false });

    expect([early.done, early.state.answers]).toEqual([undefined, []]);
    expect(pressKey(moved, key("enter")).state.answers[0]?.value).toBe("backend");
  });

  it("clamps the selection and jumps with Home and End", () => {
    const state = initialForm(questions(SCOPE));

    expect(pointer(press(state, key("up")).state)).toBe(" › 1. Frontend only");
    expect(pointer(press(state, key("down"), key("down"), key("down")).state)).toBe(" › 3. Type something.");
    expect(pointer(press(state, key("end")).state)).toBe(" › 3. Type something.");
    expect(pointer(press(state, key("end"), key("home")).state)).toBe(" › 1. Frontend only");
  });

  it("cancels on Esc", () => {
    expect(pressKey(initialForm(questions(SCOPE)), key("escape")).done).toBe("cancel");
  });
});

describe("typed answers", () => {
  it("offers Type something. only when allowOther is on", () => {
    expect(lines(initialForm(questions(SCOPE)))).toContain("   3. Type something.");
    expect(lines(initialForm(questions(PRIORITY)))).not.toContain(expect.stringContaining("Type something."));
  });

  it("opens the text input, saves trimmed text on submit and refuses an empty answer", () => {
    const typing = pressKey(initialForm(questions(SCOPE)), char("3")).state;

    expect(lines(typing)).toContain(" Your answer:");
    expect(answerText(typing, "   ").done).toBeUndefined();
    expect(answerText(typing, "   ").state.answers).toEqual([]);

    const outcome = answerText(typing, "  both, carefully ");

    expect(outcome.done).toBe("submit");
    expect(outcome.state.answers).toEqual([
      { id: "scope", value: "both, carefully", label: "both, carefully", wasCustom: true },
    ]);
  });

  it("returns to the options on Esc without an answer, and keys other than Esc do nothing while typing", () => {
    const typing = press(initialForm(questions(SCOPE)), key("end"), key("enter")).state;

    expect(pressKey(typing, char("1")).state.answers).toEqual([]);
    expect(lines(pressKey(typing, char("1")).state)).toContain(" Your answer:");

    const back = pressKey(typing, key("escape"));

    expect(back.done).toBeUndefined();
    expect(lines(back.state)).not.toContain(" Your answer:");
    expect(pointer(back.state)).toBe(" › 3. Type something.");
    expect(answerText(back.state, "late").state.answers).toEqual([]);
  });
});

describe("several questions", () => {
  const form = () => initialForm(questions(SCOPE, PRIORITY, NOTES));

  it("moves between tabs with Tab, Shift+Tab and the arrows, wrapping through the Submit tab", () => {
    const state = form();

    expect(lines(press(state, key("tab")).state)).toContain(" How urgent is it?");
    expect(lines(press(state, key("right"), key("right"), key("right")).state)).toContain(" Answers");
    expect(lines(press(state, key("backTab")).state)).toContain(" Answers");
    expect(lines(press(state, key("left"), key("left")).state)).toContain(" Anything else?");
    expect(lines(press(state, key("tab"), key("tab"), key("tab"), key("tab")).state)).toContain(
      " Which part should change?",
    );
  });

  it("advances to the next unanswered question after an answer, then to the Submit tab", () => {
    const first = press(form(), key("tab"), key("enter")).state;

    expect(lines(first)).toContain(" Anything else?");

    const second = press(first, key("enter")).state;

    expect(lines(second)).toContain(" Which part should change?");

    const third = press(second, char("2")).state;

    expect(lines(third)).toContain(" Ready to submit");
    expect(tabBar(third)).toBe(" ← ■ Scope  ■ Priority  ■ Notes  ✓ Submit →");
    expect(third.answers.map((answer) => answer.id)).toEqual(["scope", "priority", "notes"]);
  });

  it("selects the saved answer when coming back to a question", () => {
    const answered = press(form(), char("2")).state;

    expect(pointer(press(answered, key("left")).state)).toBe(" › 2. Backend only");

    const typed = answerText(press(form(), char("3")).state, "mine").state;

    expect(pointer(press(typed, key("left")).state)).toBe(" › 3. Type something.");
  });

  it("submits from the Submit tab only when every question is answered", () => {
    const partial = press(form(), char("1"), key("tab"), key("tab")).state;

    expect(lines(partial)).toContain(" Unanswered: Priority, Notes");
    expect(pressKey(partial, key("enter")).done).toBeUndefined();
    expect(pressKey(partial, char("1")).state.answers).toEqual(partial.answers);

    const complete = press(form(), char("1"), char("1"), char("1"));

    expect(complete.done).toBeUndefined();
    expect(pressKey(complete.state, key("enter"), { armed: false }).done).toBeUndefined();
    expect(pressKey(complete.state, key("enter")).done).toBe("submit");
    expect(pressKey(complete.state, key("escape")).done).toBe("cancel");
  });

  it("changes an answer without duplicating it", () => {
    const changed = press(form(), char("1"), key("backTab"), char("2")).state;

    expect(changed.answers).toEqual([
      { id: "scope", value: "backend", label: "Backend only", wasCustom: false, index: 2 },
    ]);
  });
});
