import { describe, expect, it } from "vitest";
import {
  normalizeQuestions,
  type QuestionnaireDetails,
  questionsError,
  resultText,
} from "../core/questions.ts";
import { PRIORITY, questions, SCOPE } from "./support/questions.ts";

const answered = (cancelled: boolean): QuestionnaireDetails => ({
  questions: questions(SCOPE, PRIORITY),
  answers: [
    { id: "scope", value: "backend", label: "Backend only", wasCustom: false, index: 2 },
    ...(cancelled ? [] : [{ id: "priority", value: "next sprint", label: "next sprint", wasCustom: true }]),
  ],
  cancelled,
});

describe("normalizeQuestions", () => {
  it("defaults labels to Q1, Q2 and allowOther to true", () => {
    const [first, second] = normalizeQuestions([
      { ...SCOPE, label: undefined },
      { ...PRIORITY, label: "  " },
    ]);

    expect([first?.label, second?.label]).toEqual(["Q1", "Q2"]);
    expect([first?.allowOther, second?.allowOther]).toEqual([true, false]);
  });
});

describe("questionsError", () => {
  it("rejects an empty batch, duplicate ids and unanswerable questions", () => {
    expect(questionsError([])).toBe("Error: No questions provided");
    expect(questionsError(questions(SCOPE, SCOPE))).toContain('duplicate question id "scope"');
    expect(questionsError(questions({ ...PRIORITY, options: [] }))).toContain(
      'question "priority" has no options',
    );
    expect(questionsError(questions({ ...SCOPE, options: [] }))).toBeUndefined();
    expect(questionsError(questions(SCOPE, PRIORITY))).toBeUndefined();
  });
});

describe("resultText", () => {
  it("writes one line per question with the id, the option number, label and value, or the typed text", () => {
    expect(resultText(answered(false))).toBe(
      [
        "Scope (scope): selected 2. Backend only [value: backend]",
        "Priority (priority): wrote: next sprint",
      ].join("\n"),
    );
  });

  it("reports a cancel with the answers given so far and a fallback instruction", () => {
    expect(resultText(answered(true))).toBe(
      [
        "User cancelled the questionnaire",
        "Answered before cancelling:",
        "Scope (scope): selected 2. Backend only [value: backend]",
        "Pick a sensible default for anything unanswered, or stop.",
      ].join("\n"),
    );
    expect(resultText({ ...answered(true), answers: [] })).toBe(
      ["User cancelled the questionnaire", "Pick a sensible default for anything unanswered, or stop."].join(
        "\n",
      ),
    );
  });
});
