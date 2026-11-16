# Baseline: what pi-extensions and pi already do about tokens, context and cost

Scope: this checkout (HEAD `aeafaf28`), read-only. Paths are repo-relative; "ARCH" means the folder's `ARCHITECTURE.md`. Line numbers are those of the file at this commit (docs lines are long; the number points at the bullet).

Two caveats up front.

- `future-plans/README.md` lists `idle-handoff/`, `claude-code-compat/`, `implementer-agent/` and `skill-autosetup/`, but commit `6c0f9f5e` ("remove future-plans research and spec documents") deleted those folders. Only `enterprise-workflow/`, `no-host-pi/`, `plan-mode-and-guards/`, `skills-in-main-session/` and `workflow-mechanics/` exist on disk. I read the idle-handoff documents from git history (`git show 6c0f9f5e^:future-plans/idle-handoff/...`). The skill-autosetup flow is shipped (subagents ARCH:88-89), so its plan is not needed.
- `future-plans/enterprise-workflow/harness/pi-capabilities.md` still describes the older `core/adapter` layout and a 0.75 hard ratio; use it for pi facts, not for repo state.

## 1. Inventory

Fourteen extensions (`extensions/*`) on four platform layers (`platform/pi-adapter`, `shared`, `ui-kit`, `extension-manager`), plus the standalone launcher (`launcher/`).

| Extension | What it does |
|---|---|
| `subagents` | `run_agent`, `message_agent`, `stop_agent`, `agent_status` tools; background in-process agents with their own context, tools, model, limit, optional git worktree and MCP; ten shipped agents (six chores, four leads); `/agents` overlay, `/agents setup`, `/agents create`; `fetch` tool for the `fetch` chore. |
| `session-limits` | Warns at a soft context threshold and, at a hard threshold, has the model write a handoff document and continues in a new session seeded with it; `/handoff` does it on demand. Holds the switch while agents run and keeps messages typed meanwhile. |
| `spending` | Ledger of session cost and tokens, main plus agents at any depth, persisted in the session file and carried over forks and handoffs; publishes totals for the footer. |
| `context` | `/context`: grid and legend of what fills the window (system prompt, tools, MCP tools, extension tools, memory files, skills, messages, free space, compaction reserve) and cache hit rate for the last turn and the session. |
| `footer` | Replaces pi's footer: folder, branch, model, thinking level, context figure (against the handoff point when session-limits is present), cache percent, session tokens and cost (main and agents split). |
| `model-default` | Saves every model and thinking level the user picks in the main session as pi's default (as Ctrl+S does); keeps the chosen thinking level across model switches. |
| `style` | `/style concise` (default) or `normal`: a prompt section asking for short, result-first replies; main session only. |
| `mcp-import` | `/mcp-import <claude\|cursor>`: copies MCP servers into pi's `mcp.json`, dry run unless `apply`. |
| `notifications` | One terminal notification when pi waits for input or a dialog is unanswered (`pi-notifications.json`: `channel`, `idleDelayMs` 20 s, `dialogDelayMs` 6 s, `extensions/notifications/core/settings.ts:12-16`). Not a spend or budget alert. |
| `questionnaire` | `questionnaire` tool: a batch of multiple-choice questions in one inline form. |
| `transcript` | Tool calls drawn as one-line state rows, expandable with `ctrl+o`; also used in the agent view. Display only. |
| `composer`, `working-indicator`, `command-aliases` | Editor frame, working line with elapsed time, `/continue` `/clear` `/exit` aliases. Display and naming only. |
| `launcher` (not an extension) | `pi-sandbox`: runs pi in a per-repository container with credentials replaced by placeholders and an allowlisting proxy (`launcher/ARCHITECTURE.md`). Has `pi sandbox doctor` for its own checks. No token or cost feature. |

## 2. Themes

### 2.1 Context-size awareness: have

