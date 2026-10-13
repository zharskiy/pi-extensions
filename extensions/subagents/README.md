# subagents

Repository: https://github.com/zharskiy/pi-extensions

Background subagents for the [pi coding agent](https://pi.dev). The main session becomes a coordinator: it delegates tasks to agents that run in the background with their own context, is woken once per batch with all results, and can check on, message, inspect and stop any agent. The spend of every agent is reported to the spending extension, which adds it up in the footer.

Version 0.3.0 adds the context breakdown, terminal notifications, worktrees and MCP that follows `tools`. Agents can start their own agents when their file allows it, up to three levels by default (main session, agent, sub-agent). An agent that runs out of context continues itself from a handoff file; you can message any agent from its view, browse all agents in a list, and answer permission prompts raised inside agents. The main session's own context limit is handled by the separate session-limits extension shipped in the same package.

## What you need

- pi 1.1.0 (`pi --version`), the version it is developed and tested against.
- Node 22.19 or newer (only for development; pi loads the TypeScript sources directly).
- A model configured in pi. The shipped agents name OpenAI models (see [Agents](#agents)); without OpenAI credentials, copy their files to `~/.pi/agent/agents/` and set `model` to one of your models, or name a model in the `model` parameter of `run_agent`. An agent file without a `model` line runs on the main session's model and thinking level.

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
- The widget below the editor lists running, queued and stopping agents, and finished ones for a short while (`lingerMs`, `failedLingerMs`). `/agents <id>` opens an agent's view: the effective system prompt, tools, skills and the first provider request as collapsible sections, then the transcript, then a message box for open agents.
  - Prompt sections focused: `Esc` closes, `x` stops the agent (it enters a grace period in which you can still ask it questions; `x` again closes it now), `Tab` moves through the sections and then into the message box, `Enter`/`Space` expands or collapses a section, arrows and PgUp/PgDn/Home/End or the mouse wheel scroll, Ctrl+O (pi's tools key) toggles tool detail. `c` shows or hides the context breakdown under the header. `v` switches between the focus view (prompt sections collapsed, tool detail collapsed, no context breakdown: the transcript only) and the verbose view (sections expanded, tool detail expanded, context breakdown shown); the hint bar names the current view. `c`, Ctrl+O and `Enter` still change single parts without changing the view mode. The mode is remembered across views, sessions and reloads in `~/.pi/agent/pi-subagents-view.json` (`{ "mode": "focus" }` or `"verbose"`), written by the view when you press `v`; a missing or unreadable file means focus. Agents that run in a worktree show `worktree: <path> (branch <branch>)` under the task, and after they finish what became of it (below).
  - Message box focused: typing edits the text (including `x`), `Enter` sends it to the agent as you (a running agent is steered, a stopped one answers in a new turn, a queued one gets it when it starts), `Esc` clears the text or, on an empty box, leaves it, `Tab` returns to the sections. A line under the box says how the message was delivered. Closed agents have no message box.
  - Context breakdown (`c`): one row per share of the agent's context, each with its tokens, its percent of the agent's context limit and a bar: system prompt, tools (their names, descriptions and parameter schemas), skills, messages (split into user, assistant and tool results), used and free space, then `limit N tokens (M% of the model window W)`. Figures marked `~` are estimates with pi's heuristic (characters / 4) over the recorded prompt and the transcript; `used` is the context the provider measured at the agent's last turn (for a closed agent from an earlier session, at the last assistant message in its session file), so the estimates need not add up to it. Free space is the limit minus used, never below zero. Colours follow the limits: green below `softContextRatio` × limit, yellow up to the limit, red at or above it. The limit is the agent's `limit` (stored in its `manifest.json`, so an agent from an earlier session keeps the limit it ran with; `limit unknown` when neither the manifest nor an agent file has one), capped at the model window minus `reserveTokens`, as the limits plugin applies it. The block refreshes with the view.
- `/agents` without an id opens the list of all agents grouped by state: working, needs attention, done, failed, closed. `↑`/`↓` select, `Enter` opens the agent's view, `x` stops the selected agent (`x` again closes it now), `X` then `y` stops every open agent, `/` filters by name, id or state (`Enter` keeps the filter, `Esc` clears it), `Esc` closes.
- An agent that reaches its context limit writes a handoff file and, when its work is only partial, continues itself in a new session from that file, up to `maxChainLength` sessions (3 by default). The caller is woken once, at the end of the chain, with one result; rows show `#2`, `#3` for the later sessions and any id of the chain works with `message_agent`, `agent_status` and `/agents`, also for chains from earlier sessions. A successor also receives, in its task, the batch results that reached its predecessor after it stopped for the handoff. Only a blocked handoff, one at the cap, or one that does not follow the schema (marked `(invalid: <reasons>)` after its path) reaches the caller as `handoff`; an agent that wrote no handoff file fails.
- Terminal notifications: when a batch the main session started is finished (one per batch: the agent ids and states, then the first line of the first result), when an agent asks for input (the agent and the dialog title) and when an agent fails, the extension rings the terminal bell and sends one desktop notification: OSC 9, which iTerm2, WezTerm, Ghostty and kitty document, or OSC 777 instead when `TERM` or `TERM_PROGRAM` names rxvt (rxvt-unicode with its notify extension). Other terminals that only understand OSC 777 get the bell alone. None of these terminals was tried by hand. Batches started by agents, and agents that continue in a successor session, notify nothing. Terminals without support ignore the sequences; only the interactive TUI writes them (never `--mode rpc`, `json` or `-p`). Inside tmux the desktop notification is dropped (no tmux passthrough is used); the bell still reaches tmux. Set `"notifications": false` to turn them off.
- When an agent asks for a confirmation, a choice or a text (for example a permission dialog of another extension loaded in it), the dialog appears in the main session with the agent's id and name in the title; the rows say `needs input`. `Esc` denies that one call and the agent carries on.
- Main session context limits are not part of this extension: the session-limits extension in this repository (`extensions/session-limits/`) writes a handoff at the main session's hard limit and continues in a new session. This extension reports on the busy channel (`pi:busy`, consumed by session-limits and notifications; source `pi-subagents`) whenever agents are running, so the automatic switch waits until they finish, and `/session-handoff` asks before ending them. The main session prompt tells the model to list delegated agents with their result files in that handoff.
- To run an agent on another model or thinking level, say so ("review this with <model name>", "use <model name> on high"). The main session passes your words in the `model` parameter of `run_agent` as `name[:thinking]`; it never picks a model on its own. The harness resolves the name among the models pi has credentials for, tolerating misspellings, and takes the newest version when you give none. If the name fits several model families, or none, nothing starts and the main session asks you with the candidates and their prices. The model that actually runs, as `provider/id:thinking`, is shown in the start message, the progress row, `agent_status` and the agent's manifest.
- Spending totals are not part of this extension: the spending extension in this repository (`extensions/spending/`) shows `main $x · agents $y · total $z` in the footer. This extension reports each agent's usage, at every depth and under its own id, on that extension's channel (`spending:usage`, source `agents`) whenever it grows. Tool results carry no usage, so pi's own session cost counts the main session only; without the spending extension agent spend is visible only in the agent rows and views.

Each agent has its own folder, `<main session file without .jsonl>/agents/<id>/` next to the main session file in pi's sessions folder (`~/.pi/agent/pi-subagents/<session id>/agents/<id>/` for a session without a file): `manifest.json`, the agent's session file and `result.md`. Handoff files go to the OS temp dir, `<temp dir>/pi-subagents/<session id>/<agent id>-handoff.md`, so they need no cleanup. Nothing is written to your project, except a worktree agent's checkout under `.pi/worktrees/` (plus that folder's `.gitignore`), its branch and git's worktree record (below).

Tools added to the main session: `run_agent`, `agent_status`, `message_agent`. Commands: `/agents [id]`.

## Agents

Starter agents: `explorer` (read-only search, `openai/gpt-6-luna:low`), `implementer` (scoped edits, `openai/gpt-6.1-sol:medium`), `reviewer` (read-only review, `openai/gpt-6-luna:high`), and `general` (`openai/gpt-6.1-sol:medium`, all tools), whose description tells the main session to use it only for work none of the others fits, such as running commands and summarising them or drafting a document. Every agent is listed the same way in `run_agent`; when to pick one is said in its `description`. `general` may start `explorer` and `reviewer` agents of its own; the three role agents start none. Add your own as Markdown files with frontmatter in `~/.pi/agent/agents/` or, for trusted projects, `.pi/agents/` (project files win over user files, user files over built-ins). To change a starter agent's model or thinking level, copy its file to `~/.pi/agent/agents/` and edit it there.

Every agent file declares the three list fields `tools`, `skills` and `subagents`; there is no default for them. Each takes the same three forms: a list of names (`[read, grep]`, a block list, or `read, grep`), `[]` for none, or the word `all` (also `[all]`) for everything the main session has. `all` mixed with names (`[all, read]`) is an error, and so is `All` or `ALL`: `all` is written in lowercase. Names are plain names of letters, digits, `_` and `-`, not starting with `-`, so pi's `+name`/`-name` modifiers and `*` patterns are not accepted. A key with no value (`tools:` and nothing under it) counts as missing; write `[]` for none. The other fields are optional with the defaults below, except `name`, `description` and `limit`. A name listed twice in any list field warns and counts once. The table is the whole frontmatter: these are the settings you decide per agent, and the file's body is the agent's prompt. Everything else (how results come back, the context reserve, compaction, cache warming, depth) is the same for every agent and comes from the harness and [Settings](#settings). The shipped agents declare every field, in this order, so they double as reference files.

| Field | Type | Required or default | Meaning |
|---|---|---|---|
| `name` | letters, digits, `-`, `_` | required | Name the caller passes to `run_agent`. |
| `description` | text | required | When to use the agent; shown in the `run_agent` description. |
| `model` | `name[:thinking]` or `inherit[:thinking]` | `inherit` | Model the agent runs on; `inherit` is the main session's model. |
| `limit` | integer, at least 5000 | required | Context limit in tokens; at the limit the agent writes a handoff. |
| `tools` | list, `[]` or `all` | required | Tools the agent may use; any tool also brings every MCP tool, `codemode` and `tool_search`, and `[]` brings none of them. `[]`: no tool of its own (only the agent tools when it may start agents), and no MCP server connects (see MCP tools below). `all`: the tools active in the main session when the agent starts, as pi's `defaultTools` setting, `--tools` and any tools toggled since left them; this package's tools follow `subagents`. |
| `skills` | list, `[]` or `all` | required | Skills by name. `[]`: none. `all`: every skill of the main session, passed to the agent as the main session's skill files, so a `worktree: true` agent gets uncommitted project skills too. Named skills are picked from the main session's skills. |
| `subagents` | list of agent names, `[]` or `all` | required | Agents it may start. `[]`: none. `all`: every other agent, among those loaded, never itself. |
| `worktree` | `true` or `false` | `false` | `true` runs the agent in its own git worktree. See below. |

```markdown
---
name: doc-writer
description: Writes or updates docs for one module.
model: provider/model-id:low
limit: 80000
tools: [read, grep, find, ls, edit, write]
skills: [docs-style]
subagents: []
worktree: false
---
You write documentation...
```

The shipped agents are limited to what they need: `explorer` and `reviewer` have read-only tools (`reviewer` adds `bash` for `git diff` and tests), `implementer` the editing tools and `bash`, and all three `skills: []`, `subagents: []`. `general`, for anything the others do not fit, has `tools: all`, `skills: all` and `subagents: [explorer, reviewer]`. Since `tools: all` is what the main session has active, `general` gets `grep`, `find` and `ls` when your main session has them, through `defaultTools`, `--tools` or by turning them on. The role agents load no skills; to give one a skill such as your code style, copy its file and set `skills: [your-skill]`.

A file that misses `limit` or one of the list fields, names an unknown agent in `subagents`, lists itself, or forms a cycle (`a` may start `b`, `b` may start `a`) is not loaded; pi shows a warning naming the file and the fields to add. `subagents: all` counts as naming every other agent for the cycle check, so an `all` agent cannot be started by any agent it can reach, and two `all` agents rule each other out; give agents that start others, like `general`, a list of names. `model` is `name[:thinking]`: an exact `provider/id` as listed by `pi --list-models`, or a name the harness resolves when the agent starts, like a `model` passed to `run_agent` (a model name or part of one, optionally `:high`). The thinking suffix is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; without it the agent uses the main session's thinking level, and `inherit:high` keeps the main session's model with its own level. A suffix that is not a known level stops the file from loading. There is no separate `thinking` field; any key outside the table is ignored with a warning. A model whose provider has no credentials, or a name that is ambiguous or unknown, is rejected when the agent is started, before anything runs. The body is the prompt.

**MCP tools.** MCP follows `tools`; there is no per-agent MCP filter. An agent with any tool, named or `all`, gets pi's MCP, codemode and tool search built-ins in its session, every MCP tool of every server, pi's MCP resource tools when a server offers resources, and `codemode` and `tool_search`: the harness adds `codemode`, `tool_search`, the pattern `mcp__*` and the resource tools to a named list, and to the main session's active tools for `tools: all` (MCP tools, `codemode`, `tool_search` and this package's tools of the main session are left out of that copy and added back this way). An agent with `tools: []` loads none of the built-ins, connects to no server and has no tool of its own (only the agent tools when it may start agents); an MCP tool that another extension registers itself, outside pi's MCP, stays registered in its session but is never active, and without `codemode` and `tool_search` the agent can neither see nor call it. With pi's default `codemode` exposure the agent calls MCP tools from codemode scripts, so the agent view shows `codemode` and pi's `mcp_servers` prompt section rather than one tool per MCP tool; `direct` tools appear by name. The agent connects its own servers, every enabled one, from the same `mcp.json` files as the main session (global, and the project's when it is trusted), when it starts. Every agent with tools therefore pays for its own connections, and its first prompt waits up to 10 seconds for the servers whose tools are exposed `direct` (pi's MCP startup wait; servers with other exposures connect in the background). When the main session has not loaded pi's MCP built-in, agents do not load it either, so no server connects and no MCP tool appears; they keep `codemode` and `tool_search`. This covers `pi --no-mcp`, `-builtin:mcp` in the `extensions` setting and an SDK host that disables the built-in: the harness checks, at each spawn, whether the main session has the `/mcp` command that pi's built-in registers. The `run_agent` description does not list MCP tools. The main session's MCP setup is not touched.

**Worktree agents.** `worktree: true` gives each run of the agent its own git worktree, so agents that edit code in parallel do not step on each other or on you. When the agent starts, the harness runs `git worktree add -b <branch> .pi/worktrees/<id>-<stamp> <HEAD commit>` in the main session's directory and starts the agent there (in the same subdirectory when the session runs in one), with the main session's project trust; a successor session of the same agent continues in the same worktree. The worktree starts from the last commit: uncommitted changes and untracked files of your checkout (an uncommitted `.pi/` folder, `.env`, `node_modules`) are not in it. The branch is named `pi-agents/<id>-<stamp>`, where the stamp is the creation time in base 36, so an agent id that repeats one from an earlier session still gets a branch of its own. If the session's directory is not inside a git repository, or git or the file system fails, the agent fails with `worktree failed: <error>` before anything runs. When the agent is done (done, failed, stopped, or a handoff with no successor; a chain cleans up after its last session), the harness runs `git worktree remove <path>` (without `--force`) and deletes the branch if it still points at the commit the worktree started from. The result, `agent_status`, the agent's `manifest.json` and its view report the outcome: `removed` (nothing committed), `removed; branch <branch> kept` (the agent committed; take the work with `git merge <branch>`, drop it with `git branch -D <branch>`), or `kept: <path> (branch <branch>)` when git refuses, for example over uncommitted changes (review with `git -C <path> diff`, clean up with `git worktree remove --force <path>` and `git branch -D <branch>`). The harness writes `.pi/worktrees/.gitignore` (`*`) when it is missing, so the checkouts never show in your `git status`.

An agent whose `subagents` is not `[]`, and which runs below the depth cap, gets `run_agent`, `message_agent` and `agent_status` tools. It learns which agents it may start, and the depth, concurrency and context limit rules, from the description of its `run_agent` tool, which lists only its `subagents` (every other agent for `all`, shown as `may start any other agent` in its caller's list). Its system prompt holds no orchestration rules. Like the main session, an agent that starts a batch ends its turn and is woken once with all results; while it waits it holds no concurrency slot, so a tree of agents cannot deadlock.

## Prompts

Four prompt files ship in the extension's `prompts/` directory:

- `main-session.md`: replaces pi's default system prompt in the main session. It holds all orchestration rules: when to delegate, how to split and write tasks, how to handle results, and when to forward corrections. pi's tool list, rules and docs sections are kept. The replacement happens at runtime, only in sessions where this extension and its `run-agent` plugin are enabled; nothing is written to `~/.pi/agent`.
- `main-session-agent-status.md`: a short paragraph about `agent_status`, appended to the main prompt only when the agent-status plugin is on.
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
  "softContextRatio": 0.8,
  "inlineResultChars": 4000,
  "disabledPlugins": []
}
```

`maxConcurrent` is how many agents run at once, `inlineResultChars` the longest result handed back inline, `softContextRatio` (0.8) the share of an agent's `limit` at which it gets the context limit warning, and `disabledPlugins` the ids of plugins to switch off. `disabledPlugins` is read from the user file only; in a project file it is ignored with a warning. The other keys are read once at session start (defaults, then the user file, then the project file of a trusted project); change them and run `/reload` or start a new session.

Other keys: `maxDepth` (3, from 2 to 4; the main session counts as level 1, so 2 means agents cannot start agents), `maxChainLength` (3; sessions one agent may use before a partial handoff reaches the caller), `hardContextRatio` (1.15; share past which an agent asked for a handoff is stopped; an agent asked for a handoff is also stopped three turns after the request), `reserveTokens` (16384), `stopGraceSeconds` (60), `notifications` (true; `false` turns terminal notifications off), `lingerMs` (30000; how long done rows stay in the widget and list), `failedLingerMs` (60000; the same for failed, stopped and handoff rows), `renderThrottleMs` (250; minimum time between widget and `run_agent` result redraws; the `/agents` and list views refresh every 300 ms).

## Update

```bash
pi update --extensions            # reconciles the git install of github.com/zharskiy/pi-extensions
git -C pi-extensions pull         # local checkout; then /reload in pi
```

## Develop

```bash
npm install
npm run check        # tsc, biome, vitest
PI_LIVE_MODEL=provider/id[:thinking] npm run test:live    # real agents, local only, costs money
```

`src/index.ts` is the single entry: it computes the extension's root, reads the settings and hands the plugin list from `src/plugins.ts` to the shared manager and pi adapter in `core/` (repository root). Only `core/adapter/` talks to pi. Plugins in `src/plugins/` use the shared contract (`core/adapter/contract.ts`) and the typed bus; `src/model/` holds the subagents types, bus events, service map, settings schema and paths. Plugin and component tests are under `test/`; adapter and manager tests live in `core/test/`.

### Live tests

`extensions/subagents/test/live/` runs the real plugin set over the fake host, bound to the real pi runtime, against the model in `PI_LIVE_MODEL`. Each suite writes only the agents it uses, copied from the shipped files with that model and short limits, to a temporary agent dir. Pi itself runs against a second temporary agent dir that holds only copies of the developer's `auth.json` and `models.json`, so nothing else from the real pi agent dir (context files, skills, extensions, packages, MCP config) reaches a live agent. Closing a suite checks that no plugin reported an error and that every agent ran on that model:

- `run-agent.live.test.ts`: an explorer settles as done with a result, reports a cost on `agent:usage` and writes a session file linked to the main session.
- `handoff.live.test.ts`: an agent at the smallest `limit` writes a valid handoff, a successor continues, and the caller is woken once (the suite raises `hardContextRatio` to 2 so the agent is not aborted before its handoff).
- `nesting.live.test.ts`: `general`, with no tools besides the agent tools, starts an explorer that reads a random secret from a file; `general` learns the secret only from the explorer's result, which reaches its session as one wake message, and `general` wakes the main session once.
- `worktree.live.test.ts`: a `worktree: true` agent creates `hello.txt` in its own worktree under `.pi/worktrees/` on a `pi-agents/...` branch; the uncommitted worktree is kept, and the main checkout's `git status` stays clean.
- `grants.live.test.ts`: the `tools` and `skills` grants, and MCP following `tools`, against a real pi, read from each agent's session file. The named-grant cases use several entries. An agent with `tools: [read, ls]` and `skills: [alpha, gamma]` out of three temporary skills (each with its own secret word) has exactly `read`, `ls`, `mcp__fixture__code` (a stdio MCP server in `test/live/fixtures/mcp-server.ts`, named in the trusted temporary project's `.pi/mcp.json` with `exposure: "direct"`), `codemode` and `tool_search`, only `alpha` and `gamma` with no trace of `beta` in its prompt, reads both skills' secrets, lists its directory, calls the MCP tool, and creates no file when asked to write one; an agent with `tools: []` and `skills: []` has no tool, no skill and no MCP tool; an agent with `tools: [read, ls]` and `skills: all` gets the same tools and all three skills, without `write`, `edit` or `bash`.

Run them with `PI_LIVE_MODEL=provider/id[:thinking] npm run test:live` from the package root. Without `PI_LIVE_MODEL`, or without pi credentials for that model, every live suite fails at once with a message saying what is missing. CI never runs them. An OAuth token refreshed during a run is kept only in the temporary copy.
