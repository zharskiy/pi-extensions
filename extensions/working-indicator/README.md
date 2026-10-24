<div align="center">

# working-indicator

**A rotating verb and the elapsed time of the current prompt, in place of pi's plain `Working...`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

Pi shows a plain `Working...` line while a prompt runs. This extension replaces it with a rotating verb and the time since the prompt started, next to pi's own spinner, so a long run shows that it is alive and how long it has taken.

## What it looks like

```
── ⠹ Pondering · 12s (esc to interrupt) ──────────────────────────────────
```

The working line, drawn inside the input's top line while a prompt runs.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs working-indicator with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/working-indicator/index.ts
```

| You do | You see |
|---|---|
| Send a prompt | A verb such as `Pondering`, the elapsed time (`12s`, `1m 5s`) and the interrupt hint, next to pi's spinner. |
| Wait while it runs | The time advances every second; the verb changes every 8 s. |
| Let the answer text stream in | The line hides, and comes back as soon as the text stops. |

## What it does

- **Spinner**: pi's own braille spinner, drawn inside the input's top line in the input's rule colour (it follows the thinking level and bash mode). The extension never replaces it.
- **Working line**: while a prompt runs (from agent start until the run settles, across all its model calls and tool runs), the line shows a verb (`Pondering`), the time since the prompt started from 1 s on (`12s`, `1m 5s`), and the interrupt hint from pi's `app.interrupt` keybinding, in dim. The time advances every second.
- **Verb**: picked at random when a prompt starts and changes every 8 s; it stays put in between, whatever the agent is doing. The tool rows in the transcript show what runs.
- **Hiding**: the line hides while the assistant's answer text streams in, and comes back as soon as the text stops. When the run settles the line disappears and the message goes back to pi's default.
- **Narrow terminal**: pi cuts the line.
- **Who drives it**: only the main session; subagents never show, hide or change it.
- **Modes**: active only in `tui` mode; in other modes it does nothing.

## Architecture

- `core/indicator-state.ts` holds the run state, the verb rotation (`VERB_MS`, 8000) and the prompt timer (`TICK_MS`, 1000).
- `ui/indicator-text.ts` holds the verbs and the working line text, whose duration format (`12s`, `1m 5s`) comes from `platform/shared/index.ts` and is shared with subagents; `api/plugin.ts` wires them to the host's working line.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/working-indicator   # this extension's unit tests
npm run check                                  # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
