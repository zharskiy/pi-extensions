import { describe, expect, it } from "vitest";
import type { ThemeLike, ToolRender, ToolRenderState } from "../../../core/adapter/contract.ts";
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

const state = (patch: Partial<ToolRenderState> = {}): ToolRenderState => ({
  toolCallId: "call-1",
  expanded: false,
  isPartial: false,
  isError: false,
  args: {},
  invalidate: () => {},
  ...patch,
});

const drawn = (render: ToolRender, width = 80) => (typeof render === "function" ? render(width) : render);

const tagged: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

describe("rendering", () => {
  it("renders the call as a row with the count and the dim labels", () => {
    expect(
      drawn(callText({ questions: [SCOPE, { ...PRIORITY, label: undefined }] }, plainTheme, state())),
    ).toBe("● Questionnaire 2 questions (Scope, Q2)");
    expect(drawn(callText({ questions: [SCOPE] }, plainTheme, state()))).toBe(
      "● Questionnaire 1 question (Scope)",
    );
    expect(drawn(callText({}, plainTheme, state()))).toBe("● Questionnaire 0 questions");
    expect(drawn(callText({ questions: "nope" as never }, plainTheme, state()))).toBe(
      "● Questionnaire 0 questions",
    );
    expect(drawn(callText({ questions: [SCOPE] }, tagged, state()))).toContain("<dim> (Scope)");
  });

  it("paints the bullet by the call's state", () => {
    expect(drawn(callText({}, tagged, state({ isPartial: true })))).toMatch(/^<dim>●/);
    expect(drawn(callText({}, tagged, state()))).toMatch(/^<success>●/);
    expect(drawn(callText({}, tagged, state({ isError: true })))).toMatch(/^<error>●/);
  });

  it("renders one child line per answer with a check mark and a cancel in warning colour", () => {
    const details = answered(false);

    expect(drawn(resultSummary({ text: resultText(details), details }, plainTheme))).toBe(
      ["  ⎿  ✓ Scope: 2. Backend only", "     ✓ Priority: (wrote) next sprint"].join("\n"),
    );
    expect(drawn(resultSummary({ text: "", details: answered(true) }, tagged))).toBe(
      ["  <dim>⎿  <warning>Cancelled", "     <success>✓ <accent>Scope: 2. Backend only"].join("\n"),
    );
    expect(drawn(resultSummary({ text: "Error: No questions provided", isError: true }, tagged))).toBe(
      "  <dim>⎿  <error>Error: No questions provided",
    );
  });
});
