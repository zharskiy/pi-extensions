# Current UI audit (subagents, working-indicator, footer, adapter)

Snapshot of branch `plans/claude-ux` (after PR #5). Paths are repo-relative; `sub/` = `extensions/subagents/src/`, `pi/` = `node_modules/@earendil-works/pi-coding-agent/dist/` (pi 1.1.0). ASCII renderings are derived from the code; `<…>` marks values.

---

## 1. Progress widget (below the editor)

Files: `sub/plugins/progress-widget/index.ts` (plugin), `sub/plugins/progress-widget/model.ts` (visibility, cache, lines), `sub/components/agent-row.ts` (row text), `sub/components/refresh.ts` (`createThrottle`).

- Key `WIDGET_KEY = "pi-subagents-progress"` (`index.ts:6`), installed with `host.ui.setWidget(key, render)`; the adapter always uses `placement: "belowEditor"` (`core/adapter/pi-ui.ts:333-348`) and a factory component, so pi's 10-line cap for array widgets (`pi/modes/interactive/interactive-mode.js:1871-1876`) does not apply: the widget has no row limit.
- Data flow: `bus.on("agent:changed")` → `createThrottle(refresh, () => settings.renderThrottleMs)` (`index.ts:74-75`). No other bus event is used.
- `refresh()` (`index.ts:38-72`): computes `visible()` = `visibleRecords(registry.list(), now, settings)`; prunes the closed-row cache; with no rows removes the widget (`setWidget(key, undefined)`) and stops the ticker; otherwise installs the widget once, starts `ticker ??= setInterval(refresh, TICK_MS=1000)` (`index.ts:8,61`), and calls `handle.refresh()` (TUI `requestRender`) unless every visible row is closed and unchanged (`signatureOf`, `index.ts:23-31,63-67`).
- Spinner: `frame` increments once per `refresh()` (`index.ts:70`), i.e. at most once per tick/throttled change, so the 10-frame braille spinner advances ~1 frame/s. The render closure reads `visible()` and `Date.now()` on every TUI render (`index.ts:56-58`), so elapsed times also move when pi re-renders for other reasons.
- Lingering (`model.ts:6-27`): open records (`queued|running|grace`) always visible; closed records visible while `now - endedAt < linger`, where linger = `lingerMs` (30 s) for `done` and `failedLingerMs` (60 s) for **every other closed state** (`failed`, `stopped`, `handoff`).
- Closed-row cache (`model.ts:31-63`): closed rows cached per id by `version`, `width`, `theme`; open rows always recomputed.
- Order: `registry.list()` insertion order (creation order), not tree order; nesting is shown only by indentation `"  ".repeat(depth - 2)` (`agent-row.ts:175`).
- Header (`model.ts:73-77`): `theme.fg("muted", "Agents · <n> running · /agents to browse")`, where `<n>` counts every open record (queued and grace included).

Row (`agentRow`, `agent-row.ts:152-172`; `treeRow`, `agent-row.ts:174-186`):
- `<icon> <bold id[ #chainIndex]><dim " (model)"> · <muted description truncated> <dim " · detail">[<warning " · needs input: title">][<warning " · stopping in Ns">]`
- Icons (`agent-row.ts:4-23`): running = braille frame (accent); `queued ○` muted, `grace ◐` warning, `done ✓` success, `failed ✗` error, `stopped ■` muted, `handoff ↪` warning.
- Detail: open → `progressText` (`agent-row.ts:95-108`): `queued` or `<n> tool call(s) · <tokens> tokens · <elapsed>[ · <pct>% ctx]`; closed → `finishSummary` (`agent-row.ts:77-93`): `Done (<stats>)`, `Handoff (<stats>)`, `Stopped (<stats>)`, `Failed: <error|unknown error> (<stats>)`.
- Description room = `max(8, width - 2 - head - tail - alert)`; `truncate` counts UTF-16 chars, not display width (`agent-row.ts:110-120`); the adapter then hard-truncates each line with `truncateToWidth` (`pi-ui.ts:89,343`).
- Grace suffix: `stopping in <s>s`, or `stopping · answering` when `graceEndsAt` is unset (`agent-row.ts:142-150`).
- Attention: `needs input: <title>` only while open (`agent-row.ts:126-132`).

```
Agents · 3 running · /agents to browse
⠹ explorer-3f2a9c1b7d0e (prov/model:high) · Map the auth module · 4 tool calls · 12.3k tokens · 1m 5s · 23% ctx
◐ worker-a1b2c3d4e5f6 (prov/model:medium) · Fix login bug · 9 tool calls · 30.1k tokens · 2m 10s · 41% ctx · stopping in 42s
  ○ explorer-0f9e8d7c6b5a (prov/model:low) · Find callers · queued · needs input: Run bash?
✓ reviewer-77aa88bb99cc (prov/model:high) · Review diff · Done (12 tool calls · 44.0k tokens · 3m 2s)
```

Persistence: none. Tests: `test/plugins/progress-widget/progress-widget.test.ts` (linger windows 30 s / 60 s; closed-row cache reuse; no redraw on ticks once all closed; widget removal after linger; depth indent; grace countdown and "answering" pause), `test/components/agent-row.test.ts` (token/elapsed formats, finish summary, live progress with ctx, model after id, truncation, chain index, attention suffix, indent and countdown), `test/components/refresh.test.ts` (throttle leading/trailing; watcher ticks and unsubscribes).

## 2. Agent list overlay (`/agents` with no id)

Files: `sub/plugins/agent-list-view/index.ts` (plugin, `agentList` service), `sub/plugins/agent-list-view/view.ts` (`createAgentListView`), `sub/components/agent-list.ts` (grouping, selection, rendering), `sub/components/hints.ts`.

- Opened by `/agents` (registered in agent-view, `sub/plugins/agent-view/index.ts:185-219`) when the `agentList` service exists; otherwise falls back to `host.ui.select("Open agent", labels)` with label `<id> · <state> · <description>` cut to 100 chars (`index.ts:182-183,205-217`).
- Overlay via `host.ui.openOverlay` → pi `ctx.ui.custom(..., { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } })` (`core/adapter/pi-ui.ts:353-401`): a full-screen overlay.
- Data: `records: () => registry.list()` — **only in-memory agents of this extension instance**; agents of earlier runs (manifest only) are never listed (`agent-list-view/index.ts:23`).
- Refresh: `watchAgents(bus, { relevant: () => true, ticking: any open record, onChange })` (`index.ts:12-17`); `watchAgents` throttles at hard-coded `REFRESH_MS = 300` and ticks every `TICK_MS = 1000` (`components/refresh.ts:4-6,47-67`), not `renderThrottleMs`. Each reload bumps `frame` (spinner) and re-reads records (`view.ts:34-42`).
- Grouping (`agent-list.ts:5-72`): order `Working`, `Needs attention` (open and (`grace` or `attention`)), `Done`, `Failed`, `Closed` (`stopped`, `handoff`); newest `createdAt` first within a group. Group header `bold("<Title> · <count>")`, a blank line between groups.
- Rows: `<marker> <treeRow(record, now, frame, theme, width-2)>`; marker `›` (accent bold) for the selection, else a space (`agent-list.ts:101-135`).
- Filter (`agent-list.ts:41-51`): case-insensitive substring over `agent`, `id`, `state`, group title.
- Layout (`view.ts:107-150`): header `bold("Agents") + dim(" · <open> open · <total> total")`, a dim `─` rule, scroll window (min 3 rows), padding, footer lines (filter input line `/ <input>` or `filter: <text>`, notice in warning colour, hint line).
- Keys (`view.ts:220-299`): `↑/↓` move selection (clamped, skips headers, reveals selection); `PgUp/PgDn` scroll by page; `Home/End`; `Enter` closes the list and calls `agentView.open(id)` (no return to the list afterwards); `x` stops the selected open agent; `X` asks `Stop all <n> open agents? y confirms · any other key cancels` (`y` stops every open agent); `/` opens the filter input (`api.createInput("filter by name, id or state")`); `Esc` clears an applied filter, else closes. In filter input: arrows/page keys still act, `Esc` clears filter, `Enter` keeps it, other keys edit. Wheel scroll in fullscreen TUI mode only.
- Hint text (`view.ts:59-85`): `↑/↓ select · Enter open · <x stop | x again closes now> · X stop all · / filter · <Esc clear filter|Esc close> · PgUp/PgDn Home/End[ wheel] scroll`. Notices: `stop failed: <msg>`, `no open agents to stop`; empty states `no agents in this session yet` / `no agents match "<filter>"` (`agent-list.ts:98-99`).

```
Agents · 2 open · 4 total
──────────────────────────────────────────────────────────────
Working · 1
› ⠹ explorer-3f2a9c1b7d0e (prov/model:high) · Map the auth module · 4 tool calls · …

Needs attention · 1
  ◐ worker-a1b2c3d4e5f6 (prov/model:medium) · Fix login bug · … · stopping in 42s

Done · 1
  ✓ reviewer-77aa88bb99cc (prov/model:high) · Review diff · Done (12 tool calls · 44.0k tokens · 3m 2s)

Failed · 1
  ✗ explorer-0f9e8d7c6b5a · Find callers · Failed: spawn failed: … (0 tool calls · 0 tokens · 0s)
                                                     (padding to terminal height)
↑/↓ select · Enter open · x stop · X stop all · / filter · Esc close · PgUp/PgDn Home/End scroll
```

Persistence: none. Tests: `test/components/agent-list.test.ts` (grouping/order, attention group only for open, selection clamping, filter fields, empty text, headers/marker/indent), `test/plugins/agent-list-view/agent-list-view.test.ts` (empty state via `/agents`, grouping, cursor over headers + Enter opens, x then x, X+y, X+other, `/` filter + Esc, selection stays visible in long lists).

## 3. Agent view (`/agents <id>`)

Files: `sub/plugins/agent-view/index.ts` (plugin, loader, manifest fallback, `/agents` command), `sub/plugins/agent-view/view.ts` (590 lines, `createAgentView`), `sub/plugins/agent-view/mode-store.ts`, components `collapsible.ts`, `system-prompt-block.ts`, `context-breakdown.ts`, `hints.ts`, adapter `core/adapter/pi-ui.ts` (`createTranscriptPane`, `createScrollPane`, `createInputPane`), `core/adapter/session-file.ts`.

Opening and data (`index.ts`):
- `open(id)` (`index.ts:144-178`): `findTerminal(id)` = live record's chain terminal, else `fromManifest(id)` followed through `successorId` manifests (`index.ts:58-74`). Unknown id → `notify("pi-subagents: unknown agent \"<id>\"", "warning")`; bad JSON → `pi-subagents: cannot read manifest of "<id>": <msg>`.
- Manifest fallback (`index.ts:33-56`) reads `<agentsDirFor(current session)>/<id>/manifest.json` and fills missing fields with zeros: `turns`, `toolCalls`, `tokens` = 0, `lastText` = "", no `context`. Manifest fields written by the registry: `registry.ts:21-42` (no counters). So past agents always show `0 tool calls · 0 tokens · <elapsed>` in the header. Only the current session's agents dir is searched (resume of the same session file works; other sessions do not).
- Loader (`index.ts:76-112`): each `load()` re-resolves the live chain terminal (`openedId` set when the opened id is not the terminal → hint `opened <id>, following the chain`), stats the session file and re-parses it fully with `runtime.readSession(file)` only when size or mtime changed. Errors become `session file not written yet` / `cannot read session: <msg>` (shown in warning under the prompt block).
- Refresh: `watchAgents` with `relevant = record in the opened chain`, `ticking = live && terminal open` (`index.ts:154-158,172-173`): ≤ 300 ms after a chain `agent:changed`, plus 1 s ticks while open. The child session file is written by pi per completed message, so streaming text never appears; the view shows completed messages, refreshed ~1 s. Closed or manifest-only agents never tick.
- `/agents` completion lists only `registry.list()` ids (`index.ts:187-191`).

Session file → transcript (`core/adapter/session-file.ts`; `runtime.readSession` = `readSessionFile(file, "<namespace>:prompt-record")`, `pi-child.ts:404`):
- `parseSessionLines` (`session-file.ts:158-194`): system messages (`role: "system"`, with `sections`, `toolsAdded`, `toolsRemoved`) are replayed into prompt sections and tools; the last `custom` entry `pi-subagents:prompt-record` supplies skills, guidelines, provider payload, model; `contextTokens` = last non-failed assistant usage via pi's `calculateContextTokens`.
- `transcriptItem` (`session-file.ts:67-127`): `custom_message` → `custom`; message `user` → `user` (text only); `toolResult` → `tool` (`raw` = the pi message); `assistant` → `assistant` with text, joined thinking, `toolCalls: {name, args}`, `raw`. System messages and `custom` entries are not transcript items.
- `createTranscriptPane` (`pi-ui.ts:110-211`) renders with **pi's own components**: `UserMessageComponent`, `AssistantMessageComponent(raw, true, …)` (second arg `hideThinkingBlock = true`, so thinking is always hidden), one `ToolExecutionComponent` per `toolCall` part (args = `call.arguments`), `CustomMessageComponent` for displayed custom messages. Tool results are matched by `toolCallId` and applied with `updateResult(raw)`; aborted/error assistant messages mark their calls `Operation aborted` / error text. Sync is incremental by item count; fewer items → full reset (`pi-ui.ts:194-201`). Routed messages appear as user messages `[message from user]\n<text>` (`core/adapter/route.ts:3-4`); the task arrives as `Task from <caller> (agent id <id>):…` (`sub/plugins/run-agent/task.ts:12`).
- Tool definitions: `definitionFor(name)` knows only `read, bash, powershell, edit, write, grep, find, ls` (`pi-ui.ts:93-102,118-124`). Every other tool (`codemode`, `tool_search`, `mcp__*`, MCP resource tools, nested `run_agent`, `message_agent`, `agent_status`) gets `undefined` and hits pi's **no-definition fallback** `formatToolExecution()` (`pi/modes/interactive/components/tool-execution.js:311-322`): bold tool name, blank line, `JSON.stringify(args, null, 2)`, newline, the **whole** text output (`getTextOutput`, `pi/core/tools/render-utils.js:35-53`), inside the pending/success/error background box. The fallback ignores `expanded`, so the tools-expand key does nothing for these rows.
- **Codemode in the agent view** therefore looks like this (script is one JSON string with `\n` escapes; output keeps codemode's header from `pi/extensions/codemode/execute.js:463`; nested calls in `details.calls` are not shown):

```
 codemode

 {
   "code": "const hits = await tools.grep({ pattern: \"login\", path: \"src\" });\nconst file = await tools.read({ path: hits[0].path });\nreturn file.slice(0, 200);"
 }
 Script completed
 Wall time 0.42 seconds
 Output:
 <entire output, every line, never truncated>
```

  In the main session the same tool renders through `codemodeRenderers` (`pi/extensions/codemode/renderer.js`): highlighted script (10-line preview), nested-call list with ✓/✗/… and durations, output without the header (5-line preview). Those renderers are not exported from the package root (`pi/index.js:34` exports only `createCodemodeExtension`; `package.json` exports `.`, `./rpc-entry`, `./client`, `./experimental/plugin`), so the adapter would have to capture the definition (e.g. run `createCodemodeExtension()` against a stub `registerTool`, or look up the registered tool) to reuse them.
- Built-in tools use pi's collapsed/expanded renderers and honour the tools key (`setToolsExpanded`, `pi-ui.ts:202-208`).

Layout (`view.ts:398-407`): header + optional context block, scroll window (`bodyLines` = prompt block then transcript), padding, message box line(s), hint line. The scroll pane follows the end (`ScrollView({ follow: "end" })`, `pi-ui.ts:213-244`), so it opens at the transcript tail.
- Header (`headerLines`, `view.ts:251-269`; `titleText`, `view.ts:96-110`): line 1 `<icon> <bold id[ #n]> (<agent>) · <state> · <model|model n/a>[ · continues <id>][ · continued by <id>][warning · needs input: <title>]` (icon **not** coloured, unlike rows); line 2 muted `Task: <description>`; optional muted `worktree: <worktreeText>` (`types.ts:34-46`: `<path> (branch <b>)`, `removed`, `removed; branch <b> kept`, `kept: …`); dim detail (`progressText`/`finishSummary`); dim `─` rule.
- Context breakdown (`contextLines`, `view.ts:271-309`; `components/context-breakdown.ts`), shown when `contextShown`: title `Context · ~ marks estimates (characters / 4), <used is measured|nothing measured yet> · c hides`, rows `system prompt`, `tools`, `skills`, `messages` (+ indented `user`, `assistant`, `tool results`), `used`, `free space`; each row label padded to 16, figure (with `~` when estimated) padded to 8, percent of limit padded to 7, 20-cell bar `█`/`░` coloured success/warning/error by `softContextRatio` and limit; dropped bar on narrow widths (`context-breakdown.ts:157-174`); last line `limit <n> tokens (<p>% of the model window <w>)` or `limit unknown (the agent's file is gone)` / `(model window unknown)`. Limit = `effectiveContextLimit(record.contextLimit, window, reserveTokens)`. Cached by session/record/version/width/theme.

```
⠹ explorer-3f2a9c1b7d0e (explorer) · running · prov/model:high
Task: Map the auth module
4 tool calls · 12.3k tokens · 1m 5s · 23% ctx
────────────────────────────────────────────────────────────
Context · ~ marks estimates (characters / 4), used is measured · c hides
  system prompt     3.2k~   1.6%  ░░░░░░░░░░░░░░░░░░░░
  tools             6.1k~   3.1%  █░░░░░░░░░░░░░░░░░░░
  skills             410~   0.2%  ░░░░░░░░░░░░░░░░░░░░
  messages         31.0k~  15.5%  ███░░░░░░░░░░░░░░░░░
    user            1.2k~   0.6%  ░░░░░░░░░░░░░░░░░░░░
    assistant       4.8k~   2.4%  ░░░░░░░░░░░░░░░░░░░░
    tool results   25.0k~  12.5%  ███░░░░░░░░░░░░░░░░░
  used             45.0k   22.5%  ████░░░░░░░░░░░░░░░░
  free space      155.0k   77.5%  ████████████████░░░░
  limit 200.0k tokens (92% of the model window 216.4k)
────────────────────────────────────────────────────────────
Effective prompt
› ▸ System prompt · preamble (1 lines)
  ▸ System prompt · tools (4 lines)
  ▸ Tools (9) (240 lines)
  ▸ Skills (3) (3 lines)
  ▸ Tool guidelines (14) (14 lines)
  ▸ Provider request (first, as sent) (912 lines)

Transcript
 Task from main (agent id explorer-3f2a9c1b7d0e): …      (pi UserMessageComponent)
 ls /repo/agents …                                        (pi ToolExecutionComponent)
                                                         (padding)
  message the agent…                                      (dim when unfocused, "›" accent when focused)
Esc close · x stop · ctrl+o tool detail · PgUp/PgDn Home/End scroll · c context breakdown · Tab/Enter prompt sections, Tab to the message box · focus view, v verbose  41-80/312 · following
```

- Prompt block (`promptBlock`, `view.ts:311-348`; `renderSections`, `collapsible.ts:19-48`; `promptSections`, `system-prompt-block.ts:8-48`): `bold("Effective prompt")`, one collapsible per pi section `System prompt · <name>`, then `Tools (<n>)` (name: description + 2-space-indented JSON schema), `Skills (<n>)`, `Tool guidelines (<n>)` (`- <g>`), `Provider request (first, as sent)` (full JSON payload or `not recorded`); then optional warning error line, blank, `bold("Transcript")`. Header row `<› or space> <▸|▾> <bold title, accent when focused> <dim (N lines)>`; body lines indented 4 and hard-sliced by `wrapPlain` at `width-4` characters (`view.ts:47-57`). Cached by sections/focus/width/theme/error. When the prompt record changes, collapse states are merged by title (`mergeCollapsed`, `view.ts:131-138`).
- Message box (`messageLines`, `view.ts:371-388`): only for open agents; `api.createInput("message the agent…")`; status line below: `sent: steered into the current run` / `sent: the agent answers in a new turn` / `sent: held until the agent starts` (dim) or the route error (warning; text restored into the box) (`view.ts:125-129,471-481`). Send = `runner.route(id, { sender: "user", text })` (`index.ts:117-123`).
- Hint line (`hintLine`, `view.ts:390-396`): dim hint + two spaces + position `<top+1>-<last>/<total>[ · following]`. Normal hint parts (`view.ts:77-94`): `Esc close`, `opened <id>, following the chain`?, `x stop`|`x again closes now` (open only), `<toolsKey> tool detail`, scroll hint, `c hide context`|`c context breakdown`, `Tab/Enter prompt sections[, Tab to the message box]`, `focus view, v verbose`|`verbose view, v focus`, `agent closed, messages disabled` (closed). Input-focused hint (`view.ts:59-66`): `Message box: Enter send · Esc clear, again leaves the box · Tab prompt sections · <toolsKey> tool detail · <scroll>`.
- Keys, normal focus (`view.ts:509-580`): `x` stop (first → grace, second during grace → close now; no-op when closed); `c` toggle context block; `v` toggle mode (persisted); `Enter`/`Space` toggle focused section; `Tab` next section, after the last section into the message box (if open); `↑/↓` scroll 1 line; `PgUp/PgDn` page; `Home/End`; tools key (`app.tools.expand`, matched by pi keybindings, `pi-ui.ts:378`) toggles tool detail; `Esc` close; wheel scroll (fullscreen only). Input focus (`view.ts:531-552`): scroll keys and tools key still act; `Esc` clears text, a second `Esc` leaves the box; `Tab` → first section; everything else (including `x`, `c`, `v`) types; Enter submits.
- Focus/verbose store (`mode-store.ts`): file `<agentDir>/pi-subagents-view.json` `{ "mode": "focus"|"verbose" }`; read on every `open`, written on `v`; missing or corrupt → `focus`. `applyMode` (`view.ts:172-180`): verbose = all sections expanded + tool detail expanded + context shown; focus = all collapsed, tools collapsed, context hidden. `c`, tools key and section toggles change the view without touching the stored mode. "Focus" filters nothing.
- Closed agents: no message box, input focus dropped on reload (`view.ts:241-243`), stop is a no-op, hint `agent closed, messages disabled`; no ticking.

Tests: `test/plugins/agent-view/agent-view.test.ts` (1117 lines; prompt block contents incl. MCP tools, collapsed start, prompt-block render cache, closed agent from session file, transcript snapshot via pi components (`__snapshots__/agent-view.test.ts.snap`), tools-key toggle, Enter/Tab sections, tail-open and scroll/wheel, follow vs keep position, fresh transcript on successor file change, grace via x/x, unknown id notice, message box routing/grace/Esc ladder/Tab cycle/`x` typed/failed route/closed hides box, input focus rendering, chain following + stopping the successor, header chain/attention, context block toggle/measured/manifest limits/live refresh, modes persistence/corrupt file, worktree line, no re-parse when unchanged, no reload after close, past-session chain and corrupt manifest). `test/components/context-breakdown.test.ts` (split and sums, measured used, clamp, tones, limit text, estimate marks, narrow widths). No test covers non-built-in tool rendering (codemode/MCP) in the transcript.

## 4. Notifications

Files: `sub/plugins/notifications/index.ts`, adapter `core/adapter/pi-ui.ts:276-301,440-453`.

- Gate: `notify` returns when `quiet` (set by bus `session:closing`, emitted by `runner.shutdown`, `run-agent/runner.ts:901`) or `!settings.notifications` (`index.ts:41-51`).
- Triggers:
  - Input request (`agent:changed` with a new `attention` object on an open record, deduped per id by identity, `index.ts:53-65`): title `pi-subagents: <id> (<agent>) needs input: <attention.title>`, body `<record.description>`.
  - Main batch settled (`batch:settled` with `callerId === "main"`, `index.ts:67-71`): title `pi-subagents: <id> <state>, <id> <state>, <id> <state>[, +<n> more]` (`MAX_NAMED = 3`), body = first non-empty line of the first `done` result, else first line of any result or error (`index.ts:14-31`). Nested batches are silent.
  - Agent failed (`agent:closed`, `state === "failed"`, not a main-caller agent whose batch is already all closed, `index.ts:73-81`): title `pi-subagents: <id> (<agent>) failed`, body first line of `error`. The runner's own `agent:closed` listener runs first (registered earlier) and may already have emitted `batch:settled`.
- Adapter `terminalNotify` (`pi-ui.ts:440-453`): tui mode only; writes through the last captured TUI's terminal (else stdout). `notificationSequence` (`pi-ui.ts:292-301`): control chars stripped, `;` → `,` in title; rxvt (`TERM`/`TERM_PROGRAM` matches `/rxvt/i`) → `\x07\x1b]777;notify;<title>;<body>\x07`; otherwise `\x07\x1b]9;<title>: <body>\x07` (or `<title>` alone). Both start with BEL, so the terminal bell also rings.
- No in-TUI notification (`ui.notify`) is produced by this plugin; no throttling/coalescing.
- Observing pi's idle from another extension: `Host.onIdle(handler)` is pi's `agent_settled` (`core/adapter/pi-adapter.ts:152-158,196-198`); any extension (working-indicator, footer, session-limits) can register it independently. `Host.isIdle()` = `ctx.isIdle()`. There is no `onAgentEnd`.
- Tests: `test/plugins/notifications/notifications.test.ts` (one batch notice naming agents/states; failure notice vs batch notice; once per dialog; silent for nested batches; silent with setting off and during shutdown, with the shipped plugin order). `core/test/adapter/pi-ui.test.ts` (`terminalNotify`: BEL + OSC 9 in tui; OSC 777 for rxvt; nothing in rpc/print/json or stale; control chars stripped).

## 5. What the user sees in the main transcript

Tool plumbing: `ToolSpec.renderCall(params, theme) => string` and `renderResult(result, {expanded, invalidate}, theme) => string` (`core/adapter/contract.ts:23-36`); `toPiTool` wraps each string in a pi `Text` (reused via `lastComponent`) (`core/adapter/pi-tools.ts:46-65`). Without `renderResult`, pi's default result fallback shows the text output, first 10 lines, `... (<n> more lines, <key> to expand)` (`pi/.../tool-execution.js:98-111`). All tool rows sit in pi's coloured tool box.

- `run_agent` call (`run-agent/tools.ts:194-198`): `bold("run_agent") muted("<agent>, <agent>")`.
- `run_agent` result (`tools.ts:199-207`, `143-151`): one `agentRow` per started id (chain terminal), **fixed width 120, frame 0** (spinner frozen at `⠋`), no grace suffix (uses `agentRow`, not `treeRow`), joined by newlines. It live-updates: `onRendered` stores pi's `invalidate` per batch and `run-agent/index.ts:77-104` calls it at most every `renderThrottleMs` after `agent:changed` for that batch, until the batch is closed. If the registry has no such records (after `/reload` or resume) it falls back to the model text.
- Model text (only seen via that fallback), `wait` false (`tools.ts:171-178`):
  ```
  Started batch b-1a2b3c:
  - explorer-3f2a9c1b7d0e (explorer, prov/model:high)
  You will be woken once when all agents are done. End your turn now.
  ```
  `wait: true` returns `runner.batchText(batchId)` (same text as the wake below). Validation errors thrown by `startBatch` (`runner.ts:689-713`, e.g. `unknown agent(s): x. Available: …`, `maximum agent depth 3 reached`, model errors + `Nothing was started.`) become pi error results shown as text.
- The wake (`run-agent/outbox.ts`, `run-agent/result.ts`): on `batch:settled` the runner posts `batchText` to the main outbox (`runner.ts:159-176`); the outbox delivers immediately when idle, else holds and flushes on `onIdle`, joining held texts with `\n\n---\n\n` (`outbox.ts:16-31`); delivery is `host.sendUserMessage(text)` (`run-agent/index.ts:21-25`) → `pi.sendUserMessage` (followUp when busy, `pi-adapter.ts:206-219`) → `AgentSession.sendUserMessage` → `prompt(text, { source: "extension" })` (`pi/core/agent-session.js:1848-1876`). It is a **role `user` message**, rendered by pi's `UserMessageComponent` (Markdown on the user-message background, `pi/.../components/user-message.js`), indistinguishable in style from text the user typed, and it starts a new main turn. Text (`result.ts:93-106`, `resultEntry` `37-80`):
  ```
  [pi-subagents] Batch b-1a2b3c finished: 1 done, 1 failed.

  ## explorer-3f2a9c1b7d0e (explorer) - done
  Task: Map the auth module
  Chain: explorer-… → explorer-… (2 sessions)          (only for chains)
  Done (4 tool calls · 12.3k tokens · 1m 5s)
  Worktree: removed                                      (only with worktrees)

  <full result text inline when ≤ inlineResultChars (4000)>
  — or —
  Result file: <dir>/result.md (12345 chars)
  Preview: <first 300 chars, single line>

  ## worker-a1b2c3d4e5f6 (worker) - failed
  Task: Fix login bug
  Failed: spawn failed: … (0 tool calls · 0 tokens · 0s)
  ```
  `handoff` sections add `Handoff file: <path>[ (invalid: <reasons>)]`; `stopped` carries the last text when present. The `## …` lines render as Markdown headings; inline results render as Markdown inside the user bubble.
- `message_agent` (`tools.ts:210-244`): call `bold("message_agent") accent("<id>") muted("<first 60 chars>")`; result (default fallback): `Message delivered to <id> (steer|followUp|held).` or errors `Error: unknown agent "<id>".`, `Error: only the caller that started <id> may message it.`, `Error: agent <id> is closed (<state>); closed agents cannot receive messages. Start a new agent instead.` (`runner.ts:858`).
- `agent_status` (`sub/plugins/agent-status/index.ts:27-62`, `snapshot.ts:85-113`): call `bold("agent_status") muted("<ids>"|"all")`; result (default fallback, 10 lines then expand hint), per agent:
  ```
  explorer-3f2a9c1b7d0e (explorer, prov/model:high) running · 1m 5s · 12.3k tokens · 4 tool calls · ctx 23%
    last: <last non-empty line of lastText, 160 chars>
    result: <path>      (also: chain: link N, continues <id> / error: / handoff: / worktree:)
  ```
  grace label `grace (closes in <s>s unless messaged)` or `grace (answering a message)`; unknown ids `<id>: unknown agent`; empty `No agents in this session.`
- Forwarded dialogs (`run-agent/prompts.ts:39-93`): child `confirm/select/input` go through one serial queue to pi's own dialogs with title `<id> (<agent>) asks: <title>`; while waiting the record carries `attention` (row suffix, list group, terminal notification). Child `notify` → main `ui.notify("<id> (<agent>): <message>", level)`. A closed agent's dialog resolves to the denied value without showing.

Tests: `run-agent/run-agent.test.ts` (`Started batch`, wake `finished: 3 done`), `message-agent.test.ts` (`Message delivered to <id> (steer).`), `prompts.test.ts` (dialog titles, serial queue, attention), `successor-chain.test.ts`/`stop-grace.test.ts`/`nesting.test.ts` (wake headers), `agent-status.test.ts`. **No test covers `renderCall`/`renderResult` output or the live invalidation.**

## 6. Working indicator

Files: `extensions/working-indicator/src/working-indicator.ts`, `core/adapter/pi-working.ts`, `core/adapter/pi-adapter.ts`.

- Spinner: `SPINNERS.braille` (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 80 ms) set once on `onSessionStart` via `setWorkingIndicator` (`working-indicator.ts:3-18,123-125`); adapter paints frames with `theme.fg("accent")` (`pi-working.ts:7-23`); tui only.
- Start: `host.onAgentStart` (pi `agent_start`, `pi-adapter.ts:126-132`), skipped unless `session().mode === "tui"` (`working-indicator.ts:127-133`). `start()` stops any previous timer, records `startedAt`, reads `keyText("app.interrupt")` once, picks a random verb from `VERBS` (58 entries), ticks immediately then every `TICK_MS = 1000` (unref'd) (`working-indicator.ts:99-121`).
- Tick: new random verb every `VERB_MS = 8000`; `setWorkingMessage(workingMessage(verb, elapsed, key))` = `` `${verb}… (${s}s · ${key} to interrupt)` `` (`working-indicator.ts:83-84,107-116`), e.g. `Pondering… (12s · esc to interrupt)`.
- Stop: `host.onIdle` (pi `agent_settled`) and shutdown → clear interval, `setWorkingMessage(undefined)` (pi falls back to `"Working"`).
- Adapter wiring (`pi-adapter.ts:84-158`): handles `session_start`, `session_shutdown`, `before_agent_start` (main prompt), `agent_start`, `turn_end` (→ `onTurnEnd(ContextSnapshot)`), `session_compact`, `agent_settled`. **`turn_start`, `agent_end`, `message_*` and `tool_execution_*` are not wired**; `Host` has no handlers for them.
- Tests: `extensions/working-indicator/test/working-indicator.test.ts` (format; spinner at start; first message on agent start; seconds advance; verb change; counts across turns; clears on settle and shutdown; leaves message alone when idle; restarts clock; nothing outside tui). `core/test/adapter/pi-working.test.ts` (accent frames, restore defaults, tui only). `core/test/adapter/pi-adapter.test.ts:63` (forwards start, agent start, turn end, idle).

**6(a) Does the indicator keep running while the model streams text?** Yes. pi shows its working status line at `turn_start` when `workingVisible` (`pi/modes/interactive/interactive-mode.js:2758-2771`) and clears it only at `agent_end` (`:2953-2957`), on session switch, or when a compaction/retry/branch-summary indicator replaces it (`showStatusIndicator` disposes the active one, `:1783-1794`). `message_start`/`message_update` (`:2825-2869`) and `tool_execution_start/update/end` (`:2915-2951`) never touch it, so the spinner and message stay visible below the streaming text and during tool runs. `setWorkingMessage` only stores the text and, if a working indicator is active, updates it in place (`:2061-2066`); default text is `"Working"` (`:271,1817`). Ours just rewrites that text once per second; pi animates the spinner on its own 80 ms timer. Between `agent_end` (line hidden) and `agent_settled` (our stop) our timer still ticks invisibly. The composer's editor does not set `embedWorkingStatus`, so the line renders in pi's status container above the editor (`:1776-1793`). Nothing in this repo calls `setWorkingVisible`.

**6(b) Do subagent runs affect the main indicator?**
- Not directly. Children are in-process `AgentSession`s with their own resource loader and extension runner (`core/adapter/pi-child.ts:198-300`); our extensions return early inside the child scope (`pi-adapter.ts:258-260`, `pi-scope.ts`). Child events reach only the runtime's own listener (`pi-child.ts:306-354`: `turn_end`, `assistant_message`, top-level `tool_execution_start` → `tool_start`, `agent_settled` → `settled`), which updates the registry. No main `agent_start`/`agent_settled` fires, and the child UI context's `setWorkingMessage/Indicator/Visible` are no-ops (`pi-child.ts:98-121`).
- Indirectly, through the main turn lifecycle: (1) default `wait: false`: `run_agent` returns at once and the model is told to end its turn → main `agent_settled` → indicator stops while agents keep running; the only live signals then are the widget and the live `run_agent` result rows. (2) Batch done → wake: if main is idle the outbox calls `sendUserMessage` → new main prompt → `agent_start` → indicator restarts at 0 s with a new verb. If main was busy, the outbox flushes inside the `agent_settled` handlers; pi defers any `prompt()` issued during `agent_settled` until all settled handlers have run (`pi/core/agent-session.js:1518-1520`, `_emitAgentSettled` `:684-700`), so the working indicator's stop runs first and the wake then starts a fresh run. (3) `wait: true`: the tool blocks, the main run stays active, so the indicator ticks for the whole batch. (4) `session-limits:busy` (published by `agent-registry/index.ts:7-34` while any agent is open) is consumed only by session-limits (`extensions/session-limits/src/limits.ts:327`); working-indicator does not subscribe. (5) Forwarded dialogs and child notifies open pi dialogs/notifications in the main UI and do not change the indicator.

## 7. Footer

Files: `extensions/footer/src/footer.ts` (wiring), `extensions/footer/src/render.ts` (line builders), `core/adapter/pi-footer.ts`.

- Installed on `onSessionStart` with `host.ui.setFooter(render)` (tui only, `pi-footer.ts:7-52`); `cycleKey = keyText("app.thinking.cycle")`. Totals from `spending:totals` (`parseTotals`), kept in memory; refresh on totals and `onIdle` (`footer.ts:11-46`). pi re-renders the footer on any TUI render; the adapter truncates each line with a dim `…` and re-renders on git branch change.
- Lines (`render.ts:162-177`), each prefixed by `PAD = " "`, then one blank line (`PAD_BOTTOM`):
  ```
   45.2k · $0.42 · Model Name (200k context)            statsLine (tokens green/warning >70%/error >90%; cost hidden until spending publishes)
   Session total (agents included): 1.2M / $3.10 (sub)  sessionLine (only with totals)
   pi-extensions • my session                           placeLine
   main                                                 branchLine (when known)
   ▶▶ thinking high (shift+tab to cycle)                modeLine (`thinking unavailable` for non-reasoning models)

   <status> <status>                                    statusLine (only when any)

  ```
- Other extensions' statuses: `HostUi.setStatus(key, text)` → `ctx.ui.setStatus` (`pi-ui.ts:407-409`) → pi `footerDataProvider.setExtensionStatus` + `requestRender` (`interactive-mode.js:1772-1775`) → `FooterData.statuses` → `statusLine` (`render.ts:152-160`): sorted by key, whitespace collapsed, `pi-spending` hidden, joined with single spaces, after a blank line. Current users: session-limits (`limits.ts:77`, warning segment) and spending (`spending.ts:91`, hidden).
- A "N agents running" line: possible today with no adapter change: subagents calls `host.ui.setStatus("pi-subagents", host.ui.style("accent", "2 agents running"))` on `agent:changed`; it appears in the status line (sorted among others, single line, no own position). A dedicated footer line would need either a new channel in `core/manager/channels.ts` (like `spending:totals`) that footer renders, or footer special-casing a status key. Footer and statuses work with pi's default footer too.
- Tests: `extensions/footer/test/footer.test.ts` (install, hidden cost until totals, refresh, malformed totals, refresh on idle, live reads), `render.test.ts` (formatters, colours, statuses joining/skip spending, padded block), `core/test/adapter/pi-footer.test.ts` (tui only, truncation, ellipsis theme, branch re-render, restore, footerHost context memo).

## 8. `HostUi` and related contracts (`core/adapter/contract.ts`)

`HostUi` (`contract.ts:127-145`), implemented in `createUi` (`pi-ui.ts:303-460`); all UI calls are no-ops outside a live tui context unless noted:
- `notify(message, level?: "info"|"warning"|"error"): void` — pi toast (any mode with ctx).
- `setStatus(key, text|undefined): void` — footer status segment.
- `confirm(title, message): Promise<boolean>`, `input(title, placeholder?): Promise<string|undefined>`, `select(title, options: string[]): Promise<string|undefined>` — pi dialogs (`hasUI` required).
- `setWidget(key, render: ((width, theme) => string[]) | undefined): WidgetHandle` — factory widget, always `belowEditor`; `WidgetHandle = { refresh(): void }` (requestRender).
- `openOverlay(factory: OverlayFactory): Promise<void>` — full-screen overlay; `OverlayFactory = (api: OverlayApi) => ViewComponent` (`contract.ts:100-112`). `OverlayApi`: `theme`, `rows()`, `close()`, `requestRender()`, `toolsKey`, `wheelScrolling` (fullscreen TUI), `createTranscript(): TranscriptPane` (`sync(items)`, `setToolsExpanded`, `render`), `createScroll(): ScrollPane` (`window`, `scrollBy`, `scrollTo`, `scrollToStart/End`, `state()`), `createInput(placeholder): InputPane` (`feed(key)`, `value`, `setValue`, `setFocused`, `render`). `ViewComponent`: `render`, `handleKey(KeyPress)`, `handleWheel?`, `dispose?`. `KeyPress.name`: `up|down|pageUp|pageDown|home|end|enter|escape|space|tab|toggleTools|other` (+`char`, `raw`) (`contract.ts:40-56`).
- `style(token: ThemeToken, text): string` — theme colour (`accent|muted|dim|success|warning|error|text`).
- `terminalNotify(title, body): void` — OSC 9/777 (§4).
- `setWorkingIndicator({frames, intervalMs}|undefined)`, `setWorkingMessage(text|undefined)` (§6).
- `onEditorSubmit(rewrite: (text) => string|undefined): () => void`, `mapCommandCompletion(map: (command) => string|undefined): void`, `submitEditor(text): Promise<boolean>` (`pi-editor-input.ts:44-90`).
- `setEditorFrame(frame: EditorFrame|undefined)` (`contract.ts:118-125`, `pi-editor-frame.ts:57`).
- `setFooter(render: FooterRender|undefined): WidgetHandle`; `FooterRender = (width, theme, { branch, statuses }) => string[]` (`contract.ts:349-351`).
- `keyText(binding: string): string` — pi keybinding display text.
- Tool rendering: `ToolSpec.renderCall/renderResult` return strings only; no access to pi's render context (`isPartial`, `isError`, `durationMs`, `expanded` for calls, `renderShell`, `args`).
- `Host` events (`contract.ts:175-199`): `onSessionStart`, `onSessionShutdown`, `onIdle` (agent_settled), `onTurnEnd`, `onCompact`, `onAgentStart`; plus `isIdle`, `sendUserMessage`, `dispatchCommand`, `publish/subscribe`, `appendEntry`, `readEntries`, `sessionUsage`, `session`, `context`, `model`, `thinkingLevel`, `sessionName`.
- Available in pi but **not exposed**: widget placement `aboveEditor`; `setWorkingVisible`, `setHiddenThinkingLabel`, `setHeader`, `setTitle`, `getToolsExpanded`, raw `onTerminalInput`, `pi.sendMessage` (custom messages with `display`/`details`) and `pi.registerMessageRenderer(customType, …)` (`pi/core/extensions/types.d.ts:82-193,1226-1234`); events `turn_start`, `agent_end`, `message_update`, `message_end`, `tool_execution_start/end` (`types.d.ts:1185-1194`).

## 9. Bus events and `AgentRecord`

Bus (`sub/model/events.ts:5-12`): `agent:changed` (AgentRecord, every create/update/close; `registry.ts:98,114,128`), `agent:turn` ({id, context, turns, continuing}, `runner.ts:495`), `agent:closed` (AgentRecord, `registry.ts:129`), `agent:usage` ({id, usage: UsageTotals}, turn end, settle, dispose), `batch:settled` ({batchId, callerId, terminals}, `runner.ts:169`), `session:closing` (`runner.ts:901`).

`AgentRecord` (`sub/model/types.ts:48-80`), all usable by UI:
- Identity: `id` (`<agent>-<12 hex>`, `registry.ts:15`), `agent`, `description`, `callerId` (`"main"` or agent id), `depth` (main = 1, children ≥ 2), `batchId` (`b-<6 hex>`), `dir`, `sessionFile?`, `model?` (`provider/id:thinking` label).
- State machine: `queued → running → (grace) → done|failed|stopped|handoff`; `isClosed` (`types.ts:7-9`). `graceEndsAt?` (unset while answering a message during grace).
- Time: `createdAt`, `startedAt?`, `endedAt?` (set by `close`).
- Progress: `turns` (turn_end), `toolCalls` (+1 per top-level `tool_start`; tool name dropped, `runner.ts:512-514`), `tokens` = `input + output + cacheWrite` of the child's own usage (no cacheRead, `runner.ts:483`), `context?: ContextSnapshot` ({tokens, window, percent}), `lastText` (last non-empty assistant text, copied to the record only at turn_end, `runner.ts:486,505-507`).
- Results: `resultText?`, `resultPath?`, `error?`, `handoffPath`, `handoffRequested`, `contextLimit`.
- `attention?: { kind: "confirm"|"select"|"input"; title; since }`.
- Chain: `chainIndex`, `predecessorId?`, `successorId?` (`chainTerminal`, `chainLinks`, `types.ts:11-24`).
- `worktree?: { path, branch, base, cwd, cleanup?: "removed"|"branch kept"|"kept" }`.
- `version` (bumped per update/close).
- Not on the record: current tool name/activity, cost (only on `agent:usage`), last activity time, streaming text. Manifest persists only identity, state, times, paths, error, model, worktree, contextLimit (`registry.ts:21-42`).

## 10. UI-relevant settings (`sub/model/settings.ts`)

File `pi-subagents.json` (user `<agentDir>`, project `<cwd>/.pi/` when trusted), read once per session start.
- `lingerMs` 30 000 (0–3 600 000): widget linger for `done` only.
- `failedLingerMs` 60 000: widget linger for `failed`, `stopped`, `handoff`.
- `renderThrottleMs` 250 (0–10 000): progress-widget throttle and `run_agent` result invalidation; the list and agent view ignore it (`REFRESH_MS = 300`).
- `notifications` true: terminal notifications on/off.
- `stopGraceSeconds` 60 (0–3600): grace countdown in rows, view, `agent_status`; 0 closes at once.
- Also shown in UI: `inlineResultChars` 4000 (wake inline vs file+preview), `softContextRatio` 0.8 (breakdown tones), `reserveTokens` 16 384 (effective limit), `maxConcurrent` 4 (queued rows).

---

## Smells and redesign hooks

1. Three refresh paths with different clocks: widget (own 1 s ticker + `renderThrottleMs`), `watchAgents` (hard-coded 300 ms / 1 s) for list and view, `run_agent` result invalidation (`renderThrottleMs`, no ticker). A single shared "agents clock" service would remove `progress-widget/index.ts` timer logic and the separate invalidator map in `run-agent/index.ts:77-112`.
2. Spinner frames advance on refresh (≈1 Hz) in the widget, list and view, while pi's own spinner runs at 80 ms; `run_agent` rows use frame 0 (frozen `⠋`).
3. Widget: no row cap, creation order instead of tree order, header counts queued/grace as "running", always `belowEditor` (the adapter hard-codes placement).
4. `run_agent` result rows: fixed width 120, `agentRow` without grace suffix, empty registry after reload falls back to the model-facing `End your turn now.` text. No tests for `renderCall`/`renderResult`.
5. The wake is a plain role-`user` message (`sendUserMessage`), styled as user input, with whole results inline as Markdown. pi supports `sendMessage` custom messages with `details` plus `registerMessageRenderer`, which `Host` does not expose; a custom-message wake would need `triggerTurn` semantics and the outbox's idle handling re-checked.
6. Agent view transcript knows only 8 built-in tool definitions; `codemode`, `tool_search`, `mcp__*`, nested `run_agent`/`message_agent`/`agent_status` fall back to raw `JSON.stringify(args, null, 2)` + untruncated output that ignores the tools key. Codemode's renderers are not exported by pi; reuse requires capturing the definition at runtime.
7. Thinking blocks are always hidden in the agent view (`AssistantMessageComponent(raw, true, …)`, `pi-ui.ts:164`), with no toggle.
8. Prompt block sits above the transcript and includes full tool JSON schemas and the provider payload (often hundreds of lines); `(1 lines)` plural bug and doubled parentheses `Tools (9) (240 lines)` (`collapsible.ts:29`, `system-prompt-block.ts:16`); `wrapPlain` slices by characters, not display width or words (`view.ts:47-57`).
9. Agent view header icon is uncoloured (`titleText`, `view.ts:109`) while rows colour it; hint line has up to 9 parts on one line plus the position, and is cut by width truncation.
10. Past agents (manifest only) show `0 tool calls · 0 tokens` because counters, `lastText` and `context` are not persisted; the list and `/agents` completion ignore them entirely.
11. "Focus" mode filters nothing; it only collapses sections, tools and context. The mode file is global per agent dir.
12. List → `Enter` closes the list before opening the view; `Esc` in the view returns to the editor, not the list.
13. Duplicated helpers: `formatTokens` in `footer/src/render.ts:41` and `components/agent-row.ts:25`; `─` rule built in three places; `truncate` uses string length while the adapter re-truncates with `truncateToWidth`.
14. The record has no current activity: `tool_start` drops `toolName` (`runner.ts:512-514`), `lastText` updates only at turn end, cost lives only on `agent:usage`. Rows cannot say "running grep" or show cost without new fields.
15. `tokens` on the record excludes cacheRead (`runner.ts:483`) while spending's tokens include it, so row and footer token figures disagree in meaning.
16. The agent view re-parses the whole child session file on every change (size/mtime cache only), and cannot show streaming text because it reads only the written file.
17. Terminal notifications start with BEL, are not coalesced, and fire only in tui mode; there is no in-TUI counterpart (`ui.notify`) for a settled batch.
18. Working indicator: the clock covers the whole run, including `wait: true` batches and retries; nothing indicates running background agents once main is idle other than the widget. The adapter lacks `turn_start`/`agent_end`/`message_update`/`tool_execution_*` hooks and `setWorkingVisible`, so per-phase messages (e.g. "running tool X", "waiting for N agents") need adapter additions.
19. `ToolSpec` render callbacks return strings only; richer rows (partial state, duration, error colouring, expanded call view) need the pi render context surfaced through the contract.
20. A footer "N agents running" segment can ship today via `setStatus`, but it would sit in the generic status line, sorted by key; a structured channel would be needed for a dedicated line.
