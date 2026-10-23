import type { ThemeLike, ToolRender, ToolRenderState, ToolResult } from "../../../core/adapter/contract.ts";
import { markOf, noun, type RowChild, row, rowChildren, rowText } from "../../../core/manager/row.ts";
import {
  type Answer,
  labelOf,
  type Question,
  type QuestionnaireDetails,
  type QuestionnaireParams,
  questionInputs,
} from "./result.ts";

const cancelledOf = (state: ToolRenderState) =>
  (state.result?.details as QuestionnaireDetails | undefined)?.cancelled === true;

export const callText = (
  params: QuestionnaireParams,
  theme: ThemeLike,
  state: ToolRenderState,
): ToolRender => {
  const count = questionInputs(params).length;
  const cancelled = cancelledOf(state);
  const mark = cancelled ? "stopped" : markOf(state);
  const suffix = cancelled || state.aborted ? "cancelled" : `${count} ${noun(count, "question")}`;
  const title = (paint: ThemeLike) => `${paint.bold("Questionnaire")}${paint.fg("muted", ` · ${suffix}`)}`;

  return rowText(row({ mark, title }), theme);
};

const answerLine = (questions: Question[], answer: Answer, theme: ThemeLike) => {
  const label = theme.fg("accent", `${labelOf(questions, answer)}:`);
  const shown = answer.wasCustom
    ? `${theme.fg("text", answer.label)} ${theme.fg("dim", "(wrote)")}`
    : theme.fg("text", `${answer.index}. ${answer.label}`);

  return `${label} ${shown}`;
};

const resultChildren = (result: ToolResult<QuestionnaireDetails>, theme: ThemeLike): RowChild[] => {
  const details = result.details;

  if (result.isError) {
    return [theme.fg("error", result.text)];
  }

  if (!details) {
    return [theme.fg("muted", result.text)];
  }

  return details.answers.map((answer) => answerLine(details.questions, answer, theme));
};

export const resultSummary = (result: ToolResult<QuestionnaireDetails>, theme: ThemeLike): ToolRender =>
  rowText(rowChildren({ children: resultChildren(result, theme) }), theme);
