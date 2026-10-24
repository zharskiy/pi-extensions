import type { Host, RunMode, ToolSpec } from "../../../platform/pi-adapter/index.ts";
import { AWAITING_INPUT_CHANNEL } from "../../../platform/shared/index.ts";
import {
  errorResult,
  normalizeQuestions,
  type QuestionnaireDetails,
  type QuestionnaireParams,
  questionInputs,
  questionsError,
} from "./questions.ts";

export const QUESTIONNAIRE_SOURCE = "pi-questionnaire";

const DESCRIPTION =
  "Ask the user a batch of mutually independent multiple-choice questions in one interactive form. Each question also accepts a typed answer unless allowOther is false, and the user may cancel. Interactive sessions only: it errors in non-interactive runs.";

const PROMPT_SNIPPET = "Ask a batch of independent multiple-choice questions in one form";

const PROMPT_GUIDELINES = [
  "Use questionnaire for user decisions (concrete options; prefer over prose).",
  "Batch independent questions in one call; defer dependent questions to a later call.",
  "On cancel or non-interactive results, pick a sensible default or stop.",
];

const NOT_INTERACTIVE =
  "Error: questionnaire needs the interactive terminal; pick a sensible default or ask in prose.";

const PARAMETERS = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description:
        "One batch of mutually independent questions. Include every independent question you need now; omit any whose wording or options would change based on another answer in this batch.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique identifier for this question" },
          label: {
            type: "string",
            description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
          },
          prompt: { type: "string", description: "The full question text to display" },
          options: {
            type: "array",
            description: "Available options to choose from",
            items: {
              type: "object",
              properties: {
                value: { type: "string", description: "The value returned when selected" },
                label: { type: "string", description: "Display label for the option" },
                description: { type: "string", description: "Optional description shown below label" },
              },
              required: ["value", "label"],
              additionalProperties: false,
            },
          },
          allowOther: { type: "boolean", description: "Allow 'Type something' option (default: true)" },
        },
        required: ["id", "prompt", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

type ToolDefinition = Pick<
  ToolSpec<QuestionnaireParams, QuestionnaireDetails>,
  | "name"
  | "label"
  | "description"
  | "promptSnippet"
  | "promptGuidelines"
  | "parameters"
  | "executionMode"
  | "modelOnly"
>;

export const questionnaireDefinition: ToolDefinition = {
  name: "questionnaire",
  label: "Questionnaire",
  description: DESCRIPTION,
  promptSnippet: PROMPT_SNIPPET,
  promptGuidelines: PROMPT_GUIDELINES,
  parameters: PARAMETERS,
  executionMode: "sequential",
  modelOnly: true,
};

export const checkCall = (params: QuestionnaireParams, mode: () => RunMode) => {
  const questions = normalizeQuestions(questionInputs(params));

  if (mode() !== "tui") {
    return { questions, failure: errorResult(NOT_INTERACTIVE, questions) };
  }

  const invalid = questionsError(questions);

  return { questions, failure: invalid ? errorResult(invalid, questions) : undefined };
};

export const awaitingInput = (host: Host) => (waiting: boolean) =>
  host.publish(AWAITING_INPUT_CHANNEL, {
    source: QUESTIONNAIRE_SOURCE,
    waiting,
    title: "questionnaire",
  });