- Footer line 2 shows `context 42.3k of <base>` and `cache 73%`; the base is the context window, or, when session-limits has published its settings on `session-limits:limits`, the handoff point and the label becomes `working context` (`extensions/footer/ARCHITECTURE.md:5-6`, `:8`).
- Thresholds are per session-limits and combine a ratio and an absolute token cap: the limit is `min(window x ratio, token cap)`. Defaults `softRatio` 0.45, `hardRatio` 0.60, `softTokens` 125,000, `hardTokens` 175,000 (`extensions/session-limits/core/settings.ts:5-10`; logic in `platform/shared/handoff/handoff-limit.ts` `mainLimit` and `limitLevel`; described at `extensions/session-limits/ARCHITECTURE.md:11`). Ratios decide on small windows, caps on large ones. Configurable in `pi-session-limits.json` (user and trusted project), each value validated (ratio in (0,1], tokens up to 100M).
- The soft level shows a warning notice `» handoff at 175k tokens · 142.3k used` below the editor; the footer figure turns warning at soft and error at hard (same evaluator, so they cannot disagree; `footer/ARCHITECTURE.md:6`).
- `/context` (`extensions/context/ARCHITECTURE.md:10-12`): per-category token estimate (chars/4 for system prompt, tool declarations, memory files, skills; pi's `estimateTokens` for messages; scaled to pi's reported total), messages split by kind, compaction reserve, tools "loaded on demand" counted at 0. Output goes to the transcript as a custom entry and never reaches the model; other modes get a one-line notify.
- Agents have their own limit in the agent file (`limit`, at least 5000; shipped 60k-120k) with `softContextRatio` 0.8 and `hardContextRatio` 1.15 (`extensions/subagents/core/model/settings.ts:44-48`); effective limit is `min(limit, window - reserveTokens)` (`subagents/ARCHITECTURE.md:69`). The agent view and `agent_status` show `working context X of Y` per agent.
- Absent: no percentage-of-window-only footer warning independent of session-limits, no per-tool-result size view, no per-turn "what grew" delta, no hint that points at the biggest category in `/context`.

### 2.2 Compaction and handoff: have (handoff), partly (compaction, idle)

