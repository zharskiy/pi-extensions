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

Only a level you choose is saved: the thinking selector's Enter or Ctrl+S, Shift+Tab, `/thinking <level>`, or an extension that replays your choice, such as a handoff restoring the level kept from the previous session. A model switch never changes the saved level. Pi resets the level when you switch models; this extension puts the session back on the level you last chose, or the nearest one the new model supports, and that nearest level is not saved. Switch to a model without thinking and back, and you are on your level again, with `off` never saved. Until you choose a level in a session, a switch keeps the level pi gives the new model. Starting or resuming a session saves nothing.

Known limits: picking the model you are already on (Enter on it in the selector, or `/model <current>`) makes pi reset the level to the default it loaded at startup, and that level is saved, because pi reports no model switch to extensions in that case. Changing or removing a per-model thinking level in pi's settings also sets the session's level, and that level is saved as the global default.

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
| Pick `low` in the thinking selector, then switch models with Ctrl+P | The session stays on `low`, and `low` stays the default. |

## Development

```bash
npm run test -- extensions/model-default   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
