import type { FormApi, KeyPress, ViewComponent } from "../../../platform/pi-adapter/index.ts";
import type { Question, QuestionnaireDetails } from "../core/questions.ts";
import {
  answerOf,
  answerText,
  currentQuestion,
  type FormOutcome,
  type FormState,
  initialForm,
  pressKey,
} from "./form.ts";
import { inputWidth, renderForm } from "./render.ts";

export const ANSWER_ARM_MS = 250;

export type ViewOptions = { now: () => number; onChange: (state: FormState) => void };

export const createFormView = (
  api: FormApi<QuestionnaireDetails>,
  questions: Question[],
  { now, onChange }: ViewOptions,
): ViewComponent => {
  const input = api.createTextInput();
  const openedAt = now();
  let state = initialForm(questions);

  const apply = ({ state: next, done }: FormOutcome) => {
    const startsTyping = next.typing && !state.typing;

    state = next;
    onChange(state);

    if (startsTyping) {
      const question = currentQuestion(state);
      const answer = question ? answerOf(state, question.id) : undefined;

      input.setText(answer?.wasCustom ? answer.label : "");
    }

    if (done) {
      api.done({ questions, answers: state.answers, cancelled: done === "cancel" });
      return;
    }

    api.requestRender();
  };

  input.onSubmit((text) => apply(answerText(state, text)));

  const handleKey = (key: KeyPress) => {
    if (state.typing && key.name !== "escape") {
      input.handleKey(key);
      api.requestRender();
      return;
    }

    apply(pressKey(state, key, { armed: now() - openedAt >= ANSWER_ARM_MS }));
  };

  return {
    render: (width) =>
      renderForm(state, api.theme, width, state.typing ? input.render(inputWidth(width)) : []),
    handleKey,
  };
};
