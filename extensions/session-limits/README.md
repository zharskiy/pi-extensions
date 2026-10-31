<div align="center">

# session-limits

**Hands the main session over to a new session before its context fills up, so it can run indefinitely.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A long session eventually fills the model's context window. Before that happens, this extension has the model save a handoff with a dedicated tool, and pi continues in a new session seeded with it. You keep typing, and a notice below the editor warns when the handoff is near. When background work is still running, the switch waits for it instead of ending it. The new session's first row says it continues the previous session, and it keeps the model and thinking level you had selected without changing pi's defaults. After an automatic handoff the new session picks the work up by itself, whatever the handoff Status; after `/session-handoff` it waits for you. A handoff switch starts a session marked as created from this one, so spending carries its totals over. The context thresholds are judged exactly as the footer judges them, and the handoff format is shared with subagents; what the main session is told to write is its own.

## What it looks like

```
 » handoff at 175k tokens · 142.3k used

 » handoff requested · 175k of 175k tokens

 ✓ handoff
   ↳ Saved ~/…

 » handoff from the previous session
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
| Keep working until the context grows | A warning notice below the editor shows the handoff threshold and the tokens used, then pi switches to a new session started from the handoff. |
| Watch the footer while the context grows | The `context N of X` figure counts toward the handoff point (X, the hard threshold), so a handoff is due when N reaches X. |
| `/session-handoff` | A "handoff requested" row appears in the transcript (no toast), the model saves a handoff with the `handoff` tool and ends its turn without a reply (the tool row shows the save), then pi switches to a new session started from it. |
| Ask the model to save a handoff on its own | The `handoff` tool refuses unless a handoff was requested. |
| `/session-handoff finish the login tests` | The same, with the text folded into the instruction and repeated in the new session's preface. |

## Development

```bash
npm run test -- extensions/session-limits   # this extension's unit tests
npm run check                               # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
