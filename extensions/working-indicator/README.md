# working-indicator

A pi extension that replaces pi's plain `Working...` line with a spinner, a playful verb and the elapsed time of the current prompt:

```
⠹ Percolating… (bash · 12s · esc to interrupt)
```

## What it does

- At session start the working indicator becomes the configured spinner; pi keeps it for the whole session. The default `braille` spinner is pi's own, which pi draws inside the input in the same colour as the text, the input's rule colour (it follows the thinking level and bash mode). Pi draws custom frames verbatim, so the other spinners are painted once in the theme's accent colour and do not follow the input.
- While a prompt runs (from agent start until the run settles, across all its model calls and tool runs), the working line shows a verb, the time since the prompt started (`12s`, `1m 5s`) and the interrupt hint (from pi's `app.interrupt` keybinding). While a tool runs, the tool's name comes first: `Percolating… (bash · 1m 5s · esc to interrupt)`. Pi draws it in the input's top line (`── ⠹ Percolating… (…) ───`; with the composer the rule starts `───── ⠹`), right above the text. The time advances every second; the verb changes every 8 seconds.
- The line shows while pi waits for the model, while the model thinks or writes a tool call, and while tools run. It hides while the assistant's answer text streams in, and comes back as soon as the text stops.
- When the run settles the line disappears and the message goes back to pi's default.
- Only the main session drives it; subagents never show, hide or change it.
- Active only in `tui` mode; in other modes it does nothing.

## Configuration

Constants at the top of `src/working-indicator.ts`:

- `SPINNER`: one of `braille` (default, pi's own spinner), `dots`, `bar` or `mark`, from the `SPINNERS` table.
- `VERB_MS`: how long a verb stays, in milliseconds (8000).
- `TICK_MS`: how often the message is refreshed, in milliseconds (1000).

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/working-indicator.ts` holds the spinners, the verbs and the prompt timer, and depends only on `core/adapter/contract.ts` and `core/manager/format.ts`, whose duration format (`12s`, `1m 5s`) it shares with subagents. Tests are under `test/`.
