<div align="center">

# questionnaire

**A `questionnaire` tool for the main session's model: a batch of multiple-choice questions in one inline form, your answers in one tool result.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

This extension gives the main session's model a `questionnaire` tool for decisions with concrete options. It asks you a batch of independent multiple-choice questions in one form, drawn inline where the editor is, and returns your answers in one tool result. While the form waits for you, the notifications extension can tell you so.

## What it looks like

```
──────────────────────────────────────────────────────────────
 Which part should change?

 › 1. Frontend only
   2. Backend only
   3. Type something.

 ↑↓ to select · 1-9 to pick · enter to submit · esc to cancel
──────────────────────────────────────────────────────────────
```

A form with one question, drawn inline in place of the editor while the model waits for your answer. With several questions a tab bar `← □ Scope  □ Priority  ✓ Submit →` sits above the prompt.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs questionnaire with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/questionnaire/index.ts
```

| You do | You see |
|---|---|
| Ask the model to decide something with you | The form in place of the editor, one tab per question when there are several. |
| Pick an answer per question and submit | `✓ questionnaire · 2 questions` in the transcript, your answers on a `↳` line under it. |
| Press `Esc` | `⊘ questionnaire · cancelled`; the model picks a sensible default or stops. |

## What it does

The model calls `questionnaire` with `questions: [{ id, label?, prompt, options: [{ value, label, description? }], allowOther? }]`. The tool's guidelines tell it to use the tool for decisions with concrete options, to batch only questions that do not depend on each other, and to pick a sensible default or stop when you cancel.

- **Inline**: the form takes the editor's place while it is open; what you had typed in the editor comes back when it closes. When an overlay such as `/agents` is open, the form waits until you close it.
- **One question**: a list of options. `↑`/`↓` select, `1`-`9` pick an option directly, `Enter` answers and submits, `Esc` cancels.
- **Several questions**: a tab bar `← □ Scope  □ Priority  ✓ Submit →`. `Tab`/`→` and `Shift+Tab`/`←` move between tabs; a filled `■` marks an answered question. Answering moves to the next unanswered question, then to the Submit tab, which lists your answers and `Unanswered: …` in warning colour until every question has one; `Enter` there submits. Going back to a question selects the answer you gave.
- **Your own answer**: `Type something.` (the last option, unless the model set `allowOther: false`) opens a text field below the options: `Enter` saves the text, `Esc` returns to the options. An empty answer is not saved.
- **Cancel**: `Esc` outside the text field cancels the whole form. The model then reads `User cancelled the questionnaire`, any answers you gave before cancelling and an instruction to pick a sensible default or stop.
- **Typing ahead**: number keys and Enter do nothing for the first 250 ms after the form appears, so keys you were still typing into the editor do not answer it.
- **Notifications**: while the form waits for you it reports on the awaiting-input channel (`pi:awaiting-input`), so the notifications extension sends `pi needs your input: questionnaire` after its dialog delay.
- **Interactive TUI only**: in `--mode rpc`, `--mode json` and `-p` the tool returns an error result and the model decides without asking. Only the main session has the tool: agents started by subagents never get it.

<details>
<summary>The key strip</summary>

The strip under the options names the keys in pi's `key to verb` grammar, keys dim and words muted: `↑↓ to select · 1-9 to pick · enter to submit · esc to cancel` (with several questions `tab/←→ to switch · enter to confirm`, in the text field `enter to save · esc to go back to options`); it wraps between hints on a narrow terminal.

</details>

<details>
<summary>What the model reads and what the transcript shows</summary>

What the model reads, one line per question: `Scope (scope): selected 2. Backend only [value: backend]` or `Notes (notes): wrote: keep the old API for one release`.

The transcript shows the call as a row with the state glyph and the answers under it on a `↳` line, labels in accent, answers in the text colour, a typed answer followed by a dim `(wrote)`; a cancelled form is `⊘ … · cancelled` with any answers given before the cancel, and an error is shown on the `↳` line in the error colour:

```
✓ questionnaire · 2 questions
  ↳ Scope: 2. Backend only
    Priority: Fix the login bug first (wrote)

⊘ questionnaire · cancelled
```

</details>

## Architecture

- `core/` holds the tool: `questionnaire.ts` the tool definition (schema, prompt texts), the call checks and the awaiting-input signal, `questions.ts` the types, the question normalising and the model-facing text.
- `ui/` holds the form: `form.ts` the pure form state and key handling, `render.ts` the pure form line builders over the theme, `view.ts` the form view that joins state, text input and clock, `summary.ts` the call and result renderers.
- `api/plugin.ts` registers the tool and runs `execute` (the form and the result).
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.
- From `platform/ui-kit/` it uses the option list, its keys and hints (`list.ts`) and the rules and hint line (`key-hints.ts`), both shared with the style picker, and the tab bar and tab keys (`tabs.ts`), shared with `/agents setup`. The inline form, the overlay wait and the text field (pi-tui's `Editor`) are `HostUi.showForm` in `platform/pi-adapter/ui/form.ts`.
- It talks to other extensions only over pi's event bus: it publishes on the awaiting-input channel `pi:awaiting-input` while the form waits.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/questionnaire   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
