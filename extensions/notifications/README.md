<div align="center">

# notifications

**Tells you, through your terminal, when pi is waiting for you.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

When the main session finishes its work or a dialog waits for an answer, pi is waiting for you. You may be looking at another window. This extension tells you so through your terminal, once per wait. It holds back while background agents run.

## What it looks like

A desktop notification from your terminal, after a finished run or while a dialog waits:

```
pi is waiting for your input
pi needs your input: <dialog title>
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/notifications/index.ts   # this extension alone, from a checkout
```

Run pi in a terminal that shows desktop notifications, such as iTerm2, WezTerm, Ghostty or kitty:

| Try | What you see |
|---|---|
| Let the main session finish and leave the keyboard for 20 seconds | `pi is waiting for your input`, once per finished run. |
| Leave a confirmation, choice or text field unanswered for 6 seconds | `pi needs your input: <dialog title>`. |
| Press a key or start a new run first | Nothing. The notification is cancelled. |

## Development

```bash
npm run test -- extensions/notifications   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
