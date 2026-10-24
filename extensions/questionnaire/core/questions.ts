import type { ToolResult } from "../../../pi-adapter/index.ts";

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

export type QuestionnaireParams = { questions?: QuestionInput[] };

export type QuestionnaireDetails = { questions: Question[]; answers: Answer[]; cancelled: boolean };

const CANCELLED = "User cancelled the questionnaire";

const ANSWERED_BEFORE = "Answered before cancelling:";

const FALLBACK = "Pick a sensible default for anything unanswered, or stop.";

const defaultLabel = (index: number) => `Q${index + 1}`;

export const questionInputs = (params: QuestionnaireParams) =>
  Array.isArray(params.questions) ? params.questions : [];

export const labelOf = (questions: Question[], answer: Answer) =>
  questions.find((question) => question.id === answer.id)?.label ?? answer.id;

export const normalizeQuestions = (inputs: QuestionInput[]): Question[] =>
  inputs.map((input, index) => ({
    id: input.id,
    label: input.label?.trim() || defaultLabel(index),
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
  const head = `${labelOf(questions, answer)} (${answer.id})`;

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
