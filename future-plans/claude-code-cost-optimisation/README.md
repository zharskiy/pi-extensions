# Claude Code cost optimisation

Research date: 2026-11-16, against Claude Code 2.1.325, its live docs and changelog, the Claude API docs and published community measurements. Status: researched, nothing planned yet.

Question: which features does Claude Code have that help users cut token use and spend, or audit and tune their own setup, and which of them are worth building into pi-extensions?

Answer in short:

- One lever dominates the input bill: prompt-cache health. In the only large independent benchmark, cache reads were 94% of Fable's input tokens and 30% of its bill. Claude Code's newest cost work is cache work: a per-session miss counter with a likely cause, idle compaction before the cache expires, and confirmation before a model switch while the cache is warm.
- Deferring tool definitions is the best-evidenced token saving after caching. pi already does it (`tool_search`, codemode).
- The heavily marketed tricks measured far below their claims: output-filtering proxies gave no reliable cost saving, and terse-output prompting cut about 8.5% of output tokens, not 65%.
- Claude Code's audit features (`/usage` attribution with recommendations and a fix key, `/context` suggestions, `/doctor`, `/skill-doctor`, startup size warnings) are mostly static and cheap. Their best ideas carry over to this repository without a model call.
- pi-extensions already covers context size, handoff, model choice per agent and per-session cost. It is missing cache-miss visibility, a waste audit, spend limits and a usage breakdown.

Recommendation: build three small things first, all on the existing adapter surface: a cache-miss line with a likely cause, waste hints under `/context`, and a prompt-size budget test for our own prompts. Spend notices come next. The other candidates wait for the owner's decisions and, in two cases, for new adapter Host methods.

## What moves the bill

Ranked by strength of evidence, not by how often the lever is recommended. "Independent" means a third party measured billed cost or tokens and published the method. "Vendor" means Anthropic's or a tool author's own figure. "Unmeasured" means documented mechanism or advice with no figure.

