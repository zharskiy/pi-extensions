<div align="center">

# subagents

**Background agents the main session runs, watches, messages and stops, each with its own context.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A long task fills the main session's context with searches, edits and test output. This extension lets the main session delegate that work with `run_agent` to agents that run in the background, each with its own context. The main session is woken once per batch with all results, and can check on, message and stop any agent. Starter agents ship with the package (a scout, a planner, an implementer, a reviewer and more), and you can add your own as Markdown files.

## What it looks like

```
 ✗ 3 background agents · 4m 2s · 35 calls · 64.7k tokens · $0.25
   ↳ ✓ scout  Map the auth module · model-a:low
       1m 5s · 4 calls · 12.3k tokens · $0.04
     ✗ worker  Fix the login redirect · model-a:low
       tests failed twice · 2m 10s · 31 calls · 52.4k tokens · $0.21
     ⊘ reviewer  Review the diff of PR 5 · model-b:high
       Stopped · 3s · 0 calls · worktree removed
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/subagents/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Ask for work that splits well, like "find every place we parse dates and review them" | The main session calls `run_agent`, ends its turn and is woken with every result once the batch is done. |
| `/agents` | The agents menu: view running and finished agents, set up models and skills, create a new agent. |
| `/agents setup` | A form with one tab per agent to change its model, thinking level and skills. In a project you have not trusted it saves to your user file, which applies to every project. |
| `/agents create` | The main session asks what the new agent should do and writes its file. |

<details>
<summary>What you need</summary>

A model configured in pi. The shipped agents name specific models; without credentials for those, pick one of your models per agent with `/agents setup`. An agent file without a `model` line runs on the main session's model.

</details>

## Development

```bash
npm run test -- extensions/subagents   # this extension's unit tests
npm run check                          # typecheck, biome, knip, unit tests
PI_LIVE_MODEL=provider/id[:thinking] npm run test:live    # real agents, local only, costs money
PI_LIVE_MODEL=provider/id[:thinking] npm run evals        # prompt-quality evals, local only, costs money
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
