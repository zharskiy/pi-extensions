# Plan 06: `/agents` list and agent view (one overlay), codemode rendering

Implements `plans/00-ux-spec.md` §5 (Surface C) and §6 (Surface D), decisions D3, D4, D7. Uses plan 01 §D (`createTranscript({ tools })`, captured codemode/tool_search renderers) and §E (one overlay swapping views, no contract change). Imports, never redefines: plan 04 `components/format.ts`, `components/spinner.ts`, `components/state-text.ts`, the `tools` service and `AgentRecord.activity`; plan 05 `components/agent-row.ts` (`renderRow`, `nameColumn`), `components/tree.ts` (`treeOrder`), `components/refresh.ts` (`watchAgents`). Owns: the `lingerMs` meaning change, `agentView.open(id, { from })`, and the deletions listed in §6.

## 1. Goal

1. `/agents` opens a full-screen list: `Running` (tree), `Needs input`, `Completed (n)`, the panel's row grammar, closed rows for `lingerMs` (30 s) or until `x` clears them.
2. `Enter` turns the same overlay into the agent view; `Esc` goes back to the list (selection and scroll kept, rows reloaded). A view opened from the panel or `/agents <id>` closes on `Esc`.
3. The agent view is a header (state, stats, error/handoff, chain, worktree) plus the transcript drawn with pi's components. No prompt sections, no context breakdown, no modes, no message box.
4. Codemode calls render as in the main session (highlighted script, nested calls, 5-line output preview), and nested `run_agent`/`message_agent`/`agent_status` calls use the extension's renderers. This plan only passes `tools`; plan 01 §D does the rendering.
5. Past agents (manifest only) show real counters: the manifest now stores `turns`, `toolCalls`, `tokens`.
6. Every string, key and timing comes from spec §5/§6. The mockups there are the acceptance pictures (§5 "Mockup", §6 "Mockup (running agent, codemode call collapsed)").

Behaviour summary: list = spec §5 Layout, Lifecycle, Keys, feedback line, hint line, "List and view in one overlay". View = spec §6 Header 1–6, Transcript, Scrolling, Hint line table, Keys, Refresh, Removed.

## 2. Architecture: one plugin, one overlay host

Decision: merge `agent-list-view` into the existing `agent-view` plugin (id unchanged). Folder `extensions/subagents/src/plugins/agent-view/`:

| file | content |
|---|---|
| `index.ts` | plugin: `/agents [id]` command, completion, `agentView` service, wiring of deps |
| `overlay.ts` | `createAgentsOverlay`: host component holding `current` and swapping list ↔ view |
| `list-model.ts` | pure list logic: visibility, sections, subtitle, hint, selection carry-over |
| `list.ts` | `createAgentList`: the list `ViewComponent` (+ `suspend`/`resume`) |
| `view.ts` | `createAgentView` and the pure `headerLines` |
| `loader.ts` | `createAgentSource`: live/manifest lookup, chain ids, cached session reader (moved from `index.ts`) |

Why merge (two lines): the list existed as a separate plugin only to hand a factory across a service (`agentList`), and list and view now share one overlay host and the `from` semantics, so the split costs a plugin, a service and a cross-plugin round trip for nothing. Why keep the id `agent-view` instead of a new `agent-views`: plan 05's panel and users' `disabledPlugins` already name `agent-view`; unknown ids in `disabledPlugins` are ignored silently (`extension-manager.ts:79-82`), so a stale `"agent-list-view"` entry is harmless.

`requires: ["agent-registry"]` (unchanged). `runner`, `definitions` and `tools` stay optional (`services.has`), as today.

### `model/types.ts` (ServiceMap)

```ts
export type AgentViewOrigin = "list" | "panel" | "command";
type AgentViewService = { open(id: string, options: { from: AgentViewOrigin }): Promise<void> };
```

Remove `AgentListService` and the `agentList` key. `agentView` keeps its key.

### Overlay host (`overlay.ts`)

```ts
export type OverlayStart = { kind: "list" } | { kind: "view"; id: string; from: AgentViewOrigin };
export type ListComponent = ViewComponent & { suspend(): void; resume(): void };
type OverlayParts = {
  list(hooks: { open(id: string): void; leave(): void; selected?: string }): ListComponent;
  view(id: string, from: AgentViewOrigin, leave: () => void): ViewComponent | undefined; // undefined: id no longer resolves
};
export const createAgentsOverlay = (api: OverlayApi, start: OverlayStart, parts: OverlayParts): ViewComponent
```

- State: `list?: ListComponent`, `current: ViewComponent`, `disposed = false`.
- `close()`: `dispose()` then `api.close()`. Only the host calls `api.close()`; list and view get a `leave` callback and never touch `api.close`.
- `showList(selected?)`: `list ??= parts.list({ open: showView, leave: close, selected })`; `list.resume()`; dispose the previous view; `current = list`; `api.requestRender()`.
- `showView(id)` (from the list): `const view = parts.view(id, "list", () => showList())`; if undefined, do nothing; `list.suspend()`; `current = view`.
- Start `{ kind: "list" }` → `showList()`. Start `{ kind: "view", id, from }` → `current = parts.view(id, from, from === "list" ? () => showList(id) : close)`. A service call with `from: "list"` therefore opens the view first and `Esc` builds the list with that agent selected.
- Delegation: `render(width) => current.render(width)`, `handleKey(key) => current.handleKey(key)`, `handleWheel(lines) => current.handleWheel?.(lines)`. `dispose()`: once (`disposed` guard; pi also calls it after `done()`), disposes `current` and, when different, `list`.

