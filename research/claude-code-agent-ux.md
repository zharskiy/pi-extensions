# Claude Code agent and background-task UX: reference for the pi subagents extension

Research date: 2026-10-10. Sources are the official Claude Code docs at code.claude.com (fetched through a summarising reader, so quotes are abbreviated), the Claude Code changelog (entries through 2.1.296, 9 Oct 2026), and one 2025 third-party transcript for the in-transcript line format. Where a point is not in the docs it is marked **[not documented]** or **[unverified]**.

## Executive summary: UX principles to copy

1. **One unified mental model for every agent.** A subagent is "a fresh context window plus a task prompt"; a fork is "the same, but inheriting the conversation". Every agent gets the same row, same panel, same stop/steer keys, whether it is foreground or background.
2. **Background is the default for delegated work, foreground is the exception.** Claude Code runs model-spawned subagents in the background when fork mode is on. The main session stays usable, and a completion notification wakes the parent in a later turn.
3. **A persistent panel below the prompt is the control surface.** Rows show the main session and each running agent. Arrow keys select, Enter opens the transcript and lets you message it, `x` stops it, Esc returns focus to the prompt. Finished agents drop out after a short window, and failed or stopped ones linger for about 30 seconds.
4. **Agent view is a separate dashboard, grouped by state.** Groups are Pinned, Ready for review, Needs input, Working, Completed. Each row shows name, one-line summary and age. Status is shown by icon and colour, so "needs input" stands out.
5. **Parent sees summaries, child keeps the detail.** The parent receives only the final report (plus a small metadata trailer). Intermediate tool calls live in the child's transcript. The main transcript shows a one-line result, for example `Done (12 tool uses · 86.4k tokens · 1m 13s)` in a 2025 transcript.
6. **Permissions bubble up and name the source.** Background prompts appear in the main session and name the subagent asking. Esc denies that one tool call without killing the agent.
7. **Steering is a message, not a restart.** You can message a running agent, resume a completed one by ID or name with its full history, and stop it. A user-stopped agent does not auto-resume.
8. **Cost and context are visible per row and per session.** Each row has a live token count. The status line and `/usage` give session totals, and `/context` gives a category breakdown. Context has an auto-compact threshold.
9. **Nesting is capped by configuration.** Depth and concurrency are both limits set in environment variables, and the Agent tool is withheld at the depth limit.
10. **Agents are defined in Markdown with YAML frontmatter** in project, user, plugin or managed scope, with a fixed precedence order.

---

## 1. Agent tool invocation in the transcript

**What the docs say.**
- Claude starts a subagent by calling the `Agent` tool, which "spawns a subagent with its own context window to handle a task". The parent "doesn't see the subagent's intermediate tool calls or outputs, only that final result". [tools-reference]
- The delegation appears as a tool-call row such as `code-improver(Suggest code improvements)`, showing the agent type and the one-line description. [sub-agents]
- While a foreground subagent runs, the main conversation is blocked. [sub-agents, "Run subagents in foreground or background"]

**Spinner, live tool-call counter, elapsed time, token count while running.**
- The docs do not describe the in-transcript spinner or a live tool-call counter for foreground agents. **[not documented]**
- The agent panel row does show a live token count. The status-line docs describe the default panel row as `name · description · token count`, and the `subagentStatusLine` payload exposes `tokenCount` (running), `tokenSamples` (last 16 readings, one per refresh tick), `startTime`, `status` (`running`, `completed`, `failed`, `killed`), `label` (progress summary, falling back to `description`), `model`, `effort`, `contextWindowSize`, and `cwd`. [statusline, "Subagent status lines" and "Task fields"]
- Elapsed time per row is implied by `startTime` but is not stated as a displayed column. **[unverified as a column]**

**Collapsed vs expanded while it runs.**
- Ctrl+O toggles the transcript viewer, which "shows detailed tool usage and execution, with a timestamp and the model used on each assistant message". It also expands lines that collapse by default, such as MCP calls shown as `Called slack 3 times`. [interactive-mode]
- Ctrl+E ("show all content") exists only in the classic renderer, and only inside the transcript viewer. [interactive-mode, "Transcript viewer"]
- In fullscreen rendering, clicking a collapsed tool result expands it, and clicking again collapses it. Clicking a dim `Message from @<sender>` line also expands it when the sender is a teammate or another agent in the session. [fullscreen]
- `/focus` gives "a quieter view that shows only your last prompt, a one-line summary of tool calls with edit diffstats, and the final response". The setting persists. [fullscreen, "Search and review the conversation"]
- The `viewMode` setting (`default`, `verbose`, `focus`) sets the starting view for every session. The `verbose` setting shows full tool output instead of truncated summaries. [settings-reference index entries]

