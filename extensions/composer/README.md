<div align="center">

# composer

**The input drawn as two horizontal lines, edge to edge, with pi's `›` as the prompt.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi's input is a plain editor. This extension frames it between two full-width lines, with pi's `›` in front of the first line. The lines use the colours pi already uses for the editor border, so they follow the thinking level and bash mode. Pi's working status stays inside the top line, and the editor keeps working as before.

## What it looks like

The input area of the interactive TUI:

```
────────────────────────────────────────
 › type here
   second line of input
────────────────────────────────────────
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/composer/index.ts   # this extension alone, from a checkout
```

Open pi in the interactive TUI and type:

| Try | What you see |
|---|---|
| Open pi | The input between two full-width lines, `›` in front of the first line. |
| Type a second line | It is indented under the first, with no prompt of its own. |
| Click in the input | The cursor moves to the clicked character. |

## Development

```bash
npm run test -- extensions/composer   # this extension's unit tests
npm run check                         # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
