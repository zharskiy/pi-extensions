<div align="center">

# spending

**What the whole session has cost, in the footer, subagents at every depth included.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi's own accounting covers the main session's messages. Background agents and other extensions spend money outside them, which that figure does not show. This extension adds the main session and everything other extensions spend on its behalf into one total. It keeps that total across resume, fork and handoff, and counts the parent session's spend once, when the forked or handed-off session is created.

## What it looks like

```
main $0.12 · agents $0.05 · total $0.17 (sub)
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/spending/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Work in the main session only | No segment yet: it stays hidden while no reporting source has spent anything. |
| Run a background agent with [subagents](../subagents/README.md) | `main $x · agents $y · total $z` in the footer, refreshed as the agent works. pi's default footer shows it as a status; the [footer](../footer/README.md) extension draws the same totals itself and hides that status. |
| Quit and resume the session | The same totals as before you quit. |

## Development

```bash
npm run test -- extensions/spending   # this extension's unit tests
npm run check                         # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
