# working-indicator

A pi extension that replaces pi's plain `Working...` line with a rotating verb and the elapsed time of the current prompt, next to pi's own spinner:

```
── ⠹ Pondering · 12s (esc to interrupt) ──────────────────────────────────
```

## What it does

- The spinner is pi's own braille spinner, drawn inside the input's top line in the input's rule colour (it follows the thinking level and bash mode). The extension never replaces it.
- While a prompt runs (from agent start until the run settles, across all its model calls and tool runs), the working line shows a verb (`Pondering`), the time since the prompt started from 1 s on (`12s`, `1m 5s`), and the interrupt hint from pi's `app.interrupt` keybinding, in dim. The time advances every second.
- The verb is picked at random when a prompt starts and changes every 8 s; it stays put in between, whatever the agent is doing. The tool rows in the transcript show what runs.
- The line hides while the assistant's answer text streams in, and comes back as soon as the text stops. When the run settles the line disappears and the message goes back to pi's default.
- On a narrow terminal pi cuts the line.
- Only the main session drives it; subagents never show, hide or change it.
- Active only in `tui` mode; in other modes it does nothing.

## Layout

`index.ts` is the pi entry; it re-exports `api/extension.ts`, which builds the extension with `createManagedExtension` (`extension-manager/`) on the shared pi adapter in `pi-adapter/` (repository root). `core/indicator-state.ts` holds the run state, the verb rotation (`VERB_MS`, 8000) and the prompt timer (`TICK_MS`, 1000); `ui/indicator-text.ts` holds the verbs and the working line text, whose duration format (`12s`, `1m 5s`) comes from `shared/index.ts` and is shared with subagents; `api/plugin.ts` wires them to the host's working line. Tests are under `tests/`. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), where things are in [STRUCTURE.md](STRUCTURE.md).
