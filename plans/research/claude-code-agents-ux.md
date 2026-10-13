# How Claude Code presents background subagents to the user

Research notes, 2026-10-13. Subject: Claude Code CLI 2.1.296 (the locally installed binary at
`/Users/maxim/.local/share/claude/versions/2.1.296`), the official docs at code.claude.com and the
public CHANGELOG.md. Scope: only the subagent / background-task UX. Nothing else about Claude Code.

Evidence conventions:

- `docs:` = quoted from https://code.claude.com/docs/en/<page> (sub-agents, interactive-mode,
  commands, keybindings, tools-reference, statusline, settings-reference, agent-teams).
- `bin:` = string extracted verbatim from the 2.1.296 binary (`strings` over the Bun-compiled
  JS). Template fragments are quoted as they appear in the minified source.
- `changelog <version>:` = line from https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
  with the version header it sits under.
- Anything not confirmed by one of those is marked "unconfirmed" and kept separate.

## Summary of the UX model (10 lines)

1. Subagents are background by default in an interactive session ("fork mode" on); Claude cannot ask for the foreground. Foreground only when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` or for teammates' subagents.
2. There are three surfaces: (a) a collapsed Agent tool block in the transcript, (b) the "subagent panel" (a few rows under the prompt), (c) the `/tasks` dialog (alias `/bashes`), which is the full list plus detail/transcript view.
3. `/agents` is NOT the running list; it only prints a reminder about editing agent definition files (older versions: a definition wizard). Ctrl+T is the to-do checklist, not tasks.
4. Transcript block: `Running **N** agents…` (or `Running N Explore agents…`) with one row per agent `Type (description) · N tool uses · X tokens` and a status line (`Initializing…`, last tool, `Running in the background`, `Done`). When all are done: `**N** agents finished` or `**N** background agents launched (↓ to manage)`. Foreground agents additionally show their last few tool calls inline with `(ctrl+o to expand)`.
5. Panel rows under the prompt: pointer, status glyph (`○`, filled when viewed), name (`(+N)` descendants), description or latest progress summary, right-aligned `elapsed · ↓ 12.3k tokens`, warning-colored `N queued`. Max 5 rows, `↑ N more` on the `main` row when scrolled. Idle rows auto-hide after 30 s; >3 idle collapse into `N idle agents`.
6. Panel keys (Footer context): ↑/↓ select, Enter view, `x` stop (or clear if finished), Esc collapse/deselect, Ctrl+X Ctrl+K stop all (twice within 3 s). The footer hint reads `enter to view · x to stop · esc to collapse · ctrl+x ctrl+k to stop all agents`.
7. Lifecycle in the panel: a successful finish removes the row immediately and shows `/tasks to see subagents` in the footer for 30 s; a failed/stopped row lingers 30 s (dismiss sooner with `x`).
8. `/tasks` dialog: title `Background`, subtitle `N active agents · N active shells`, grouped sections `Shells`, `Monitors`, `MCP tasks`, `Cloud agents`, `Local agents`, `Completed (n)`, `Dynamic workflows`, `System tasks`; rows show a status icon, description, `running|done|waiting|parked[, unread]` and `model · effort`. Keys: `↑/↓ to select · enter to view · f to foreground · x to stop · ctrl+x ctrl+k to stop all agents · esc to close`. Enter opens the agent transcript (prompt placeholder becomes `Message @name…`, header `Viewing @name · esc to return`).
9. Completion lands in the transcript as a dim one-line task notification whose text is the model-facing summary `Agent "<description>" finished` (red for `failed: …`, gold for `was stopped by user`) with ` · <duration>` detail and `sent N messages (ctrl+o)` sublines; the model gets a `<task-notification>` and the tool result ends with `Done (N tool uses · X tokens · Ns)`.
10. Esc interrupts only the main turn; background agents keep running. The post-response line then reads `Waiting for **N** background agents to finish`. Ctrl+X Ctrl+K is the only "stop all" gesture; `x` in the panel or `/tasks` stops one (no confirmation except for `/ultrareview`).

## 1. The agents / tasks list widget

### Facts

Which command. `/tasks` (alias `/bashes`) is the running-work list:

- docs commands: "`/tasks` | View and manage background work in the current session, including subagents that have finished. Also available as `/bashes`".
- docs interactive-mode: "`Ctrl+T` | Toggle Claude's task checklist | … This is not the background-task view; use `/tasks` to see running shells and subagents".
- docs keybindings: "`app:toggleTodos` | Ctrl+T | Toggle visibility of Claude's to-do checklist. This is not the `/tasks` background-task view".
- `/tasks` runs immediately even mid-turn: docs commands: "Claude Code runs some commands immediately without interrupting the response, such as `/status`, `/tasks`, and `/usage`."

`/agents` is the definition manager, not the running list:

- docs commands: "`/agents` | Print a reminder to ask Claude to create or manage subagents, or to edit `.claude/agents/` or `~/.claude/agents/` directly. On v2.1.197 and earlier, opens an interactive interface for creating and managing subagent configurations".
- docs sub-agents (summary of the same page): on v2.1.197 and earlier the wizard had a "Running" tab and a "Library" tab. Today the running list lives only in `/tasks` and the panel.

Two distinct "list" surfaces exist:

(a) The subagent panel below the prompt (always visible while agents run), docs sub-agents: "Running forks appear in a panel below the prompt input, with one row for the main session and one for each fork." and "Claude Code shows nested subagents as a tree in the subagent panel below the prompt input and marks each row that still has descendants in the panel with a `(+N)` count of them. Open a row to see that subagent's siblings and direct children with a path back to `main`."

(b) The `/tasks` dialog (full list, grouped, with detail view).

What a panel row shows (bin, component `Yoe` and `zoe`):

- Main row: `${pointer}${glyph} main` — bin: `children:[Le,He," main"]` where `Le = te.pointer+" "` when selected, `He = M ? uo : te.circle` (filled glyph when that row is the one being viewed, `○` otherwise). Overflow marker on the main row: bin: `` $e=ee>0?`${CN} ${ee} more`:"" `` with `CN="↑"`, i.e. `↑ 3 more`.
- Agent row: pointer + tree connector (`treeConnector`) + status glyph coloured by `D1(status)` (bin: `case"completed":return"success";case"failed":case"killed":return"error"`), then label `P1(T)` = agent type (or `@name` for teammates) plus `descendantSuffix` (bin: `` zRt(n) => ` (+${n})` ``), then the description column which prefers the latest progress summary (bin: `Et=Nr(T.progress?.summary??"")||Nr(T.description)`), then a right-aligned status: `[elapsed, tokenText].join(" · ")` plus a warning-coloured `N queued` (bin: `` he=ee>0?`${ee} queued`:"" ``) and an optional link.
- `tokenText` is `↓ 12.3k tokens` (down arrow while the agent has recent tool activity, up arrow otherwise): bin: `` Te=h.progress?.lastActivity?te.arrowDown:te.arrowUp,Me=we!==void 0&&we>0?`${Te} ${Bs(we)} tokens`:"" ``.
- `elapsed` values (bin `BNe`): running agent → live `rn(now - startTime - totalPausedMs)` (formatted duration); agent blocked on its own nested agent → `"waiting"`; completed and kept → `"idle"`; teammates add `"awaiting approval"`. changelog 2.1.181: "Fixed subagents blocked on a nested agent showing a ticking elapsed time instead of "waiting" in the agent panel".
- docs settings-reference `subagentStatusLine`: "Claude Code lists them in a task display below the prompt, one row per subagent showing `name · description · token count`." (The `tasks` JSON given to that hook carries `id`, `name`, `agentType`, `description`, `status`, `model`, `effort`, `tokenCount`, `cwd`.)
- Row cap and idle handling: changelog 2.1.181: "Improved the subagent panel: idle subagents auto-hide after 30s, the list caps at 5 rows with scroll hints, and keyboard hints now show in the footer". bin constants: `n1=5,Koe=3` (5 visible rows, idle collapse threshold 3). Collapsed row text: bin: `` Ct=T===1?"1 idle agent":`${T} idle agents` `` with a `○` glyph. docs agent-teams: "When more than three teammates are idle at once, the rows beyond the first three collapse into a single row that counts the collapsed teammates, such as `2 idle agents` when five are idle. Select it and press Enter to expand the collapsed rows, or press Esc to collapse them again."
- Model/effort on the row (via `/tasks`): docs sub-agents: "To check which model a subagent is running on, run `/tasks`. Claude Code names the model on the subagent's row, and adds the effort level set for that subagent, if any. Requires Claude Code v2.1.242 or later."

What a `/tasks` row shows (bin, `NG` and the dialog):

- Dialog chrome: bin: `title:"Background"`, subtitle built from counts: `` `${pp} agents` `` (teammates), `` `${mp} active shells|active shell` ``, `` `${Vd} active agents|active agent` ``. Empty state: bin: `"No tasks currently running"`.
- Sections (bin headings with `(count)`): `Shells`, `Monitors`, `MCP tasks`, `Cloud agents`, `Local agents`, `Completed`, `Dynamic workflows`, and `System tasks` (bin: `JG="System tasks"`, row meta `` `${pw.size} hidden` ``). changelog 2.1.285: "Changed `/tasks` to fold background work Claude Code runs for itself under one "System tasks" row; press Enter on it to show those tasks".
- Local agent row (bin `case"local_agent"`): `label: h.description`, `icon:` status icon (`pk(status)`; pending-style icon with aria-label `waiting:` or `parked:`), `meta: [ "running" | "done" | "waiting" | "parked" + (completed && !notified ? ", unread" : ""), "<model> <effort>" ]`. Shell row: label = command, meta = status. Workflow row meta: `` `${h.agentCount} agents` `` while running.
- changelog 2.1.283: "Improved `/tasks`: rows show a status icon, the name and whole facts, the title and key hints stay on screen with many tasks, and the list gains paging keys, the mouse wheel and clicks". changelog 2.1.284: "the details after each name now line up in one column when they fit, and otherwise sit at the right edge".
- Grouping/sorting: running work first, completed below. docs sub-agents: "A background subagent that completes stays listed in `/tasks`, marked done and sorted below running work, for the same 30 seconds as the footer hint."
- changelog 2.1.6: "Improved the `/tasks` dialog to go directly to task details when there's only one background task running".

When rows are removed (docs sub-agents, "Run subagents in foreground or background"):

- "When a subagent finishes successfully, Claude Code removes its row immediately and, except in screen reader mode, shows `/tasks to see subagents` in the footer for 30 seconds. During those 30 seconds, run `/tasks` and press `Enter` on the subagent to open its transcript. Before v2.1.232, Claude Code kept the row for 30 seconds after the subagent finished, the same as a failed one, and showed no footer hint."
- "When a subagent fails or you stop it, Claude Code keeps its row for 30 seconds. To clear the row sooner, select it and press `x`."
- "A background subagent that completes stays listed in `/tasks`, marked done and sorted below running work, for the same 30 seconds as the footer hint. Its detail view stays open when the subagent finishes. Subagents that fail or that you stop leave the list. Before v2.1.208, a completed subagent left the list the moment it finished and its detail view closed."
- changelog 2.1.232: "Updated agent panel: completed subagents hide immediately with a `/tasks` footer hint, and the "↓ N more" overflow indicator moved left for visibility".
- Teammate idle rows: docs agent-teams: "Once every agent in the panel is idle, idle rows hide after 30 seconds and reappear on the teammate's next turn".

### Unconfirmed / inferred

- The exact status glyph set (`pk(status)`) was not decoded; the panel uses `te.circle` (`○`) for not-viewed rows and a distinct glyph for the viewed row. The `/tasks` icons are most likely the generic status glyphs (tick / cross / spinner-dot) shared with other dialogs.
- Whether the panel shows `↓ N more` on the last row as well as `↑ N more` on `main`: the changelog says "↓ N more" exists; the binary shows `↑ N more` on the main row. Inference: both directions exist, depending on scroll position.

## 2. The footer / status line while agents run

### Facts

- There is no "N background tasks (↓ to view)" text in 2.1.296. What exists:
  - While agents run: the panel itself (rows described above) plus a hint line. With no row selected the hint is `↑/↓ to select · enter to view` (bin `T1`: when nothing is selected it emits `{chord:h.select,action:"select"}` / `{chord:h.open,action:"view"}`).
  - After a success: bin: `"/tasks to see subagents"` rendered dim in the footer (`Rce()`), for 30 s (docs above).
  - After the main turn ends while agents still run, the post-response timer line reads: bin: `children:["Waiting for",re,ge,oe," to finish"]` where `re` = `` ` ${bold N} background agents` `` and `oe` = `` ` ${bold N} dynamic workflows` `` joined by `" and"`. changelog 2.1.152: "The post-response timer now shows "Waiting for N background agents/workflows to finish" when backgrounded agents or workflows are still running, and reports the cumulative time once their results are processed". Otherwise that line is `` `${verb} for ${duration}` `` plus `` ` · done ${time}` ``.
  - Right-aligned footer area carries "background agent status" (changelog 2.1.236: "Right-aligned footer items (goal indicator, session state, background agent status) and truncated notices now share a consistent right margin").
- Per-agent line vs summary line: per-agent rows (the panel), capped at 5, plus the single-line hints. Not a single summary line.
- The key that opens the list from the footer: the panel rows are a "footer item"; docs keybindings Footer context: `footer:up` = Up / Ctrl+P ("Navigate up in footer (deselects at top)"), `footer:down` = Down / Ctrl+N, `footer:openSelected` = Enter, `footer:clearSelection` = Escape, `footer:close` = `x`. So ↓ from the (empty) prompt moves selection into the panel; Enter opens the selected agent. bin default bindings: `{context:"Footer",bindings:{up:"footer:up","ctrl+p":"footer:up",down:"footer:down","ctrl+n":"footer:down",right:"footer:next",left:"footer:previous",enter:"footer:openSelected",escape:"footer:clearSelection",x:"footer:close"}}`. The transcript block says `(↓ to manage)` explicitly (bin: `" background agents launched"," ",…{chord:"down",action:"manage",parens:!0}`).
- Spinner token count includes background agents: changelog 2.1.0: "Improved token count display in spinner to include tokens from background agents".
- Terminal progress indicator: docs settings-reference: "The indicator stays visible after the turn ends while background subagents or dynamic workflows are still running, and clears once the session is idle."
- Screen reader mode suppresses the `/tasks to see subagents` hint (docs above).

### Unconfirmed / inferred

- The user's recollection of "N background tasks (↓ to view)" probably refers to an older build (2.1.x before the panel, around 2.1.6/2.1.7 where "status bar duplicating background task indicator" and "mismatch between background task count in status bar and items shown in tasks dialog" were fixed). In 2.1.296 the count lives in the transcript block and the `/tasks` subtitle, not a footer count line.
- Hints for the `claude agents` fleet view (`N done` pulse, "agents footer hint now shows how many background agents are waiting on your input", `ctrl+x to stop`) belong to background sessions, not in-session subagents; listed here only to avoid confusion.

## 3. Inside the list view: keys, detail view

### Facts

Panel keys (docs sub-agents, table "Use these keys to interact with the panel"):

| Key | Action |
| :- | :- |
| `↑` / `↓` | Move between rows |
| `Enter` | Open the selected fork's transcript and send it follow-up messages |
| `x` | Stop the selected fork if it's running, or dismiss its row if it's no longer running. On the main session row, or on the row of the fork whose transcript you opened with `Enter`, `x` types into the prompt instead |
| `Esc` | Return focus to the prompt input |

Hint line text (bin `Tf`/`T1`): `Tf={open:"enter",close:"x",collapse:"escape",select:["up","down"],stopAll:"ctrl+x ctrl+k"}`, `ene="stop all agents"`. With a row selected the hints are `enter to view`, `x to stop` (or `x to clear` when the task no longer runs: bin `const io=DI(Kt)?"stop":"clear"`), `esc to collapse` (when collapsible), and `ctrl+x ctrl+k to stop all agents` (only when more than one agent, bin `showStopAll:co>1`), joined with ` · `; on terminals narrower than ~90 columns the stop-all hint is dropped. On the collapsed idle row the hint is `enter to expand`. While viewing a row the hint collapses to `↑/↓ to select`. changelog 2.1.281 confirms wording: "the agent panel footer offering "Enter to view" and "x to stop" on the agent you are already viewing" and 2.1.282 "its "Esc to collapse" hint".

Esc semantics (docs interactive-mode, `Esc` row): "While a footer item is selected, such as a row in the subagent panel below the prompt, `Esc` deselects it instead of interrupting." docs agent-teams: "Escape: clear the selection. While you're viewing a teammate's transcript, Escape interrupts that teammate's current turn".

`/tasks` dialog keys (bin): list mode: `↑/↓ to select`, `enter to view` (or `enter to show` on the System tasks row), `f to foreground` (when the task can be foregrounded), `x to stop`, `<stop-all chord> to stop all agents` (shown on a running local agent row), `esc to close`; in the actions submenu `esc to go back`. Actions submenu (bin: `"Actions for"` + name; `MWe={view:"View",foreground:"Foreground",stop:"Stop…`). Detail view hint (bin `_p`): `← to go back`, `esc / enter / space to close`, `x to stop`. changelog 2.1.203: "Changed left arrow to no longer close the background tasks, diff, and workflow detail views — press Esc instead". Stopping confirmation: none for subagents; changelog 2.1.281: "pressing `x` on a running `/ultrareview` now asks for confirmation before stopping the review". Remote tasks list rows show ` · stopping…` after `x` (bin).

Paging: docs keybindings: "In list panels such as `/skills`, `/mcp`, and `/tasks`, Claude Code applies your `select:pageUp`, `select:pageDown`, `select:first`, and `select:last` bindings."

What Enter opens (the agent transcript view):

- docs sub-agents: "With a fork's or subagent's transcript open, follow-up messages and skills go to that agent, and built-in commands go to your main conversation, with these safeguards: `/compact`, `/clear`, and `/rewind` act on the main conversation, so Claude Code asks you to confirm … `/model` and `/fast` … don't run from this view. A notice tells you why."
- Header over the prompt while viewing (bin `$6`): `Viewing @<name> · esc to return`, followed by the agent's prompt in dim text. Prompt placeholder: bin `` `Message @${name}…` `` (changelog 2.1.251).
- Send-now while it is busy: docs sub-agents: "To have the viewed agent read your message before the work it's waiting on finishes, send it with `Ctrl+Enter` or `Ctrl+X Ctrl+S`." (v2.1.286+). Resuming a stopped agent by typing: docs: "While that subagent's row is still in the subagent panel, type into its transcript to resume it yourself."
- The view is the agent's own transcript (its tool calls and results, not only the final report). docs agent-teams: "press Enter to view its session and type to send it a message"; changelog 2.1.179: "Fixed Ctrl+O not showing the subagent's transcript when viewing a subagent"; 2.1.257: "made background subagents' and teammates' counters update live while a response streams". Notifications that arrive while a panel is open are deferred with a line: bin: `"Background task update"` / `` `${n} background task updates` `` + `"waiting while this panel is open"` (changelog 2.1.277).
- Workflow agent detail (related, bin/changelog 2.1.199-era): "tool calls are marked running, failed or done, the subagent's task list is shown when it has one, and Enter unfolds the listed calls with their inputs and results".

### Unconfirmed / inferred

- Whether the `/tasks` detail view for a local agent is the same component as the panel's transcript view: docs say `/tasks` → Enter "open its transcript" and the detail view "stays open when the subagent finishes", so inferred yes (both call `onOpenTranscript`, a prop name present in the dialog, bin).

## 4. What lands in the main transcript

### Facts

Spawn / running (bin `PLo` + `ym`, the Agent tool renderer; one block per assistant message that launched agents):

- Header line with spinner glyph: `Running **N** agents…` or, when every agent has the same type, `Running **N** Explore agents…` (bin: `["Running ",bold(m.length)," ",B?`${B} agents`:"agents","…"]`). Non-background blocks append the `(ctrl+o to expand)` hint (`wu`).
- One row per agent, tree-connected (`branch` / `last` connectors): `**AgentType** (description)` with the type colour-coded (bin: `[bold(agentType)," (",description,")"]`), or for named agents `**@name**: description`. Followed by ` · N tool use(s) · X tokens` while not background-resolved (bin: `` [" · ",M," tool ",M===1?"use":"uses",C!==null&&[" · ",Bs(C)," tokens"]] ``). The status child line is: bin: `if(!E) return j||"Initializing…"; if(W) return T??"Running in the background"; return "Done"` where `j` = last tool info (e.g. the last tool call summary), `E` = resolved, `W` = async && resolved.
- Below each foreground agent the block shows the agent's last few tool calls condensed (bin `mmt`): searches/reads are folded into a summary such as `Searching for 3 patterns, reading 2 files` / `Searched for 3 patterns, read 2 files` (bin `Jor`), older ones fold into `+N tool uses (ctrl+o to expand)` (bin: `e(wy,{count:U,unit:"tool use",expandable:!0})`). When the terminal is short it collapses to one line: bin: `"In progress… · ",bold(G)," tool uses",` · ${tokens} tokens`," · ",(ctrl+o to expand)`.
- docs sub-agents (summary): "the delegation appears as a tool call row showing the subagent's name followed by a short task description, such as `code-improver(Suggest code improvements)`."

Live update: yes. The block re-renders as progress messages arrive (tool count, tokens, last tool). changelog 2.1.0: "Improved skills to show progress while executing, displaying tool uses as they happen" (same renderer family); 2.1.30: "Added token count, tool uses, and duration metrics to Task tool results".

Completion (foreground, blocking): header becomes `**N** agents finished` (or `**N** Explore agents finished`), rows switch to `Done`, and the tool result text is `Done (N tool uses · X tokens · Ys)`: bin: `` W=`Done (${[E===1?"1 tool use":`${E} tool uses`,Bs(B)+" tokens",rn(S)].join(" · ")})` ``. With `(ctrl+o to expand)` the result expands to the agent's final report.

Completion (background launch): header becomes `**N** background agents launched (↓ to manage)` (bin: `[bold(m.length)," background agents launched"," ",(↓ to manage)]`), rows show `Running in the background` (or the task description), and no tool-count/tokens suffix. The tool result sent to the model says the agent is running (bin: `The agent is now running and will receive instructions via mailbox.` for teammates; `` Background agent "${h}" (${b}) is still running. `` … `Do NOT spawn a duplicate. You will be notified when it completes.`) and changelog 2.1.193: "the launch result no longer instructs Claude to "end your response"".

Background completion → a task notification in the transcript:

- Model-facing summary (bin): `` Mon='Agent "' ``, `BTo="finished"`; the summary is `` `${Mon}${description}" ${Ze}` `` where `Ze` is `finished` | `` `failed: ${error||"Unknown error"}` `` | `was stopped by Claude` | `was stopped by user` | `` `was stopped: ${reason}` `` | `` `stopped at its ${n}-turn limit (partial result…)` ``. Resumed: `` `Agent "${n}" was resumed by the user` ``. Shells use `Npe="Background command "`.
- User-visible row (bin `gn`): `tone: failed→"red", killed→"gold", else "dim"`, `text` = first line of the summary, `detail` = `[context, duration, deliveryNote].join(" · ")` (duration formatted via `rn`), `subLines` = remaining lines plus `sent a message (ctrl+o)` / `` `sent ${T} messages (ctrl+o)` ``. So the visible shape is e.g. `Agent "Audit the auth flow" finished · 3m 12s`. changelog 2.1.144: "Added elapsed duration to background subagent completion notifications (e.g. "Agent completed · 3h 2m 5s")" (older wording). changelog 2.1.0: "background task completion notifications to appear proactively with bullet point" and "now shows clean completion message instead of raw output"; 2.1.7: "Added inline display of agent's final response in task notifications"; 2.1.6: "task notification display to cap at 3 lines with overflow summary when multiple background tasks complete simultaneously".
- The model receives `<task-notification>` XML inside a `<system-reminder>` with `<task-id>`, `<status>`, `<summary>`, `<result>…</result>`, `<usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>` (bin). docs sub-agents: "A background subagent's report arrives inside a completion notification, which is marked as an automated event rather than a message from you." The notification instructs the model: bin: `Carry on as if the tool had just returned it: do not announce a notification or a background task.`
- docs sub-agents: "A background subagent's results reach Claude as a completion notification in a later turn. Claude waits for that notification before reporting the subagent's results, and if you ask about progress first, it reports that the subagent is still running."
- Focus view collapses them: docs commands `/focus`: "The tool-call summary also counts the subagents launched in the turn and collapses completed background-task notifications into a single count."

Agent tool description (model-facing, bin; the user-behaviour parts):

- "Subagents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running."
- Variant when fork mode is off: "Subagents run in the background by default; you'll be notified when one completes. Pass `run_in_background: false` only when your very next action depends on the result and nothing else could usefully happen while it runs — otherwise background it so the user can interject."
- "The agent's final report is not shown to the user — relay what matters." (alt: "The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.")
- "A fork runs in the background and keeps its tool output out of your context. If you are the fork, execute directly — don't re-delegate."
- `run_in_background` param text: "Agents run in the background by default; you will be notified when one completes. Se…" (truncated in extraction). When unavailable: "The run_in_background and name parameters are not available in this context. Only synchronous subagents are supported."
- Tool result on completion: `agentId: …` `(use SendMessage with to: '…', summary: '<5-10 word recap>' to continue this agent)` + `<usage>subagent_tokens: … tool_uses: … duration_ms: …</usage>`; empty report: `(Subagent completed but returned no output.)`.

### Unconfirmed / inferred

- Singular wording: the header hardcodes `agents`; whether `Running 1 agents…` is special-cased elsewhere is unconfirmed.
- The exact glyph for the transcript bullet of a task notification was not extracted (the row renderer `gn` only sets tone/text).

## 5. Ctrl+O / verbose mode and the inner transcript

### Facts

- docs interactive-mode: "`Ctrl+O` | Toggle transcript viewer | Shows detailed tool usage and execution … Also expands lines that collapse by default, such as MCP calls, shown as a single `Called slack 3 times` line".
- In the Agent block, the non-transcript render shows only the last `iC` progress lines and folds the rest into `+N tool uses (ctrl+o to expand)`; in transcript mode (`isTranscriptMode`) it shows the agent's prompt (`RKn{prompt}`) and every progress message (bin `mmt`: `B=T?E:E.slice(-iC)`, `T&&q&&e(…RKn,{prompt:q})`). So the full inner transcript of a foreground subagent is visible inline with Ctrl+O.
- For background subagents the inline block does not show tool calls (`isAsync` rows show only `Running in the background`); the full transcript is reached by viewing the agent (panel Enter or `/tasks` Enter), and Ctrl+O inside that view shows its verbose transcript (changelog 2.1.179 "Fixed Ctrl+O not showing the subagent's transcript when viewing a subagent"; 2.1.90-era "Fixed extra blank lines appearing below each tool call in the expanded subagent transcript view (Ctrl+O)").
- Hand-back provenance preamble hidden outside verbose: changelog 2.1.280-era: "Fixed subagent hand-back messages showing an internal provenance preamble when expanded outside verbose mode".
- Remote Control: changelog 2.1.251: "Added live streaming of a foreground subagent's tool calls and results to Remote Control clients (background subagents, the default, still show status only)".
- Transcript files: `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl` (docs sub-agents).

### Unconfirmed / inferred

- The value of `iC` (how many recent tool lines stay visible per foreground agent) was not found; by analogy with other condensed blocks it is small (3–5).

## 6. Nested and parallel agents

### Facts

- Parallel agents launched in one assistant message render as ONE block with a count header and one tree row per agent (bin `PLo`: rows map with `isLast:O===M.length-1`, connectors `branch`/`last`).
- The panel shows every agent as its own row; nested agents are a tree with `(+N)` descendant counts and the ability to open a row to see "siblings and direct children with a path back to `main`" (docs sub-agents). changelog 2.1.193: "Fixed agent panel hiding sibling agents when viewing a subagent".
- Only the top-level summary reaches the main conversation: docs sub-agents: "In an interactive session, only the top-level subagent's summary returns to you and the intermediate output stays out of your main conversation: a subagent that launches background subagents waits for their results before it finishes."
- Concurrency: docs: default limit 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), error `Concurrent subagent limit reached`; nesting depth default 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
- Teammates share the panel: docs agent-teams: "Subagents appear in the same agent panel as teammates".

