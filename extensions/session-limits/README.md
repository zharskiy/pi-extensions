<div align="center">

# session-limits

**Hands the main session over to a new session before its context fills up, so it can run indefinitely.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A long session eventually fills the model's context window. Before that happens, this extension has the model write a handoff file, and pi continues in a new session seeded with it. You keep typing, and one notice says what is happening. When background work is still running, the switch waits for it instead of ending it. The context limit logic is shared with subagents.

## What it looks like

```
 » Handoff at 175k tokens · 142.3k used

 » Handoff from the previous session
   ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/session-limits/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Keep working until the context grows | A warning notice below the editor counts down to the handoff, then pi switches to a new session started from it. |
| Watch the footer while the context grows | The `context N% of X` figure counts toward the handoff point (X, the hard threshold), so 100 % means a handoff is due. |
| `/session-handoff` | The model writes a handoff now, then pi switches to a new session started from it. |
| `/session-handoff finish the login tests` | The same, with the text folded into the instruction and repeated in the new session's preface. |

## Development

```bash
npm run test -- extensions/session-limits   # this extension's unit tests
npm run check                               # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
