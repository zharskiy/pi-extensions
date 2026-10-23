import type { ThemeLike, ToolRender, ToolRenderState, ToolResult } from "../../../core/adapter/contract.ts";
import { childRow, noun, rowText, type Styled, toolRow, toolState } from "../../../shared/row.ts";
import {
  type Answer,
  defaultLabel,
  labelOf,
  type Question,
  type QuestionnaireDetails,
  type QuestionnaireParams,
  questionInputs,
} from "./result.ts";

export const callText = (
  params: QuestionnaireParams,
  theme: ThemeLike,
  state: ToolRenderState,
): ToolRender => {
  const questions = questionInputs(params);
  const labels = questions.map((question, index) => question?.label?.trim() || defaultLabel(index));
  const count = `${questions.length} ${noun(questions.length, "question")}`;
  const title = (paint: ThemeLike) => {
    const named = `${paint.bold("Questionnaire")} ${count}`;

    return labels.length > 0 ? `${named}${paint.fg("dim", ` (${labels.join(", ")})`)}` : named;
  };

  return rowText(toolRow({ state: toolState(state), title }), theme);
};

const answerSummary = (questions: Question[], answer: Answer) => (theme: ThemeLike) => {
  const shown = answer.wasCustom
    ? `${theme.fg("dim", "(wrote)")} ${answer.label}`
    : `${answer.index}. ${answer.label}`;

  return `${theme.fg("success", "✓")} ${theme.fg("accent", labelOf(questions, answer))}: ${shown}`;
};

const resultChildren = (result: ToolResult<QuestionnaireDetails>): Styled[] => {
  const details = result.details;

  if (result.isError) {
    return [(theme) => theme.fg("error", result.text)];
  }

  if (!details) {
    return [result.text];
  }

  const answers = details.answers.map((answer) => answerSummary(details.questions, answer));

  return details.cancelled ? [(theme) => theme.fg("warning", "Cancelled"), ...answers] : answers;
};

export const resultSummary = (result: ToolResult<QuestionnaireDetails>, theme: ThemeLike): ToolRender =>
  rowText(childRow({ children: resultChildren(result) }), theme);
