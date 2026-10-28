<div align="center">

# context

**`/context` shows what fills the main session's context window, per category, with cache hit rates.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A context window fills with more than the conversation. The system prompt, tool declarations, memory files and skills all take their share. `/context` shows what fills the main session's window, as a grid of one cell per percent and a legend of tokens per category. It also shows how much of the prompt the provider's cache served, for the last turn and the whole session.

## What it looks like

The title line always carries the time the snapshot was taken.

```
 » Context usage · 14:32
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   model-name · 61.2k/200k tokens (31%)
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Cache hit: last turn 87% · session 91%
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
     ■ · · · · · · · · ·   Estimated usage by category
     · · · · · · · · · ·   ■ System prompt: 4.1k tokens (2.1%)
     · · · · · · · · · ·   ■ System tools: 5.3k tokens (2.6%)
     · · · · · · · · · ·   ■ MCP tools: 1.8k tokens (0.9%)
     · · · · · · · · · ·   ■ Extension tools: 2.6k tokens (1.3%)
     · · · · · · · · · ·   ■ Memory files: 3.2k tokens (1.6%)
     · · ░ ░ ░ ░ ░ ░ ░ ░   ■ Skills: 1.4k tokens (0.7%)
                           ■ Messages: 42.8k tokens (21.4%)
                           · Free space: 122.4k (61.2%)
                           ░ Compaction reserve: 16.4k tokens (8.2%)

     Memory files · AGENTS.md
     ↳ 2 files · 3.2k tokens
     Skills · /skill:<name>
     ↳ 2 skills · 1.4k tokens
     MCP tools · /mcp
     ↳ 2 tools · 1.8k tokens · 1 loaded on demand
     Extension tools
     ↳ 1 tool · 2.6k tokens
     Messages
     ↳ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinki...
     ... (14 more items, ctrl+o to expand)
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/context/index.ts   # this extension alone, from a checkout
```

Run it in the main session:

| Try | What you see |
|---|---|
| `/context` | The block above, appended to the transcript. It is never sent to the model. |
| `ctrl+o` | Every `/context` block expands to list each memory file, skill, tool and message kind, by tokens. |

## Development

```bash
npm run test -- extensions/context   # this extension's unit tests
npm run check                        # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
