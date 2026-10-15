import type { ThemeLike } from "../../../core/adapter/contract.ts";
import {
  allAnswered,
  answerOf,
  currentQuestion,
  type FormState,
  formOptions,
  isMulti,
  onSubmitTab,
  unanswered,
} from "./form.ts";

const PAD = " ";

const DOT = " · ";

const DESCRIPTION_INDENT = "      ";

const prefixed = (
  theme: ThemeLike,
  first: string,
  text: string,
  width: number,
  next = " ".repeat(theme.width(first)),
) =>
  theme
    .wrap(text, Math.max(1, width - theme.width(first)))
    .map((line, index) => `${index === 0 ? first : next}${line}`);

const padded = (theme: ThemeLike, text: string, width: number) => prefixed(theme, PAD, text, width);

const tabBar = (state: FormState, theme: ThemeLike) => {
  const active = (text: string) => theme.fg("accent", theme.bold(text));

  const tabs = state.questions.map((question, index) => {
    const answered = Boolean(answerOf(state, question.id));
    const box = answered ? "■" : "□";

    if (index === state.tab) {
      return active(`${box} ${question.label}`);
    }

    return `${theme.fg(answered ? "success" : "muted", box)} ${theme.fg(answered ? "text" : "muted", question.label)}`;
  });

  const submit = onSubmitTab(state)
    ? active("✓ Submit")
    : theme.fg(allAnswered(state) ? "success" : "dim", "✓ Submit");

  return `${theme.fg("dim", "←")} ${[...tabs, submit].join("  ")} ${theme.fg("dim", "→")}`;
};

const optionLines = (state: FormState, theme: ThemeLike, width: number) =>
  formOptions(currentQuestion(state)).flatMap((option, index) => {
    const selected = index === state.option;
    const typing = Boolean(option.other) && state.typing;
    const pointer = selected ? theme.fg("accent", theme.bold("›")) : " ";
    const label = `${index + 1}. ${option.label}${typing ? " ✎" : ""}`;
    const head = prefixed(
      theme,
      `${PAD}${pointer} `,
      theme.fg(selected || typing ? "accent" : "text", label),
      width,
    );
    const description = option.description
      ? prefixed(theme, DESCRIPTION_INDENT, theme.fg("muted", option.description), width)
      : [];

    return [...head, ...description];
  });

const hint = (state: FormState) => {
  if (state.typing) {
    return ["Enter save", "Esc back to options"];
  }

  if (onSubmitTab(state)) {
    return ["Tab/←→ switch", allAnswered(state) ? "Enter submit" : undefined, "Esc cancel"];
  }

  return isMulti(state)
    ? ["↑↓ select", "1-9 pick", "Tab/←→ switch", "Enter confirm", "Esc cancel"]
    : ["↑↓ select", "1-9 pick", "Enter submit", "Esc cancel"];
};

const submitLines = (state: FormState, theme: ThemeLike, width: number) => {
  const answers = state.questions.flatMap((question) => {
    const answer = answerOf(state, question.id);

    if (!answer) {
      return [];
    }

    const text = answer.wasCustom ? `(wrote) ${answer.label}` : answer.label;

    return padded(theme, `${theme.fg("muted", `${question.label}:`)} ${theme.fg("text", text)}`, width);
  });

  const missing = unanswered(state).map((question) => question.label);
  const status = missing.length
    ? theme.fg("warning", `Unanswered: ${missing.join(", ")}`)
    : theme.fg("success", "Press Enter to submit");
  const title = missing.length ? "Answers" : "Ready to submit";

  return [
    ...padded(theme, theme.fg("accent", theme.bold(title)), width),
    "",
    ...answers,
    ...(answers.length > 0 ? [""] : []),
    ...padded(theme, status, width),
  ];
};

const questionLines = (state: FormState, theme: ThemeLike, width: number, input: string[]) => {
  const question = currentQuestion(state);

  if (!question) {
    return [];
  }

  const answer = state.typing
    ? [
        "",
        ...padded(theme, theme.fg("muted", "Your answer:"), width),
        ...input.map((line) => `${PAD}${line}`),
      ]
    : [];

  return [
    ...padded(theme, theme.fg("text", question.prompt), width),
    "",
    ...optionLines(state, theme, width),
    ...answer,
  ];
};

export const inputWidth = (width: number) => Math.max(1, width - 2);

export const renderForm = (state: FormState, theme: ThemeLike, width: number, input: string[] = []) => {
  const rule = theme.fg("accent", "─".repeat(Math.max(1, width)));
  const tabs = isMulti(state) ? [...padded(theme, tabBar(state, theme), width), ""] : [];
  const body = onSubmitTab(state)
    ? submitLines(state, theme, width)
    : questionLines(state, theme, width, input);
  const hints = hint(state).filter((part): part is string => part !== undefined);

  return [rule, ...tabs, ...body, "", ...padded(theme, theme.fg("dim", hints.join(DOT)), width), rule];
};
