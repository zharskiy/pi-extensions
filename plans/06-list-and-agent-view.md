# Plan 06: `/agents` list and agent view (one overlay), codemode rendering

Implements `plans/00-ux-spec.md` §5 (Surface C) and §6 (Surface D), decisions D3, D4, D7. Uses plan 01 §D (`createTranscript({ tools })`, captured codemode/tool_search renderers) and §E (one overlay swapping views, no contract change). Imports, never redefines: plan 04 `components/format.ts`, `components/spinner.ts`, `components/state-text.ts`, the `tools` service and `AgentRecord.activity`; plan 05 `components/agent-row.ts` (`renderRow`, `nameColumn`), `components/tree.ts` (`treeOrder`), `components/refresh.ts` (`watchAgents`). Owns: the `lingerMs` meaning change, making `options` of `agentView.open(id, { from })` required (plan 05 adds `AgentViewOrigin` and the optional parameter), and the deletions listed in §6.

Reviewed 2026-10-14: findings 2, 4, 8, 9, 11, 12, 13, 15, 19, 20, 25, 33, 37 applied; decisions P4 (tools service object), P6 (Esc cancels and closes). Revised 2026-10-14 (third pass): the list keeps the agent tree in both sections (`Running`, `Completed (n)`; no `Needs input` section, §3); the view header leads with `<agent> › <description>` and moves the id to its dim second line (§4); every line follows spec §2 "Padding and margins" (`PAD`, `innerWidth`, `alignRight` from `format.ts`); the view hint is `esc …`, `x …`, `r request`/`r hide request`, `<toolsKey> tool detail` (no `↑/↓ to scroll`); the recorded-session fixture loses its model name (§6). Revised 2026-10-14 (fourth pass): agents never ask the user, so the list has no `needs input` row or subtitle part and the view header no `needs input` suffix (spec §2 "Agents never ask"; plan 04 §4 removed `attention`).

## 1. Goal

1. `/agents` opens a full-screen list in two sections, both in tree order (every subagent under its caller): `Running` (open roots with all their listed descendants, closed ones included) and `Completed (n)` (closed roots, newest first, each with its closed descendants); the panel's row grammar; closed rows for `lingerMs` (30 s) or until `x` clears them.
2. `Enter` turns the same overlay into the agent view; `Esc` goes back to the list (selection and scroll kept, rows reloaded). A view opened from the panel or `/agents <id>` closes on `Esc`.
3. The agent view is a header (`<agent> › <description>`, then state, model and id, stats, error/handoff, chain, worktree), one collapsed Request line, then the transcript drawn with pi's components, starting with the task. `r` shows the first request as the model received it (the literal body, pretty-printed), collapsed by default. No prompt sections, no context breakdown, no modes, no message box.
4. Codemode calls render as in the main session (highlighted script, nested calls, 5-line output preview), and nested `run_agent`/`message_agent`/`agent_status` calls use the extension's renderers. This plan only passes `tools`; plan 01 §D does the rendering.
5. Past agents (manifest only) show real counters: the manifest now stores `turns`, `toolCalls`, `tokens`.
6. Every string, key and timing comes from spec §5/§6. The mockups there are the acceptance pictures (§5 "Mockup", §6 "Mockup (running agent, codemode call collapsed)").

