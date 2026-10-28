# Questionnaire structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `createManagedExtension` with namespace `pi-questionnaire` and `questionnairePlugin`.
- `api/plugin.ts`: `questionnairePlugin` and `createQuestionnaire`; registers the tool, its `execute` (form, awaiting-input signal, result) and renderers.
- `core/questionnaire.ts`: `QUESTIONNAIRE_SOURCE`, `questionnaireDefinition` (name, prompt texts, parameter schema, execution mode), `checkCall`, `awaitingInput`.
- `core/questions.ts`: question, answer and details types, normalising, validation, result text, error results (always given the batch's questions).
- `ui/form.ts`: pure form state and key handling (`initialForm`, `pressKey`, `answerText`).
- `ui/render.ts`: `renderForm` line builders over the theme.
- `ui/view.ts`: `createFormView`; joins form state, text input and clock.
- `ui/summary.ts`: `callText` and `resultSummary` for the tool row.
- `tests/questionnaire.test.ts`: the tool on a fake host.
- `tests/form.test.ts`, `tests/render.test.ts`, `tests/result.test.ts`, `tests/summary.test.ts`: unit tests per module.
- `tests/support/questions.ts`: shared question fixtures.
