<div align="center">

# model-default

**The model you last picked becomes pi's saved default, without pressing Ctrl+S.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi saves a model as the default for new sessions only when you press Ctrl+S in the model selector. Enter, `/model <name>` and Ctrl+P switch the current session and leave the default behind, so the next session starts on a model you moved away from. With this extension every model you pick in the main session is saved as the default, as Ctrl+S would, and the thinking level is left alone. Subagents never change it.

## What it looks like

Pick `acme/beta` with Enter, and pi's `settings.json` follows:

```
{
  "theme": "dark",
  "defaultProvider": "acme",
  "defaultModel": "beta"
}
```

If the file cannot be written, a warning says why and the session keeps the model:

```
pi-model-default: acme/beta is not saved as the default model: <reason>
```

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

## Development

```bash
npm run test -- extensions/model-default   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