Behaviour summary: list = spec §5 Layout, Lifecycle, Keys, feedback line, hint line, "List and view in one overlay". View = spec §6 Header 1–6, Transcript, Task, Request, Scrolling, Hint line table, Keys, Refresh, Removed.

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
export type AgentViewOrigin = "list" | "panel" | "command";   // added by plan 05
type AgentViewService = { open(id: string, options: { from: AgentViewOrigin }): Promise<void> };  // plan 05's `options?` becomes required
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
- `stop = (id) => services.has("runner") ? services.require("runner").stop(id) : undefined`; `tools = () => services.has("tools") ? services.require("tools").list() : []` (the service is the object `{ list(): AnyToolSpec[]; add(spec: AnyToolSpec): void }` that plan 04's `run-agent` provides; `agent-status` adds its spec through `add`).
- `watch(tickMs, onChange)` = `watchAgents(bus, { relevant, tickMs, throttleMs: () => settings.renderThrottleMs, onChange })`; list: `relevant: () => true`; view: `relevant: (record) => chainLinks(registry, record).some((link) => link.id === id)` and `tickMs`: the live chain terminal `running`/`grace` → 100, `queued` → 1000, closed or not live → `undefined`.

## 3. The list (`list-model.ts`, `list.ts`)

### Data and sections (`list-model.ts`, pure)

Spec §5: the list shows the agent structure everywhere. `Running` holds every open root with all its listed descendants under it; `Completed (n)` holds the closed roots, newest first, each with its closed descendants. Agents never wait on the user (spec §2 "Agents never ask"), so every record is either open or closed and there is no third section.

```ts
export const isListRoot = (record: AgentRecord, byId: ReadonlyMap<string, AgentRecord>): boolean;  // caller main or not in the input; or record open and its caller closed
export const visibleRecords = (records: AgentRecord[], now: number, lingerMs: number, cleared: ReadonlySet<string>): AgentRecord[];
export type ListSection = { title: string; rows: TreeRow[] };
export const listSections = (visible: AgentRecord[]): ListSection[];
export const subtitle = (visible: AgentRecord[]): string; // " · 3 running · 2 done" | ""
export const clearTargets = (id: string, visible: AgentRecord[]): string[];  // ids `x` clears on a closed row
export const listHint = (selected: AgentRecord | undefined): string;
export const carrySelection = (previousIds: string[], ids: string[], selected: string | undefined): string | undefined;
```

- Trees: a record's caller is the record named by its `callerId` (chain links resolved as in `treeOrder`: a chain is one row, its terminal). `isListRoot`: `callerId === "main"`, or the caller is not in the input, or the record is open and its caller is closed (rare: a caller normally outlives its children; the open record then starts its own tree in `Running`). The root of a record is the first `isListRoot` record on its caller path. A tree is open when its root is open.
- `visibleRecords` (pure; also used by the `/agents` completion): open records always. A closed record in an open tree is listed while `now - endedAt < lingerMs` or while its caller is open. A closed tree (root closed, every member closed) is listed as a whole while `now - root.endedAt < lingerMs`. Then every listed record keeps its callers listed up to its root, so the structure is never torn (a closed child of a closed child of an open root stays while anything under it is listed). Ids in `cleared` are never listed. A missing `endedAt` counts as `now`.
- `listSections(visible)`: `byId` over `visible`; `Running` = `treeOrder(visible records of open trees, (r) => isListRoot(r, byId))` (roots by `createdAt`, children under their caller, siblings by `createdAt`, connectors as in the panel). `Completed` = the closed roots, sorted by `endedAt` descending, each followed by `treeOrder(that root's subtree)`, concatenated (`treeOrder` sorts roots by `createdAt`, so the section orders its roots itself and calls it once per root). Title `Completed (${roots.length})`: `n` counts roots, not rows. `openDescendants` come from `treeOrder`, so `(+N)` agrees with the panel. Empty sections are dropped. There are only these two sections.
- `subtitle(visible)`: `running` = every open visible record (queued, running, grace); `done` = closed visible records in either section (not only roots); a zero part omitted; joined with `SEP`.
- `clearTargets(id, visible)`: a closed root → its id and every visible record of its subtree; a closed child → its id and its visible closed descendants (nothing is left without its caller); an open record → `[]` (`x` stops it instead).
- `listHint`: none selected → `esc to close` (declared deviation from the spec's single hint line: only an empty list has no selection, and it has nothing to select, view or stop); open (queued/running) → `↑/↓ to select · enter to view · x to stop · X to stop all · esc to close` (72 columns); grace → the same with `x to close now`; closed → with `x to clear`.
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
- `render(width)` (spec §2 "Padding and margins", §5 Layout; `inner = innerWidth(width)`, `PAD`, `truncateCols` from `format.ts`): title `PAD + bold("Agents") + dim(subtitle)` with the plain text cut at `inner`; body: for each section a blank line before all but the first, `PAD + bold(title)`, then `renderRow({ ...row, selected: row.record.id === selectedId }, now, width, api.theme, nameCols)` with `nameCols = nameColumn(sections.flatMap((section) => section.rows))` computed once per render (plan 05's signature takes tree rows, so `(+N)` is measured; one name column for the whole list). Rows carry `PAD` and end at `PAD + inner` like the panel's (plan 05), so the pointer gutter sits under the headers' first letter and the glyphs two columns in (spec §5 mockup); with no rows the title is `PAD + bold("Agents")` and the body is `PAD + fg("muted", "No agents running")`. Footer: the feedback line `PAD + fg(token, truncateCols(text, inner))` when set, then `PAD + fg("dim", truncateCols(listHint(selected), inner))`. Layout `["", title, "", ...body window, ...padding, "", feedback?, hint, ""]`: the top and bottom rows and the row above the feedback/hint block are always blank (the hint never moves). `height = max(1, api.rows() - 5 - footer.length)` (top blank, title, blank, reserved blank, bottom blank; `footer` = feedback and hint); `scroll.window(body, height)`; if the selected line is outside `[top, top + height)` → `scroll.scrollTo(line < top ? max(0, line - 1) : line - height + 1)` and window again (the `- 1` keeps a section header in view); pad to `height`.
- Keys (spec §5):

| key | action |
|---|---|
| `up` / `down` | `move(∓1)`: selection over `ids`, clamped; no selection → first row |
| `pageUp` / `pageDown` | `move(∓(height - 1))` (the window scrolls with the selection, which stays visible) |
| `home` / `end` | first / last id |
| wheel | `move(lines)` (deviation: moves the selection like the page keys, so "the selection is kept visible" holds) |
| `enter` | `deps.open(selectedId)` when set |
| `x` | open → `stop(id)` (queued closes, running enters grace); grace → `stop(id)` (runner closes now); closed → every id of `clearTargets(id, visible)` into `deps.cleared` (a closed root takes its subtree, a closed child only itself and its closed descendants), `reload()` |
| `X` | stop-all flow below |
| `escape` | cancels a pending confirmation (if any), then `deps.leave()` (decision P6) |
| other (`/`, letters, `tab`, `space`, `toggleTools`) | nothing |

- Stop-all: `X` with no open visible record (`!visible.some((r) => !isClosed(r.state))`; spec "with no open agent", and `grace` is open) → `showFeedback("No running agents", "muted", NO_AGENTS_MS)`. Otherwise, first `X` → `pendingStopAll = true`, `showFeedback("Press X again to stop all agents", "warning", STOP_ALL_CONFIRM_MS)`; second `X` while pending → `stop(id)` for every `queued`/`running` record (grace records are left alone: they are stopping already, and a second stop would close them now), clear feedback and pending. With only grace records open the second `X` is a no-op: nothing is stopped, and pending and the feedback `Press X again to stop all agents` stay until their timer clears them. Any other key while pending clears feedback and pending, then performs its own action (`Esc` therefore cancels and closes the overlay).
- `showFeedback(text, token, ms)`: clear the old timer, set feedback, `feedbackTimer = setTimeout(() => { feedback = undefined; pendingStopAll = false; api.requestRender(); }, ms)`, then `feedbackTimer.unref()` (an open overlay must not keep the process alive). A rejected stop shows `stop failed: <message>` (`warning`, 3000 ms) (kept from today; not in the spec). `dispose()` clears the timer and unwatches; a timer or stop resolving after dispose does nothing (`disposed` flag).

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

Header (`headerLines`, spec §6 lines 1–6, then the rule). Every text line is `PAD + …` and cut at `inner = innerWidth(width)` (plain text cut with `truncateCols` before painting); identity per spec §2: the agent name and the description lead, the id sits on the dim second line:

```ts
// 1. title: glyph in the state token, agent name bold (+ " #n" for a later chain link), " › ", description plain;
//    no "(agent)", no "continues"/"continued by": the chain line replaces them
const name = agent + (chainIndex > 1 ? ` #${chainIndex}` : "");
const prefix = `${glyph} ${name} › `;
const desc = truncateCols(singleLine(description), Math.max(8, inner - displayWidth(prefix)));
PAD + fg(stateToken(s), glyph) + " " + bold(name) + " › " + desc   // cut at inner as a whole when 8 description columns do not fit
// 2. state, model, id (dim); the only place the view shows the id
PAD + fg("dim", truncateCols(`${stateWord(s)} · ${model ?? "model n/a"} · id ${id}`, inner))
// 3. stats, live while open
PAD + fg("dim", truncateCols([formatToolUses(toolCalls), tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
  formatDuration(elapsedOf(record, now)), formatCtx(ctxPercent)].filter(Boolean).join(SEP), inner))
// ctxPercent = ctxTokens / limit * 100, ctxTokens = record.context?.tokens ?? session?.contextTokens,
// limit = effectiveContextLimit(record.contextLimit, record.context?.window ?? 0, reserveTokens);
// undefined when ctxTokens is null/undefined or limit <= 0
// 4. optional (invalid-handoff reasons are stored in `error` too: runner.ts:338, `error: validation.errors.join("; ")`; result.ts:55 only prints them)
failed:  PAD + fg("error", truncateCols(`error: ${firstLine(error ?? "unknown error")}`, inner))
handoff: PAD + fg("warning", truncateCols(`handoff: ${handoffPath}${error ? ` (invalid: ${error})` : ""}`, inner))
// 5. optional, chain.length > 1
PAD + fg("dim", truncateCols(`chain: ${chain.join(" → ")} (${chain.length} sessions)${openedId ? ` · opened ${openedId}` : ""}`, inner))
// 6. optional; worktreeText unchanged: "<path> (branch <b>)", "removed", "removed; branch <b> kept", "kept: <path> (branch <b>)"
PAD + fg("dim", truncateCols(`worktree: ${worktreeText(worktree)}`, inner))
// 7. rule: full width on purpose; rules are chrome and are not inset (spec §2)
fg("dim", "─".repeat(width))
```

`singleLine`, `firstLine`, `elapsedOf` and `formatDuration` are imported from `components/format.ts` (plan 04); `view.ts` defines no local text helpers.

Body: `data.error` → one line `PAD + fg("warning", truncateCols(data.error, inner))` and nothing else: with `data.error` (`session file not written yet`, `cannot read session: <msg>`) there is no session, so no Request line is drawn (spec §6 Request); else `requestLines(data.session?.prompt.providerPayload, open, requestExpanded, width, api.theme)` followed by `transcript.render(width)`, or by `PAD + fg("dim", "(no transcript yet)")` when empty. `transcript.render(width)` gets the full width on purpose: pi's components pad themselves by 1 on both sides (`outputPad`), which lands their text on the `PAD` column of `▸ Request`. No `Effective prompt`/`Transcript` titles.

Request block: `requestExpanded` starts `false` on every open and is reset to `false` when the opened agent changes (the same `record.id + sessionFile` check that makes a new transcript pane); it is never persisted. `hasRequest = requestLineCount(data.session?.prompt.providerPayload) > 0`. The block is the spec §6 "Request" picture, drawn by `components/request-block.ts` (below). `Ctrl+O` does not touch it.

Transcript: `transcript = api.createTranscript({ tools: deps.tools })`; `sync(data.session?.items ?? [])` on every load; a new pane (same `tools`, `setToolsExpanded(toolsExpanded)`) when `record.id + sessionFile` changes (successor), as today. `toolsExpanded` starts `false`.

Footer: optional `PAD + fg("warning", truncateCols(notice, inner))` (`stop failed: <msg>`, cleared on the next key), then the hint line. Layout `["", ...header (with the rule), ...body window, ...padding, "", notice?, hint, ""]` (spec §2: blank top row, reserved blank above the notice/hint block, blank bottom row). `height = max(3, api.rows() - header.length - 3 - footer.length)` (`header` includes the rule; 3 = the three blank rows; `footer` = notice and hint); `scroll.window(body, height)`; pad.

Hint line (spec §6 hint parts): `esc to go back` (from the list) or `esc to close`; `x to stop` (open) or `x to close now` (grace), absent when closed; `r request` or `r hide request` (`requestExpanded`), absent when `!hasRequest`; `<api.toolsKey> tool detail`; joined with `SEP`. No `↑/↓ to scroll` part: the position shows the scrolling. The longest hint is `esc to go back · x to close now · r hide request · ctrl+o tool detail` (69 columns). Position `${top + 1}-${min(total, top + height)}/${total}`, plus ` · end to follow` when the agent is open and `!scroll.state().following`; omitted when `total === 0`. Right-aligned inside the padding: `PAD + fg("dim", alignRight(hint, pos, inner) ?? truncateCols(hint, inner))` (`alignRight` from `format.ts` returns `undefined` when `displayWidth(hint) + 2 + displayWidth(pos) > inner`), so the position ends at column `width - 2` and the last column stays blank.

Scrolling and follow: `api.createScroll()` is pi's `ScrollView({ follow: "end" })` (`pi-ui.ts:213-244`). Today's behaviour, kept unchanged and sufficient: it starts following, so the first layout pins to the tail (opens at the tail); `scrollBy(-n)`, `scrollToStart()` (when content exceeds the viewport) clear following; `scrollToEnd()` sets it; while following, every `window()` call re-pins to the new tail, otherwise the top is kept and clamped. One nuance: reaching the tail with `↓`, `PgDn` or wheel-down also resumes following (ScrollView sets following whenever the top equals the maximum). That is accepted (being at the tail is following); `End` remains the documented way. Nothing in `createScrollPane` changes.

Keys (spec §6): `up` → `scrollBy(-1)`; `down` → `scrollBy(1)`; `pageUp`/`pageDown` → `scrollBy(∓max(1, height - 1))`; `home` → `scrollToStart()`; `end` → `scrollToEnd()`; `toggleTools` → flip `toolsExpanded`, `transcript.setToolsExpanded`; char `r` → when `hasRequest`, flip `requestExpanded`, then expanded → `scrollToStart()` (stops following; the block begins at line 0), collapsed → `scrollToEnd()` (follows again when open; a closed agent never ticks, so it only sits at the tail), `api.requestRender()`; without a request `r` does nothing; char `x` → when open, `Promise.resolve(deps.stop()).then(reload).catch(fail)` (runner: running → grace, grace/queued → closed now); `escape` → `deps.leave()`; wheel → `scrollBy(lines)`. Everything else (`enter`, `space`, `tab`, `c`, `v`, other letters) does nothing.

### Request block (`components/request-block.ts`, new, pure)

```ts
export const requestLineCount = (payload: unknown): number;   // JSON.stringify(payload, null, 2).split("\n").length; 0 for undefined or when stringify fails
export const requestLines = (payload: unknown | undefined, open: boolean, expanded: boolean, width: number, theme: ThemeLike): string[];
```

- Every line is `PAD + …` (spec §2): the `▸`/`▾` line at column `PAD`, aligned with pi's transcript text.
- `payload === undefined` → `[PAD + fg("dim", open ? "▸ Request · not sent yet" : "▸ Request · not recorded")]`, whatever `expanded` says.
- Collapsed → ``[PAD + fg("dim", `▸ Request · ${requestLineCount(payload)} lines`)]``.
- Expanded → ``PAD + fg("dim", `▾ Request · ${n} lines`)``, then every line of `JSON.stringify(payload, null, 2)` soft-wrapped at `max(1, innerWidth(width) - 2)` display columns with plain wrapping (cut at the column, using `charWidth` from `components/format.ts` so wide characters never split; no word logic, no highlighting, no colour) and each visual line prefixed with `PAD + "  "` (column 3; continuations too); no trailing blank (the transcript pane's spacer before the task message gives the gap). The last column stays blank. Nothing is omitted or truncated.
- The stringified text and its split lines are cached per payload identity (`WeakMap<object, string[]>` for objects; primitives are re-stringified, they are short). The record only changes when the session file is re-parsed, so a re-render or a width change reuses the string; the wrap is recomputed per width (one-entry cache keyed by payload and width).
- `JSON.stringify` failing (a cycle cannot come from a parsed session file, but `unknown` allows it) → the `not recorded` line; the view's `hasRequest` uses the same check (`requestLineCount` returns 0 then), so `r` and its hint part follow.

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
| row bridge | `src/components/legacy-row.ts`, `test/components/legacy-row.test.ts` | plan 05's temporary copy of today's row helpers; its last importers (`agent-list.ts`, `agent-list-view/`, the old `view.ts`) go in this plan |
| old list plugin | `src/plugins/agent-list-view/` (both files), `test/plugins/agent-list-view/`, its line in `src/plugins.ts` | |
| message box | `view.ts`: `api.createInput`, `send`, `deliveryText`, `showRouteResult`, input focus, `Tab` cycle; `index.ts`: `send()` and the `runner.route(id, { sender: "user" })` call | `runner.route` itself stays (`message_agent` uses it) |
| `/` filter, `X`+`y` | old `agent-list-view/view.ts` | gone with the file |
| `context` deps | `index.ts`: `softRatio`, `estimate: runtime.estimateTokens` | |
| `select` fallback | `/agents` without the list | |

Kept on purpose:
- The child extension keeps writing `pi-subagents:prompt-record` (`pi-child.ts`), and `runtime.readSession` keeps returning `prompt` (`session-file.ts` replay, `PromptRecord` in the contract). The view reads the record again, for `providerPayload` only (the Request block, §4); `sections`, `tools`, `skills` and `guidelines` have no reader in the UI. The replay of `sections`/`tools` in `session-file.ts` stays as it is: no change to the parser or the contract. Only the per-section UI goes. The parser tests move to `core/test/adapter/session-file.test.ts` (§9).
- `OverlayApi.createInput`, `InputPane`, `createInputPane` stay in the contract and the adapter, and `createFakeInputPane` in the fakes. After this plan no extension calls `createInput` (only `core/test/adapter/pi-ui.test.ts` tests `createInputPane`). It is a general overlay capability, so it is kept regardless.
- `AgentRuntime.estimateTokens` stays in the contract (no extension caller left; same reasoning).

Fixture cleanup: `extensions/subagents/test/plugins/agent-view/fixtures/recorded-session.jsonl` carries a real model name, inside its `providerPayload` (`"model": …`) and in the other `model` fields of its entries (one of them with a provider prefix). The Request block now shows that payload, so the repo rule (no provider or model names in code or fixtures) applies: replace every such string with `provider/model` (the bare `model` value of the payload too), and update any test that asserts the old value.

## 7. Settings

- `lingerMs`: no code change (default 30 000, range 0–3 600 000). Meaning: how long a closed agent stays in the `/agents` list. The panel stops reading it in plan 05 (`doneLingerMs`/`failedLingerMs`).
- `renderThrottleMs` now also throttles the list and the view (through `watchAgents`).
- Nothing reads or writes `pi-subagents-view.json` any more.

## 8. Docs (final text)

`extensions/subagents/README.md`, "Use". Plan 05 replaces line 36 and its three sub-bullets with its panel bullets. Append these two bullets right after plan 05's panel bullets and delete line 40 (the old `/agents` list bullet):

```markdown
- `/agents` opens the agents list over the whole screen in two sections, each showing every agent under the agent that started it: `Running` (open agents, with their finished children still under them while the caller runs) and `Completed (n)` (finished, failed, stopped or handed off agents started by the main session, newest first, each with the agents it started; a finished group stays `lingerMs`, 30 s by default). The title counts `3 running · 2 done`. `↑`/`↓` select, PgUp/PgDn, Home/End and the mouse wheel move faster, `Enter` opens the agent's view in the same overlay, `x` stops the selected agent or clears a finished row (a finished top-level agent together with the agents it started), `X` twice within 3 seconds stops every running agent, `Esc` closes.
- The agent view (`Enter` in the list or on a panel row, or `/agents <id>` for any agent of this session, also from earlier runs and any link of a handoff chain) shows the agent's name and description (`explorer › Map the auth module`), then its state, model and id (the id is what `/agents <id>` takes), `N tool uses · tokens · time · N% ctx`, the error or handoff file, the chain and the worktree, then its transcript drawn with pi's own components, starting with the task it was given: codemode scripts with their nested tool calls and output, and nested `run_agent` blocks as in the main session. It opens at the end and follows new output; `↑`, PgUp, Home or the wheel stop following, `End` resumes. Ctrl+O (pi's tools key) toggles tool detail. Press `r` to show the first request as the model received it (the literal body, pretty-printed), collapsed by default; `r` again hides it. `x` stops the agent: its turn is aborted and it closes after `stopGraceSeconds` unless its caller messages it first; `x` again closes it now. `Esc` goes back to the list when you came from it, otherwise closes. Worktree agents show `worktree: <path> (branch <branch>)`, and after they finish what became of it (below). To correct an agent, ask the main session; it messages the agent with `message_agent`.
```

README "Other keys" sentence: plan 05 owns its final text (it already gives `lingerMs` its list meaning and `renderThrottleMs` its scope over every surface); this plan does not edit it.

README line 7: replace its first sentence (`Version 0.3.0 adds …`) with `Version 0.4.0 replaces the progress widget with a panel below the editor, redraws `run_agent` as a start block with one completion line per agent, merges the list and the view into one `/agents` overlay, and moves notifications to the notifications extension.`, and in the third sentence replace `you can message any agent from its view, browse all agents in a list, and answer permission prompts raised inside agents` with `you can browse all agents and open any agent's view with `/agents`, and answer permission prompts raised inside agents` (the message box and the context breakdown are gone).

Root `README.md` line 5 (subagents bullet): drop `with a context breakdown per agent` (plan 03 already dropped `terminal notifications`), so the bullet ends `…optionally in their own git worktree, with MCP for every agent with tools; what they spend is reported to spending.`

`ARCHITECTURE.md`:
- Plugin list: replace `` `agent-view` [registry] (`/agents`), `agent-list-view` [registry, agent-view] `` with `` `agent-view` [registry] (`/agents`: the list and the agent view in one overlay, the `agentView` service) ``.
- Run step 5, second sentence → `The entry stays in the session file and runtime.readSession still parses it; the agent view shows its provider payload, the first request as sent, as one collapsed Request block (key r).` (with backticks around the identifier and the key).
- Messages bullet: `` `message_agent` (only the agent's caller) routes `[message from <sender>]` text: … `` (drop "and the agent view").
- "Status and views" (title from plan 03; the final bullet list is in plan 04 §9): this plan writes bullets 4 and 5 of that list, appended after plan 05's panel bullet (bullet 3, which already replaced today's widget/list bullet), and replaces today's agent view bullet with bullet 5:
  - `` The `/agents` list shows the agent tree in two sections (`Running`: open roots with their listed descendants; `Completed (n)`: closed roots, newest first, with their descendants; `list-model.ts`, `treeOrder` per section), re-renders on `agent:changed` (throttled by `renderThrottleMs`) plus the shared ticker; closed records stay for `lingerMs` (a closed subtree from its root's `endedAt`), or under an open caller, or until `x` clears them. ``
  - `` The agent view shares the list's overlay (one `openOverlay`; the host component swaps list and view, `Esc` returns to the list only when the view was opened from it). It reads the agent's session file through `runtime.readSession`, re-parsing only when the file's size or mtime changed, and falls back to `manifest.json` (which stores the final `turns`, `toolCalls` and `tokens`) for agents not in memory. Its transcript renders built-in tools with pi's definitions, `codemode`/`tool_search` with renderers captured from pi's exported extension factories (generic fallback if capture fails), and the subagents tools with the specs passed to `createTranscript({ tools })`. Above the transcript, a collapsed Request line expands with `r` to the prompt record's `providerPayload` as pretty-printed plain text. Nothing of the view is persisted. ``
- Persistence summary: `manifest.json` line → `` `manifest.json` (rewritten on state or worktree change; final counters on close) ``; `<agentDir>` line drops `pi-subagents-view.json`.

`STRUCTURE.md`:
- Plugins: `agent-view/  # /agents overlay: index (command, service), overlay.ts (list/view host), list.ts + list-model.ts (tree sections), view.ts, loader.ts`; delete the `agent-list-view/` line.
- Components comment: remove `agent-list`, `collapsible`, `context-breakdown`, `system-prompt-block`, `hints.ts`; add `request-block` (the agent view's Request block) (plans 04/05 add their modules to the same comment).

## 9. Tests

Helpers: `extensions/subagents/test/helpers/overlay.ts` (new) exports `plain`, `key`, and `fakeOverlayApi(rows)` returning `{ api, state: { closed, renders }, transcripts: { tools?: AnyToolSpec[] }[] }`, with `createTranscript: (options) => { transcripts.push(options ?? {}); return createTranscriptPane({ requestRender } as never, "/repo", { tools: options?.tools }); }`, `createScroll: () => createScrollPane(requestRender)`, `createInput: createFakeInputPane`. Old local `fakeApi`s go. Fixture `test/plugins/agent-view/fixtures/recorded-session.jsonl` stays, with its model strings replaced by `provider/model` (§6 "Fixture cleanup"). Snapshot file `__snapshots__/agent-view.test.ts.snap` is deleted and re-recorded as `view.test.ts.snap`. Tests that use fake timers call `vi.useRealTimers()` in `afterEach`, and every opened view is disposed in `afterEach`. Line indexes below are of the whole rendered overlay (spec §2 "Padding and margins"): `lines[0]` is the blank top row, `lines.at(-1)` the blank bottom row, `lines.at(-2)` the hint, `lines.at(-3)` the reserved blank (or the notice/feedback when shown); every other text line starts with `PAD`.

### Mapping of `test/plugins/agent-view/agent-view.test.ts` (renamed `view.test.ts`)

| old test | fate |
|---|---|
| system prompt block: renders the recorded prompt… / lists MCP tools… / starts collapsed… | removed from the view; the first two become parser tests in `core/test/adapter/session-file.test.ts` (below); the third goes |
| reuses the rendered prompt block… | removed |
| opens for a closed agent by reading its session file | changed: `lines[0] === ""`, `lines[1] === " ✓ explorer › list agents"`, ``lines[2] === ` done · ${model} · id ${id}` ``, `lines[3]` matches `/^ \d+ tool uses? · /`, `lines[4]` is the rule (`─` × width), `lines[5]` matches `/^ ▸ Request · \d+ lines$/` (the fixture has a prompt record), transcript line ` Three files: …` present, `lines.at(-2)` starts ` esc to close · r request · ctrl+o tool detail`, `lines.at(-3)` and `lines.at(-1)` are `""` |
| renders the transcript with pi's message and tool components | changed: slice from the line after the collapsed Request line to before the reserved blank above the hint; snapshot re-recorded (only the `Transcript` title line disappears) |
| toggles tool detail with the tools-expand key | survives |
| toggles sections with Enter and moves focus with Tab | replaced by `ignores Enter, Space, Tab, c and v` (render unchanged, overlay open) |
| opens at the tail, scrolls with keys and the wheel… | changed: `opens at the tail and scrolls with keys and the wheel` (open record; Home shows the task line first and appends ` · end to follow`; wheel 3 moves the top by 3; End drops the suffix) |
| follows new entries at the tail and keeps the position when scrolled up | survives |
| starts a fresh transcript when the view follows a successor… | survives (new deps shape); also asserts that an expanded Request block is collapsed again for the successor |
| enters grace on the first x and closes on the second, notifying the caller once | changed: hint `x to stop` → `x to close now` after the first `x`; state grace → stopped; child aborted; the caller-notification assertion goes (runner tests cover it; plan 02 changes the wake) |
| only notifies for unknown agents and opens nothing | moves to `overlay.test.ts`, unchanged |
| message box (7 tests), input focus (1) | removed; replaced by `never routes anything from the UI` (type `hello` + Enter on a running agent: `runner.route` spy not called, no input line rendered) |
| follows the opened link to its live successor and stops the successor | changed: `lines[1]` starts ` ⠋ explorer #2 › ` (or the frame at the test's clock) and `lines[2]` ends `id ${second}`; a line equals ` chain: ${first.id} → ${second} (2 sessions) · opened ${first.id}`; hint contains `x to stop`; no `(type a message)`; `x` stops the successor |
| shows the chain index and chain links (renamed by plan 04 §4, which dropped the pending question) | changed: `vi.setSystemTime(0)`; ``lines[1] === ` ⠋ explorer #2 › ${description}` ``, ``lines[2] === ` running · model n/a · id ${id}` ``; chain line from `chain: ["explorer-0001", id]` |
| context breakdown: toggles… / reads the measured total… | removed |
| opens from the manifest with the definition's limit | changed: stats line ends `· 2% ctx` (fixture context 2.3k of 100k) |
| prefers the limit stored in the manifest… | changed: `contextLimit: 70_000` → `· 3% ctx`; unknown agent without a limit → no `ctx` part |
| refreshes the block with the live turn context | changed: `refreshes the header stats with the live turn context` → after `turn({ tokens: 85_000, window: 200_000 })` the stats line ends `· 85% ctx` |
| modes (4 tests) | removed; replaced by `writes no view state file` (press `v`, `pi-subagents-view.json` absent under the agent dir) |
| shows the worktree and branch under the task | changed: `lines[4] === " worktree: /project/.pi/worktrees/explorer-1-abc (branch pi-agents/explorer-1-abc)"`, `lines[5]` is the rule; with `cleanup: "branch kept"` → ` worktree: removed; branch pi-agents/explorer-1-abc kept` |
| does not parse the session file again while its size and time are unchanged | survives |
| never reloads after close, and reports a failed stop | survives (`stop failed: runner gone`) |
| follows a chain of an earlier session to its last link | changed: `lines[1]` contains `explorer #2 › `, `lines[2]` ends `id explorer-old2`; chain line ` chain: explorer-old1 → explorer-old2 (2 sessions) · opened explorer-old1` |
| reports a corrupt manifest instead of throwing | moves to `overlay.test.ts`, unchanged |

New in `view.test.ts`:
- `renders the header per state`: `headerLines` table (agent `explorer`, description `Map the auth module`, id `explorer-1`, model `provider/model`) for queued (line 1 ` ○ explorer › Map the auth module`, line 2 ` queued · provider/model · id explorer-1`, line 3 ` 0 tool uses · 0s`), running (spinner, `running`), grace (`◐`, `stopping`), done (`✓`, `done`), failed (`✗`, `failed`, then ` error: tests failed twice` from `"tests failed twice\nstack"`), stopped (`■`, `stopped`), handoff (`↪`, `handed off`, ` handoff: /tmp/h.md`), handoff invalid (` handoff: /tmp/h.md (invalid: missing Status)`). With a recording theme, the glyph is painted in the state token, the agent name is bold, the description is unpainted and line 2 is `dim`.
- `names the agent and the description on line 1 and the id only on line 2`: `model: undefined` → line 2 ` running · model n/a · id explorer-1`; chain index 2 → line 1 ` ⠋ explorer #2 › Map the auth module`; no header line but line 2 contains `explorer-1`.
- `cuts every header line at the inner width`: width 40 and a 90-character description → every header line except the rule starts with `" "` and has `displayWidth <= 39`; line 1 keeps at least 8 description columns and ends with `…`; the rule is 40 columns of `─`.
- `omits zero tokens and an unknown ctx`: `4 tool uses · 1m 5s`.
- `writes the hint per state and origin`: the parts of spec §6 (open/closed × list/not, grace, request expanded, no request) exactly, e.g. ` esc to close · x to stop · r request · ctrl+o tool detail`, ` esc to go back · x to close now · r hide request · ctrl+o tool detail`, ` esc to close · x to stop · ctrl+o tool detail`; no hint contains `↑/↓`; plus position `1-N/N` right-aligned at width 100, ending at column 98 (`displayWidth(hint line) === 99`).
- `drops the position when it does not fit`: width 40 → hint only, ` ` + the hint cut with `…` to 38 columns; width 80 with the longest hint and `1-14/940` → no position (69 + 2 + 8 > 78).
- `pads every line and keeps the last column blank`: at widths 80 and 40, open and closed, Request collapsed and expanded: `lines[0]`, the reserved blank and `lines.at(-1)` are `""`; every other line except the rule starts with `" "` and has `displayWidth <= width - 1`; the rule is `width` columns.
- `draws no Request line on a load error`: an open record whose session file is not written yet → the body is the one line ` session file not written yet` (`warning`), no `▸ Request` line, no `r ` part in the hint.
- `stops following on ↑, PgUp, Home and wheel-up and resumes on End`: open record, 20 rows; for each stop key: append items through `watch` → the new last line is not visible and ` · end to follow` shows; `End` → visible, suffix gone; a further append is visible at once.
- `renders codemode calls with pi's renderer`: §5 fixture, collapsed assertions and `toMatchSnapshot()`.
- `expands the codemode script and output with the tools key`: output line 6 visible after `toggleTools`.
- `renders nested run_agent calls with the extension's renderer`: harness `[agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentStatusPlugin, agentViewPlugin]` (`agent_status` reaches the `tools` service through `agentStatusPlugin`); open the view through the service; spy `renderCall` on every spec in `transcripts[0].tools` before rendering; after `render`, the `run_agent` spy was called with `expect.objectContaining({ agents: [{ agent: "explorer", task: "find callers" }] })`, `transcripts[0].tools` names include `run_agent`, `message_agent`, `agent_status`, and the text lacks `"agents": [`.
- `shows persisted counters for agents known only from their manifest`: manifest `{ toolCalls: 4, tokens: 12_300, turns: 3, startedAt: 0, endedAt: 65_000 }` → `4 tool uses · 12.3k tokens · 1m 5s · 2% ctx`.
- `shows 0 tool uses for a manifest written before counters were stored`.
- Request block (inline session lines with a `pi-subagents:prompt-record` entry whose `providerPayload` is the small fixture `{ model: "provider/model", system: "You are explorer…", tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } }], messages: [{ role: "user", content: "Task from main (agent id explorer-1): Map the auth module" }] }`; no real provider or model names):
  - `shows the task as the first transcript item`: the line after the Request line starts ` Task from main (agent id explorer-1): Map the auth module`.
  - `shows the request collapsed on open`: the line after the rule is ` ▸ Request · N lines` with `N === JSON.stringify(payload, null, 2).split("\n").length`; no `"model": "provider/model"` line; the hint contains `r request` between `x to stop` and `ctrl+o tool detail`.
  - `expands the request with r and scrolls to the top`: open record, 10 rows, transcript longer than the window; `r` → the first body line is ` ▾ Request · N lines`, the next is `   {` (column 3), the position starts `1-` and ends ` · end to follow`, the hint contains `r hide request`; an item appended through `watch` does not move the window.
  - `collapses the request with r and returns to the tail, following`: after `r` twice the last transcript line is visible, ` · end to follow` is gone, and a further append is visible at once.
  - `collapses to the tail without following for a closed agent`: closed record; `r` twice → the last transcript line is visible and no ` · end to follow` suffix.
  - `starts collapsed again on every open`: `r`, `Esc` back to the list, `Enter` on the same row → `▸ Request · N lines`.
  - `says not sent yet while the agent is open without a request`: open record, session without a prompt record → ` ▸ Request · not sent yet`, no `r ` part in the hint (neither `r request` nor `r hide request`); `r` changes nothing (same lines, still following).
  - `says not recorded for a closed agent without a request`: manifest-only agent → ` ▸ Request · not recorded`, no `r ` part; `r` does nothing.
  - `leaves the request alone on the tools key`: `toggleTools` with the block collapsed keeps `▸ Request · N lines`; expanded keeps the JSON lines unchanged.
  - `renders the expanded request as plain indented text`: `r`, slice from `▾ Request` to the blank line before the task, `toMatchSnapshot()`; with a recording theme, only the `▾` line is painted (`dim`) and no JSON line carries a colour.

### `test/components/request-block.test.ts` (new)

Fixture payloads use `provider/model` and generic text only.

- `counts the lines of the pretty-printed request`: `requestLineCount(payload) === JSON.stringify(payload, null, 2).split("\n").length` for a nested object; `0` for `undefined` and for a cyclic object.
- `draws one collapsed line with the count`: `requestLines(payload, true, false, 80, theme)` for a payload of 12 pretty-printed lines → `[" ▸ Request · 12 lines"]` (stripped; `PAD` first), painted `dim`.
- `says not sent yet when open and not recorded when closed`: `requestLines(undefined, true, false, …)` → `[" ▸ Request · not sent yet"]`; `(undefined, false, false, …)` → `[" ▸ Request · not recorded"]`; both the same with `expanded: true`.
- `expands to the pretty-printed request at PAD + 2`: `expanded: true` → first line ` ▾ Request · N lines`, then exactly the lines of `JSON.stringify(payload, null, 2)` each prefixed with `PAD + "  "` (three spaces), then `""`; nothing omitted.
- `wraps long string values at the inner width minus 2`: a 300-character `system` string at width 40 → every line has `displayWidth <= 39` (36 columns of JSON after the three-space prefix; the last column stays blank), every continuation starts with three spaces, and joining the continuations (minus the prefix) gives back the original line.
- `does not split wide characters`: a value of CJK characters at an odd width → no line exceeds `width - 1`.
- `reuses the stringified request for the same payload`: spy on `JSON.stringify` → called once across two renders at different widths with the same object, again for a new object.

### `test/plugins/agent-view/list-model.test.ts` (replaces `test/components/agent-list.test.ts`)

- `lists open records always and closed roots for lingerMs after endedAt`: a closed root done at `now - 29_999` listed, at `now - 30_000` not; a cleared closed id hidden; a cleared open id still listed.
- `keeps a closed child under its open caller past lingerMs`: running root `a`, child `a1` done at `now - 60_000` → listed under `a`; a closed grandchild `a1x` of the closed `a1` done at `now - 60_000` → not listed, and at `now - 1_000` → listed (and keeps `a1` listed).
- `moves a closed subtree to Completed and lingers it from the root's endedAt`: root `r` done at `now - 10_000` with child `r1` done at `now - 50_000` → both listed under `Completed (1)`; at `now - 30_000` for `r` → neither listed.
- `splits Running and Completed by the state of the root`: open roots with all their listed descendants → `Running`; closed roots with their descendants → `Completed`; an open child of a closed caller is a root of `Running` (depth 0); no third section exists; empty sections dropped.
- `orders each section as a tree`: `Running` rows in `treeOrder` (callers first, siblings by `createdAt`, connectors, `openDescendants` counted over open rows only); a closed child keeps its position and depth.
- `orders Completed roots by newest endedAt first with their descendants under them and counts roots`: roots `r` (ended 20) and `s` (ended 30), `r` with child `r1` → rows `[s, r, r1]`, `r1` at depth 1; title `Completed (2)`.
- `counts the subtitle`: ` · 3 running · 2 done` (`running` counts queued, running and grace records; `done` counts closed rows in both sections), ` · 2 running`, ` · 1 done`, `""`.
- `clears a closed root with its subtree and a closed child alone`: `clearTargets(r)` → `[r, r1, r1x]`; `clearTargets(a1)` under running `a` → `[a1]` plus its closed descendants; an open id → `[]`.
- `carries the selection to the next row, else the previous, else none`.
- `writes the hint for the selected row`: the four texts of §3.

### `test/plugins/agent-view/list.test.ts` (replaces `test/plugins/agent-list-view/agent-list-view.test.ts`)

| old test | fate |
|---|---|
| opens from /agents without an id and shows the empty state | changed: `lines[0] === ""`, `lines[1] === " Agents"`, contains ` No agents running`, `lines.at(-2) === " esc to close"`, `lines.at(-1) === ""` |
| groups agents by state, newest first | replaced by `shows the sections, headers, rows and subtitle`: a running root with a running child and a done child, plus a done root with a done child → `""`, ` Agents · 2 running · 3 done`, `""`, ` Running`, root row, `├─` running child row, `└─` child row ending `done · …`, `""`, ` Completed (1)`, root row, `└─` child row |
| moves the cursor over headers and opens the selected agent with Enter | changed: `moves over rows, skipping headers, clamped at both ends` (Enter is in `overlay.test.ts`) |
| stops the selected agent with x and closes it with a second x | survives; hints `x to stop` → `x to close now` |
| stops every open agent after X and y | changed: `stops every running agent after X twice within 3 s` (fake timers; feedback `Press X again to stop all agents` above the hint; running → grace, queued → stopped, a grace record untouched; feedback gone) |
| stops nothing after X and any other key | changed: `drops the confirmation after 3 s or on any other key` (X, advance 3001 ms, feedback gone, X shows it again without stopping; X then `down`: feedback gone, selection moved, nothing stopped; X then Esc: feedback gone, nothing stopped, `state.closed` true) |
| filters rows with / and clears the filter with Esc | replaced by `ignores / and other unbound keys` |
| keeps the selected row visible while moving through a long list | survives |

New: `pads every line and keeps the last column blank` (widths 80 and 40: `lines[0]`, the reserved blank above the feedback/hint block and `lines.at(-1)` are `""`; title, headers, feedback and hint start with `" "`; rows start with `" "` and their glyph is at column 3; every line has `displayWidth <= width - 1`); `clears a completed subtree with x on its root and a child alone with x on the child` (`x` on the `Completed` root → it and its child are gone; `x` on a closed child under a running root → only that row is gone); `says No running agents for 2 s` (only closed rows → muted feedback; gone after 2000 ms); `leaves grace agents alone on stop-all` (only grace rows: no `No running agents`; X twice stops nothing and the feedback stays `Press X again to stop all agents` until 3 s pass); `clears its timers on dispose` (X, then `dispose()` → `vi.getTimerCount() === 0`; the feedback timer was `unref()`'d, checked with a `setTimeout` recorder through `vi.stubGlobal` as in plan 05's refresh test); `keeps a closed row for lingerMs, then drops it on the tick` (fake timers; at 29 s present, at 31 s gone); `clears a closed row with x, selects the next row, and keeps it cleared after reopening /agents`; `moves the selection with PgDn, End and the wheel and keeps it visible`; `refreshes when an agent changes` (spawn after opening → row appears after `flush`); `completes /agents with the listed ids only` (an expired and a cleared agent missing from `complete("")`).

### `test/plugins/agent-view/overlay.test.ts` (new)

- `Enter swaps to the view in the same overlay and Esc returns to the list with the selection kept`: select row 2, Enter → `lines[1]` names its agent and description (` ⠋ explorer › …`), `lines[2]` ends `id <its id>`, the hint (`lines.at(-2)`) starts ` esc to go back`, `state.closed` false, one overlay factory in `host.overlays`; Esc → list with `›` on row 2; Esc → `state.closed` true.
- `reloads the list on return`: an agent closes while the view is shown; back in the list it is under `Completed (1)`.
- `/agents <id> opens the view and Esc closes the overlay`: hint starts ` esc to close`.
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

Prerequisites: plan 01 §D (`createTranscript({ tools })`, `createTranscriptPane(…, { tools })`, captured renderers); plan 04 (`format.ts`, `spinner.ts`, `state-text.ts`, the `tools` service); plan 05 (`agent-row.ts` `renderRow`/`nameColumn`, `tree.ts`, the new `refresh.ts`). Plan 05's `watchAgents` signature change breaks today's two callers (`agent-view/index.ts`, `agent-list-view/index.ts`); plan 05's bridge stands: it patches both call sites with `tickMs: () => (ticking() ? 1_000 : undefined)` and moves today's row helpers to `components/legacy-row.ts`. Alternatively land 05 and 06 in one PR: no bridge, and `options` is required from the start.

1. `registry.ts` counters + registry test. `npm run test`.
2. `model/types.ts`: make `options` of `AgentViewService.open` required (plan 05 added `AgentViewOrigin` and `options?`), drop `agentList`.
3. `components/request-block.ts` + its test; `agent-view/loader.ts` (move + `chain`), `view.ts` (rewrite), `list-model.ts`, `list.ts`, `overlay.ts`, `index.ts`.
4. Delete `mode-store.ts`, `agent-list-view/`, `components/{agent-list,collapsible,context-breakdown,system-prompt-block,hints,legacy-row}.ts` (and `test/components/legacy-row.test.ts`); update `plugins.ts`.
5. Tests: helper, `view.test.ts` (rename and rework), `list-model`, `list`, `overlay`, session-file, plugins; delete the old ones; delete the old snapshot file and record the new one with `npx vitest run extensions/subagents/test/plugins/agent-view -u`, then review the snapshot diff (the transcript snapshot loses only its `Transcript` title; the codemode and expanded-request ones are new).
6. Docs (§8).
7. `npm run check` (typecheck, biome, unit tests), clean.

Manual checklist (`pi -e ./extensions/subagents/src/index.ts`, fullscreen and regular TUI):
- [ ] Start 3 agents, one of them hitting a confirmation from an extension: `/agents` shows `Agents · 3 running`, one `Running` section, no `needs input` anywhere (the agent got the denial and carried on), rows aligned like the panel, spinner turning; an agent that starts agents has them under it, and a finished child stays under its running caller; once the caller finishes, the group moves to `Completed (1)` together.
- [ ] Padding: title, rows, header, `▸ Request` and hint start one column in; nothing touches the right edge; the view's rule runs edge to edge; a blank row above the hint.
- [ ] `↓`, `Enter`: the same overlay shows the view; `Esc` returns with the same row selected; `Esc` closes.
- [ ] `/agents <id>` and `Enter` on a panel row: `Esc` closes at once; hint says `esc to close`.
- [ ] An agent using codemode: highlighted script, `✓ grep …` lines, 5-line output with expand hint; Ctrl+O expands everything.
- [ ] An agent that calls `run_agent`: the nested block looks like the main transcript's.
- [ ] `↑` stops following (` · end to follow`), `End` resumes; a finished agent shows no suffix and no spinner.
- [ ] The view header reads `<glyph> explorer › <description>` with `<state> · <model> · id <id>` under it. The view shows `▸ Request · N lines` under the rule and the task as the first transcript item; a just-started agent briefly shows `▸ Request · not sent yet`. `r` expands the first request at the top as plain indented JSON (system prompt, tools with schemas, first messages), the hint says `r hide request`; `r` again returns to the tail and follows. Reopening the view shows it collapsed. An agent from before the upgrade shows `▸ Request · not recorded` and `r` does nothing.
- [ ] `x` in list and view: grace then close now; `x` on a finished row clears it; `X` shows `Press X again to stop all agents` and the second `X` stops all; `X` then `Esc` cancels and closes the list; with nothing running `No running agents` disappears after 2 s.
- [ ] A finished agent leaves the list after 30 s; `/agents <id>` still opens it, also after `/resume`, with real tool-use and token counts.
- [ ] No `pi-subagents-view.json` is created under `~/.pi/agent`.

Deviations and clarifications (also in the report): plugin id kept as `agent-view` (merge instead of a new `agent-views` id); the list's wheel and page keys move the selection; the selection falls back to the previous row before clearing; reaching the tail by scrolling resumes following; the view's tick also stats the session file; `stop failed: <msg>` feedback kept; stop-all leaves grace records alone (with only grace rows the second `X` is a no-op); an empty list's hint is `esc to close`; `x` on a closed child also clears its closed descendants; completion lists only listed agents; `worktree: kept: …` keeps today's text.