**Completion.**
- Third-party 2025 transcript (Simon Willison, 11 Oct 2025): a finished Task shows a one-line summary under the tool row, `⎿  Done (12 tool uses · 86.4k tokens · 1m 13s)`. The search tool shows `⎿  Found 47 files (ctrl+o to expand)`. This is a 2025 observation, so treat the exact glyphs and wording as **[unverified for October 2026]**. [https://simonwillison.net/2025/Oct/11/sub-agents]
- The docs state that the parent gets the subagent's final text as the Agent tool result. The docs do not say whether the raw report is rendered verbatim in the transcript or only relayed by the parent's next message. **[not documented]**. The background case is explicit: "Claude waits for that notification before reporting results", so the user sees Claude's report, not the child's transcript. [sub-agents, "How results return to the parent"]
- If a subagent is cut off, the partial output is returned with a note. Hitting `maxTurns` marks the result as partial, and Claude can resume the subagent to continue. [tools-reference; sub-agents]

## 2. Background agents

**Starting.**
- Tool parameter: `run_in_background` on the Agent tool. Claude can set it, but with fork mode on, Claude Code "removes the Agent tool's `run_in_background` parameter", so Claude can't ask for the foreground. [sub-agents]
- Keyboard: **Ctrl+B** "backgrounds Bash commands and agents. Tmux users press twice". [interactive-mode]
- Frontmatter: `background: true` keeps a subagent in the background. [sub-agents]
- Mode rules, in order: teammate-spawned subagents run in the foreground; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` forces foreground; with fork mode on (interactive default), subagents run in the background; with fork mode off, subagents run in the background by default and in the foreground when Claude needs the result. [sub-agents]
- Fork mode: `CLAUDE_CODE_FORK_SUBAGENT=1` turns it on in non-interactive mode and the SDK, `0` turns it off everywhere. An `Agent(fork)` deny rule keeps fork mode on but stops Claude spawning forks. [sub-agents]
- Agent view: `claude agents` opens it. `claude --bg "<prompt>"` starts a background session from the shell. `/background` (alias `/bg`) detaches the current session. Pressing `←` on an empty prompt does the same and opens agent view. [agent-view; commands]

**Task notification on completion.**
- Background results "arrive as a completion notification in a later turn. Claude waits for that notification before reporting". If you ask about progress first, Claude says the subagent is still running. [sub-agents]
- On success the row is removed. The footer shows `/tasks to see subagents` for 30 seconds (not in screen-reader mode). [sub-agents, "Foreground and background runs"]
- Hooks: `Notification` fires with type `agent_completed` or `agent_needs_input`. Desktop/terminal notifications are configured by `preferredNotifChannel`; push by `agentPushNotifEnabled` and `inputNeededNotifEnabled`. [agent-view; settings-reference index]
- Outside agent view, the `←` hint in a normal session shows a count such as `← 2 agents`, and briefly `← 2 done` when a session ends with nothing waiting. [agent-view, "Completion notifications"]

**Panel, overlay and task list.**
- **`/tasks`** (also `/bashes`) "views and manages background work in the current session, including subagents that have finished". It shows each subagent's model and opens transcripts. Completed subagents stay listed for 30 seconds. [commands; sub-agents, "/agents command UI"]
- **Subagent panel below the prompt**: one row for the main session and one per running fork (the docs describe this for forks; background subagents show in the same agent panel per the status-line docs). Keys: `↑`/`↓` move, `Enter` opens the transcript and sends follow-ups, `x` stops a running one or dismisses a finished one, `Esc` returns to the prompt. Failed or stopped rows stay for 30 seconds. [sub-agents, "Observe and steer running forks"]
- **Ctrl+T** toggles Claude's to-do checklist, not the background view. The docs say explicitly: "This is not the background-task view; use `/tasks`". [interactive-mode]
- **Agent view** (`claude agents`) is the full dashboard. See the layout below. Keys are in section 11.

Illustrative layout built from the documented groups and row fields (**mockup is mine, not a screenshot**):

```
 Agents                                       Ctrl+S: group by directory
 Pinned
   ✽ refactor-auth       reviewing token refresh edge cases       2m
 Needs input
   ✻ migration-check     Waiting: "Drop legacy table? (y/n)"      6m
 Working
   ✽ test-triage         running pytest, 14 failures so far       1m
   ✽ docs-sweep          updating 3 READMEs                        40s
 Completed
   ● api-audit           Done, 4 findings                          8m
 ↑↓ move  →/Enter attach  Space peek  x stop  Ctrl+X Ctrl+X delete  ? help
```

Icon and colour states from the agent-view table: animated `✽`/`✻` = working or waiting, dimmed = idle, yellow = needs input, green = completed, red = failed, grey = stopped, `∙` = process exited (replying restarts it). [agent-view, "Layout and status"]

**Stopping and attaching.**
- Inside the main session: `Ctrl+X Ctrl+K` stops all running background subagents and turns off artifact auto-replies for the session. Press twice within 3 seconds to confirm. It works while a background subagent's permission prompt is open. [interactive-mode, "General controls"]
- In `/tasks` or the panel: `x` stops a running agent. Enter opens its transcript so you can message it. [sub-agents]
- In agent view: `Ctrl+X` stops, a second `Ctrl+X` within two seconds deletes. `claude stop <id>` (alias `claude kill`), `/stop` from inside a session, and `claude rm <id>` are the shell equivalents. A `Ctrl+X` delete is refused when unpushed commits exist, and removing a worktree deletes uncommitted changes, so commit first. [agent-view, "Stopping and deleting"]
- Attach and detach: `Enter` or `→` attaches (fullscreen). `←` on an empty prompt, `/exit`, or `Ctrl+Z` detaches without stopping. Claude posts a recap on attach. [agent-view]
- Peek: `Space` opens a panel showing the question the session waits on, its result, or status, and linked PRs. [agent-view]

**What a fork is.**
- A fork is a subagent that "inherits the entire conversation so far instead of starting fresh... Its tool calls stay out of your conversation, and only its final result comes back". [sub-agents, "Fork the current conversation"]
- Invoke with `/subtask <task>` (v2.1.212+; `/fork` on v2.1.161–2.1.211, and `/fork` starts a forked subagent whenever agent view is turned off). Claude can also request the `fork` type through the Agent tool.
- A fork shares the parent's system prompt, tools, model and cache, so its first request reuses the parent's prompt cache. A fork cannot spawn further forks. It keeps the parent's exact tool pool.
- Distinct command: `/fork [prompt]` copies the whole session into a new background session (its own row in agent view) while the original keeps running. Forked sessions are independent unless cross-session messaging is on. [agent-view, "Fork concept"; commands]
- `/btw` answers a side question without tools. Pressing `f` in the overlay forks the question and answer into a background subagent with full tools. [interactive-mode, "Side questions"]

## 3. Agent teams / teammates (experimental)

**Status.** Experimental and off by default. Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the environment or `settings.json` `env`. Interactive sessions only. [agent-teams]

**Team panel (in-process mode, the default).** Teammates appear in an agent panel below the prompt.
- `↑`/`↓` select a teammate, `Enter` opens its transcript and lets you type to it, `Esc` clears the selection (and, inside a teammate's transcript, interrupts that teammate's current turn), `x` stops a selected teammate, and Ctrl+T toggles the task list.
- Idle rows hide 30 seconds after the whole panel goes idle and return on the teammate's next turn. With more than three idle, extras collapse to `N idle agents`, which Enter expands. [agent-teams, "Start your first agent team" and "Talk to teammates directly"]

**Split-pane mode.** Each teammate gets a tmux pane or an iTerm2 split (requires `tmux` or `it2`). Set `teammateMode` to `in-process` (default), `auto`, `tmux` or `iterm2`, or pass `--teammate-mode`. Split panes are not supported in VS Code's integrated terminal, Windows Terminal or Ghostty. [agent-teams, "Choose a display mode"]

**Sending messages.** Plain text and skills go to the selected teammate. Built-in commands go to the lead. `/compact`, `/clear` and `/rewind` act on the lead, so Claude Code asks you to confirm first. `/model` and `/fast` are blocked from the teammate view. [agent-teams, "Talk to teammates directly"]

**Shared task list.** Tasks have three states: pending, in progress, completed. Pending tasks with unresolved dependencies can't be claimed. The lead can assign tasks, or teammates self-claim the next unblocked task. File locking prevents double claims. Dependencies unblock automatically on completion. The list is stored at `~/.claude/tasks/{team-name}/`. [agent-teams, "Assign and claim tasks" and "Architecture"]

**Messaging.** Each agent has a JSON mailbox at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`. Teammates message each other directly by name. Idle notifications send the final answer to the lead automatically. [agent-teams, "Architecture" and "Context and communication"]

**Separation of output.** Each teammate has its own context window. In-process output is separated by selecting the teammate's transcript. In split panes, each has its own terminal pane. Permission prompts from teammates appear in the lead session. [agent-teams, "Permissions"]

**Plan approval.** A teammate spawned while the lead is in plan mode works read-only until its plan is ready. It then sends a plan-approval request, which the lead session approves automatically. [agent-teams, "Have teammates plan before implementing"]

**Quality-gate hooks.** `TeammateIdle` (exit 2 keeps it working), `TaskCreated` and `TaskCompleted` (exit 2 blocks and returns feedback). [agent-teams, "Enforce quality gates with hooks"; hooks guide, partly truncated]

**Limitations.** No session resumption of in-process teammates (`/resume` and `/rewind` do not restore them). One team per session. No nested teams. In-process teammates' own subagents run in the foreground, and `background: true` fails for them. The lead is fixed. [agent-teams, "Limitations"]

**Cost.** Teams use significantly more tokens. In-process teammates' cache holds five minutes by default; `subagentPromptCacheTtl: "1h"` extends it. [agent-teams, "Token usage"]

## 4. Nested agents

- Subagents can spawn subagents "up to **three layers** below the main conversation". [sub-agents, "Nesting and limits"]
- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` sets the limit. A value of `1` disables nesting.
- At the limit the `Agent` tool is withheld from subagents, except that a fork at the limit gets an error instead of spawning.
- Concurrency: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20). Exceeding it returns `Concurrent subagent limit reached`.
- To stop a subagent spawning others, omit `Agent` from `tools` or put it in `disallowedTools`.
- Display: **[not documented]**. The docs describe a tree in `/tasks` only by saying it lists subagents and their transcripts. The changelog entry for 2.1.290 says the VS Code agent map showed a "nested sub-agent" and placed agents it starts under the main agent, which suggests a tree view exists in VS Code. The terminal tree form is **[unverified]**.
- Nested agents are not explicitly described as having their own panel rows. A subagent's own background children appear in `/tasks`. **[unverified]**

## 5. Custom agent definitions

**File location and precedence** (highest first). [sub-agents, "Scope and precedence"]
1. Managed settings (organisation)
2. `--agents` CLI flag (JSON; a file path in non-interactive mode)
3. `.claude/agents/` (project; found by walking up from the working directory; closest wins)
4. `~/.claude/agents/` (all projects)
5. Plugin `agents/` directory (where the plugin is enabled)

Scanning is recursive; only `name` identifies an agent. Plugin subfolders join the name, so `my-plugin/agents/review/security.md` becomes `my-plugin:review:security`. Higher-priority names win on collision. `--add-dir` directories also contribute. Files edited in watched directories are picked up within seconds. A new `agents` directory needs a restart. [sub-agents]

**Frontmatter fields** (table transcribed from the docs; the docs give no formal default column except where noted). [sub-agents, "Supported frontmatter fields"]

| Field | Type / values | Notes |
|---|---|---|
| `name` | string, up to 256 chars | Required. No `:`, must not start with `-` |
| `description` | string | Required. Drives delegation. Keep it short; keep all descriptions under about 15,000 tokens combined |
| `tools` | comma string or YAML list | Omitted = inherit all subagent-available tools |
| `disallowedTools` | same format | Removed from the inherited or listed set. Takes precedence over `tools` |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, full ID, or `inherit` | If omitted, the model resolution order applies |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Overrides the session level for that subagent |
| `color` | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` | Display only |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` | Ignored when the parent is `bypassPermissions`, `acceptEdits` or `auto`. Plugin agents cannot set it |
| `hooks` | hook config | Scoped to the subagent. Ignored for plugin subagents |
| `skills` | list of skill names | Full skill content preloaded. Max 32, each once (changelog 2.1.295) |
| `memory` | `user`, `project`, `local` | Persistent memory; adds Read/Write/Edit |
| `mcpServers` | names or inline configs | Ignored for plugin subagents |
| `maxTurns` | integer | Result is marked partial at the limit |
| `background` | boolean | Keeps it in the background |
| `isolation` | `worktree` | Runs in a temporary git worktree; auto-removed if no changes |
| `initialPrompt` | string | First user turn when run as the main agent |
| `omitClaudeMd` | boolean | Skips all CLAUDE.md files (2.1.271+) |
| `experimental` | map, `cacheTtl`: `5m` or `1h` | Prompt cache lifetime (2.1.248+) |
| `autoCompactWindow` | number | Subagent-specific auto-compact window (2.1.296) |

Example from the docs:

```yaml
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
memory: project
---
```

Unknown fields are ignored. Files with no `name`, or with unparseable YAML, are skipped silently or with a debug-log entry. Run `/doctor` to see duplicate names in the same directory. [sub-agents, "/agents command UI"; debug-your-config]

**What a subagent inherits** [sub-agents, "What a subagent inherits"]
- Starts fresh: its system prompt (the Markdown body; it replaces the Claude Code system prompt and only environment details are appended), the task message the parent writes, all CLAUDE.md files (unless `omitClaudeMd`; Explore and Plan skip them), a git status snapshot (Explore and Plan skip it), preloaded skills, and a sibling roster when `SendMessage` is available.
- Inherited from the parent: tools (narrowed by the filters above; background subagents get a smaller built-in set, and MCP tools are kept), permission mode (in the cases above), extended-thinking setting, `settings.json` hooks (including `PreToolUse`, which fires inside subagents), and permission rules.
- Not inherited: output style, auto memory, the parent's context window size (each subagent is sized by its own model).

**`/agents` UI.** On v2.1.197 and earlier, `/agents` opens a wizard with a **Running** tab and a **Library** tab (create, edit, delete). On later builds it prints a reminder to ask Claude or edit `.claude/agents/` and `~/.claude/agents/` directly. **Check which behaviour the target build has.** [sub-agents; commands]

## 6. Permission handling for subagents

- **Foreground:** prompts pass straight through to the user. [sub-agents]
- **Background:** prompts surface in the main session and name the requesting subagent. Approve to continue, or press **Esc** to deny that one tool call. [sub-agents]
- A session-wide grant from a background prompt applies to the whole session, including the main conversation. [sub-agents]
- `Ctrl+X Ctrl+K` can be pressed while a background prompt is open. [interactive-mode]
- `dontAsk` auto-denies prompts. Explicitly allowed tools still run. [sub-agents]
- **Auto mode:** a classifier reviews each subagent tool call and its final report. The `SubagentHandback` tool, present only in auto mode, delivers the report after the classifier reviews it. [sub-agents; tools-reference]
- Agent messages are never approval. "No agent message counts as user approval for a pending permission prompt." In teams, a message from another agent is treated as untrusted. [sub-agents; agent-teams, "Messages between agents"]
- Permission rules can disable subagent types: `Agent(Explore)` or `Agent(my-custom-agent)` in `permissions.deny`, or `claude --disallowedTools "Agent(Explore)"`. [tools-reference]

## 7. Cost and context display

**Status line.** Set via `statusLine` (a shell command receiving JSON on stdin). The payload includes `model`, `workspace` (`current_dir`, `project_dir`, `added_dirs`, `git_worktree`, `repo`), `cost` (`total_cost_usd`, `total_duration_ms`, `total_api_duration_ms`, `total_lines_added`, `total_lines_removed`), `context_window` (`total_input_tokens`, `total_output_tokens`, `context_window_size` (200000 default, 1000000 for extended-context models), `used_percentage`, `remaining_percentage`, `current_usage`), `exceeds_200k_tokens`, `rate_limits` (five-hour and seven-day `used_percentage` and `resets_at`, plus `spend_limit`), `prompt_cache`, and `agent.name` (with `--agent`). [statusline, "Available data"]
- `used_percentage` is computed from input tokens only (`input + cache_creation + cache_read`), not output. [statusline]
- The docs' example script uses **green under 70%, yellow 70–89%, red 90% and above**. This is the script's own choice, not a built-in threshold. [statusline, multi-line example]
- A custom status line hides most built-in footer hints, including `esc to interrupt`. [statusline]
- The `prompt_cache` object explicitly does not count subagent requests. [statusline, "Prompt cache fields"]

**`/usage` (alias `/cost`, `/stats`).** The Session block shows total cost (computed locally at list price unless `modelPricing` is set), API duration, wall duration, code changes, and usage by model with cache read/write. `/clear` resets it. A `Prompt cache (main)` line covers the main conversation only, "not subagents". On Pro, Max, Team and Enterprise, a plan breakdown attributes recent usage to "skills, subagents, plugins, and individual MCP servers, each shown as a percentage of the total". Press `d` or `w` to switch between 24 hours and 7 days. [costs, "Using the /usage command" and "Plan usage breakdown"]

**Subagent cost in the session total.** The docs say subagent requests "count toward the same usage limits as the main conversation", and that background subagents "use their own tokens while they run". They do not say explicitly whether `cost.total_cost_usd` or the `/usage` Session total includes subagent spend. **[unverified; test on a real build before copying the behaviour]**

**`/context`.** "Visualize current context usage as a colored grid. Shows optimization suggestions for context-heavy tools, memory bloat, and capacity warnings." The breakdown covers system prompt, system tools, MCP tools, custom subagents (with the source each loaded from), memory files, skills and conversation messages. In fullscreen, the per-item breakdown collapses; `/context all` expands it. [commands; debug-your-config] The status line and `/context` can disagree briefly: `/context` adds an estimate for messages since the last API response. [statusline, Troubleshooting]

Illustrative `/context` shape (**the exact text is not in the docs; this mockup is my structure based on the documented categories**):

```
 Context usage  48.2k / 200k  (24%)
   System prompt        4.2k
   System tools        11.0k
   MCP tools            1.1k   (deferred)
   Custom subagents     0.6k   code-reviewer (project)
   Memory files         0.9k   CLAUDE.md, MEMORY.md
   Skills               0.4k
   Messages            30.0k
   Autocompact buffer  33.0k
```

**Context colours and auto-compact thresholds.**
- The docs do not define a built-in colour scheme for context warnings. The `/context` output uses colour and includes "capacity warnings". The exact colour thresholds are **[not documented]**.
- Auto-compact window (from the model-config reader excerpt): models with a native 1M window (Fable, Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later) compact "at about 967K tokens by default". Sonnet 4.6 and Opus 4.6 without extended context compact at the 200K boundary. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces the 200K boundary. [model-config]
- Override order (highest first): `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var; `/autocompact <size>` (e.g. `500k`, `auto` to reset; saved per model since 2.1.288); `--autocompact` flag; `autoCompactWindow` setting (also in subagent frontmatter). Accepted range 100K to 1M. [model-config; commands]
- `DISABLE_COMPACT` disables all compaction. [model-config]
- A context or auto-compact warning "is not a usage limit". [costs]

## 8. Steering a running agent

- **Message a running foreground or background agent.** Open its transcript from the panel (Enter) and type. Plain text and skills go to that agent. `Ctrl+Enter` or `Ctrl+X Ctrl+S` sends the message now, so the agent reads it before its current wait finishes (2.1.286+). [sub-agents, "Observe and steer"; interactive-mode, "Queue messages"]
- **Message from the main session.** Claude can call `SendMessage` with `to` set to an agent ID or name. This does not require teams. [sub-agents, "Resume subagents"; tools-reference]
- **Interrupt.** `Esc` in the main session stops the current response or tool call mid-turn. The work done so far is kept. Queued messages are then sent. With a panel row selected, Esc deselects the row instead. [interactive-mode]
- **Resume a finished agent.** A subagent returns an agent ID on completion. `SendMessage` to that ID or name resumes it in the background with its full history, tool calls and reasoning. Resuming starts a new run under the same ID. Explore and Plan are one-shot and cannot be resumed. `SendMessage` refuses a name that now points to a newer agent. [sub-agents]
- **User-stopped agents do not auto-resume.** A message to one that you stopped with `x` is refused. Sending a finished agent a message resumes it. [sub-agents]
- **Completion.** The final report goes to the parent, as the Agent tool result (foreground) or a completion notification (background). Claude relays it. The docs do not say the raw report is shown to the user. **[not documented]**. The user can read it by opening the agent's transcript in `/tasks` or the panel.
- **Transcripts.** `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. They persist across main-conversation compaction and are deleted after `cleanupPeriodDays` (default 30). [sub-agents]
- **Stop-all.** `Ctrl+X Ctrl+K`, twice within 3 seconds. [interactive-mode]

## 9. Handoff and continuation when context runs out

Anthropic's documented patterns, none of them a formal "handoff file" convention:

1. **Delegate verbose work to a subagent.** "Delegate verbose operations to subagents so the verbose output stays in the subagent's context while only a summary returns." [costs, "Delegate verbose operations"; context-window]
2. **`/compact [instructions]`.** Summarises the conversation so far. Focus text is optional, e.g. `/compact Focus on code samples and API usage`. A `# Compact instructions` section in CLAUDE.md steers every compaction. [commands; costs]
3. **Auto-compaction** at the window in section 7. After compaction, the system prompt, CLAUDE.md, memory and MCP tools reload. Claude re-reads up to five recently modified files, and re-injects the bodies of invoked skills (capped at 5,000 tokens each). Skill listings are not re-injected. [context-window simulation text]
4. **`/clear` plus `/rename` and `/resume`.** Use `/rename` before clearing so you can find the old session, then `/resume` to return to it. [costs, "Manage context proactively"]
5. **Resume from a summary.** On Pro and Max, when a large session is resumed after a long break, Claude Code offers to resume from a summary. [costs, "Why usage climbs"; sessions]
6. **Continue in a new session.** `/fork` copies the conversation into a new background session. `/background` detaches the current one. [agent-view]
7. **Subagent results.** Returned as text in the Agent tool result (foreground), or in a completion notification (background). Output is scanned before Claude reads it, and "subagent results are marked as subagent output, and they carry no user authority". Partial output is returned with a note when a run is cut off. The docs do not describe a file-based return convention for subagents. **[not documented]**
8. **Transcript files** persist per agent, so the parent or a human can re-read the full child run without it entering the parent's context. [sub-agents]

## 10. Keyboard shortcuts and visual language

**Core keys** (from interactive-mode, "General controls"):

| Key | Effect |
|---|---|
| `Esc` | Interrupt Claude; close a dialog; deselect a panel row. Declines a permission prompt |
| `Ctrl+B` | Background a running Bash command or agent (tmux: press twice) |
| `Ctrl+O` | Toggle transcript viewer (tool detail, timestamps, model per message, expanded collapsed lines) |
| `Ctrl+E` | Show all content in the transcript viewer (classic renderer only) |
| `Ctrl+T` | Toggle Claude's to-do checklist (not the background view) |
| `Ctrl+X Ctrl+K` | Stop all background subagents in the session (press twice within 3 s) |
| `Ctrl+Enter` / `Ctrl+X Ctrl+S` | Send queued messages now; when the turn is running a background-able tool, that work moves to the background and keeps running |
| `Ctrl+G` / `Ctrl+X Ctrl+E` | Edit the prompt in the external editor |
| `Ctrl+C` | Interrupt; first press clears input, second exits |

**Panel keys** (sub-agents, "Observe and steer"): `↑`/`↓` move, `Enter` opens transcript and messages, `x` stops or dismisses, `Esc` returns to prompt.

**Agent view keys** (agent-view, "Keyboard shortcuts"): `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`, `Enter` or `→` attach, `Space` peek, `←` detach (or background and open agent view), `Alt+1`..`Alt+9` attach to session N in the focused directory, `Tab` browse subagents on an empty input, `Ctrl+S` group by state or directory, `Ctrl+T` pin, `Ctrl+F` find by name (`n:` filter), `Alt+↑`/`Alt+↓` jump between groups, `Ctrl+R` rename, `Ctrl+G` edit dispatch in `$EDITOR`, `Shift+↑`/`Shift+↓` reorder, `Ctrl+X` stop (twice within 2 s to delete), `Esc` close peek or clear, `Ctrl+C` clear (twice to exit), `?` help. Filters: `a:<agent>`, `s:<state>`, `n:<text>`, `o:<text>`, `#1234` (PR).

**Transcript viewer (fullscreen)** (fullscreen): `/` search, `n`/`N` next/previous match, `{`/`}` previous/next prompt, `g`/`G` top/bottom, `Ctrl+u`/`Ctrl+d` half page, `[` write whole transcript to scrollback, `v` open in `$EDITOR`.

**Visual language, documented**
- Panel and agent-view icons: `✽` / `✻` animated while working; `✢` for `/loop` sleeping; `∙` for exited; yellow = needs input; dimmed = idle; green = completed; red = failed; grey = stopped. PR badges: yellow pending or failing checks, green passing, purple merged, grey draft or closed. [agent-view]
- Panel row default: `name · description · token count`. [statusline]
- Background tasks and the Ctrl+T checklist are kept visually separate. [interactive-mode]

**Visual language, from third-party transcripts only [unverified for 2026]**
- Tool call bullet `⏺` (e.g. `⏺ Search(pattern: "**/*.html")`), result line prefixed `⎿`, Task summary `⎿  Done (N tool uses · X tokens · Ys)`, and the hint `(ctrl+o to expand)` under collapsed results. [Simon Willison, 2025]
- Nested tree characters: **[not documented]** in the official docs.

**Fullscreen/agent-view layout behaviour** [fullscreen]: the prompt stays fixed at the bottom while output scrolls. A `Jump to bottom` button appears when scrolled up, with a count such as `3 new messages`. Mouse wheel and click expand are supported. `viewMode` sets the default view.

## 11. Recommended UX patterns for the pi extension

Priority legend: **MVP** = must copy for the first release. **Later** = nice-to-have after MVP.

### MVP (must copy)

1. **Single-line start and finish rows for every agent.** Start row: agent name, one-line description, status icon. Finish row: `Done (N tool calls · tokens · elapsed)`. This is the cheapest way to show progress without flooding the main transcript. Source: sections 1 and 10.
2. **A panel below the prompt** listing the main session and every running agent at any depth, with status icon, description, live token count and elapsed time. Keys: `↑`/`↓` select, `Enter` opens and messages, `x` stops, `Esc` deselects. Finished rows linger for about 30 seconds, failed and stopped rows for longer. Sources: sections 2 and 10.
3. **Background by default, with a completion notification that wakes the caller.** Batch completion for parallel runs matches pi's plan (wake once when the whole batch is done). Show `/tasks`-style "see agents" hint in the footer for 30 seconds after completion. Sources: section 2.
4. **Per-agent transcript view** opened from the panel, with Ctrl+O-style toggling of tool detail and expanded collapsed lines. Messaging from this view goes to that agent. Source: sections 1, 8.
5. **Esc semantics**: interrupt the current turn (keeping work done), deny one permission prompt, deselect a row. Stop is a separate key (`x`). Source: sections 6, 8.
6. **Permission prompts name the agent asking.** Background prompts surface in the main session with the agent's name. A session-wide grant applies to the whole session. Agent messages never count as approval. Source: section 6.
7. **Stop and stop-all.** Per-agent stop plus a stop-all chord with confirmation (press twice within 3 seconds), like `Ctrl+X Ctrl+K`. Source: sections 2, 8.
8. **Resume by ID with full history**, and a rule that user-stopped agents do not resume. This maps to pi's "continue" action. Note the conflict: pi's plan says a closed agent is final and continuation is a new agent from a handoff file. Claude resumes in place. Decide which one pi follows, and make the UI say so. Source: section 8.
9. **Per-row cost and a session total in the footer**, with a breakdown that attributes spend to subagents. Claude's docs leave it unclear whether subagent spend is in the session total, so pi should make the rule explicit and test it. Source: section 7.
10. **Agent definition files** as Markdown with YAML frontmatter. Use `name`, `description`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `background`, `skills`, `omitClaudeMd`, with project-over-user precedence. The frontmatter list is a good baseline. Source: section 5.
11. **Configurable depth and concurrency** with defaults of 3 levels and 20 concurrent agents. Claude withholds the spawn tool at the depth limit, and a fork at the limit returns an error. Pi's default of 3 (four possible) fits. Source: section 4.
12. **A context breakdown view (`/context`-style)** with categories (system prompt, tools, memory, skills, messages, free space), and a visible auto-compact or handoff threshold. Pi's soft and hard limits map to this. Use the docs' example colours (green under 70%, yellow 70–89%, red 90% and above) as a starting point, not a standard. Source: section 7.
13. **A "system prompt as collapsible sections" block at the top of an agent transcript.** Claude has no equivalent in the docs, so this is pi's own addition. It fits the principle that the transcript records what was sent. Source: pi handoff, plus section 5 (what a subagent inherits).

### Later (nice to have)

14. **Agent view as a separate dashboard** with state groups (Pinned, Ready for review, Needs input, Working, Completed), filters such as `s:` and `a:`, and a find key. Source: section 2.
15. **Peek (`Space`)** showing the question the agent waits on and its result, without attaching. Source: section 2.
16. **Message queue while an agent works**, with a send-now chord that moves the running background work to the background. Source: section 8.
17. **Worktree isolation per agent** (`isolation: worktree`), with a refusal to delete uncommitted work. Source: sections 5, 2.
18. **Teams-style shared task list with dependencies and claiming** and a per-agent mailbox. This goes beyond pi's "agents never talk to each other" rule, so it is a later decision. Source: section 3.
19. **Plan-approval gate** for read-only planning agents before implementation. Source: section 3.
20. **Quality-gate hooks** (`TeammateIdle`, `TaskCreated`, `TaskCompleted` style: exit code 2 keeps the agent working or blocks completion). Source: section 3.
21. **Customisable panel row** via a script that receives per-agent JSON (`tokenCount`, `tokenSamples`, `status`, `label`, `model`, `contextWindowSize`). Source: section 7.
22. **Focus and verbose view modes** persisted per user. Source: section 1.
23. **Cache-aware fork.** A fork shares the parent's prompt cache, and Claude's in-process teammates have a five-minute cache by default, with `1h` as an opt-in. This is directly relevant to pi's "never break your own prompt cache" rule. Source: sections 2, 3.
24. **Push or terminal notification** on "needs input" and "completed". Source: section 2.

## Source list

Official docs (code.claude.com/docs/en/...):
- sub-agents.md — https://code.claude.com/docs/en/sub-agents.md
- agent-view.md — https://code.claude.com/docs/en/agent-view.md
- agent-teams.md — https://code.claude.com/docs/en/agent-teams.md
- interactive-mode.md — https://code.claude.com/docs/en/interactive-mode.md
- tools-reference.md — https://code.claude.com/docs/en/tools-reference.md
- commands.md — https://code.claude.com/docs/en/commands.md
- costs.md — https://code.claude.com/docs/en/costs.md
- statusline.md — https://code.claude.com/docs/en/statusline.md
- settings-reference.md — https://code.claude.com/docs/en/settings-reference.md (index entries only; the reader truncated it)
- model-config.md — https://code.claude.com/docs/en/model-config.md (auto-compact and effort sections; truncated)
- context-window.md — https://code.claude.com/docs/en/context-window.md (interactive simulation; text extracted from its data)
- debug-your-config.md — https://code.claude.com/docs/en/debug-your-config.md
- fullscreen.md — https://code.claude.com/docs/en/fullscreen.md
- hooks.md — https://code.claude.com/docs/en/hooks.md (truncated; SubagentStart/Stop and Team hook details not read in full)
- changelog.md — https://code.claude.com/docs/en/changelog.md (entries 2.1.288 to 2.1.296, Oct 2026)
- Docs map — https://code.claude.com/docs/en/claude_code_docs_map.md

Third-party:
- Simon Willison, "Claude Code sub-agents" (11 Oct 2025): https://simonwillison.net/2025/Oct/11/sub-agents (2025 transcript; line format only)

Known gaps: the docs do not show a screenshot of the foreground agent start line, do not describe a live spinner or tool-call counter for foreground agents, do not say whether subagent cost is in the session total, and do not describe nested agent display in the terminal. Verify these on a live build before copying them.
