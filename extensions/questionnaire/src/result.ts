import type { ThemeLike, ToolResult } from "../../../core/adapter/contract.ts";

export type QuestionOption = { value: string; label: string; description?: string };

export type QuestionInput = {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionOption[];
  allowOther?: boolean;
};

export type Question = {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
};

export type Answer = { id: string; value: string; label: string; wasCustom: boolean; index?: number };

export type QuestionnaireDetails = { questions: Question[]; answers: Answer[]; cancelled: boolean };

const CANCELLED = "User cancelled the questionnaire";

const ANSWERED_BEFORE = "Answered before cancelling:";

const FALLBACK = "Pick a sensible default for anything unanswered, or stop.";

export const normalizeQuestions = (inputs: QuestionInput[]): Question[] =>
  inputs.map((input, index) => ({
    id: input.id,
    label: input.label?.trim() || `Q${index + 1}`,
    prompt: input.prompt,
    options: input.options ?? [],
    allowOther: input.allowOther !== false,
  }));

export const questionsError = (questions: Question[]) => {
  if (questions.length === 0) {
    return "Error: No questions provided";
  }

  const duplicate = questions.find(
    (question, index) => questions.findIndex((other) => other.id === question.id) !== index,
  );

  if (duplicate) {
    return `Error: duplicate question id "${duplicate.id}"; give every question its own id`;
  }

  const empty = questions.find((question) => question.options.length === 0 && !question.allowOther);

  return empty ? `Error: question "${empty.id}" has no options and allowOther is false` : undefined;
};

const answerLine = (questions: Question[], answer: Answer) => {
  const label = questions.find((question) => question.id === answer.id)?.label ?? answer.id;
  const head = `${label} (${answer.id})`;

  if (answer.wasCustom) {
    return `${head}: wrote: ${answer.label}`;
  }

  return `${head}: selected ${answer.index}. ${answer.label} [value: ${answer.value}]`;
};

export const resultText = ({ questions, answers, cancelled }: QuestionnaireDetails) => {
  const lines = answers.map((answer) => answerLine(questions, answer));

  if (!cancelled) {
    return lines.join("\n");
  }

  return [CANCELLED, ...(lines.length > 0 ? [ANSWERED_BEFORE, ...lines] : []), FALLBACK].join("\n");
};

export const errorResult = (text: string, questions: Question[] = []): ToolResult<QuestionnaireDetails> => ({
  text,
  isError: true,
  details: { questions, answers: [], cancelled: true },
});

const plural = (count: number) => `${count} question${count === 1 ? "" : "s"}`;

export const callText = (params: { questions?: QuestionInput[] }, theme: ThemeLike) => {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const labels = questions.map((question, index) => question?.label?.trim() || `Q${index + 1}`);
  const title = `${theme.bold("questionnaire")} ${theme.fg("muted", plural(questions.length))}`;

  return labels.length > 0 ? `${title}${theme.fg("dim", ` (${labels.join(", ")})`)}` : title;
};

const answerSummary = (questions: Question[], answer: Answer, theme: ThemeLike) => {
  const label = questions.find((question) => question.id === answer.id)?.label ?? answer.id;
  const shown = answer.wasCustom
    ? `${theme.fg("dim", "(wrote)")} ${answer.label}`
    : `${answer.index}. ${answer.label}`;

  return `${theme.fg("success", "✓")} ${theme.fg("accent", label)}: ${shown}`;
};

export const resultSummary = (result: ToolResult<QuestionnaireDetails>, theme: ThemeLike) => {
  const details = result.details;

  if (!details || result.isError) {
    return result.isError ? theme.fg("error", result.text) : result.text;
  }

  const lines = details.answers.map((answer) => answerSummary(details.questions, answer, theme));

  return (details.cancelled ? [theme.fg("warning", "Cancelled"), ...lines] : lines).join("\n");
};
