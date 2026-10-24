<div align="center">

# working-indicator

**A rotating verb and the elapsed time of the current prompt, in place of pi's plain `Working...`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi shows a plain `Working...` line while a prompt runs. This extension replaces it with a rotating verb and the time since the prompt started, next to pi's own spinner. A long run then shows that it is alive and how long it has taken.

## What it looks like

The working line, drawn inside the input's top line while a prompt runs:

```
── ⠹ Pondering · 12s (esc to interrupt) ──────────────────────────────────
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/working-indicator/index.ts   # this extension alone, from a checkout
```

Send a prompt in the interactive TUI:

| Try | What you see |
|---|---|
| Send a prompt | A verb such as `Pondering`, the elapsed time and the interrupt hint, next to pi's spinner. |
| Wait while it runs | The time advances every second; the verb changes every 8 s. |
| Let the answer text stream in | The line hides, and comes back as soon as the text stops. |

## Development

```bash
npm run test -- extensions/working-indicator   # this extension's unit tests
npm run check                                  # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
