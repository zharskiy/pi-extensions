import { describe, expect, it } from "vitest";
import type { ThemeLike, ToolRender, ToolRenderState } from "../../../core/adapter/contract.ts";
import { plainTheme, taggedTheme } from "../../../core/test/helpers/fakes.ts";
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
  aborted: false,
  expanded: false,
  isPartial: false,
  isError: false,
  args: {},
  invalidate: () => {},
  ...patch,
});

const drawn = (render: ToolRender, width = 80) => (typeof render === "function" ? render(width) : render);

const tagged: ThemeLike = taggedTheme(() => "");

describe("rendering", () => {
  it("renders the call as a row with the question count", () => {
    expect(
      drawn(callText({ questions: [SCOPE, { ...PRIORITY, label: undefined }] }, plainTheme, state())),
    ).toBe("✓ questionnaire · 2 questions");
    expect(drawn(callText({ questions: [SCOPE] }, plainTheme, state()))).toBe("✓ questionnaire · 1 question");
    expect(drawn(callText({}, plainTheme, state()))).toBe("✓ questionnaire · 0 questions");
    expect(drawn(callText({ questions: "nope" as never }, plainTheme, state()))).toBe(
      "✓ questionnaire · 0 questions",
    );
    expect(drawn(callText({ questions: [SCOPE] }, tagged, state()))).toBe(
      "<success>✓ questionnaire<muted> · 1 question",
    );
  });

  it("marks the call by its state", () => {
    expect(drawn(callText({}, tagged, state({ isPartial: true })))).toMatch(/^<dim>◌ /);
    expect(drawn(callText({}, tagged, state({ isError: true })))).toMatch(/^<error>✗ /);
    expect(drawn(callText({}, plainTheme, state({ isError: true, aborted: true })))).toBe(
      "⊘ questionnaire · cancelled",
    );
  });

  it("marks a cancelled questionnaire as stopped", () => {
    const details = answered(true);
    const cancelled = state({ result: { text: resultText(details), details } });

    expect(drawn(callText({ questions: [SCOPE, PRIORITY] }, plainTheme, cancelled))).toBe(
      "⊘ questionnaire · cancelled",
    );
    expect(drawn(callText({}, tagged, cancelled))).toBe("<muted>⊘ questionnaire<muted> · cancelled");
  });

  it("lists the answers on a ↳ line without a check mark, typed answers marked (wrote)", () => {
    const details = answered(false);

    expect(drawn(resultSummary({ text: resultText(details), details }, plainTheme))).toBe(
      ["  ↳ Scope: 2. Backend only", "    Priority: next sprint (wrote)"].join("\n"),
    );
    expect(drawn(resultSummary({ text: resultText(details), details }, tagged))).toBe(
      [
        "  <dim>↳ <accent>Scope: <text>2. Backend only",
        "    <accent>Priority: <text>next sprint <dim>(wrote)",
      ].join("\n"),
    );
  });

  it("keeps the answers given before a cancel and nothing else", () => {
    expect(drawn(resultSummary({ text: "", details: answered(true) }, plainTheme))).toBe(
      "  ↳ Scope: 2. Backend only",
    );
    expect(drawn(resultSummary({ text: "", details: { ...answered(true), answers: [] } }, plainTheme))).toBe(
      "",
    );
  });

  it("shows an error in the error colour on the ↳ line", () => {
    expect(drawn(resultSummary({ text: "Error: No questions provided", isError: true }, tagged))).toBe(
      "  <dim>↳ <error>Error: No questions provided",
    );
  });
});
