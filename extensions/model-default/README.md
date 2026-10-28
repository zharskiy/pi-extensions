<div align="center">

# model-default

**The model and thinking level you last picked become pi's saved defaults, without pressing Ctrl+S.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi saves a model as the default for new sessions only when you press Ctrl+S in the model selector. Enter, `/model <name>` and Ctrl+P switch the current session and leave the default behind, so the next session starts on a model you moved away from. The thinking selector works the same way: Enter and Shift+Tab change the level for the current session only. With this extension every model and every thinking level you pick in the main session is saved as the default, as Ctrl+S would. Subagents never change either.

## What it looks like

Pick `acme/beta` with Enter and `high` in the thinking selector, and pi's `settings.json` follows:

```
{
  "theme": "dark",
  "defaultProvider": "acme",
  "defaultModel": "beta",
  "defaultThinkingLevel": "high"
}
```

If the file cannot be written, a warning says why and the session keeps the model or level:

```
pi-model-default: acme/beta is not saved as the default model: <reason>
pi-model-default: high is not saved as the default thinking level: <reason>
```

Every change of the thinking level counts, not only the ones you make yourself. A model switch sets the level pi loaded as the default when the session started (or the model's own level, or the nearest one the model supports), and that level is saved; switching to a model without thinking saves `off`. An extension that sets the level, such as a handoff restoring the level kept from the previous session, saves it too. Starting or resuming a session saves nothing.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/model-default/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Pick a model with Enter in the selector, then `/new` | The new session starts on that model. |
| Cycle models with Ctrl+P, then restart pi | Pi starts on the model you cycled to. |
| Press Shift+Tab to cycle the thinking level, then `/new` | The new session starts on that level. |

## Development

```bash
npm run test -- extensions/model-default   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
