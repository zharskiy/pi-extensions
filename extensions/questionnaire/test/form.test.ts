import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../core/adapter/contract.ts";
import {
  allAnswered,
  answerText,
  type FormOutcome,
  type FormState,
  formOptions,
  initialForm,
  onSubmitTab,
  pressKey,
  stopTyping,
} from "../src/form.ts";
import { char, key, PRIORITY, questions, SCOPE } from "./fixtures.ts";

const NOTES = {
  id: "notes",
  label: "Notes",
  prompt: "Anything else?",
  options: [{ value: "none", label: "None" }],
};

const press = (state: FormState, ...keys: KeyPress[]) =>
  keys.reduce<FormOutcome>((outcome, next) => pressKey(outcome.state, next), { state });

describe("single question", () => {
  it("submits at once on Enter, with the option number", () => {
    const outcome = press(initialForm(questions(SCOPE)), key("down"), key("enter"));

    expect(outcome.done).toBe("submit");
    expect(outcome.state.answers).toEqual([
      { id: "scope", value: "backend", label: "Backend only", wasCustom: false, index: 2 },
    ]);
  });

  it("has no tabs: Tab and arrows left and right do nothing", () => {
    const outcome = press(initialForm(questions(SCOPE)), key("tab"), key("right"), key("backTab"));

    expect(outcome.state.tab).toBe(0);
    expect(onSubmitTab(outcome.state)).toBe(false);
  });

  it("picks an option with a digit, unless digits are not armed yet", () => {
    const state = initialForm(questions(SCOPE));

    expect(pressKey(state, char("2"), false)).toEqual({ state });
    expect(pressKey(state, char("2")).state.answers[0]?.value).toBe("backend");
    expect(pressKey(state, char("9"))).toEqual({ state });
  });

  it("clamps the selection and jumps with Home and End", () => {
    const state = initialForm(questions(SCOPE));

    expect(press(state, key("up")).state.option).toBe(0);
    expect(press(state, key("down"), key("down"), key("down")).state.option).toBe(2);
    expect(press(state, key("end")).state.option).toBe(2);
    expect(press(state, key("end"), key("home")).state.option).toBe(0);
  });

  it("cancels on Esc", () => {
    expect(pressKey(initialForm(questions(SCOPE)), key("escape")).done).toBe("cancel");
  });
});

describe("typed answers", () => {
  it("offers Type something. only when allowOther is on", () => {
    expect(formOptions(questions(SCOPE)[0]).at(-1)).toMatchObject({ label: "Type something.", other: true });
    expect(formOptions(questions(PRIORITY)[0]).map((option) => option.label)).toEqual(["Now", "Later"]);
  });

  it("opens the text input, saves trimmed text on submit and refuses an empty answer", () => {
    const typing = pressKey(initialForm(questions(SCOPE)), char("3")).state;

    expect(typing.typing).toBe(true);
    expect(answerText(typing, "   ")).toEqual({ state: typing });

    const outcome = answerText(typing, "  both, carefully ");

    expect(outcome.done).toBe("submit");
    expect(outcome.state.answers).toEqual([
      { id: "scope", value: "both, carefully", label: "both, carefully", wasCustom: true },
    ]);
  });

  it("returns to the options without an answer", () => {
    const typing = press(initialForm(questions(SCOPE)), key("end"), key("enter")).state;
    const back = stopTyping(typing);

    expect([back.typing, back.option, back.answers]).toEqual([false, 2, []]);
    expect(answerText(back, "late")).toEqual({ state: back });
  });
});

describe("several questions", () => {
  const form = () => initialForm(questions(SCOPE, PRIORITY, NOTES));

  it("moves between tabs with Tab, Shift+Tab and the arrows, wrapping through the Submit tab", () => {
    const state = form();

    expect(press(state, key("tab")).state.tab).toBe(1);
    expect(press(state, key("right"), key("right"), key("right")).state.tab).toBe(3);
    expect(onSubmitTab(press(state, key("backTab")).state)).toBe(true);
    expect(press(state, key("left"), key("left")).state.tab).toBe(2);
    expect(press(state, key("tab"), key("tab"), key("tab"), key("tab")).state.tab).toBe(0);
  });

  it("advances to the next unanswered question after an answer, then to the Submit tab", () => {
    const first = press(form(), key("tab"), key("enter")).state;

    expect(first.tab).toBe(2);

    const second = press(first, key("enter")).state;

    expect(second.tab).toBe(0);

    const third = press(second, char("2")).state;

    expect(onSubmitTab(third)).toBe(true);
    expect(allAnswered(third)).toBe(true);
    expect(third.answers.map((answer) => answer.id)).toEqual(["scope", "priority", "notes"]);
  });

  it("selects the saved answer when coming back to a question", () => {
    const answered = press(form(), char("2")).state;

    expect(press(answered, key("left")).state.option).toBe(1);

    const typed = answerText(press(form(), char("3")).state, "mine").state;

    expect(press(typed, key("left")).state.option).toBe(2);
  });

  it("submits from the Submit tab only when every question is answered", () => {
    const partial = press(form(), char("1"), key("tab"), key("tab")).state;

    expect(onSubmitTab(partial)).toBe(true);
    expect(pressKey(partial, key("enter"))).toEqual({ state: partial });
    expect(pressKey(partial, char("1"))).toEqual({ state: partial });

    const complete = press(form(), char("1"), char("1"), char("1"));

    expect(complete.done).toBeUndefined();
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
