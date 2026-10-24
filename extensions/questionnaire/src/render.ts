import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { hintLines, type KeyHint } from "../../../core/manager/hints.ts";
import { PAD, padded, rule } from "../../../core/manager/layout.ts";
import { CANCEL_HINT, listLines, SELECT_HINTS } from "../../../core/manager/list.ts";
import { TAB_SWITCH_HINT, tabBar } from "../../../core/manager/tabs.ts";
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

const tabs = (state: FormState, theme: ThemeLike) =>
  tabBar(
    theme,
    state.questions.map((question) => ({
      label: question.label,
      done: Boolean(answerOf(state, question.id)),
    })),
    state.tab,
    allAnswered(state),
  );

const optionLines = (state: FormState, theme: ThemeLike, width: number) => {
  const options = formOptions(currentQuestion(state)).map((option) => {
    const typing = Boolean(option.other) && state.typing;

    return { ...option, mark: typing ? "✎" : undefined, active: typing };
  });

  return listLines(theme, options, state.option, width);
};

const SUBMIT_HINT: KeyHint = ["enter", "to submit"];

const hints = (state: FormState): readonly KeyHint[] => {
  if (state.typing) {
    return [
      ["enter", "to save"],
      ["esc", "to go back to options"],
    ];
  }

  if (onSubmitTab(state)) {
    return [TAB_SWITCH_HINT, ...(allAnswered(state) ? [SUBMIT_HINT] : []), CANCEL_HINT];
  }

  const actions: KeyHint[] = isMulti(state) ? [TAB_SWITCH_HINT, ["enter", "to confirm"]] : [SUBMIT_HINT];

  return [...SELECT_HINTS, ...actions, CANCEL_HINT];
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
    : theme.fg("success", "Press enter to submit");
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
  const bar = isMulti(state) ? [...padded(theme, tabs(state, theme), width), ""] : [];

  const body = onSubmitTab(state)
    ? submitLines(state, theme, width)
    : questionLines(state, theme, width, input);

  return [
    rule(theme, width),
    ...bar,
    ...body,
    "",
    ...hintLines(theme, hints(state), width),
    rule(theme, width),
  ];
};