### Command and service (`index.ts`)

- `agentView.open(id, { from })`: `terminalOrNotice(id)` exactly as today (`pi-subagents: unknown agent "<id>"`, `pi-subagents: cannot read manifest of "<id>": <msg>`, both `warning`, no overlay); then `host.ui.openOverlay((api) => createAgentsOverlay(api, { kind: "view", id, from }, parts(api)))`.
- `/agents`: description `Open the agents list, or one agent's view by id. Usage: /agents [id]`. `run(args)`: non-empty id → `open(id, { from: "command" })`; empty → overlay with `{ kind: "list" }`. The `host.ui.select` fallback goes (the list is always there now).
- Completion: the ids of the agents the list currently shows (`visibleRecords(registry.list(), Date.now(), settings.lingerMs, cleared)`), prefix-filtered, label `<id> · <stateWord(state)> · <description>` cut with `truncateCols(…, 100)`. Older agents still open by typed id.
- Plugin-scope state: `cleared = new Set<string>()` (ids cleared with `x` in the list; per extension instance, independent of the panel's own clearing, survives reopening `/agents`).
- `parts(api)`: `list` → `createAgentList({ records: () => registry.list(), lingerMs: settings.lingerMs, cleared, stop, watch, ...hooks }, api)`; `view` → `source.find(id)` (try/catch → `undefined`), then `createAgentView({ load: source.loader(id, terminal), from, tools: tools(), reserveTokens: settings.reserveTokens, stop: () => stop(id), watch: viewWatch(id), leave }, api)`.
- `stop = (id) => services.has("runner") ? services.require("runner").stop(id) : undefined`; `tools = () => services.has("tools") ? services.require("tools") : []` (the `AnyToolSpec[]` plan 04 provides).
- `watch(tickMs, onChange)` = `watchAgents(bus, { relevant, tickMs, throttleMs: () => settings.renderThrottleMs, onChange })`; list: `relevant: () => true`; view: `relevant: (record) => chainLinks(registry, record).some((link) => link.id === id)` and `tickMs`: the live chain terminal `running`/`grace` → 100, `queued` → 1000, closed or not live → `undefined`.

## 3. The list (`list-model.ts`, `list.ts`)

### Data and sections (`list-model.ts`, pure)

```ts
export const visibleRecords = (records: AgentRecord[], now: number, lingerMs: number, cleared: ReadonlySet<string>) =>
  records.filter((r) => !isClosed(r.state) || (!cleared.has(r.id) && r.endedAt !== undefined && now - r.endedAt < lingerMs));
export type ListSection = { title: string; rows: TreeRow[] };
export const listSections = (visible: AgentRecord[]): ListSection[];
export const subtitle = (visible: AgentRecord[], sections: ListSection[]): string; // " · 3 running · 1 done" | ""
export const listHint = (selected: AgentRecord | undefined): string;
export const carrySelection = (previousIds: string[], ids: string[], selected: string | undefined): string | undefined;
```

- `Running`: open records without `attention` (queued, running, grace), `treeOrder(running)`; a child whose caller is in another section renders at depth 0 (`treeOrder`'s rule).
- `Needs input`: open records with `attention`, flat, by `createdAt`.
- `Completed (n)`: closed records, flat, newest `endedAt` first. Title `Completed (${rows.length})`.
- Flat rows are `TreeRow`s with `depth: 0, last: true, ancestorsContinue: []` and `openDescendants` taken from `treeOrder(visible)` (one map by id), so `(+N)` agrees across sections.
- Empty sections are dropped. Subtitle: `running` = every open visible record, `done` = Completed rows, a zero part omitted, joined with `SEP`.
- `listHint`: none selected → `esc to close`; open (queued/running) → `↑/↓ to select · enter to view · x to stop · X to stop all · esc to close`; grace → the same with `x to close now`; closed → with `x to clear`.
- `carrySelection`: keep `selected` if still in `ids`; else the first id after its old index in `previousIds` that is still in `ids`; else the nearest one before it; else `undefined` (spec "moves the selection to the next row, or clears it": cleared only when no row is left).
- The old `components/agent-list.ts` is deleted, not rewritten (its grouping, filter and `treeRow` rendering are all replaced); `components/hints.ts` is deleted (`stopHint`/`scrollHint` texts are gone from both surfaces; no other user after plan 05 removes the progress widget).

### Component (`list.ts`)

```ts
export type ListDeps = {
  records(): AgentRecord[]; lingerMs: number; cleared: Set<string>;
  stop(id: string): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void): () => void;
  open(id: string): void; leave(): void; selected?: string;
};
export const STOP_ALL_CONFIRM_MS = 3_000;
export const NO_AGENTS_MS = 2_000;
export const createAgentList = (deps: ListDeps, api: OverlayApi): ListComponent
```

- State: `visible`, `sections`, `ids` (selectable, display order), `selectedId` (initial `deps.selected ?? ids[0]`), `scroll = api.createScroll()`, `feedback?: { text; token: "warning" | "muted" }`, `feedbackTimer`, `pendingStopAll = false`, `unwatch`.
- `reload()`: `visible = visibleRecords(deps.records(), Date.now(), deps.lingerMs, deps.cleared)`, recompute sections and ids, `selectedId = carrySelection(oldIds, ids, selectedId)`, `api.requestRender()`. Runs on `watch` (throttled `agent:changed` plus the shared tick: `tickMs` = 100 while any visible record is `running`/`grace`, 1000 while rows are shown, `undefined` with no rows; the 1 s tick also expires lingering rows).
- `suspend()`: `unwatch()`. `resume()`: `reload()` and re-`watch`. Created resumed by the host.
- `render(width)`: title block `[bold("Agents") + dim(subtitle), ""]`; body: for each section a blank line before all but the first, `bold(title)`, then `renderRow({ ...row, selected: row.record.id === selectedId }, now, width, api.theme, nameColumn(visible))` (one name column for the whole list); with no rows the title is `bold("Agents")` and the body is `fg("muted", "No agents running")`. Footer: feedback line (`fg(token, text)`) when set, then `fg("dim", listHint(selected))`. `height = max(1, api.rows() - 2 - footer.length)`; `scroll.window(body, height)`; if the selected line is outside `[top, top + height)` → `scroll.scrollTo(line < top ? max(0, line - 1) : line - height + 1)` and window again (the `- 1` keeps a section header in view); pad to `height`.
- Keys (spec §5):

| key | action |
|---|---|
| `up` / `down` | `move(∓1)`: selection over `ids`, clamped; no selection → first row |
| `pageUp` / `pageDown` | `move(∓(height - 1))` (the window scrolls with the selection, which stays visible) |
| `home` / `end` | first / last id |
| wheel | `move(lines)` (deviation: moves the selection like the page keys, so "the selection is kept visible" holds) |
| `enter` | `deps.open(selectedId)` when set |
| `x` | open → `stop(id)` (queued closes, running enters grace); grace → `stop(id)` (runner closes now); closed → `deps.cleared.add(id)`, `reload()` |
| `X` | stop-all flow below |
| `escape` | pending confirmation → cancel only; else `deps.leave()` |
| other (`/`, letters, `tab`, `space`, `toggleTools`) | nothing |

- Stop-all: `X` with no `queued`/`running` visible record → `showFeedback("No running agents", "muted", NO_AGENTS_MS)`. Otherwise, first `X` → `pendingStopAll = true`, `showFeedback("Press X again to stop all agents", "warning", STOP_ALL_CONFIRM_MS)`; second `X` while pending → `stop(id)` for every `queued`/`running` record (grace records are left alone: they are stopping already, and a second stop would close them now), clear feedback and pending. Any other key while pending clears feedback and pending, then (except `Esc`) performs its own action.
- `showFeedback(text, token, ms)`: clear the old timer, set feedback, `setTimeout(() => { feedback = undefined; pendingStopAll = false; api.requestRender(); }, ms)`. A rejected stop shows `stop failed: <message>` (`warning`, 3000 ms) (kept from today; not in the spec). `dispose()` clears the timer and unwatches; a timer or stop resolving after dispose does nothing (`disposed` flag).

## 4. The agent view (`view.ts`, `loader.ts`)

### Loader (`loader.ts`, moved from `index.ts`)

```ts
export type ViewData = { record: AgentRecord; openedId?: string; chain: string[]; session?: SessionRecord; error?: string };
export const createAgentSource = (deps: { host: Host; runtime: AgentRuntime; registry: AgentRegistry; limitOf(agent?: string): number }) => ({
  find(id: string): AgentRecord | undefined,   // live chain terminal, else manifest followed through successorId; throws on corrupt JSON
  loader(id: string, found: AgentRecord): () => ViewData,
});
```

- `fromManifest`, `pastTerminal`, `findTerminal`, the `CachedSession` stat cache and the error texts (`session file not written yet`, `cannot read session: <msg>`) move unchanged. `limitOf` is today's `definedLimit`.
- `chain`: live → `chainLinks(registry, record).map((link) => link.id)`; manifest → walk `predecessorId` through `fromManifest` (stop at a missing or unreadable manifest), oldest first.
- The manifest fallback keeps `{ turns: 0, toolCalls: 0, tokens: 0, ...manifest }`, so old manifests show `0 tool uses`, new ones their stored counters (below).

### Manifest counters (`agent-registry/registry.ts`)

Add `turns: record.turns, toolCalls: record.toolCalls, tokens: record.tokens` to the object written by `writeManifestFile`. The manifest is rewritten on every state change and on close (`registry.close` → `persist`), so a closed agent's manifest carries its final counters; mid-run values may lag, which only matters after a crash. No other writer changes.

### Component

```ts
export type ViewDeps = {
  load(): ViewData; from: AgentViewOrigin; tools: AnyToolSpec[]; reserveTokens: number;
  stop(): Promise<unknown> | undefined;
  watch(tickMs: () => number | undefined, onChange: () => void): () => void;  // tickMs supplied by index.ts
  leave(): void;
};
export const createAgentView = (deps: ViewDeps, api: OverlayApi): ViewComponent;
export const headerLines = (data: ViewData, theme: ThemeLike, width: number, now: number, reserveTokens: number): string[];
```

Header (`headerLines`, spec §6 lines 1–6, then the rule):

```ts
// 1. title (glyph in the state token; no "(agent)", no "continues"/"continued by": the chain line replaces them)
fg(stateToken(s), stateGlyph(s, now)) + " " + bold(id + (chainIndex > 1 ? ` #${chainIndex}` : ""))
  + ` · ${stateWord(s)} · ${model ?? "model n/a"}`
  + (open && attention ? fg("warning", ` · needs input: ${oneLine(attention.title)}`) : "")
// 2. description, no "Task: " prefix
fg("muted", truncateCols(oneLine(description), width))
// 3. stats, live while open
fg("dim", [formatToolUses(toolCalls), tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
  formatDuration((endedAt ?? now) - (startedAt ?? createdAt)), formatCtx(ctxPercent)].filter(Boolean).join(SEP))
// ctxPercent = ctxTokens / limit * 100, ctxTokens = record.context?.tokens ?? session?.contextTokens,
// limit = effectiveContextLimit(record.contextLimit, record.context?.window ?? 0, reserveTokens);
// undefined when ctxTokens is null/undefined or limit <= 0
// 4. optional (result.ts:55 stores invalid-handoff reasons in `error` too)
failed:  fg("error", `error: ${firstLine(error ?? "unknown error")}`)
handoff: fg("warning", `handoff: ${handoffPath}${error ? ` (invalid: ${error})` : ""}`)
// 5. optional, chain.length > 1
fg("dim", `chain: ${chain.join(" → ")} (${chain.length} sessions)${openedId ? ` · opened ${openedId}` : ""}`)
// 6. optional; worktreeText unchanged: "<path> (branch <b>)", "removed", "removed; branch <b> kept", "kept: <path> (branch <b>)"
fg("dim", `worktree: ${worktreeText(worktree)}`)
// 7. rule
fg("dim", "─".repeat(width))
```

`oneLine` = `text.replace(/\s+/g, " ").trim()`, `firstLine` = first line of the text; both local to `view.ts`.

Body: `data.error` → one `warning` line with it; else `transcript.render(width)`, or `fg("dim", "(no transcript yet)")` when empty. No `Effective prompt`/`Transcript` titles.

Transcript: `transcript = api.createTranscript({ tools: deps.tools })`; `sync(data.session?.items ?? [])` on every load; a new pane (same `tools`, `setToolsExpanded(toolsExpanded)`) when `record.id + sessionFile` changes (successor), as today. `toolsExpanded` starts `false`.

Footer: optional `fg("warning", notice)` (`stop failed: <msg>`, cleared on the next key), then the hint line. `height = max(3, api.rows() - header.length - footer.length)`; `scroll.window(body, height)`; pad.

Hint line (spec §6 table): parts `esc to go back` (from the list) or `esc to close`; `x to stop` (open) or `x to close now` (grace), absent when closed; `<api.toolsKey> tool detail`; `↑/↓ to scroll`; joined with `SEP`. Position `${top + 1}-${min(total, top + height)}/${total}`, plus ` · end to follow` when the agent is open and `!scroll.state().following`; omitted when `total === 0`. Right-aligned: `hint + " ".repeat(width - w(hint) - w(pos)) + pos` (both `dim`) when `displayWidth(hint) + 2 + displayWidth(pos) <= width`, else `truncateCols(hint, width)`.

Scrolling and follow: `api.createScroll()` is pi's `ScrollView({ follow: "end" })` (`pi-ui.ts:213-244`). Today's behaviour, kept unchanged and sufficient: it starts following, so the first layout pins to the tail (opens at the tail); `scrollBy(-n)`, `scrollToStart()` (when content exceeds the viewport) clear following; `scrollToEnd()` sets it; while following, every `window()` call re-pins to the new tail, otherwise the top is kept and clamped. One nuance: reaching the tail with `↓`, `PgDn` or wheel-down also resumes following (ScrollView sets following whenever the top equals the maximum). That is accepted (being at the tail is following); `End` remains the documented way. Nothing in `createScrollPane` changes.

Keys (spec §6): `up` → `scrollBy(-1)`; `down` → `scrollBy(1)`; `pageUp`/`pageDown` → `scrollBy(∓max(1, height - 1))`; `home` → `scrollToStart()`; `end` → `scrollToEnd()`; `toggleTools` → flip `toolsExpanded`, `transcript.setToolsExpanded`; char `x` → when open, `Promise.resolve(deps.stop()).then(reload).catch(fail)` (runner: running → grace, grace/queued → closed now); `escape` → `deps.leave()`; wheel → `scrollBy(lines)`. Everything else (`enter`, `space`, `tab`, `c`, `v`, letters) does nothing.

Refresh: `deps.watch(tickMs, reload)`. `reload()` (no-op after dispose) calls `deps.load()`, re-syncs the transcript, `api.requestRender()`. `load()` re-resolves the live chain terminal (cheap) and stats the session file; it re-parses only when size or mtime changed (the cache in `loader.ts`). A change refresh comes at most every `renderThrottleMs` after a chain `agent:changed`; the tick (100 ms running/grace, 1000 ms queued, none when closed) animates the spinner and the stats line and, as a side effect, also stats the file. Parsing is still gated on size/mtime, so this costs one `stat` per tick. A closed or manifest-only agent never ticks.

## 5. Codemode and nested tools

Nothing to implement beyond `createTranscript({ tools: deps.tools })`. Plan 01 §D makes `createTranscriptPane` resolve `codemode`/`tool_search` through renderers captured from pi's factories and our specs through `tools`. The tests in §9 prove it in the agent view with pi's real components:

- Codemode fixture (inline JSON lines, parsed with `parseSessionLines`): a user task; an assistant message with text `I will start with the login path.` and a `toolCall` `{ id: "cm1", name: "codemode", arguments: { code: <the 3-line script of the spec mockup> } }`; a `toolResult` for `cm1` with content `[{ text: "Script completed\nWall time 0.42 seconds\nOutput:\n" }, { text: <8 lines starting "export const login = async (req: Request) => {"> }]` and `details: { calls: [{ id: "n1", name: "grep", args: "{\"pattern\":\"login\",\"path\":\"src\"}", status: "ok", durationMs: 120 }, { id: "n2", name: "read", args: "{\"path\":\"src/auth/login.ts\"}", status: "ok", durationMs: 40 }] }`; then an assistant `grep` call with no result yet.
- Expected visible text, collapsed (stripped of APC/SGR): a ` codemode` title line; ` const hits = await tools.grep({ pattern: "login", path: "src" });`; ` ✓ grep {"pattern":"login","path":"src"}` followed by pi's duration; ` ✓ read {"path":"src/auth/login.ts"}`; output lines 1–5 and a `more lines` expand hint; not output line 6; no `Script completed`; no `"code":` (the generic JSON fallback). Expanded with `toggleTools`: output line 6 present. The collapsed transcript is snapshotted.
- Nested `run_agent`: the agent's session has an assistant `toolCall` `run_agent` `{ agents: [{ agent: "explorer", task: "find callers" }] }` and its `toolResult`. The rendered text must not contain the generic `"agents": [` JSON, and the `run_agent` spec's `renderCall` must have been called with those args (spy, §9).

## 6. Deletions

| what | where | note |
|---|---|---|
| `mode-store.ts` + `pi-subagents-view.json` | `src/plugins/agent-view/` | no reader or writer remains; existing files on disk are left alone |
| context breakdown | `src/components/context-breakdown.ts`, `test/components/context-breakdown.test.ts` | |
| prompt sections | `src/components/system-prompt-block.ts`, `src/components/collapsible.ts` | no other importer (grep) |
| list grouping/filter | `src/components/agent-list.ts`, `test/components/agent-list.test.ts` | replaced by `list-model.ts` |
| hints | `src/components/hints.ts` | |
| old list plugin | `src/plugins/agent-list-view/` (both files), `test/plugins/agent-list-view/`, its line in `src/plugins.ts` | |
| message box | `view.ts`: `api.createInput`, `send`, `deliveryText`, `showRouteResult`, input focus, `Tab` cycle; `index.ts`: `send()` and the `runner.route(id, { sender: "user" })` call | `runner.route` itself stays (`message_agent` uses it) |
| `/` filter, `X`+`y` | old `agent-list-view/view.ts` | gone with the file |
| `context` deps | `index.ts`: `softRatio`, `estimate: runtime.estimateTokens` | |
| `select` fallback | `/agents` without the list | |

Kept on purpose:
- The child extension keeps writing `pi-subagents:prompt-record` (`pi-child.ts`), and `runtime.readSession` keeps returning `prompt` (`session-file.ts` replay, `PromptRecord` in the contract). Cheap, harmless, keeps the effective prompt inspectable for a future surface. Only the UI goes. The parser tests move to `core/test/adapter/session-file.test.ts` (§9).
- `OverlayApi.createInput`, `InputPane`, `createInputPane` stay in the contract and the adapter, and `createFakeInputPane` in the fakes. After this plan no extension calls `createInput` (only `core/test/adapter/pi-ui.test.ts` tests `createInputPane`). It is a general overlay capability, so it is kept regardless.
- `AgentRuntime.estimateTokens` stays in the contract (no extension caller left; same reasoning).

## 7. Settings

- `lingerMs`: no code change (default 30 000, range 0–3 600 000). Meaning: how long a closed agent stays in the `/agents` list. The panel stops reading it in plan 05 (`doneLingerMs`/`failedLingerMs`).
- `renderThrottleMs` now also throttles the list and the view (through `watchAgents`).
- Nothing reads or writes `pi-subagents-view.json` any more.

## 8. Docs (final text)

`extensions/subagents/README.md`, "Use". Line 36 keeps its first sentence (the panel, plan 05). Its second sentence (`` `/agents <id>` opens an agent's view… ``), the three sub-bullets after it (prompt sections, message box, context breakdown) and the `/agents` list bullet are replaced by:

```markdown
- `/agents` opens the agents list over the whole screen: `Running` (open agents, children under the agent that started them), `Needs input` (agents waiting on a dialog) and `Completed (n)` (finished, failed, stopped or handed off, newest first; each stays `lingerMs`, 30 s by default). `↑`/`↓` select, PgUp/PgDn, Home/End and the mouse wheel move faster, `Enter` opens the agent's view in the same overlay, `x` stops the selected agent or clears a finished row, `X` twice within 3 seconds stops every running agent, `Esc` closes.
- The agent view (`Enter` in the list or on a panel row, or `/agents <id>` for any agent of this session, also from earlier runs and any link of a handoff chain) shows the agent's state, id and model, its description, `N tool uses · tokens · time · N% ctx`, the error or handoff file, the chain and the worktree, then its transcript drawn with pi's own components: codemode scripts with their nested tool calls and output, and nested `run_agent` blocks as in the main session. It opens at the end and follows new output; `↑`, PgUp, Home or the wheel stop following, `End` resumes. Ctrl+O (pi's tools key) toggles tool detail. `x` stops the agent: its turn is aborted and it closes after `stopGraceSeconds` unless its caller messages it first; `x` again closes it now. `Esc` goes back to the list when you came from it, otherwise closes. Worktree agents show `worktree: <path> (branch <branch>)`, and after they finish what became of it (below). To correct an agent, ask the main session; it messages the agent with `message_agent`.
```

README settings sentence: replace `` `lingerMs` (30000; how long done rows stay in the widget and list) `` with `` `lingerMs` (30000; how long finished agents stay in the `/agents` list) ``. In the `renderThrottleMs` fragment (rewritten by plan 04), the list and view part reads `` the `/agents` list and the agent view refresh at the same rate `` (drop `refresh every 300 ms`).

`ARCHITECTURE.md`:
- Plugin list: replace `` `agent-view` [registry] (`/agents`), `agent-list-view` [registry, agent-view] `` with `` `agent-view` [registry] (`/agents`: the list and the agent view in one overlay, the `agentView` service) ``.
- Run step 5, second sentence → `The entry stays in the session file and runtime.readSession still parses it; no view shows it.` (with backticks around the identifier).
- Messages bullet: `` `message_agent` (only the agent's caller) routes `[message from <sender>]` text: … `` (drop "and the agent view").
- "Status, views, notifications": replace the list half of the widget bullet (plan 05 rewrites the panel half) and the agent view bullet with:
  - `` The `/agents` list re-renders on `agent:changed` (throttled by `renderThrottleMs`) plus the shared ticker; closed rows stay for `lingerMs` or until `x` clears them. ``
  - `` The agent view shares the list's overlay (one `openOverlay`; the host component swaps list and view, `Esc` returns to the list only when the view was opened from it). It reads the agent's session file through `runtime.readSession`, re-parsing only when the file's size or mtime changed, and falls back to `manifest.json` (which stores the final `turns`, `toolCalls` and `tokens`) for agents not in memory. Its transcript renders built-in tools with pi's definitions, `codemode`/`tool_search` with renderers captured from pi's exported extension factories (generic fallback if capture fails), and the subagents tools with the specs passed to `createTranscript({ tools })`. Nothing of the view is persisted. ``
- Persistence summary: `manifest.json` line → `` `manifest.json` (rewritten on state or worktree change; final counters on close) ``; `<agentDir>` line drops `pi-subagents-view.json`.

`STRUCTURE.md`:
- Plugins: `agent-view/  # /agents overlay: index (command, service), overlay.ts (list/view host), list.ts + list-model.ts, view.ts, loader.ts`; delete the `agent-list-view/` line.
- Components comment: remove `agent-list`, `collapsible`, `context-breakdown`, `system-prompt-block`, `hints.ts` (plans 04/05 add their modules to the same comment).

## 9. Tests

Helpers: `extensions/subagents/test/helpers/overlay.ts` (new) exports `plain`, `key`, and `fakeOverlayApi(rows)` returning `{ api, state: { closed, renders }, transcripts: { tools?: AnyToolSpec[] }[] }`, with `createTranscript: (options) => { transcripts.push(options ?? {}); return createTranscriptPane({ requestRender } as never, "/repo", { tools: options?.tools }); }`, `createScroll: () => createScrollPane(requestRender)`, `createInput: createFakeInputPane`. Old local `fakeApi`s go. Fixture `test/plugins/agent-view/fixtures/recorded-session.jsonl` stays. Snapshot file `__snapshots__/agent-view.test.ts.snap` is deleted and re-recorded as `view.test.ts.snap`. Tests that use fake timers call `vi.useRealTimers()` in `afterEach`, and every opened view is disposed in `afterEach`.

### Mapping of `test/plugins/agent-view/agent-view.test.ts` (renamed `view.test.ts`)

| old test | fate |
|---|---|
| system prompt block: renders the recorded prompt… / lists MCP tools… / starts collapsed… | removed from the view; the first two become parser tests in `core/test/adapter/session-file.test.ts` (below); the third goes |
| reuses the rendered prompt block… | removed |
| opens for a closed agent by reading its session file | changed: ``lines[0] === `✓ ${id} · done · ${model}` ``, `lines[1] === "list agents"`, `lines[2]` matches `/^\d+ tool uses? · /`, `lines[3]` is the rule, transcript line ` Three files: …` present, last line starts `esc to close · ctrl+o tool detail · ↑/↓ to scroll` |
| renders the transcript with pi's message and tool components | changed: slice from the line after the rule to before the hint; snapshot re-recorded (only the `Transcript` title line disappears) |
| toggles tool detail with the tools-expand key | survives |
| toggles sections with Enter and moves focus with Tab | replaced by `ignores Enter, Space, Tab, c and v` (render unchanged, overlay open) |
| opens at the tail, scrolls with keys and the wheel… | changed: `opens at the tail and scrolls with keys and the wheel` (open record; Home shows the task line first and appends ` · end to follow`; wheel 3 moves the top by 3; End drops the suffix) |
| follows new entries at the tail and keeps the position when scrolled up | survives |
| starts a fresh transcript when the view follows a successor… | survives (new deps shape) |
| enters grace on the first x and closes on the second, notifying the caller once | changed: hint `x to stop` → `x to close now` after the first `x`; state grace → stopped; child aborted; the caller-notification assertion goes (runner tests cover it; plan 02 changes the wake) |
| only notifies for unknown agents and opens nothing | moves to `overlay.test.ts`, unchanged |
| message box (7 tests), input focus (1) | removed; replaced by `never routes anything from the UI` (type `hello` + Enter on a running agent: `runner.route` spy not called, no input line rendered) |
| follows the opened link to its live successor and stops the successor | changed: `lines[0]` contains `${second} #2`; a line equals `chain: ${first.id} → ${second} (2 sessions) · opened ${first.id}`; hint contains `x to stop`; no `(type a message)`; `x` stops the successor |
| shows the chain index, chain links and a pending question | changed: `vi.setSystemTime(0)`; ``lines[0] === `⠋ ${id} #2 · running · model n/a · needs input: Allow rm -rf build?` ``; chain line from `chain: ["explorer-0001", id]` |
| context breakdown: toggles… / reads the measured total… | removed |
| opens from the manifest with the definition's limit | changed: stats line ends `· 2% ctx` (fixture context 2.3k of 100k) |
| prefers the limit stored in the manifest… | changed: `contextLimit: 70_000` → `· 3% ctx`; unknown agent without a limit → no `ctx` part |
| refreshes the block with the live turn context | changed: `refreshes the header stats with the live turn context` → after `turn({ tokens: 85_000, window: 200_000 })` the stats line ends `· 85% ctx` |
| modes (4 tests) | removed; replaced by `writes no view state file` (press `v`, `pi-subagents-view.json` absent under the agent dir) |
| shows the worktree and branch under the task | changed: `lines[3] === "worktree: /project/.pi/worktrees/explorer-1-abc (branch pi-agents/explorer-1-abc)"`, `lines[4]` is the rule; with `cleanup: "branch kept"` → `worktree: removed; branch pi-agents/explorer-1-abc kept` |
| does not parse the session file again while its size and time are unchanged | survives |
| never reloads after close, and reports a failed stop | survives (`stop failed: runner gone`) |
| follows a chain of an earlier session to its last link | changed: `lines[0]` contains `explorer-old2 #2`; chain line `chain: explorer-old1 → explorer-old2 (2 sessions) · opened explorer-old1` |
| reports a corrupt manifest instead of throwing | moves to `overlay.test.ts`, unchanged |

New in `view.test.ts`:
- `renders the header per state`: `headerLines` table for queued (`○ … · queued · …`, `0 tool uses · 0s`), running (spinner, `running`), grace (`◐`, `stopping`), done (`✓`, `done`), failed (`✗`, `failed`, then `error: tests failed twice` from `"tests failed twice\nstack"`), stopped (`■`, `stopped`), handoff (`↪`, `handed off`, `handoff: /tmp/h.md`), handoff invalid (`handoff: /tmp/h.md (invalid: missing Status)`). With a recording theme, the glyph is painted in the state token.
- `omits zero tokens and an unknown ctx`: `4 tool uses · 1m 5s`.
- `writes the hint per state and origin`: the five rows of spec §6 (open/closed × list/not, grace) exactly, plus position `1-N/N` right-aligned at width 100.
- `drops the position when it does not fit`: width 40 → hint only, cut with `…`.
- `stops following on ↑, PgUp, Home and wheel-up and resumes on End`: open record, 20 rows; for each stop key: append items through `watch` → the new last line is not visible and ` · end to follow` shows; `End` → visible, suffix gone; a further append is visible at once.
- `renders codemode calls with pi's renderer`: §5 fixture, collapsed assertions and `toMatchSnapshot()`.
- `expands the codemode script and output with the tools key`: output line 6 visible after `toggleTools`.
- `renders nested run_agent calls with the extension's renderer`: harness with `runAgentPlugin`; open the view through the service; spy `renderCall` on every spec in `transcripts[0].tools` before rendering; after `render`, the `run_agent` spy was called with `expect.objectContaining({ agents: [{ agent: "explorer", task: "find callers" }] })`, `transcripts[0].tools` names include `run_agent`, `message_agent`, `agent_status`, and the text lacks `"agents": [`.
- `shows persisted counters for agents known only from their manifest`: manifest `{ toolCalls: 4, tokens: 12_300, turns: 3, startedAt: 0, endedAt: 65_000 }` → `4 tool uses · 12.3k tokens · 1m 5s · 2% ctx`.
- `shows 0 tool uses for a manifest written before counters were stored`.

### `test/plugins/agent-view/list-model.test.ts` (replaces `test/components/agent-list.test.ts`)

- `lists open records always and closed ones for lingerMs after endedAt`: done at `now - 29_999` listed, at `now - 30_000` not; a cleared closed id hidden; a cleared open id still listed.
- `splits Running, Needs input and Completed`: queued/running/grace → Running; open with attention → Needs input; closed with a stale attention → Completed; empty sections dropped.
- `orders Running as a tree and puts a child of an agent in another section at depth 0`.
- `orders Completed by newest endedAt first and titles it with the count`: `Completed (2)`.
- `counts the subtitle`: ` · 3 running · 1 done`, ` · 2 running`, ` · 1 done`, `""`.
- `carries the selection to the next row, else the previous, else none`.
- `writes the hint for the selected row`: the four texts of §3.

### `test/plugins/agent-view/list.test.ts` (replaces `test/plugins/agent-list-view/agent-list-view.test.ts`)

| old test | fate |
|---|---|
| opens from /agents without an id and shows the empty state | changed: `lines[0] === "Agents"`, contains `No agents running`, last line `esc to close` |
| groups agents by state, newest first | replaced by `shows the sections, headers, rows and subtitle`: 3 agents, one with attention, one closed done → `Agents · 2 running · 1 done`, blank, `Running`, row, blank, `Needs input`, row, blank, `Completed (1)`, row |
| moves the cursor over headers and opens the selected agent with Enter | changed: `moves over rows, skipping headers, clamped at both ends` (Enter is in `overlay.test.ts`) |
| stops the selected agent with x and closes it with a second x | survives; hints `x to stop` → `x to close now` |
| stops every open agent after X and y | changed: `stops every running agent after X twice within 3 s` (fake timers; feedback `Press X again to stop all agents` above the hint; running → grace, queued → stopped, a grace record untouched; feedback gone) |
| stops nothing after X and any other key | changed: `drops the confirmation after 3 s or on any other key` (X, advance 3001 ms, feedback gone, X shows it again without stopping; X then `down`: feedback gone, selection moved, nothing stopped; X then Esc: overlay still open) |
| filters rows with / and clears the filter with Esc | replaced by `ignores / and other unbound keys` |
| keeps the selected row visible while moving through a long list | survives |

New: `says No running agents for 2 s` (only closed rows → muted feedback; gone after 2000 ms); `keeps a closed row for lingerMs, then drops it on the tick` (fake timers; at 29 s present, at 31 s gone); `clears a closed row with x, selects the next row, and keeps it cleared after reopening /agents`; `moves the selection with PgDn, End and the wheel and keeps it visible`; `refreshes when an agent changes` (spawn after opening → row appears after `flush`); `completes /agents with the listed ids only` (an expired and a cleared agent missing from `complete("")`).

### `test/plugins/agent-view/overlay.test.ts` (new)

- `Enter swaps to the view in the same overlay and Esc returns to the list with the selection kept`: select row 2, Enter → `lines[0]` names its id, hint starts `esc to go back`, `state.closed` false, one overlay factory in `host.overlays`; Esc → list with `›` on row 2; Esc → `state.closed` true.
- `reloads the list on return`: an agent closes while the view is shown; back in the list it is under `Completed (1)`.
- `/agents <id> opens the view and Esc closes the overlay`: hint starts `esc to close`.
- `a view opened from the panel closes on Esc`: `services.require("agentView").open(id, { from: "panel" })`.
- `a view opened with from list goes back to a new list with that agent selected`.
- `only notifies for unknown agents and opens nothing`, `reports a corrupt manifest instead of throwing` (moved).
- `disposes the hidden list and the view when the overlay closes`: after Esc from the list, `registry.update` plus a 1 s wait adds no renders.

### Other tests

- `test/plugins/agent-registry/registry.test.ts`: `writes the final turns, tool calls and tokens to the manifest on close` (real `writeManifestFile` in a temp dir; update counters; close; JSON has them).
- `core/test/adapter/session-file.test.ts`: `replays prompt sections, tools, skills, guidelines, payload and model` (inline system message + `pi-subagents:prompt-record` entry; asserts `prompt.sections` names, `prompt.tools` names, `skills`, `guidelines`, `providerPayload`, `model`) and `replays MCP tools and sections` (the old MCP test's input; asserts `mcp_servers` section text and the two tool names).
- `test/plugins.test.ts` `skips plugins disabled in settings…`: keep `commands.has("agents") === false`; replace the exact notice with "no notice names `agent-list-view`" (plan 05 asserts its own notice if its panel requires `agent-view`).
- Delete: `test/components/agent-list.test.ts`, `test/components/context-breakdown.test.ts`, `test/plugins/agent-list-view/agent-list-view.test.ts`.

## 10. Order of work

Prerequisites: plan 01 §D (`createTranscript({ tools })`, `createTranscriptPane(…, { tools })`, captured renderers); plan 04 (`format.ts`, `spinner.ts`, `state-text.ts`, the `tools` service); plan 05 (`agent-row.ts` `renderRow`/`nameColumn`, `tree.ts`, the new `refresh.ts`). Plan 05's `watchAgents` signature change breaks today's two callers (`agent-view/index.ts`, `agent-list-view/index.ts`): land 05 and 06 in one PR, or have 05 patch the two call sites with `tickMs: () => 1000` until 06 lands.

1. `registry.ts` counters + registry test. `npm run test`.
2. `model/types.ts`: `AgentViewOrigin`, new `AgentViewService`, drop `agentList`.
3. `agent-view/loader.ts` (move + `chain`), `view.ts` (rewrite), `list-model.ts`, `list.ts`, `overlay.ts`, `index.ts`.
4. Delete `mode-store.ts`, `agent-list-view/`, `components/{agent-list,collapsible,context-breakdown,system-prompt-block,hints}.ts`; update `plugins.ts`.
5. Tests: helper, `view.test.ts` (rename and rework), `list-model`, `list`, `overlay`, session-file, plugins; delete the old ones; delete the old snapshot file and record the new one with `npx vitest run extensions/subagents/test/plugins/agent-view -u`, then review the snapshot diff (the transcript snapshot loses only its `Transcript` title; the codemode one is new).
6. Docs (§8).
7. `npm run check` (typecheck, biome, unit tests), clean.

Manual checklist (`pi -e ./extensions/subagents/src/index.ts`, fullscreen and regular TUI):
- [ ] Start 3 agents, one of them asking a confirmation from an extension: `/agents` shows `Agents · 3 running`, `Running` and `Needs input`, rows aligned like the panel, spinner turning.
- [ ] `↓`, `Enter`: the same overlay shows the view; `Esc` returns with the same row selected; `Esc` closes.
- [ ] `/agents <id>` and `Enter` on a panel row: `Esc` closes at once; hint says `esc to close`.
- [ ] An agent using codemode: highlighted script, `✓ grep …` lines, 5-line output with expand hint; Ctrl+O expands everything.
- [ ] An agent that calls `run_agent`: the nested block looks like the main transcript's.
- [ ] `↑` stops following (` · end to follow`), `End` resumes; a finished agent shows no suffix and no spinner.
- [ ] `x` in list and view: grace then close now; `x` on a finished row clears it; `X` shows `Press X again to stop all agents` and the second `X` stops all; with nothing running `No running agents` disappears after 2 s.
- [ ] A finished agent leaves the list after 30 s; `/agents <id>` still opens it, also after `/resume`, with real tool-use and token counts.
- [ ] No `pi-subagents-view.json` is created under `~/.pi/agent`.

Deviations and clarifications (also in the report): plugin id kept as `agent-view` (merge instead of a new `agent-views` id); the list's wheel and page keys move the selection; the selection falls back to the previous row before clearing; reaching the tail by scrolling resumes following; the view's tick also stats the session file; `stop failed: <msg>` feedback kept; stop-all leaves grace records alone and `Esc` only cancels a pending confirmation; completion lists only listed agents; `worktree: kept: …` keeps today's text.
