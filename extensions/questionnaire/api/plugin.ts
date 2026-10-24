import type { Host, ToolSpec } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";
import { awaitingInput, checkCall, questionnaireDefinition } from "../core/questionnaire.ts";
import { type QuestionnaireDetails, type QuestionnaireParams, resultText } from "../core/questions.ts";
import { initialForm } from "../ui/form.ts";
import { callText, resultSummary } from "../ui/summary.ts";
import { createFormView } from "../ui/view.ts";

const questionnaireTool = (
  host: Host,
  now: () => number = Date.now,
): ToolSpec<QuestionnaireParams, QuestionnaireDetails> => ({
  ...questionnaireDefinition,
  execute: async (params, { signal }) => {
    const { questions, failure } = checkCall(params, () => host.session().mode);

    if (failure) {
      return failure;
    }

    let latest = initialForm(questions);

    const waiting = awaitingInput(host);

    waiting(true);

    try {
      const shown = await host.ui.showForm<QuestionnaireDetails>(
        (api) =>
          createFormView(api, questions, {
            now,
            onChange: (state) => {
              latest = state;
            },
          }),
        { signal },
      );

      const details = shown ?? { questions, answers: latest.answers, cancelled: true };

      return { text: resultText(details), details };
    } finally {
      waiting(false);
    }
  },
  renderShell: "row",
  renderCall: callText,
  renderResult: (result, _state, theme) => resultSummary(result, theme),
});

export const createQuestionnaire = (host: Host, now?: () => number) => {
  host.registerTool(questionnaireTool(host, now));
};

export const questionnairePlugin: Plugin<never, never, undefined> = {
  id: "questionnaire",
  enable({ host }) {
    createQuestionnaire(host);

    return undefined;
  },
};
