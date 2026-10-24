<div align="center">

# style

**Switches the output style of the main session and of every subagent with one command.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

This extension switches the output style of the main session and of every subagent at once. The shipped `concise` style asks for short, result-first replies, while the engineering work stays as thorough as usual. The style is its own section of the system prompt, so pi's prompt and your own additions stay as they are. Your choice survives new sessions.

## What it looks like

The list `/style` opens in place of the editor, the current style marked `✓` and selected:

```
──────────────────────────────────────────────────────────────
 Output style

 › 1. concise ✓  short, result-first replies
   2. normal  no style, pi's default replies

 ↑↓ to select · 1-9 to pick · enter to choose · esc to cancel
──────────────────────────────────────────────────────────────
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/style/index.ts   # this extension alone, from a checkout
```

Pick a style in the interactive TUI:

| Try | What you see |
|---|---|
| `/style` | The list of styles in place of the editor. |
| Pick `concise` | The main session and every agent answer in short, result-first replies from their next run. |
| `/style normal` | The style is removed and pi's default replies return. |

## Development

```bash
npm run test -- extensions/style   # this extension's unit tests
npm run check                      # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
