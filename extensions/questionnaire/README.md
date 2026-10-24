<div align="center">

# questionnaire

**A `questionnaire` tool for the main session's model: a batch of multiple-choice questions in one inline form, your answers in one tool result.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Some decisions come down to a few concrete options. This extension gives the main session's model a `questionnaire` tool for them. It asks a batch of independent multiple-choice questions in one form, drawn inline where the editor is. Your answers go back in one tool result.

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

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/questionnaire/index.ts   # this extension alone, from a checkout
```

The model opens the form; you answer it with the keyboard:

| Try | What you see |
|---|---|
| Ask the model to decide something with you | The form in place of the editor, one tab per question when there are several. |
| Pick an answer per question and submit | `✓ questionnaire · 2 questions` in the transcript, your answers under it. |
| Pick `Type something.` | A text field for your own answer. `Enter` saves it. |
| Press `Esc` | `⊘ questionnaire · cancelled`. The model picks a sensible default or stops. |

## Development

```bash
npm run test -- extensions/questionnaire   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
