import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { type QuestionnaireDetails, resultText } from "../src/result.ts";
import { callText, resultSummary } from "../src/summary.ts";
import { PRIORITY, questions, SCOPE } from "./fixtures.ts";

const answered = (cancelled: boolean): QuestionnaireDetails => ({
  questions: questions(SCOPE, PRIORITY),
  answers: [
    { id: "scope", value: "backend", label: "Backend only", wasCustom: false, index: 2 },
    ...(cancelled ? [] : [{ id: "priority", value: "next sprint", label: "next sprint", wasCustom: true }]),
  ],
  cancelled,
});

describe("rendering", () => {
  it("renders the call with the count and the labels", () => {
    expect(callText({ questions: [SCOPE, { ...PRIORITY, label: undefined }] }, plainTheme)).toBe(
      "questionnaire 2 questions (Scope, Q2)",
    );
    expect(callText({ questions: [SCOPE] }, plainTheme)).toBe("questionnaire 1 question (Scope)");
    expect(callText({}, plainTheme)).toBe("questionnaire 0 questions");
    expect(callText({ questions: "nope" as never }, plainTheme)).toBe("questionnaire 0 questions");
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
