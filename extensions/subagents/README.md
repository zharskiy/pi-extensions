# subagents

Repository: https://github.com/zharskiy/pi-extensions

Background subagents for the [pi coding agent](https://pi.dev). The main session becomes a coordinator: it delegates tasks to agents that run in the background with their own context, is woken once per batch with all results, and can check on, message, inspect and stop any agent. The spend of every agent is reported to the spending extension, which adds it up in the footer.

Release 0.2. Agents can start their own agents when their file allows it, up to three levels by default (main session, agent, sub-agent). An agent that runs out of context continues itself from a handoff file; you can message any agent from its view, browse all agents in a list, and answer permission prompts raised inside agents. The main session's own context limit is handled by the separate session-limits extension shipped in the same package.

## What you need

- pi 1.1.0 (`pi --version`). The extension pins its adapter to this version.
- Node 22 or newer (only for development; pi loads the TypeScript sources directly).
- A model configured in pi. Agents use the main session's model unless their file names another one.

## Install

From a local checkout:

```bash
git clone https://github.com/zharskiy/pi-extensions.git
pi install ./pi-extensions           # installs every extension of the package; add -l for the current project only
```

From git:

```bash
pi install git:github.com/zharskiy/pi-extensions
```

Try it for one run without installing: `pi -e ./pi-extensions/extensions/subagents/src/index.ts`.

## Use

- Ask for work that splits well ("find every place we parse dates and review them"). The main session calls `run_agent`, ends its turn, and is woken once when the whole batch is done.
- While agents run you can keep typing. Corrections for a running agent are forwarded with `message_agent`.
- The widget below the editor lists running agents. `/agents <id>` opens an agent's view: the effective system prompt, tools, skills and the first provider request as collapsible sections, then the transcript, then a message box for open agents.
  - Prompt sections focused: `Esc` closes, `x` stops the agent (it enters a grace period in which you can still ask it questions; `x` again closes it now), `Tab` moves through the sections and then into the message box, `Enter`/`Space` expands or collapses a section, arrows and PgUp/PgDn/Home/End or the mouse wheel scroll, Ctrl+O (pi's tools key) toggles tool detail.
  - Message box focused: typing edits the text (including `x`), `Enter` sends it to the agent as you (a running agent is steered, a stopped one answers in a new turn, a queued one gets it when it starts), `Esc` clears the text or, on an empty box, leaves it, `Tab` returns to the sections. A line under the box says how the message was delivered. Closed agents have no message box.
- `/agents` without an id opens the list of all agents grouped by state: working, needs attention, done, failed, closed. `↑`/`↓` select, `Enter` opens the agent's view, `x` stops the selected agent (`x` again closes it now), `X` then `y` stops every open agent, `/` filters by name, id or state (`Enter` keeps the filter, `Esc` clears it), `Esc` closes.
- An agent that reaches its context limit writes a handoff file and, when its work is only partial, continues itself in a new session from that file, up to `maxChainLength` sessions (3 by default). The caller is woken once, at the end of the chain, with one result; rows show `#2`, `#3` for the later sessions and any id of the chain works with `message_agent`, `agent_status` and `/agents`. Only a blocked handoff, one at the cap, or one that does not follow the schema (marked `(invalid: <reasons>)` after its path) reaches the caller as `handoff`; an agent that wrote no handoff file fails.
- When an agent asks for a confirmation, a choice or a text (for example a permission dialog of another extension loaded in it), the dialog appears in the main session with the agent's id and name in the title; the rows say `needs input`. `Esc` denies that one call and the agent carries on.
- Main session context limits are not part of this extension: the session-limits extension in this repository (`extensions/session-limits/`) writes a handoff at the main session's hard limit and continues in a new session. This extension reports on that extension's busy channel (`session-limits:busy`, source `pi-subagents`) whenever agents are running, so the automatic switch waits until they finish, and `/session-handoff` asks before ending them. The main session prompt tells the model to list delegated agents with their result files in that handoff.
- To run an agent on another model or thinking level, say so ("review this with haiku", "use gpt-6.1-sol on high"). The main session passes your words in the `model` parameter of `run_agent` as `name[:thinking]`; it never picks a model on its own. The harness resolves the name among providers you are logged in to, tolerating misspellings (`hiaku`), and takes the newest version when you give none (`haiku` → `anthropic/claude-haiku-5-5`). If the name fits several model families, or none, nothing starts and the main session asks you with the candidates and their prices. The model that actually runs, as `provider/id:thinking`, is shown in the start message, the progress row, `agent_status` and the agent's manifest.
- Spending totals are not part of this extension: the spending extension in this repository (`extensions/spending/`) shows `main $x · agents $y · total $z` in the footer. This extension reports each agent's usage, at every depth and under its own id, on that extension's channel (`spending:usage`, source `agents`) whenever it grows. Tool results carry no usage, so pi's own session cost counts the main session only; without the spending extension agent spend is visible only in the agent rows and views.

Tools added to the main session: `run_agent`, `agent_status`, `message_agent`. Commands: `/agents [id]`.

## Agents

Starter agents: `explorer` (read-only search, `openai/gpt-6-luna`), `implementer` (scoped edits, `openai/gpt-6.1-sol`), `reviewer` (read-only review, `openai/gpt-6-luna`), and `general` (`openai/gpt-6.1-sol`, all tools), a fallback for work none of the others fits, such as running commands and summarising them or drafting a document. `general` may start `explorer` and `reviewer` agents of its own; the three role agents start none. Add your own as Markdown files with frontmatter in `~/.pi/agent/agents/` or, for trusted projects, `.pi/agents/` (project files win over user files, user files over built-ins). To change a starter agent's model, copy its file to `~/.pi/agent/agents/` and edit it there.

```markdown
---
name: doc-writer
description: Writes or updates docs for one module.
limit: 80000                 # required: context budget in tokens; at the limit the agent writes a handoff
subagents: []                # required: agents it may start, [] for none
tools: read, grep, find, ls, edit, write
model: openai/gpt-6-luna:low # optional name[:thinking]; omit or "inherit" for the main session's model
fallback: false              # optional: true lists the agent only for work no other agent fits
skills: [docs-style]         # optional subset of your skills
output: text                 # text (last message) or file (result.md)
maxTurns: 30                 # optional
---
You write documentation...
```

A file that misses `limit` or `subagents`, names an unknown agent in `subagents`, lists itself, or forms a cycle (`a` may start `b`, `b` may start `a`) is not loaded; pi shows a warning naming the file. `model` is `name[:thinking]`: an exact `provider/id` as listed by `pi --list-models`, or a name the harness resolves when the agent starts, like a `model` passed to `run_agent` (`haiku`, `gpt-6.1-sol:high`). The thinking suffix is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; without it the agent uses the main session's thinking level, and `inherit:high` keeps the main session's model with its own level. A suffix that is not a known level stops the file from loading. There is no separate `thinking` field: a file that still has one is not loaded, and the warning asks you to move the level onto `model`. A model whose provider has no credentials, or a name that is ambiguous or unknown, is rejected when the agent is started, before anything runs. Fields from Claude Code and other pi packages (`color`, `tools` as a list, `max_turns`, ...) are accepted; other unknown keys are ignored.

An agent whose `subagents` list is not empty, and which runs below the depth cap, gets `run_agent`, `message_agent` and `agent_status` tools. It learns which agents it may start, and the depth, concurrency and budget rules, from the description of its `run_agent` tool, which lists only its `subagents`. Its system prompt holds no orchestration rules. Like the main session, an agent that starts a batch ends its turn and is woken once with all results; while it waits it holds no concurrency slot, so a tree of agents cannot deadlock.

## Prompts

Three prompt files ship in the extension's `prompts/` directory:

- `main-session.md`: replaces pi's default system prompt in the main session. It holds all orchestration rules: when to delegate, how to split and write tasks, how to handle results, and when to forward corrections. pi's tool list, rules and docs sections are kept. The replacement happens at runtime, only in sessions where this extension is loaded; nothing is written to `~/.pi/agent`.
- `base-system-prompt.md`: added to every agent's system prompt, followed by the agent file's body.
- `handoff.md`: the instruction an agent gets at its context limit, with the handoff file schema.

To customise them, edit the files in your local checkout of this package (the one you passed to `pi install`) and run `/reload` in pi:

```bash
$EDITOR pi-extensions/extensions/subagents/prompts/main-session.md
```

Packages installed from git or npm are overwritten by `pi update`, so keep custom prompts in a fork or local checkout.

## Settings

Optional JSON in `~/.pi/agent/pi-subagents.json` or `.pi/pi-subagents.json` (trusted projects):

```json
{
  "maxConcurrent": 4,
  "budgetTokens": 100000,
  "inlineResultChars": 4000,
  "disabledPlugins": []
}
```

Other keys: `maxDepth` (3, from 2 to 4; the main session counts as level 1, so 2 means agents cannot start agents), `maxChainLength` (3; sessions one agent may use before a partial handoff reaches the caller), `softBudgetRatio` (0.8), `hardBudgetRatio` (1.15), `reserveTokens` (16384), `stopGraceSeconds` (60), `lingerMs`, `failedLingerMs`, `renderThrottleMs`.

## Update

```bash
pi update --extensions            # reconciles the git install of github.com/zharskiy/pi-extensions
git -C pi-extensions pull         # local checkout; then /reload in pi
```

## Develop

```bash
npm install
npm run check        # tsc, biome, vitest
```

`src/index.ts` is the single entry: it computes the extension's root, reads the settings and hands the plugin list from `src/plugins.ts` to the shared manager and pi adapter in `core/` (repository root). Only `core/adapter/` talks to pi. Plugins in `src/plugins/` use the shared contract (`core/adapter/contract.ts`) and the typed bus; `src/model/` holds the subagents types, bus events, service map, settings schema and paths. Plugin and component tests are under `test/`; adapter and manager tests live in `core/test/`.
