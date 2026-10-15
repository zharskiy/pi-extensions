import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import {
  callText,
  normalizeQuestions,
  type QuestionnaireDetails,
  questionsError,
  resultSummary,
  resultText,
} from "../src/result.ts";
import { PRIORITY, questions, SCOPE } from "./fixtures.ts";

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

describe("rendering", () => {
  it("renders the call with the count and the labels", () => {
    expect(callText({ questions: [SCOPE, { ...PRIORITY, label: undefined }] }, plainTheme)).toBe(
      "questionnaire 2 questions (Scope, Q2)",
    );
    expect(callText({ questions: [SCOPE] }, plainTheme)).toBe("questionnaire 1 question (Scope)");
    expect(callText({}, plainTheme)).toBe("questionnaire 0 questions");
  });

  it("renders answers with a check mark and a cancel in warning colour", () => {
    const details = answered(false);
    const theme = { ...plainTheme, fg: (token: string, text: string) => `<${token}>${text}` };

    expect(resultSummary({ text: resultText(details), details }, plainTheme)).toBe(
      ["✓ Scope: 2. Backend only", "✓ Priority: (wrote) next sprint"].join("\n"),
    );
    expect(resultSummary({ text: "", details: answered(true) }, theme)).toBe(
      ["<warning>Cancelled", "<success>✓ <accent>Scope: 2. Backend only"].join("\n"),
    );
    expect(resultSummary({ text: "Error: No questions provided", isError: true }, theme)).toBe(
      "<error>Error: No questions provided",
    );
  });
});