## 7. Stopping

### Facts

- Esc interrupts the main turn only: changelog 2.1.47: "Background agents now continue running when you press ESC to cancel the main thread"; 2.1.49: "Added Ctrl+F keybinding to kill background agents (two-press confirmation)"; 2.1.90-era: "Changed "stop all background agents" keybinding from `Ctrl+F` to `Ctrl+X Ctrl+K`".
- docs interactive-mode: "`Ctrl+X Ctrl+K` | Stop all running background subagents in this session, and turn off artifact auto-replies for the rest of it. Press twice within 3 seconds to confirm. You can press it while a background subagent's permission prompt is open".
- Feedback strings (bin): first press → `` `Press ${chord} again to stop background agents` `` (a transient footer feedback); hint variants `"again to stop background agents"` / `"twice to stop background agents"`; nothing running → `"No background agents running"` (2 s feedback). Permission prompts from background agents also show the chord (changelog 2.1.158-era: "Improved permission prompts from background agents to show the Ctrl+X Ctrl+K shortcut").
- Stop one agent: `x` on its panel row or in `/tasks` (docs table above), or ask Claude (`TaskStop` tool: docs tools-reference "Stops a running background task by ID"). After stopping from `/tasks`: docs tools-reference: "After you stop one there … Claude moves on instead of waiting for it." Monitors started by that agent stop with it (docs). Stopped agents do not auto-resume: docs: "A subagent you stopped yourself, with `x` in `/tasks` or an SDK `stop_task` request, doesn't auto-resume. If Claude sends it a message, the message is refused and Claude is told the agent was cancelled."
- Ctrl+C: changelog 2.1.274-era: "Fixed Ctrl+C needing three or four presses to exit while background subagents are running; two presses now exit". Exit warns about running agents (changelog 2.1.203-era "/exit incorrectly warning about running background agents").
- In the transcript after a stop: the notification summary `Agent "<description>" was stopped by user` rendered gold (bin `tone: killed→"gold"`); for the model, a user-authored stop also injects `` Background agent "${name}" was stopped by the user. `` or `` `${n} background agents were stopped by the user: …` `` (bin). changelog 2.1.80-era: "killing a background agent now preserves its partial results in the conversation context". The stopped row stays in the panel 30 s (docs).

