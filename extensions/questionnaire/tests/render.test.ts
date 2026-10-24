import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { char, key, plainTheme, tokenTaggingTheme } from "../../../test-framework/index.ts";
import { answerText, initialForm, pressKey } from "../src/form.ts";
import { renderForm } from "../src/render.ts";
import { PRIORITY, questions, SCOPE } from "./support/questions.ts";

const tagged: ThemeLike = tokenTaggingTheme();

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
      " ↑↓ to select · 1-9 to pick · enter to submit",
      " esc to cancel",
      rule(60),
    ]);
  });

  it("draws the tab bar for several questions, marking answered tabs and the active one", () => {
    const state = pressKey(initialForm(questions(SCOPE, PRIORITY)), char("2")).state;
    const lines = renderForm(state, plainTheme, 80);

    expect(lines.slice(0, 3)).toEqual([rule(80), " ← ■ Scope  □ Priority  ✓ Submit →", ""]);
    expect(lines.slice(-3, -1)).toEqual([
      " ↑↓ to select · 1-9 to pick · tab/←→ to switch · enter to confirm",
      " esc to cancel",
    ]);

    const bar = renderForm(state, tagged, 120)[1];

    expect(bar).toContain("<success>■</>");
    expect(bar).toContain("<accent>□ Priority");
    expect(bar).toContain("<dim>✓ Submit");

    const pointer = renderForm(state, tagged, 120).find((line) => line.includes("1. Now"));

    expect(pointer).toContain("<accent>1. Now");
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
      " tab/←→ to switch · esc to cancel",
      rule(60),
    ]);
    expect(renderForm(submit, tagged, 60).find((line) => line.includes("Unanswered"))).toContain("<warning>");

    const complete = pressKey(pressKey(submit, key("backTab")).state, char("1")).state;

    expect(renderForm(complete, plainTheme, 60).slice(3, 10)).toEqual([
      " Ready to submit",
      "",
      " Scope: (wrote) both",
      " Priority: Now",
      "",
      " Press enter to submit",
      "",
    ]);
    expect(renderForm(complete, plainTheme, 60).at(-2)).toBe(
      " tab/←→ to switch · enter to submit · esc to cancel",
    );
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
      " enter to save · esc to go back to options",
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
