# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), shipped as one pi package (`pi-extensions-mz`). Version 0.4.0, for pi 1.2.0 or later within pi 1 (developed and tested against pi 1.3.0).

- [subagents](extensions/subagents/README.md): background agents run, watched and messaged from the main session, inside the main session's process, optionally in their own git worktree, with MCP for every agent with tools. A panel below the editor (under the footer block when the footer is installed) shows the running agents (`↓` to select, `←` for the list), `/agents` lists them and opens any agent's view, the `run_agent` block's rows show each agent's outcome, and agents never ask you anything; what they spend is reported to spending. `/agents setup` sets an agent's model, thinking level and skills, `/agents create` writes a new agent file.
- [session-limits](extensions/session-limits/README.md): the main session hands itself over to a new session before its context fills up.
- [spending](extensions/spending/README.md): the session's total spend in the footer, the main session plus everything other extensions report, such as subagents at every depth.
- [working-indicator](extensions/working-indicator/README.md): pi's working line shows a rotating verb and the elapsed time of the current prompt (`Pondering · 12s`) next to pi's own spinner.
- [notifications](extensions/notifications/README.md): one terminal notification when pi waits for your input (after the work and any background agents are done) and one when a dialog waits unanswered.
- [command-aliases](extensions/command-aliases/README.md): friendlier names for built-in commands (`/continue`, `/clear`, `/exit`).
- [composer](extensions/composer/README.md): the input drawn between two full-width rules in the editor's colour, with pi's `›` message cursor as the prompt.
- [questionnaire](extensions/questionnaire/README.md): a `questionnaire` tool the main session's model uses to ask you a batch of independent multiple-choice questions in one inline form (tabs, number keys, a typed answer per question), with a notification when it waits.
- [style](extensions/style/README.md): `/style concise` makes the main session and every subagent answer in short, result-first replies; `/style normal` turns it off, and `/style` alone opens a list of the styles to pick from.
- [context](extensions/context/README.md): `/context` prints what fills the context window into the transcript: a usage grid, the estimated tokens per category (system prompt, tools, memory files, skills, messages, free space, compaction reserve), the cache hit rate of the last turn and the session, and every file, skill and tool with `ctrl+o`.
- [footer](extensions/footer/README.md): replaces pi's footer with a multi-line block right below the editor, above the subagents panel: context, session cache hit rate, cost, model, session total including agents, folder, branch, thinking level and the other extensions' statuses.
- [transcript](extensions/transcript/README.md): pi's tool calls drawn as pi-native state rows: a state glyph (`◌` running, `✓` done, `✗` failed, `⊘` stopped), a title (`read src/stats.py:5-14`, `edit`, `bash npm test`) with the failure reason or duration after it, and the outcome on a `↳` line (`10 lines`, `Added 1 line, removed 1 line`, the last lines of shell output) that `ctrl+o` or a click expands; messages and thinking keep pi's own look. The subagents, questionnaire, `/context` and handoff rows use the same row language.
- [mcp-import](extensions/mcp-import/README.md): `/mcp-import <claude|cursor> [project] [apply]` copies MCP servers from Claude Code or Cursor into pi's `mcp.json`; a dry run unless you add `apply`, and existing servers are never overwritten.

## Install

```bash
pi install ./pi-extensions                      # local checkout; add -l for the current project only
pi install git:github.com/zharskiy/pi-extensions
```

Either installs all extensions. To try one for a single run without installing, pass its entry file:

```bash
pi -e ./pi-extensions/extensions/subagents/index.ts
pi -e ./pi-extensions/extensions/session-limits/index.ts
pi -e ./pi-extensions/extensions/spending/index.ts
pi -e ./pi-extensions/extensions/working-indicator/index.ts
pi -e ./pi-extensions/extensions/notifications/index.ts
pi -e ./pi-extensions/extensions/command-aliases/index.ts
pi -e ./pi-extensions/extensions/composer/index.ts
pi -e ./pi-extensions/extensions/questionnaire/index.ts
pi -e ./pi-extensions/extensions/style/index.ts
pi -e ./pi-extensions/extensions/context/index.ts
pi -e ./pi-extensions/extensions/footer/index.ts
pi -e ./pi-extensions/extensions/mcp-import/index.ts
pi -e ./pi-extensions/extensions/transcript/index.ts
```

