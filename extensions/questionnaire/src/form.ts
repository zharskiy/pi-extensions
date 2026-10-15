import type { KeyPress } from "../../../core/adapter/contract.ts";
import type { Answer, Question, QuestionOption } from "./result.ts";

export const OTHER_LABEL = "Type something.";

export type FormOption = QuestionOption & { other?: boolean };

export type FormState = {
  questions: Question[];
  tab: number;
  option: number;
  answers: Answer[];
  typing: boolean;
};

export type FormOutcome = { state: FormState; done?: "submit" | "cancel" };

export const initialForm = (questions: Question[]): FormState => ({
  questions,
  tab: 0,
  option: 0,
  answers: [],
  typing: false,
});

export const isMulti = (state: FormState) => state.questions.length > 1;

export const onSubmitTab = (state: FormState) => isMulti(state) && state.tab === state.questions.length;

export const currentQuestion = (state: FormState): Question | undefined =>
  onSubmitTab(state) ? undefined : state.questions[state.tab];

export const answerOf = (state: FormState, id: string) => state.answers.find((answer) => answer.id === id);

export const formOptions = (question: Question | undefined): FormOption[] => {
  if (!question) {
    return [];
  }

  return question.allowOther
    ? [...question.options, { value: "", label: OTHER_LABEL, other: true }]
    : question.options;
};

export const unanswered = (state: FormState) =>
  state.questions.filter((question) => !answerOf(state, question.id));

export const allAnswered = (state: FormState) => unanswered(state).length === 0;

const optionFor = (state: FormState, tab: number) => {
  const question = state.questions[tab];
  const answer = question ? answerOf(state, question.id) : undefined;

  if (!question || !answer) {
    return 0;
  }

  return answer.wasCustom ? formOptions(question).length - 1 : Math.max(0, (answer.index ?? 1) - 1);
};

const goTo = (state: FormState, tab: number): FormState => ({ ...state, tab, option: optionFor(state, tab) });

const shiftTab = (state: FormState, step: number) => {
  const tabs = state.questions.length + 1;

  return goTo(state, (state.tab + step + tabs) % tabs);
};

const nextUnanswered = (state: FormState) => {
  const count = state.questions.length;
  const order = Array.from({ length: count }, (_, offset) => (state.tab + 1 + offset) % count);

  return order.find((tab) => !answerOf(state, state.questions[tab]?.id ?? "")) ?? count;
};

const save = (state: FormState, answer: Answer): FormOutcome => {
  const answers = state.questions.flatMap((question) => {
    const kept = question.id === answer.id ? answer : answerOf(state, question.id);

    return kept ? [kept] : [];
  });
  const saved = { ...state, answers, typing: false };

  if (!isMulti(state)) {
    return { state: saved, done: "submit" };
  }

  return { state: goTo(saved, nextUnanswered(saved)) };
};

const choose = (state: FormState, index: number): FormOutcome => {
  const question = currentQuestion(state);
  const option = formOptions(question)[index];

  if (!question || !option) {
    return { state };
  }

  if (option.other) {
    return { state: { ...state, option: index, typing: true } };
  }

  return save(
    { ...state, option: index },
    { id: question.id, value: option.value, label: option.label, wasCustom: false, index: index + 1 },
  );
};

const move = (state: FormState, index: number): FormOutcome => {
  const last = formOptions(currentQuestion(state)).length - 1;

  return { state: { ...state, option: Math.max(0, Math.min(last, index)) } };
};

const digitOf = (key: KeyPress) =>
  key.name === "other" && key.char && /^[1-9]$/.test(key.char) ? Number(key.char) : undefined;

const tabKeys: Partial<Record<KeyPress["name"], (state: FormState) => FormState>> = {
  tab: (state) => shiftTab(state, 1),
  right: (state) => shiftTab(state, 1),
  backTab: (state) => shiftTab(state, -1),
  left: (state) => shiftTab(state, -1),
};

const questionKeys: Partial<Record<KeyPress["name"], (state: FormState) => FormOutcome>> = {
  up: (state) => move(state, state.option - 1),
  down: (state) => move(state, state.option + 1),
  home: (state) => move(state, 0),
  end: (state) => move(state, formOptions(currentQuestion(state)).length - 1),
  enter: (state) => choose(state, state.option),
};

const submitKeys: Partial<Record<KeyPress["name"], (state: FormState) => FormOutcome>> = {
  enter: (state) => (allAnswered(state) ? { state, done: "submit" } : { state }),
};

export const pressKey = (state: FormState, key: KeyPress, armed = true): FormOutcome => {
  if (key.name === "escape") {
    return { state, done: "cancel" };
  }

  const tabbed = isMulti(state) ? tabKeys[key.name] : undefined;

  if (tabbed) {
    return { state: tabbed(state) };
  }

  const digit = digitOf(key);

  if (!armed && (key.name === "enter" || digit !== undefined)) {
    return { state };
  }

  if (onSubmitTab(state)) {
    return submitKeys[key.name]?.(state) ?? { state };
  }

  if (digit !== undefined) {
    return choose(state, digit - 1);
  }

  return questionKeys[key.name]?.(state) ?? { state };
};

export const answerText = (state: FormState, text: string): FormOutcome => {
  const question = currentQuestion(state);
  const trimmed = text.trim();

  if (!question || !state.typing || trimmed === "") {
    return { state };
  }

  return save(state, { id: question.id, value: trimmed, label: trimmed, wasCustom: true });
};

export const stopTyping = (state: FormState): FormState => ({ ...state, typing: false });
