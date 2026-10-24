import type { KeyPress } from "../../../core/adapter/contract.ts";
import { listKey } from "../../../core/manager/list.ts";
import { tabStep } from "../../../core/manager/tabs.ts";
import type { Answer, Question, QuestionOption } from "./result.ts";

const OTHER_LABEL = "Type something.";

type FormOption = QuestionOption & { other?: boolean };

export type FormState = {
  questions: Question[];
  tab: number;
  option: number;
  answers: Answer[];
  typing: boolean;
};

export type FormOutcome = { state: FormState; done?: "submit" | "cancel" };

type KeyOptions = { armed?: boolean };

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

const questionKey = (state: FormState, key: KeyPress, { armed = true }: KeyOptions): FormOutcome => {
  const step = listKey(key, state.option, formOptions(currentQuestion(state)).length);

  if (!step || (step.pick && !armed)) {
    return { state };
  }

  return step.pick ? choose(state, step.index) : { state: { ...state, option: step.index } };
};

const submitKeys: Partial<Record<KeyPress["name"], (state: FormState) => FormOutcome>> = {
  enter: (state) => (allAnswered(state) ? { state, done: "submit" } : { state }),
};

const stopTyping = (state: FormState): FormState => ({ ...state, typing: false });

export const pressKey = (state: FormState, key: KeyPress, options: KeyOptions = {}): FormOutcome => {
  if (state.typing) {
    return { state: key.name === "escape" ? stopTyping(state) : state };
  }

  if (key.name === "escape") {
    return { state, done: "cancel" };
  }

  const tabbed = isMulti(state) ? tabStep(key, state.tab, state.questions.length + 1) : undefined;

  if (tabbed !== undefined) {
    return { state: goTo(state, tabbed) };
  }

  if (onSubmitTab(state)) {
    const submit = options.armed === false ? undefined : submitKeys[key.name];

    return submit?.(state) ?? { state };
  }

  return questionKey(state, key, options);
};

export const answerText = (state: FormState, text: string): FormOutcome => {
  const question = currentQuestion(state);
  const trimmed = text.trim();

  if (!question || !state.typing || trimmed === "") {
    return { state };
  }

  return save(state, { id: question.id, value: trimmed, label: trimmed, wasCustom: true });
};
