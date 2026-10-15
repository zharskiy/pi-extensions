# questionnaire

A pi extension that gives the main session's model a `questionnaire` tool: it asks you a batch of independent multiple-choice questions in one form, drawn inline where the editor is, and returns your answers in one tool result.

## What it does

- The model calls `questionnaire` with `questions: [{ id, label?, prompt, options: [{ value, label, description? }], allowOther? }]`. The tool's guidelines tell it to use the tool for decisions with concrete options, to batch only questions that do not depend on each other, and to pick a sensible default or stop when you cancel.
- The form takes the editor's place while it is open; what you had typed in the editor comes back when it closes. When an overlay such as `/agents` is open, the form waits until you close it.
- One question: a list of options. `↑`/`↓` select, `1`-`9` pick an option directly, `Enter` answers and submits, `Esc` cancels.
- Several questions: a tab bar `← □ Scope  □ Priority  ✓ Submit →`. `Tab`/`→` and `Shift+Tab`/`←` move between tabs; a filled `■` marks an answered question. Answering moves to the next unanswered question, then to the Submit tab, which lists your answers and `Unanswered: …` in warning colour until every question has one; `Enter` there submits. Going back to a question selects the answer you gave.
- `Type something.` (the last option, unless the model set `allowOther: false`) opens a text field below the options: `Enter` saves the text, `Esc` returns to the options. An empty answer is not saved.
- `Esc` outside the text field cancels the whole form. The model then reads `User cancelled the questionnaire`, any answers you gave before cancelling and an instruction to pick a sensible default or stop.
- Number keys and Enter do nothing for the first 250 ms after the form appears, so keys you were still typing into the editor do not answer it.
- What the model reads, one line per question: `Scope (scope): selected 2. Backend only [value: backend]` or `Notes (notes): wrote: keep the old API for one release`. The transcript shows `✓ Scope: 2. Backend only` lines, or `Cancelled`.
- While the form waits for you it reports on the awaiting-input channel (`pi:awaiting-input`), so the notifications extension sends `pi needs your input: questionnaire` after its dialog delay.
- Interactive TUI only. In `--mode rpc`, `--mode json` and `-p` the tool returns an error result and the model decides without asking. Only the main session has the tool: agents started by subagents never get it.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root). `src/questionnaire.ts` holds the tool (schema, prompt texts, the form view that joins state, text input and clock), `src/form.ts` the pure form state and key handling, `src/render.ts` the pure line builders over the theme, and `src/result.ts` the question normalising, the model-facing text and the call and result renderers. The inline form, the overlay wait and the text field (pi-tui's `Editor`) are `HostUi.showForm` in `core/adapter/pi-form.ts`. Tests are under `test/`.