| Rank | Lever | Evidence | What it shows |
|---|---|---|---|
| 1 | Cache health: stable prefix, no mid-session busts, no idle gaps past the TTL | Independent and vendor | Quesma, 1,740 Claude Code and OpenCode attempts: cache reads were 94% of Fable input tokens and 30% of the bill ([community-and-api](research/community-and-api.md) 1.1, https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/). Reads cost 0.1x of base input (0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable), writes 1.25x (5 min) or 2x (1 h) ([models-effort-billing](research/models-effort-billing.md) 5). Anthropic confirmed a client bug that turned later turns into cache misses and believes it drove faster usage-limit drain (https://www.anthropic.com/engineering/april-23-postmortem). |
| 2 | Per-token price of the model | Vendor price list (fact); the quality trade-off is unmeasured | Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per MTok input/output ([models-effort-billing](research/models-effort-billing.md) 5). Claude Code's docs name "Opus left as the default" as a common cause of high API spend. |
| 3 | Deferred tool definitions (tool search) | Vendor-measured, consistent secondary figures | Anthropic: definitions fell from about 77K to 8.7K tokens (85%) and tool-selection accuracy rose (https://www.anthropic.com/engineering/advanced-tool-use). Secondary: 12 MCP servers at about 63K tokens without tool search and 5.8K with it; 7 servers at 67K tokens, a third of a 200K window, before any input ([community-and-api](research/community-and-api.md) 1.8, 2.5). |
| 4 | Context carried per request: clear between tasks, compact or hand off earlier | Unmeasured; the mechanism is documented | Every request re-reads the whole prefix. With 1M windows auto-compaction fires at about 967K, so lowering the window is the lever Claude Code's docs point to ([context-and-session](research/context-and-session.md) 3, 5). |
| 5 | Always-on instructions: CLAUDE.md, skill listing, agent descriptions, tool descriptions | Vendor guidance, no end-to-end figure | Size times number of requests. Claude Code cut its own workflow tool description from 5.7K to about 1K tokens and the `claude-api` skill from 200K+ to about 25K ([binary-and-changelog](research/binary-and-changelog.md), tool search table). |
| 6 | Effort and thinking | Mechanism documented, no saving figure | Thinking is billed as output, "tens of thousands of tokens per request" at default budgets per the costs page ([models-effort-billing](research/models-effort-billing.md) 1, 3). Output is a small share of billed tokens (0.6 to 2.5% per one secondary source), so the gain is bounded. |
| 7 | Subagents for verbose work | Contested | They keep the lead's context small but every subagent sends its own requests. Agent teams use about 7x the tokens of a standard session when teammates run in plan mode (Claude Code costs page) ([tools-and-extensions](research/tools-and-extensions.md), multi-agent warnings). |
| 8 | Output filtering (RTK-style proxies, test-output hooks) | Independent: far below claims | Claimed 60 to 90%. Measured: Fable bill down about 5%, almost all from one task, with a per-task change of +1% and a 95% interval including zero; on DeepSeek the bill rose 5% because turns rose 18%. Terminal output was only about 7% of Fable's input tokens (11% with other tool output). The tool's own counter reported 89% saved ([community-and-api](research/community-and-api.md) 1.1). |
| 9 | Terse-output prompting ("caveman") | Independent, reported secondhand: far below claims | Claimed 65%. JetBrains' paired test converged to about 8.5% fewer output tokens with indistinguishable outcomes ([community-and-api](research/community-and-api.md) 1.5). |
| 10 | Code-navigation indexes (LSP, Serena, vector search) | Mixed or vendor-only | CircleCI's grep versus LSP comparison went both ways by task and model. Every other figure is the author's own ([community-and-api](research/community-and-api.md) 1.6). |

Two conclusions shape the candidates. Spend is mostly re-read context, so showing and preventing cache loss is worth more than squeezing output. And every always-on token is paid on every request, so static size checks pay off at no running cost.

## What Claude Code offers

Condensed. Detail, versions and sources are in the research files.

### Reducing tokens and spend

| Theme | Feature | Mechanism | Knob | Detail |
|---|---|---|---|---|
| Caching | Prompt layout and TTL | Stable content first; 1 h TTL for the subscription main conversation, 5 min elsewhere | `promptCacheTtl`, `subagentPromptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL` | [context-and-session](research/context-and-session.md) 2 |
| Caching | Cache-safe changes | Plan mode, skills, permission mode and `/recap` append instead of editing the prefix; tool list frozen under tool search | built in | same |
| Caching | Warm-cache guards | `/model` and effort changes ask for confirmation while the cache is warm; `/reload-plugins` refuses a full re-read without `--force` | `PreModelSwitch` hook | same |
| Compaction | Auto and manual compaction | Summary replaces history near the window limit | `/autocompact`, `autoCompactWindow`, `/compact [focus]`, "Compact instructions" in CLAUDE.md | [context-and-session](research/context-and-session.md) 3 |
| Compaction | Idle compaction | Compacts an idle conversation of at least 200K tokens shortly before the 1 h cache expires | `idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | same |
| Compaction | Partial compaction, side questions | `/rewind` Summarize from or up to here; `/btw` answers without entering history | commands | same |
| Memory | Lazy instructions | Nested CLAUDE.md and `paths:` rules load on demand; MEMORY.md capped at 200 lines or 25 KB; per-file truncation of on-demand files | `claudeMdExcludes`, `paths:` | [context-and-session](research/context-and-session.md) 6 |
| Tools | MCP tool search | Only names and server instructions load until a tool is used | `ENABLE_TOOL_SEARCH`, per-server `alwaysLoad` | [tools-and-extensions](research/tools-and-extensions.md), MCP |
| Tools | Output caps and spill to file | Bash inline to about 30K characters, MCP to 25K tokens, larger results saved to a file with a preview | `bashOutputMaxChars`, `MAX_MCP_OUTPUT_TOKENS` | [context-and-session](research/context-and-session.md) 7 |
| Tools | Tool removal | A bare tool name in a deny rule removes the definition from context (under tool search a mid-session deny leaves the definitions in the request and only blocks the call) | `--tools`, `permissions.deny` | [tools-and-extensions](research/tools-and-extensions.md), output styles |
| Skills | Listing budget | Names and descriptions within 1% of the window; least-used descriptions dropped first | `skillListingBudgetFraction`, `skillOverrides`, `disable-model-invocation` | [tools-and-extensions](research/tools-and-extensions.md), skills |
| Subagents | Isolation and forks | Fresh context returns a summary only; a fork reuses the parent's cache | `model`, `effort`, `tools`, `omitClaudeMd`, `maxTurns` | [tools-and-extensions](research/tools-and-extensions.md), subagents |
| Hooks | Pre and post filtering | `updatedInput` rewrites a command; `updatedToolOutput` replaces what the model sees | `hooks` | [tools-and-extensions](research/tools-and-extensions.md), hooks |
| Models | Aliases, per-agent model, effort | Cheaper model per subagent; effort levels; `maxEffortLevel` cap | `/model`, `/effort`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT` | [models-effort-billing](research/models-effort-billing.md) 2, 3 |
| Limits | Budget and turn caps | Stop at an estimated dollar amount or turn count, print mode only; no interactive cap exists | `--max-budget-usd`, `--max-turns` | [models-effort-billing](research/models-effort-billing.md) 7 |
| Scripted runs | Minimal mode | Skips hooks, skills, plugins, MCP, CLAUDE.md, auto memory | `--bare` | [models-effort-billing](research/models-effort-billing.md) 9 |

### Auditing and tuning a setup

| Feature | What it tells the user | Model call | Applies changes | Detail |
|---|---|---|---|---|
| `/usage` session block | Cost, per-model tokens, and a `Prompt cache (main)` line: hit share, misses with age and tokens re-cached, expected rebuilds, warm or cold, likely cause of the last miss | No | No | [setup-diagnostics](research/setup-diagnostics.md) 2 |
| `/usage` attribution and recommendations | Share of recent usage per skill, subagent, plugin and MCP server; a recommendation row only for behaviour at 10% or more of usage, such as `Trim CLAUDE.md · 49k tokens per request` or `Switch from max to high effort` | No | `f` applies effort rows and hands the rest to Claude with a show-before-change instruction | same |
| `/context` | Window grid by category with suggestions for heavy tools, memory bloat and capacity | Not documented; falls back to a local estimate instead of small-model requests since 2.1.261 | No | same; [binary-and-changelog](research/binary-and-changelog.md) |
| `/doctor` | Install health, unused extensions compared with their context cost, CLAUDE.md content Claude could derive from the repo, usage fixes from the last 7 days | Yes, it is a bundled skill | After confirmation | [setup-diagnostics](research/setup-diagnostics.md) 2 |
| `/doctor prompt-audit` | Instructions written for older models, dangling references, contradictions | Yes | On request | same |
| `/skill-doctor`, `claude plugin details` | Context cost per skill or plugin, never-invoked skills, plugins not used recently | None stated | No | same; [tools-and-extensions](research/tools-and-extensions.md), plugins |
| Status line JSON | `context_window.*`, `cost.total_cost_usd`, `rate_limits.*` and a `prompt_cache` object (`warm`, `ttl`, `expires_at`, `misses`, `hit_ratio`, `last_miss_cause`, `recache_tokens_if_cold`) | No | No | [setup-diagnostics](research/setup-diagnostics.md) 3 |
| Static size warnings | At startup: CLAUDE.md or rules file over 200 lines, a combined-size limit, agent descriptions over 15K tokens; skill listing over budget (debug log); one MCP result over 10K tokens | No | No | [setup-diagnostics](research/setup-diagnostics.md) 5 |
| Resume warning | On Pro, Max and Ultra, resuming after a long break shows the share of the 5-hour limit the saved conversation alone would use | No | No | [context-and-session](research/context-and-session.md) 4 |
| OpenTelemetry | `cost.usage` and `token.usage` split by `query_source`, `effort`, cache write 5 m and 1 h | No | No | [models-effort-billing](research/models-effort-billing.md) 6 |

The design pattern worth copying is the split between three layers: static warnings that cost nothing, a local report that ranks causes by share and labels each as auto-fixable or advisory, and a model-driven checkup reserved for edits that need judgement ([setup-diagnostics](research/setup-diagnostics.md) 8).

## Where pi-extensions stands

From [pi-extensions-baseline](research/pi-extensions-baseline.md). "Pi" means pi's own features, which this repository does not own.

### Reducing tokens and spend

| Theme | Status | What exists | Gap |
|---|---|---|---|
| Context size | have | Footer figure; soft and hard thresholds as `min(window x ratio, token cap)`, default 125K and 175K tokens; per-agent limits | No per-turn growth view, no hint at the largest category |
| Compaction and handoff | partly | Handoff at the hard threshold or on `/handoff`; pi compacts natively | No idle or cache-expiry trigger (idle handoff was dropped); `session_before_compact` unused |
| Prompt-cache protection | partly | Agents' prefix fixed at spawn; `/style` patches one section; pi's `cacheWarming` | Nothing detects or explains a bust; cache lifetime not exposed |
| Model and thinking choice | have | Per-agent `model:thinking`, chores on cheap models, `/agents setup`, `model-default` | No thinking-token cap (pi exposes levels only) |
| Subagent isolation | have | Own context, 8,000-character inline result, tool allowlists, depth, concurrency and chain limits | No turn, token or dollar budget per agent |
| Tool surface | partly | Pi's `tool_search`, codemode and exposure modes; `/context` counts deferred tools at 0 | Per-agent MCP all or nothing; per-server filter planned, unbuilt |
| Tool output size | partly | Agent result cap, `fetch` caps, shell chore logs to files; pi truncates built-in output | No `tool_result` handling for the main session |
| Our own prompt size | partly | Visible in `/context` | No test or budget guards it; `main-session.md` alone is 5.7 KB on every request |
| Spend limits | missing | Context and agent-count limits only | No spend or token budget, no cost alert |

### Auditing and tuning

| Theme | Status | What exists | Gap |
|---|---|---|---|
| Context breakdown | have | `/context` grid by category with a cache hit rate for the last turn and the session | No suggestions |
| Cache visibility | partly | Hit rate in the footer (uncoloured) and `/context` (coloured at 70% and 30%) | No misses, no cause, no warm or cold state, no cache-write cost |
| Cost reporting | partly | Footer and per-agent receipts from pi's figures; totals survive fork, resume and handoff | No per-model or per-agent-type view, no history, no command |
| Setup audit | partly | `/agents setup` proposes models, thinking and skills per agent | Nothing flags a large `AGENTS.md`, upfront MCP tools, a big skill listing or oversized agent descriptions |
| Diagnostics | partly | `pi sandbox doctor` for the launcher; settings warnings at start | Nothing for tokens |

## Candidates for this repository

Ordered by expected value against effort. All take cost only from pi's usage figures (`UsageTotals` carries input, output, cache read and cache write tokens with pi's cost per bucket, [`usage.ts`](../../platform/pi-adapter/types/usage.ts)), name no provider or model, and fall under the docs-sync rule for every extension they touch. Adapter methods named below are in [`host-capabilities.ts`](../../platform/pi-adapter/types/host-capabilities.ts).

### 1. Cache-miss line with a likely cause

- What: after each request, decide whether it was a miss and say why. `/context` gets a line such as `cache 91% · 2 misses (last 6m ago, 310k tokens re-cached, likely cause: model switched)`, and the footer cache figure (plain `muted` today) turns to warning on a fresh miss. Causes it can name: model switch, thinking-level switch, prompt section changed, tool set changed, compaction or handoff (expected rebuild), long idle gap.
- Modelled on: `/usage` `Prompt cache (main)` and the status line `prompt_cache` object. Claude Code counts a miss when a request re-processes more than 5% and at least 2,000 tokens of what could have been read, with no compaction to explain it ([setup-diagnostics](research/setup-diagnostics.md) 3).
- Evidence: rank 1 above. Users cannot fix what they cannot see, and Claude Code built this alongside a run of fixes for misses it found in its own client.
- Where: the rule in `platform/shared` next to `cache-hit.ts`; display in `context` and `footer`.
- Pi surface: available today. `lastRequestUsage()` gives cache read and write per request; `onModelSelect`, `onThinkingSelect` and `onCompact` mark expected or explained events; `contextFacts()` gives sections and tools to diff between requests; `onAssistantEnd` marks the end of each request (the handler takes its own timestamp). Cache-write cost comes from pi's `cost.cacheWrite`. A warm or cold state with time to expiry needs a new Host method that returns the model's cache lifetime (pi has per-model `promptCache` lifetimes, per the baseline); ship without it first.
- Constraints: thresholds are fractions and token counts, not provider rules; the miss history lives in memory or as a session custom entry (session dir). Docs for `context`, `footer`, root.
- Size: small to medium. Most of the work is cause attribution and tests with invented fixtures.
- Add-on, same release: after `onModelSelect` or `onThinkingSelect` with a large warm context, a one-line notice that the next request re-sends about N tokens uncached. A confirmation before the switch, as Claude Code does, is not possible: pi's `model_select` and `thinking_level_select` only notify ([pi-capabilities.md](../enterprise-workflow/harness/pi-capabilities.md) line 27).

### 2. Waste hints under `/context`

- What: a short list of findings below the grid, each with its token cost per request and the action, for example: `AGENTS.md · 9.1k tokens per request · move detail into skills or nested files`; `MCP server x: 14 tools loaded up front · 6.2k tokens · set toolExposure to deferred`; `skill listing · 3.4k tokens`; `run_agent description · 2.8k tokens`; `one tool result is 38% of messages`. Only rows over a threshold appear, largest first.
- Modelled on: `/context` suggestions, the static startup warnings (200-line CLAUDE.md, 15K-token agent descriptions) and `/usage` recommendation rows.
- Evidence: rank 3 and 5. Upfront MCP definitions are the best-measured waste; always-on text is paid on every request.
- Where: `context` (`core` computes findings, `ui` renders them).
- Pi surface: available today. `contextFacts()` returns sections, tools with `source`, `onDemand` and size, and messages with block tokens.
- Constraints: read-only, no model call, writes nothing, output never reaches the model (as `/context` today). Thresholds as settings only if the owner wants them; otherwise constants. Docs for `context`, root.
- Size: small.

### 3. Prompt-size budget test for this repository

- What: a unit test that fails when a shipped prompt file or tool description grows past a stated budget: `prompts/main-session.md`, `base-system-prompt.md`, the `run_agent` description with all shipped agents, the handoff template, the `style` section. A short script prints the current sizes.
- Modelled on: Claude Code's own trimming in its changelog (workflow tool description from 5.7K to about 1K tokens, `claude-api` skill from 200K+ to about 25K).
- Evidence: rank 5. Our 5.7 KB main-session prompt is paid on every main-session request; growth today is caught by nobody.
- Where: `test/`, next to `docs-sync.test.ts`. Under the docs-sync rule a root test changes no extension docs.
- Pi surface: none; reads files.
- Constraints: none touched. The owner picks the budgets.
- Size: smallest of all.

### 4. Spend notices and agent budgets

- What: a notice when the session total passes user-set amounts (for example at 5 and 20 dollars), shown once per threshold; for subscription sessions the same on tokens, since pi marks them `on subscription`. Optionally a per-call `budget` in tokens on `run_agent` that stops the agent the way the hard context limit does.
- Modelled on: `--max-budget-usd` and `--max-turns`, which Claude Code offers only in print mode; interactive Claude Code has no cap at all.
- Evidence: a guard, not a saving. It catches runaway cases such as the 9x-cost rewrite loop in the RTK benchmark and reported autocompact loops ([community-and-api](research/community-and-api.md) 1.1, 1.8).
- Where: `spending` for the session notices (it has the ledger and today has no settings, so this adds `pi-spending.json` under the agent dir plus a trusted project file); `subagents` for the agent budget.
- Pi surface: available today (`sessionUsage`, the `spending:usage` channel, session `subscription` flag).
- Constraints: amounts come from the user and are compared with pi's cost figures; no price table. Settings file under the agent dir. Docs for `spending`, `subagents`, root.
- Size: small for notices, medium for agent budgets.

### 5. Notice on return after a long idle

- What: on the first input after an idle gap longer than the cache lifetime, with context over a threshold, show the size of the uncached re-send and offer `/handoff` (a small seed instead of a full re-read) or continue.
- Modelled on: idle compaction and the resume warning on Pro, Max and Ultra ([context-and-session](research/context-and-session.md) 3, 4).
- Evidence: idle gaps past the TTL are the documented cost trap (rank 1); Claude Code built two features for it. No figure for how much they save.
- Where: `session-limits`, which owns the handoff switch and thresholds.
- Pi surface: `onInput` can hold the input and `onIdle` marks the start of the gap. The cache lifetime needs the same new Host method as candidate 1, or a setting. Pi's own `cacheWarming: idle` overlaps: if the user runs it, the cache stays warm and the notice should stay silent, which needs pi's `cache_warming_decision` exposed through another Host method.
- Constraints: no new files. Docs for `session-limits`, root.
- Size: medium. Owner decision required: the full idle-handoff design was dropped before (spec recoverable with `git show 6c0f9f5e^:future-plans/idle-handoff/`).

### 6. `/spending` breakdown with recommendations

- What: a command that splits the session's cost into main and agents by agent name, shows cache read and cache write as shares of cost, and lists recommendation rows only for behaviour at 10% or more of spend, each naming the command that fixes it (`/agents setup`, `/style concise`, `/handoff`).
- Modelled on: `/usage` attribution, recommendations and the fix key.
- Evidence: visibility only; no measurement that it lowers spend.
- Where: `spending` for the data and command; `subagents` must put the agent name on its usage reports (today `spending:usage` carries `source` and `id` only).
- Pi surface: totals are available. A per-model split needs a new Host method, and whether pi's per-message usage carries the model was not checked. Cross-session history would need a ledger file under the agent dir.
- Constraints: cost from pi; any history file under the agent dir. Docs for `spending`, `subagents`, root.
- Size: medium to large; build after 1 and 2 show what the rows should be.

### 7. Spill oversized main-session tool results to a file

- What: when a main-session tool result (mainly MCP and extension tools, since pi truncates built-ins) exceeds a size, save it to the session dir and give the model the path plus head and tail.
- Modelled on: Claude Code's spill to file for Bash over about 30K characters and MCP results over 25K tokens or 50K characters.
- Evidence: weak to moderate. Insurance against single huge results; the RTK benchmark says routine filtering does not pay.
- Where: a new plugin in `context` or a small extension.
- Pi surface: needs a new Host method around pi's `tool_result` event, which the adapter does not wrap today.
- Constraints: file in the session dir. Docs for the owning extension, the adapter, root.
- Size: medium. Build only if candidate 2's "one tool result is N% of messages" row fires often.

Already planned and supported by this evidence: the per-agent MCP filter `mcp: [server, "server:pattern"]` (delivery order item 3 in [future-plans/README.md](../README.md)). Deferred-definition figures (rank 3) back it.

## Not worth adopting

| Idea | Reason |
|---|---|
| Output-compression proxy or command-rewriting hook as a default | Independent benchmark found no reliable cost saving, one `find` rewrite loop that cost about 9x on a single attempt, and on DeepSeek (OpenCode) 18% more turns that cancelled a 7% drop in input per turn. Our shell chore already keeps logs in files. |
| A stronger terse-output style | About 8.5% of output tokens, and output is a small share of the bill. `/style concise` already exists; Anthropic's postmortem records a quality drop from a verbosity limit. |
| Code-index MCP servers (Serena, vector search) | No independent cost evidence; each adds tool schemas to every request. |
| Old tool-result clearing mid-session | Each clear invalidates the cache from that point; Claude Code does not document its own trigger; pi compaction and our handoff already bound context. |
| Per-turn model routing | Each switch rebuilds the cache at write price; routing at agent boundaries already exists (chores and leads). Routers also carry provider knowledge. |
| Contracted-rate or price tables (`modelPricing`) | Conflicts with the rule that cost comes from pi's figures only. |
| Cache TTL control, keep-alive pings | Provider-specific; pi has `PI_CACHE_RETENTION` and `cacheWarming`; a secondary test found keep-alive pings unreliable. |
| Fast mode, advisor tool, Batch API, ultrareview | Provider features, not savings (fast mode costs 2x), or not reachable through pi. |
| Agent teams | About 7x the tokens of a standard session in plan mode. |
| A model-driven `/doctor` | Costs tokens on every run; candidates 1 and 2 cover the static part. Reconsider only for edits that need judgement, such as trimming `AGENTS.md`. |
| A lower compaction window | session-limits already hands off at `min(window x ratio, token cap)`, 175K tokens by default. |

## Questions for the owner

1. Candidates 1 to 3 need no decision beyond go. Should they ship as one release or three?
2. Spend notices: warn only, or also stop? Which default amounts, if any, and should agent budgets be in tokens (works on subscription) or dollars?
3. Idle return notice: revive a light form of the dropped idle handoff, or leave idle cost to pi's `cacheWarming`?
4. Two new adapter Host methods recur: the model's cache lifetime (candidates 1 and 5) and a `tool_result` hook (candidate 7). Worth adding ahead of the candidates that need them?
5. A cross-session spend history means a new file under the agent dir. Wanted?
6. Prompt budgets in candidate 3: what numbers, and does the `run_agent` description count against the subagents budget?

## What could not be verified

Merged from the fact sheets, limited to what bears on a decision.

- Claude Code clears old tool results client-side (it counts them as expected rebuilds), but no page documents the trigger, threshold or setting ([context-and-session](research/context-and-session.md) 9).
- The current cache TTL per plan in practice. Docs give 1 h for the subscription main conversation; user reports from April 2026 describe a silent drop to 5 minutes, and an open issue says 2.1.218 stopped requesting 1 h ([community-and-api](research/community-and-api.md) 1.8).
- The output share of billed tokens (0.6 to 2.5%) and both JetBrains studies rest on secondary pages; the originals returned 403.
- The agent-team 7x figure is Anthropic's own (costs page, read by three sheets); the 2-4x subagent multiplier is secondary only.
- How many refills trip the autocompact thrashing guard: "a few" in the docs, "three times in a row" in a changelog line quoted in an issue.
- `--max-turns` is documented and still named in changelog entries up to 2.1.304, but absent from the 2.1.325 `--help` output, so it is probably a hidden flag; a `CLAUDE_CODE_MAX_TURNS` variable seen in the binary is in neither the changelog nor the help.
- Pi side, not checked here: whether pi's per-message usage names the model (candidate 6), and whether pi's cache lifetimes and `cache_warming_decision` are still as described in the dropped idle-handoff research.

## How the fact sheets were reconciled

- Idle compaction delay: docs say "about one hour idle", the changelog says about 54 minutes. Not a conflict: it runs shortly before the 1 h TTL ends; 54 minutes is the precise figure (changelog), "about an hour" the docs' rounding. Version: docs say 2.1.290+, changelog 2.1.299; minor.
- Default effort: Claude Code docs give `medium` on Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5, `xhigh` on Opus 4.7, `high` otherwise ([models-effort-billing](research/models-effort-billing.md) 3, [setup-diagnostics](research/setup-diagnostics.md)). The API effort page reports API defaults (high on most models, medium on Opus 5.5 and Haiku 5.5). This README takes the Claude Code figures for Claude Code.
- Built-in Explore model: Explore inherits the parent's model, capped at Opus (when the parent is Fable it runs on the `opus` alias except on cloud providers); it no longer runs on Haiku (changelog 2.1.198, sub-agents page). [models-effort-billing](research/models-effort-billing.md) had garbled this sentence and was corrected.
- Tool-search 10% threshold: current docs make "always defer" the default and the 10% threshold the `auto` mode ([tools-and-extensions](research/tools-and-extensions.md), [context-and-session](research/context-and-session.md) 7). The binary sheet's "auto at 10% since 2.1.7" default comes from an older changelog entry, so this README takes the docs reading. Not decision-relevant for pi, whose deferral is its own.
- Agent-team multiplier: three sheets read 7x (plan mode) on Anthropic's costs page; the agent-teams page says only "significantly more tokens", and the community sheet could not reach the page. Taken as documented.
- Output-style change and the cache: the live prompt-caching page lists a mid-session style switch under actions that keep the cache, because the new style arrives as a message (since 2.1.251; before that it applied only after `/clear`). The 2.1.73 changelog line, style fixed at session start, describes the older behaviour. [tools-and-extensions](research/tools-and-extensions.md) said it carried a cache cost and was corrected.
- Version off-by-ones between docs and changelog (`promptCacheTtl` and `modelPricing` 2.1.242 against 2.1.243) are left as recorded; nothing here depends on them.

## Research files

- [context-and-session.md](research/context-and-session.md): prompt caching, compaction, idle compaction, rewind, memory files and output caps.
- [models-effort-billing.md](research/models-effort-billing.md): model aliases and defaults, effort and thinking, fast mode, API prices, spend visibility and limits by billing mode.
- [tools-and-extensions.md](research/tools-and-extensions.md): MCP tool search and output limits, skills, subagents, hooks, plugins, output styles, tool removal.
- [setup-diagnostics.md](research/setup-diagnostics.md): `/usage`, `/context`, `/doctor`, `/skill-doctor`, status line fields, automatic warnings, official guidance.
- [binary-and-changelog.md](research/binary-and-changelog.md): flags, environment variables and settings keys in the 2.1.325 binary; changelog by theme.
- [community-and-api.md](research/community-and-api.md): community tools with independent measurements, known cost traps, Claude API features and their portability.
- [pi-extensions-baseline.md](research/pi-extensions-baseline.md): what this repository and pi already do per theme, and the AGENTS.md constraints.
