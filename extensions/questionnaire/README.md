# questionnaire

A pi extension that gives the main session's model a `questionnaire` tool: it asks you a batch of independent multiple-choice questions in one form, drawn inline where the editor is, and returns your answers in one tool result.

## What it does

- The model calls `questionnaire` with `questions: [{ id, label?, prompt, options: [{ value, label, description? }], allowOther? }]`. The tool's guidelines tell it to use the tool for decisions with concrete options, to batch only questions that do not depend on each other, and to pick a sensible default or stop when you cancel.
- The form takes the editor's place while it is open; what you had typed in the editor comes back when it closes. When an overlay such as `/agents` is open, the form waits until you close it.
- One question: a list of options. `↑`/`↓` select, `1`-`9` pick an option directly, `Enter` answers and submits, `Esc` cancels. The strip under the options names the keys in pi's `key to verb` grammar, keys dim and words muted: `↑↓ to select · 1-9 to pick · enter to submit · esc to cancel` (with several questions `tab/←→ to switch · enter to confirm`, in the text field `enter to save · esc to go back to options`); it wraps between hints on a narrow terminal.
- Several questions: a tab bar `← □ Scope  □ Priority  ✓ Submit →`. `Tab`/`→` and `Shift+Tab`/`←` move between tabs; a filled `■` marks an answered question. Answering moves to the next unanswered question, then to the Submit tab, which lists your answers and `Unanswered: …` in warning colour until every question has one; `Enter` there submits. Going back to a question selects the answer you gave.
- `Type something.` (the last option, unless the model set `allowOther: false`) opens a text field below the options: `Enter` saves the text, `Esc` returns to the options. An empty answer is not saved.
- `Esc` outside the text field cancels the whole form. The model then reads `User cancelled the questionnaire`, any answers you gave before cancelling and an instruction to pick a sensible default or stop.
- Number keys and Enter do nothing for the first 250 ms after the form appears, so keys you were still typing into the editor do not answer it.
- What the model reads, one line per question: `Scope (scope): selected 2. Backend only [value: backend]` or `Notes (notes): wrote: keep the old API for one release`. The transcript shows the call as a row with the state glyph and the answers under it on a `↳` line, labels in accent, answers in the text colour, a typed answer followed by a dim `(wrote)`; a cancelled form is `⊘ … · cancelled` with any answers given before the cancel, and an error is shown on the `↳` line in the error colour:

  ```
  ✓ Questionnaire · 2 questions
    ↳ Scope: 2. Backend only
      Priority: Fix the login bug first (wrote)

  ⊘ Questionnaire · cancelled
  ```
- While the form waits for you it reports on the awaiting-input channel (`pi:awaiting-input`), so the notifications extension sends `pi needs your input: questionnaire` after its dialog delay.
- Interactive TUI only. In `--mode rpc`, `--mode json` and `-p` the tool returns an error result and the model decides without asking. Only the main session has the tool: agents started by subagents never get it.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root). `src/questionnaire.ts` holds the tool (schema, prompt texts, `execute`), `src/view.ts` the form view that joins state, text input and clock, `src/form.ts` the pure form state and key handling, `src/render.ts` the pure form line builders over the theme (the option list, its keys and hints come from `core/manager/list.ts`, the rules and hint line from `core/manager/layout.ts`, both shared with the style picker, and the tab bar and tab keys from `core/manager/tabs.ts`, shared with `/agents setup`), `src/summary.ts` the call and result renderers, and `src/result.ts` the types, the question normalising and the model-facing text. The inline form, the overlay wait and the text field (pi-tui's `Editor`) are `HostUi.showForm` in `core/adapter/pi-form.ts`. Tests are under `test/`.
