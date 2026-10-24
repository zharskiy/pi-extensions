<div align="center">

# footer

**A multi-line status block below the editor: context, cache, cost, model, session total, folder, branch, thinking level.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

This extension replaces pi's footer with a status block right below the editor. Besides the main session's figures, it shows the cost of the whole session, subagents at every depth included, as reported to the [spending](../spending/README.md) extension. The status texts other extensions set get a line each.

## What it looks like

```

 150.1k · cache 91% · $4.00 · model-name (1M context)
 session total (agents included) 162.4k · $4.42
 my-project git:(feature-branch) • session-name
 thinking high (shift+tab to cycle)

 <status text other extensions have set>

```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/footer/index.ts   # this extension alone, from a checkout
```

Start pi in a git checkout and read the block line by line:

| Try | What you see |
|---|---|
| Line 1 | How full the context window is, the cache hit rate, the main session's cost and the model. |
| Line 2 | Tokens and cost of the whole session, agents included. Hidden until spending reports. |
| Line 3 | The folder name, the git branch and the session name when one is set. |
| Press `shift+tab` | The thinking level on line 4 changes. |

## Development

```bash
npm run test -- extensions/footer   # this extension's unit tests
npm run check                       # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