## Coming from another tool

- Skills: nothing to do when they live in `.agents/skills`. Pi reads `~/.agents/skills` and `.agents/skills` as well as its own `~/.pi/agent/skills` and `.pi/skills`, and the same `.agents/skills` folder works in several other tools, so keep shared skills there.
- Agent definitions and instruction files: rewrite them by hand. Pi reads `AGENTS.md` and `CLAUDE.md` as they are; other instruction files (rule folders, local or imported files) are merged into one of those. Agent files from other tools lack this package's `limit`, `tools`, `skills` and `subagents` fields, so start from `/agents create <name>`, which writes a documented template, and copy the old prompt into its body, or ask the main session to convert a file (see [subagents](extensions/subagents/README.md#agents)).
- MCP servers: `/mcp-import claude` or `/mcp-import cursor` (add `project` for the project's servers) shows what it would copy into pi's `mcp.json`; add `apply` to write it, then `/reload`. OAuth sign-ins do not transfer: sign in again with `/mcp`.
- Afterwards pi manages the servers itself: `/mcp` in a session lists them and lets you inspect, reconnect, sign in or out, enable or disable them, and `pi mcp add|remove|list|login|logout` does the same from the shell.

A team can commit `.pi/mcp.json`, `.pi/agents/`, `.pi/pi-subagents.json` and `.agents/skills`; a colleague who trusts the project gets the same setup.

## Update

```bash
pi update --extensions              # git install
git -C pi-extensions pull           # local checkout; then /reload in pi
```

## Develop

```bash
npm install
npm run check                                     # typecheck, biome, knip, unit tests; no credentials, no network
PI_LIVE_MODEL=provider/id:low npm run test:live   # live tests with real agents, local only, costs money
PI_LIVE_MODEL=provider/id:low npm run evals       # prompt-quality evals with real agents, local only, costs money
```

`npm run check` is what CI runs. `npm run test:live` runs the `*.live.test.ts` files and `npm run evals` the `*.eval.ts` files in `evals/` (see [evals/README.md](evals/README.md)); neither runs in `npm run check` or CI. Both need `PI_LIVE_MODEL=provider/id[:thinking]` set to a model you have pi credentials for (in pi's agent dir, `~/.pi/agent/auth.json`, or the dir in `PI_CODING_AGENT_DIR`; the optional `PI_LIVE_CHORE_MODEL` puts the chore agents on a second model); without it, or without credentials, they fail at once with a message saying what is missing. The runs never read that agent dir otherwise: each suite links your `auth.json` (and copies `models.json`, if present) into a temporary agent dir and points pi at it, so your `AGENTS.md`, skills, extensions and MCP config stay out; a token pi refreshes during a run goes through the link into the real file, so it is not lost. Everything they create lives in temporary directories, except the evals' results in the gitignored `evals/.results/`.

## Layout

- `pi-adapter/`: the only code that imports pi; `index.ts` is the interface every extension depends on (the `Host` and `AgentRuntime` types, `createPiExtension`, the row geometry).
- `shared/`, `ui-kit/`, `extension-manager/`: pi-free helpers and cross-extension formats, theme-aware components (the row language the transcript, questionnaire, subagents, context and session-limits rows share), and `createManagedExtension`, which boots each extension's plugins and settings.
- `extensions/<name>/`: one folder per extension with its README; `index.ts` is its entry (listed under `pi.extensions` in `package.json`), `api/` wires it, `core/` holds the logic, `ui/` the rendering, `tests/` the tests.
- `test-framework/`: the fakes and harnesses every test shares; `test-framework/pi/` holds the only test helpers that import pi. `evals/`: the prompt-quality evals.
- Layers point one way, `pi-adapter ← shared ← ui-kit ← extension-manager ← extensions`, each reached only through its `index.ts`; extensions import each other only through `index.ts` and today talk only over pi's event bus. Biome, knip and `test/architecture.test.ts` enforce the rules as part of `npm run check`.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains how it works, [STRUCTURE.md](STRUCTURE.md) shows where things are, [AGENTS.md](AGENTS.md) is the short guide for coding agents.