- Pi compacts natively: auto at `contextTokens > window - reserveTokens` (default 16,384), `keepRecentTokens` 20,000, manual `/compact [instructions]`, per-model overrides (`future-plans/enterprise-workflow/harness/pi-capabilities.md:68-72`; pi's, not ours). This repo does not trigger or customise main-session compaction. session-limits only listens to `Host.onCompact` to forget its cached token count (`session-limits/ARCHITECTURE.md:23`).
- Our mechanism is the handoff, triggered by session-limits at the hard level on turn end, or by `/handoff [focus]`. The model gets an instruction (template `platform/shared/handoff/handoff-prompt.md`), calls the `handoff` tool, which writes `<OS temp>/pi-handoff/<session id>/main-handoff.md` and validates six sections (Status, Outcome, Evidence, Blocker, Next, Files touched; status `done|partial|blocked`). Pi then starts a new session seeded with it (`ARCH:11`, `:13`). Model and thinking level carry over without moving pi's defaults; spending totals carry over (`spending/ARCHITECTURE.md:9`).
- Preserved: only what the model writes into the handoff, plus delegated-agent ids and result file paths (main prompt rule, `extensions/subagents/prompts/main-session.md` "Session handoffs"), late agent results and the user's queued messages. The previous transcript is shown above the seed for the user only; the model sees the handoff alone.
- The switch waits for busy sources (`pi:busy`, agents open) and asks for confirmation for a manual handoff (`session-limits/ARCHITECTURE.md:18`).
- Agents hand off the same way at their own limit, in chains of up to `maxChainLength` 3; a successor starts from the handoff alone (`subagents/ARCHITECTURE.md:69-70`). Agents never compact (`child-runtime.ts:49-52`, compaction disabled).
- Idle or cache-expiry awareness: missing. Idle handoff while the provider cache is warm was designed and dropped (`future-plans/README.md`, row "idle-handoff", status dropped; research recoverable from git at `6c0f9f5e^:future-plans/idle-handoff/`). Its numbers (idle ratio 0.4, 60 s margin, 30-minute lifetime floor, `PI_CACHE_RETENTION=long`) were never built. Note the `notifications` idle timer is unrelated: it only alerts the user.
- Absent: custom compaction summaries (`session_before_compact` is available in pi but unused), a `/compact`-style command of ours, rewinding to a point and summarising from there, pruning of old tool results, a user choice between compact and handoff.

### 2.3 Prompt-cache awareness: partly

- Tracked and shown: cache hit = `cacheRead / (input + cacheRead + cacheWrite)` for last turn and session in `/context`, session figure in the footer (painted `muted`, not coloured: `extensions/footer/ui/render.ts:84`; `context/ARCHITECTURE.md:14`), coloured success from 70 %, warning from 30 %, error below only in `/context` (`context/ARCHITECTURE.md:12`; `platform/shared/cache-hit.ts`, `platform/ui-kit/cache-tone.ts`). Nothing shows until the session reports a cache read or write. Figures come from pi's normalised usage buckets.
- Not tracked: cache write cost separately, cache TTL or time since last request, cache-busting events (model switch, prompt section change, tool set change), per-agent cache rate.
- Prompt stability by design: agents' prompt prefix is fixed at spawn (`platform/pi-adapter/ARCHITECTURE.md:58`); `/style` changes one prompt section and pi sends only the changed section as a patch (`style/ARCHITECTURE.md`); `model-default` re-applies the chosen thinking level after a model switch. None of these is framed or tested as cache protection.
- Pi's own: `cacheWarming` setting (`off`, `streaming` default, `idle`), re-sending the last request with a one-token cap at 90 % of the cache lifetime, a `cache_warming_decision` event, model `promptCache` lifetimes, `PI_CACHE_RETENTION=long` (idle-handoff research, `modes-and-compaction.md`; `pi-capabilities.md:29`). Our only touch: child sessions force `cacheWarming: "off"` (`platform/pi-adapter/child/child-runtime.ts:51`), and `/context` excludes cache-warming usage entries from the session figure.

### 2.4 Cost and usage reporting: have (money), partly (breakdowns)

- Source of truth is pi's own per-message usage cost; we never price anything (`spending/ARCHITECTURE.md:5`; AGENTS.md rule). `sumUsage` adds assistant, tool-result, `usage`, compaction and branch-summary usage.
- Per session: footer line 2 shows chargeable tokens (`input + output + cacheRead + cacheWrite`) and cost; with agents it reads `$main main · $agents agents · $total total`; subscription (OAuth) sessions mark the total `on subscription` (`footer/ARCHITECTURE.md:5`, `spending/ARCHITECTURE.md:8,10`). Totals survive resume, fork and handoff (`spending/ARCHITECTURE.md:9`).
- Per agent: every `run_agent` batch result and the agent panel/list carry a receipt `Done · 1m 5s · 4 calls · 12.3k tokens · $0.04`, summed over a handoff chain (`subagents/ARCHITECTURE.md:47`); the agent view shows context use. Agent usage reaches spending on `spending:usage` (monotonic ledger, idempotent).
- Pi's own `/session` reports usage and cache rate; `/context` differs slightly because it leaves out compaction and tool-result usage (`context/ARCHITECTURE.md:12`).
- Absent: per-model breakdown, per-agent-type totals, per-day or cross-session history, cost projection, "what did this turn cost" row, cost of the handoff itself, a `/cost` or `/usage` command, export. No command exists beyond the footer and `/context`.

### 2.5 Model and thinking-level choice: have

- Per agent file: `model: name[:thinking]` or `inherit[:thinking]`; shipped agents name specific models (the only place model names may appear). `run_agent` accepts a per-call `model` that is applied on top (`subagents/ARCHITECTURE.md:20,30,39`). Resolution: exact `provider/id`, then fuzzy within provider scope; ambiguous or unknown fails the call with candidates (`pi-adapter/ARCHITECTURE.md:56`). Thinking level: suffix, then definition, then main session's level.
- Overrides without editing agent files: `pi-subagents.json` (user and trusted project) with `agents.<name>.{model, thinking, skills}` (`subagents/ARCHITECTURE.md:31`), written by `/agents setup`: a tabbed form (leads and chores), presets `Previous` and `Suggested`, one-line form `/agents setup <agent> model=… thinking=… skills=…`.
- Complexity-based delegation is in the main prompt: chores (`scout`, `editor`, `verifier`, `shell`, `fetch`, `image`) run on cheap models at low thinking and are the default for well-specified work; leads (`planner` high, `implementer` medium, `reviewer` high, `general` medium) are for judgement (`extensions/subagents/prompts/main-session.md`; agent files under `extensions/subagents/agents/`). Evals cover routing (`test/evals/routing`).
- Main session: `model-default` persists the last model and thinking level; pi's Shift+Tab cycles thinking; pi's Ctrl+P cycles models (pi's own).
- Absent: automatic per-turn model routing, a "fast mode" or small-model helper for housekeeping inside the main session (title, summaries), effort suggestion by task, a setup step that recommends cheaper models from observed spend, a way to cap thinking tokens (pi exposes levels only).

### 2.6 Subagents as context isolation: have

- Each agent is an in-process pi `AgentSession` with its own session file, prompt, tools, skills and MCP (`subagents/ARCHITECTURE.md:42`). The main session receives only the agent's final text: `Status:` line plus sections, up to `inlineResultChars` 8,000, otherwise the head plus `Result file: <path> (<N> more chars)`; the main prompt says to pass paths rather than paste and not to read handoffs (`ARCH:47`, `prompts/main-session.md` "Results").
- Tool restriction per agent: `tools` allowlist (`[]`, list or `all`); scout is `[read, grep, find, ls]`, editor `[read, grep, find, ls, edit, write]`, shell `[bash, read]`; `skills`, `subagents` grant, `mcp: true|false` (`ARCH:22-27`). The main session is unrestricted (`ARCH:35`).
- Limits: per-agent `limit` (context), `maxDepth` 3, `maxConcurrent` 12 shared by the tree, `maxChildrenPerAgent` 6, `maxChainLength` 3, `stopGraceSeconds` 60, fetch caps (`fetchTimeoutSeconds` 20, `fetchMaxBytes` 5 MB, `fetchMaxChars` 40,000) (`core/model/settings.ts:44-59`, ranges at `:110-112`). Hard stop: abort 3 turns after a handoff request or past `limit x hardContextRatio`. There is no per-agent turn budget, wall-clock timeout or dollar cap.
- Background: every batch runs in the background; the caller is woken once with all results through a hidden message; `stop_agent` and Esc stop agents; `pi:busy` and `pi:background-work` keep idle notifications and handoffs honest.
- Worktrees: `worktree: true` runs the agent in `<cwd>/.pi/worktrees/<id>-<stamp>` on branch `pi-agents/<id>-<stamp>` (`ARCH:94-96`).
- Shell chore saves full command output to a log in its agent folder and returns a digest plus the log path (`agents/chores/shell.md:14-19`).

### 2.7 Tool surface size: partly (pi's mechanisms, ours thin)

- Pi provides `codemode` (script tool calling other tools), `tool_search` and tool exposure modes `direct`, `model-only`, `codemode`, `deferred`, `hidden`; MCP servers are exposed by default through codemode, with `toolExposure` patterns per server in `mcp.json` (`pi-capabilities.md:93`). `/context` counts deferred tools at 0 tokens and lists the MCP ones as "loaded on demand" (`context/ARCHITECTURE.md:10-11`).
- Ours: `ToolSpec` can set `modelOnly` and `promptGuidelines` (`pi-adapter/ARCHITECTURE.md:38`). Per-agent MCP is all or nothing: `mcp: true` loads pi's MCP built-in with every enabled server, `mcp: false` none; any non-empty `tools` also brings `codemode` and `tool_search` (`subagents/ARCHITECTURE.md:27,42`). Chores run `mcp: false` and carry no skills. A per-server filter (`mcp: [server, "server:pattern"]`) is planned and unbuilt (`future-plans/README.md`, delivery order item 3).
- `mcp-import` copies server definitions only; it does not trim or measure them.
- Skills: pi puts `<available_skills>` (name, description, location) in the prompt and loads the body on demand through `read`; `/skill:name` injects a body (`future-plans/skills-in-main-session/research.md:9-13`). Settings exclusions (`skills: ["!pattern"]`) trim the main session only. Agents get only the skills named in their file, override or `run_agent` call, and the `skills` argument must be a subset of what the caller has (`ARCH:39`). `/agents setup` proposes at most five skills per lead. A `skill` tool for on-demand main-session skills is deferred (`skills-in-main-session/README.md`).
- Absent: any report of MCP tool tokens per server beyond the `/context` row, auto-disable of unused servers, a deferred-by-default policy for our own tools.

### 2.8 Tool output size control: partly

- Ours: agent results are capped when returned to the caller (8,000 chars inline, rest in `result.md`); the `fetch` tool caps bytes and characters; the shell chore writes logs to files and reads them by `grep` or line range; scouts return `path:line` findings, not file bodies. Tool rows in the transcript are display-only (collapsed) and do not change what the model sees (`transcript/ARCHITECTURE.md`).
- Pi's own: truncation of built-in tool output (`read`, `bash`) with a note, pi's `estimateTokens`, compaction cutting tool results to 2,000 characters in summarisation requests (idle-handoff research, `modes-and-compaction.md` section 4; pi's, not verified here).
- Absent: no extension hooks `tool_result` to shrink or filter output, no head and tail cap with spill to a file for the main session's tools, no `.gitignore`-style output filters, no command-output compression, no warning when one tool result is a large share of context. `/context` shows tool results as one aggregate figure.

### 2.9 Prompt size of the extensions themselves: partly (measured by hand, not guarded)

- What we add to the main prompt: `prompts/main-session.md` (about 5.7 KB, role, agent guide, brief template, result rules; `subagents/ARCHITECTURE.md:35`), plus `main-session-agent-status.md` (312 B) when the agent-status plugin is on, the `run_agent` description (lists each agent's description, per `ARCH:16-17`), tool schemas of `run_agent`, `message_agent`, `stop_agent`, `agent_status`, `handoff`, `questionnaire`, and `fetch` (agents only), and the `output_style` section from `style` (`prompts/concise.md`). Agents get pi's prompt plus `base-system-prompt.md` (2.2 KB) and the agent body (`ARCH:33`). `/context` makes the sum visible: extension tools and system prompt rows.
- Guards: none on size. `test/evals/` scores routing quality and planner, reviewer and implementer behaviour, not token cost of prompts (`test/evals/README.md`). Unit tests in `extensions/context/tests/` check the breakdown arithmetic, not our prompts. Biome, knip and `docs-sync` do not look at prompt length.
- Absent: a test or eval that fails when an extension's prompt contribution grows past a budget, a script that prints prompt tokens per extension, conditional loading of the agent-orchestration section for sessions that never delegate.

### 2.10 Diagnostics: partly

- `/context` is the closest to a doctor for the prompt. `/agents setup` inspects the project and the skill inventory and proposes skills, models and thinking levels per agent, with a confirm form and a write to `pi-subagents.json`; the same form flags changes with `(changed)` and `(in use)` (`subagents/ARCHITECTURE.md:88-92`). After saving it suggests `/new` to free the tokens the setup took.
- `pi sandbox doctor` reports launcher checks by area (host, sandbox, network, credentials, leak sweep) with hints (`launcher/ARCHITECTURE.md`; root ARCH, launcher bullet). It does not concern tokens.
- Settings problems become warnings at session start (`pi-<ext> settings: …`).
- Absent: a command that audits the user's setup for waste (large `AGENTS.md`, many MCP servers, unused skills, MCP servers with huge tool lists, models too expensive for chores) and recommends changes; no recommendation based on spend history.

### 2.11 Notifications and budgets: partly (limits yes, spend limits no)

- Present: context threshold notice, `handoff failed · run /handoff` when stuck, agent turn and chain limits, `maxChildrenPerAgent`, `maxConcurrent`, `maxDepth`, the `notifications` extension for input waits (OSC 9/777 or bell, `pi-notifications.json`).
- Absent: any spend limit (dollar or token) per session, per agent or per day; any alert when cost passes a figure; any turn cap for the main session; any warning on an unusually expensive turn; budgets in `run_agent`.

## 3. What pi provides natively (not ours)

Evidence is the adapter code under `platform/pi-adapter/` and the capability notes in `future-plans/`.

| Area | Pi provides | We add |
|---|---|---|
| Compaction | Auto compaction at `window - reserveTokens`, `keepRecentTokens`, manual `/compact`, `session_before_compact` and `session_compact` events, `ctx.compact()`, overflow recovery (`pi-capabilities.md:16-17,68-72`) | Handoff switch instead; adapter exposes only `onCompact` (`pi-adapter/ARCHITECTURE.md:24`). Children get compaction disabled with a reserve (`child-runtime.ts:49-52`) |
| Usage figures | Per-message usage with four prompt buckets (input, output, cacheRead, cacheWrite) and cost already priced; `estimateTokens`; context size and window via the context object; unknown tokens right after compaction | Sums (`sumUsage`, `platform/pi-adapter/context/usage-math.ts`), the `ContextSnapshot` on turn end (`pi-adapter/ARCHITECTURE.md:26`), `contextFacts()` (`:43`) |
| Cost | Cost per message computed by pi from model prices; subscription marking for OAuth providers; `/session` stats | Ledger, footer, receipts (`spending`) |
| Caching | `cacheWarming` (`off`, `streaming`, `idle`), `cache_warming_decision` event, model `promptCache` lifetimes, `PI_CACHE_RETENTION` | Hit-rate display; children set to `off` |
| Thinking levels | Levels per model, `/thinking`, Shift+Tab, `thinking_level_select` event, per-model levels, `defaultThinkingLevel` | `model-default` persistence and re-apply; per-agent `:thinking` |
| Models | Registry, credentials, `setModel`, scope (`enabledModels`), virtual-model routing, `modelRegistry.classify` and `streamSimple` for cheap side calls (`pi-capabilities.md:34-35`) | Resolution for agents (`child/model-resolver.ts`); none of the routing hooks is used |
| Tools | Built-ins with truncated output, `codemode`, `tool_search`, exposure modes, MCP built-in with `mcp.json`, `toolExposure` | Custom tools, `modelOnly` mapping, `mcp` flag on agents |
| Skills | Discovery, `<available_skills>` index in prompt, body read on demand, `/skill:name`, exclusions | Per-agent skill lists and inventory |
| Sessions | JSONL tree, fork, clone, `/tree`, custom entries, `new session` with `withSession` | Handoff flow, entries (`pi-spending:usage` and others) |
| Events | `agent_settled`, `turn_end`, `before_agent_start`, `tool_call`, `tool_result`, `context`, `input`, `session_before_*` | The adapter subscribes to a subset; `tool_result`, `context` and `input` (partly, `Host.onInput`) are unused for token control |

## 4. Constraints from AGENTS.md and the architecture that a new feature must respect

- No provider or model names in code or prompts; cost only from pi's own usage figures, never a price table; only shipped agent files name models (`AGENTS.md`; root ARCH "Repo rules"). Unit-test fixtures use invented names.
- Pi packages are imported only in `platform/pi-adapter/` (with its tests), `test/framework/pi/` and `launcher/hostpi/*.mjs`; everything else goes through `platform/pi-adapter/index.ts`. New pi hooks (for example `tool_result`, `session_before_compact`, `context`) need an adapter `Host` method first. Shipped code never imports `test/`.
- Extensions import each other only through `index.ts` and only from `api/`; today they use the bus (`platform/shared/channels/host-channels.ts`) and shared formats. New cross-extension data (a budget, a cost event) goes through a typed channel or `platform/shared`. Layering inside an extension is `core` then `ui` then `api` then `index.ts`; `core/` imports no theme or other extension. No `export *`, no dead code (knip), no cycles; folder shape and depth are tested by `test/architecture.test.ts`.
- Files an extension may write: only under pi's agent dir or session dir (`~/.pi/agent`), except handoff documents in the OS temp dir (`pi-handoff/<session id>/...`), agent worktrees, `<cwd>/.pi/.gitignore`, and two project files on the user's command (`.pi/pi-subagents.json`, `.pi/mcp.json`). Any other write under `<cwd>/.pi/` goes through `writeSettingsFile` or `ensureProjectSubdir` from `platform/shared`. Settings follow the pattern `<agentDir>/pi-<extension>.json` plus a trusted project file, validated by a schema; session data as custom entries named `<namespace>:<kind>`. State in memory is lost on reload.
- The launcher may not import `platform/shared`, writes only what its "Files written" list names, and has a fixed folder graph.
- User-facing failures are data (warnings, error results), not exceptions.
- Any change under `extensions/<name>/` or `launcher/` outside `tests/` must also change that folder's `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md` (`test/docs-sync.test.ts`). Prompt text lives in `prompts/` files read at enable time.
- `npm run check` (typecheck, biome, knip, unit tests) must pass; `test:live` and `evals` are local only, cost money and never run in CI.

## 5. Summary table

| Theme | Status | One line |
|---|---|---|
| Context-size awareness | have | Footer figure, `/context`, soft and hard thresholds in ratio and absolute tokens, per-agent limits |
| Compaction and handoff | partly | Handoff at a threshold or on `/handoff`; pi's compaction untouched; no idle or cache-expiry trigger (dropped) |
| Prompt-cache awareness | partly | Hit rate shown; no TTL, no cache-bust tracking; pi's cache warming not exposed |
| Cost and usage reporting | partly | Session and per-agent cost in the footer and receipts, from pi; no per-model view, no history, no command |
| Model and thinking choice | have | Per-agent model and thinking, chores versus leads, `/agents setup`, `model-default`; no automatic routing |
| Subagents as isolation | have | Own context, capped results, tool allowlist, depth, concurrency and chain limits, worktrees; no turn or dollar budget |
| Tool surface size | partly | Pi's deferred tools and `tool_search`; per-agent MCP all-or-nothing; skills by index; per-server filter and `skill` tool unbuilt |
| Tool output size control | partly | Agent result cap, fetch caps, shell log files; no `tool_result` shrinking for the main session |
| Extension prompt size | partly | `/context` shows it; no test, eval or budget guards it |
| Diagnostics | partly | `/context` and `/agents setup`; no waste audit |
| Notifications and budgets | missing | Context and agent-count limits only; no spend or turn budget, no cost alert |