### Unconfirmed / inferred

- No confirmation dialog for `x` on an ordinary subagent (only `/ultrareview` asks). Inferred from the changelog wording that singles out `/ultrareview`.

## 8. Counters and spinner verbs

### Facts

- Per-agent counters: `N tool uses · X tokens` in the transcript rows (bin), `elapsed · ↓ X tokens` on panel rows (bin), `Done (N tool uses · X tokens · duration)` on the tool result (bin), ` · duration` on the completion notification (bin/changelog 2.1.144). Tokens are abbreviated with `Bs()` (e.g. `12.3k`), durations with `rn()` (e.g. `3h 2m 5s`, `1m 2s`).
- Status words per agent: `Initializing…`, `<last tool info>`, `Running in the background`, `Done` (transcript rows, bin); `running`, `done`, `waiting`, `parked`, `, unread` (`/tasks` meta, bin); `waiting`, `idle`, `awaiting approval` (panel elapsed slot, bin).
- Progress summary verbs in the condensed block (bin `Jor`): `Searching for N patterns` / `Searched for N patterns`, `Reading N files` / `Read N files`, `Listing N directories` / `Listed N directories`, `Recalling N memories`, `Searching memories`, `Writing N memories`.
- There is no dedicated "agent spinner verb"; the header uses the normal spinner glyph with `Running N agents…`, and the main spinner's token figure includes background agents (changelog 2.1.0).

