<div align="center">

# command-aliases

**Friendlier names for built-in commands: `/continue`, `/clear` and `/exit`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

This extension gives three of pi's built-in commands a second name: `/continue` for `/resume`, `/clear` for `/new` and `/exit` for `/quit`. Typing an alias, picking it in the slash menu or running it as a command all end in the built-in.

## What it looks like

The slash menu after typing `/`, pi's own commands left out:

```
→ clear       Alias for /new
  continue    Alias for /resume
  exit        Alias for /quit
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/command-aliases/index.ts   # this extension alone, from a checkout
```

Type an alias in the interactive TUI:

| Try | What you see |
|---|---|
| `/continue` | pi's `/resume` runs. |
| `/clear` | pi's `/new` runs. |
| Type `/` | The aliases in the slash menu, each marked `Alias for` its target. |

## Development

```bash
npm run test -- extensions/command-aliases   # this extension's unit tests
npm run check                                # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
