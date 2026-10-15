import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { answerText, initialForm, pressKey } from "../src/form.ts";
import { renderForm } from "../src/render.ts";
import { char, key, PRIORITY, questions, SCOPE } from "./fixtures.ts";

const tagged: ThemeLike = {
  ...plainTheme,
  fg: (token, text) => `<${token}>${text}</>`,
  bold: (text) => `*${text}*`,
};

const rule = (width: number) => "─".repeat(width);

describe("renderForm", () => {
  it("draws a single question without a tab bar, with the pointer on the selection", () => {
    expect(renderForm(initialForm(questions(SCOPE)), plainTheme, 60)).toEqual([
      rule(60),
      " Which part should change?",
      "",
      " › 1. Frontend only",
      "   2. Backend only",
      "      Keep the UI as it is",
      "   3. Type something.",
      "",
      " ↑↓ select · 1-9 pick · Enter submit · Esc cancel",
      rule(60),
    ]);
  });

  it("draws the tab bar for several questions, marking answered tabs and the active one", () => {
    const state = pressKey(initialForm(questions(SCOPE, PRIORITY)), char("2")).state;
    const lines = renderForm(state, plainTheme, 80);

    expect(lines.slice(0, 3)).toEqual([rule(80), " ← ■ Scope  □ Priority  ✓ Submit →", ""]);
    expect(lines.at(-2)).toBe(" ↑↓ select · 1-9 pick · Tab/←→ switch · Enter confirm · Esc cancel");

    const bar = renderForm(state, tagged, 120)[1];

    expect(bar).toContain("<success>■</> <text>Scope</>");
    expect(bar).toContain("<accent>*□ Priority*</>");
    expect(bar).toContain("<dim>✓ Submit</>");
    expect(renderForm(state, tagged, 120)).toContain(" <accent>*›*</> <accent>1. Now</>");
  });

  it("lists the answers on the Submit tab and warns about unanswered questions", () => {
    const partial = pressKey(
      pressKey(initialForm(questions(SCOPE, PRIORITY)), char("3")).state,
      char("x"),
    ).state;
    const typed = answerText(partial, "both").state;
    const submit = pressKey(typed, key("tab")).state;

    expect(renderForm(submit, plainTheme, 60)).toEqual([
      rule(60),
      " ← ■ Scope  □ Priority  ✓ Submit →",
      "",
      " Answers",
      "",
      " Scope: (wrote) both",
      "",
      " Unanswered: Priority",
      "",
      " Tab/←→ switch · Esc cancel",
      rule(60),
    ]);
    expect(renderForm(submit, tagged, 60)).toContain(" <warning>Unanswered: Priority</>");

    const complete = pressKey(pressKey(submit, key("backTab")).state, char("1")).state;

    expect(renderForm(complete, plainTheme, 60).slice(3, 10)).toEqual([
      " Ready to submit",
      "",
      " Scope: (wrote) both",
      " Priority: Now",
      "",
      " Press Enter to submit",
      "",
    ]);
    expect(renderForm(complete, plainTheme, 60).at(-2)).toBe(" Tab/←→ switch · Enter submit · Esc cancel");
  });

  it("shows the text input below the options while typing", () => {
    const typing = pressKey(initialForm(questions(SCOPE)), char("3")).state;

    expect(renderForm(typing, plainTheme, 60, ["[input]"])).toEqual([
      rule(60),
      " Which part should change?",
      "",
      "   1. Frontend only",
      "   2. Backend only",
      "      Keep the UI as it is",
      " › 3. Type something. ✎",
      "",
      " Your answer:",
      " [input]",
      "",
      " Enter save · Esc back to options",
      rule(60),
    ]);
  });

  it("wraps long prompts and descriptions under their indent", () => {
    const long = questions({
      id: "long",
      prompt: "Which of these rather long alternatives do you prefer?",
      options: [{ value: "a", label: "Alpha", description: "The first letter of the Greek alphabet" }],
      allowOther: false,
    });

    expect(renderForm(initialForm(long), plainTheme, 24).slice(1, 8)).toEqual([
      " Which of these rather",
      " long alternatives do",
      " you prefer?",
      "",
      " › 1. Alpha",
      "      The first letter",
      "      of the Greek",
    ]);
  });
});