## Design-relevant takeaways (rules to carry over)

1. One transcript block per launch: spinner + `Running **N** agents…` while running; `**N** agents finished` or `**N** background agents launched (↓ to manage)` when done. Group by type when all agents share one (`Running 3 Explore agents…`).
2. One tree row per agent inside the block: `**Type** (description) · N tool uses · X tokens` and a status line `Initializing…` → last tool → `Running in the background` | `Done`.
3. Foreground agents show their recent tool calls inline (folded: `Searched for 3 patterns, read 2 files`, `+N tool uses (ctrl+o to expand)`); background agents show status only, never their tool calls, in the main transcript.
4. Tool result string: `Done (N tool uses · 12.3k tokens · 1m 2s)`; singular `1 tool use`.
5. Background completion is a dim one-liner: `Agent "<description>" finished · 3m 12s`; red `Agent "…" failed: <error>`; gold `Agent "…" was stopped by user`; sublines `sent N messages (ctrl+o)`. Cap at ~3 lines when several finish at once.
6. Panel under the prompt, max 5 rows, `↑/↓ N more` scroll markers, a `main` row first, nested agents as a tree with `(+N)`.
7. Panel row: `pointer glyph name (+N)  description-or-latest-progress   elapsed · ↓ 12.3k tokens [· N queued]`; `waiting` replaces elapsed when blocked on a child, `idle` when done but kept.
8. Keys: ↓ from an empty prompt selects the panel; ↑/↓ move; Enter opens; `x` stops (or clears a finished row); Esc deselects/collapses (never interrupts while a row is selected); Ctrl+X Ctrl+K twice within 3 s stops all. Hints: `enter to view · x to stop · esc to collapse · ctrl+x ctrl+k to stop all agents`.
9. Timings: successful rows vanish immediately and the footer shows `/tasks to see subagents` for 30 s; failed/stopped rows linger 30 s; idle rows auto-hide after 30 s; >3 idle collapse into `N idle agents`.
10. `/tasks` (alias `/bashes`) is the full list: title `Background`, subtitle `N active agents · N active shells`, sections with `(count)`, completed sorted below running, `No tasks currently running` empty state, `System tasks (N hidden)` fold, rows `description   running|done[, unread]   model effort`.
11. Opening an agent = its live transcript with an input: header `Viewing @name · esc to return`, placeholder `Message @name…`; plain text goes to the agent, slash commands to main (confirm for `/compact`, `/clear`, `/rewind`). Ctrl+Enter sends before its current wait finishes. Typing into a stopped agent resumes it.
12. Esc on the main turn never stops background agents; after the main turn the status line reads `Waiting for **N** background agents to finish`.
13. Feedback strings for stop-all: `Press ctrl+x ctrl+k again to stop background agents`; `No background agents running` (2 s).
14. Permission prompts from background agents surface in the main session, name the agent, and Esc denies just that one call.
15. Keep the agent-definition command (`/agents`) separate from the running list; keep the to-do checklist (Ctrl+T) separate too.
16. Model-facing contract: "Subagents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results"; "The agent's final report is not shown to the user — relay what matters."; notifications say "Carry on as if the tool had just returned it: do not announce a notification or a background task."
