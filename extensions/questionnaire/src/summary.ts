import type { ThemeLike, ToolResult } from "../../../core/adapter/contract.ts";
import {
  type Answer,
  defaultLabel,
  labelOf,
  type Question,
  type QuestionnaireDetails,
  type QuestionnaireParams,
  questionInputs,
} from "./result.ts";

const plural = (count: number) => `${count} question${count === 1 ? "" : "s"}`;

export const callText = (params: QuestionnaireParams, theme: ThemeLike) => {
  const questions = questionInputs(params);
  const labels = questions.map((question, index) => question?.label?.trim() || defaultLabel(index));
  const title = `${theme.bold("questionnaire")} ${theme.fg("muted", plural(questions.length))}`;

  return labels.length > 0 ? `${title}${theme.fg("dim", ` (${labels.join(", ")})`)}` : title;
};

const answerSummary = (questions: Question[], answer: Answer, theme: ThemeLike) => {
  const shown = answer.wasCustom
    ? `${theme.fg("dim", "(wrote)")} ${answer.label}`
    : `${answer.index}. ${answer.label}`;

  return `${theme.fg("success", "✓")} ${theme.fg("accent", labelOf(questions, answer))}: ${shown}`;
};

export const resultSummary = (result: ToolResult<QuestionnaireDetails>, theme: ThemeLike) => {
  const details = result.details;

  if (!details || result.isError) {
    return result.isError ? theme.fg("error", result.text) : result.text;
  }

  const lines = details.answers.map((answer) => answerSummary(details.questions, answer, theme));

  return (details.cancelled ? [theme.fg("warning", "Cancelled"), ...lines] : lines).join("\n");
};
