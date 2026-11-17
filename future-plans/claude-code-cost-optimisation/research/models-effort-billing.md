# Claude Code: model choice, effort, spend visibility, spend limits, billing modes

Research date: 2026-11-16. Source: live Claude Code docs (code.claude.com/docs/en/...) and API pricing (platform.claude.com/docs/en/about-claude/pricing). Version numbers are the "requires vX" notes quoted by the docs. Pages fetched through a summarising fetcher (model-config, costs, cli-reference, monitoring-usage, subagents, headless, statusline) are paraphrased accurately where marked quoted; env-vars, settings-reference, commands, skills were read as raw text. Anything not confirmed on a live page is marked "unverified".

## 1. Official cost page: numbers and recommendations

Source: https://code.claude.com/docs/en/costs.md

- Quoted averages: about $13 per developer per active day and $150-250 per developer per month across enterprise deployments; below $30 per active day for 90% of users. The page tells teams to pilot first and measure.
- Cost figures are computed locally from token counts at list price, unless the managed-only setting `modelPricing` is set (contracted rates; `multiplier` below 1 for discount, above 1 for markup (v2.1.271+), plus per-model `overrides`; ignored in user/project/local settings and `--settings`; v2.1.242+). Figures are estimates, not an invoice.
- Recommendations the page lists, with mechanism:

| Recommendation | Mechanism | Knob |
|---|---|---|
| Clear between tasks | Stale context is re-sent (cache-read rate) on every request | `/clear`, `/rename` then `/resume` |
| Custom compaction instructions | Smaller, targeted summary | `/compact <focus>`; "Compact instructions" section in CLAUDE.md |
| Sonnet by default, Opus for hard work | Lower per-token price | `/model`, `/config`, `model` setting |
| Haiku for simple subagents | Lower per-token price for delegated work | `model: haiku` in subagent frontmatter |
| Deferred MCP tool definitions (default) and disabling unused servers | Only tool names enter context until a tool is used | `/mcp`, `/context`; `ENABLE_TOOL_SEARCH` |
| Prefer CLI tools (`gh`, `aws`, ...) over MCP | No per-tool listing in context | n/a |
| Code intelligence plugins | Go-to-definition replaces grep plus multi-file reads | plugins |
| Hooks that preprocess output | Example: PreToolUse hook rewriting test commands to `| tail -n 100`; "tens of thousands of tokens to hundreds" | `hooks.PreToolUse` |
| Move workflow instructions from CLAUDE.md into skills | Skills load on demand; keep CLAUDE.md under 200 lines | skills |
| Lower effort or disable thinking for simple tasks | Thinking tokens bill as output tokens; "default budget can be tens of thousands of tokens per request" | `/effort`, `/config`, `MAX_THINKING_TOKENS` (fixed-budget models only) |
| Delegate verbose operations to subagents | Verbose output stays in subagent context; only summary returns | subagents |
| Specific prompts, plan mode (Shift+Tab), Esc / `/rewind` early, verification targets | Avoid wasted exploration and rework | n/a |

- Agent teams: about 7x the tokens of a standard session when teammates run in plan mode; use Sonnet for teammates, keep teams small, shut down finished teammates. Disabled by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
- Background token usage (quoted list under "Background token usage" and "Why usage climbs in a long session"): session recap and idle compaction (`idleCompaction` setting; false disables; v2.1.290+); prompt suggestions (a short request on the session model after each response, mostly cache reads; skipped near usage limit; can be turned off); session-scoped scheduled tasks firing while idle; cross-session messages (`crossSessionInbound: "hold"`); goal check-ins (max three idle check-ins per goal; `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` disables); subagents and workflow agents; compaction itself (a large request); cache misses after a break longer than the cache TTL.
- `/usage` (alias `/cost`, `/stats`) on plans shows an attribution breakdown by skill, subagent, plugin and MCP server, and recommendations (any row at or above 10% of recent usage), e.g. "Trim CLAUDE.md", "Switch from max to high effort · /effort high". Pressing `f` applies `/effort` rows automatically (v2.1.305+). Loops rows need v2.1.242+. Data is local-history based, one machine only.
- `/insights`: HTML report of up to 200 recent sessions at `~/.claude/usage-data/report.html`; its own tokens count against plan or API usage.
- `DISABLE_COST_WARNINGS=1` turns cost warning messages off (https://code.claude.com/docs/en/env-vars.md).

## 2. Model selection

Sources: https://code.claude.com/docs/en/model-config.md, https://code.claude.com/docs/en/sub-agents.md, https://code.claude.com/docs/en/env-vars.md

- Aliases: `default`, `best` (same as `opus`), `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`. On the Anthropic API: opus = Opus 5.5, sonnet = Sonnet 5.5, haiku = Haiku 5.5, fable = Fable 5.2. On Bedrock and Google Agent Platform: Opus 5.5 / Sonnet 4.5 / Haiku 4.5. Foundry: Opus 4.6 / Sonnet 4.5 / Haiku 4.5. Claude Platform on AWS: Opus 5.5 / Sonnet 4.6 / Haiku 4.5.
- Default model: Opus 5.5 on Pro, Max, Ultra, Team, Enterprise, API, Claude Platform on AWS, Bedrock, Agent Platform; Sonnet 4.5 on Foundry. No Fable default anywhere. An admin's organization default overrides. (This matches the cost page's remark that "Opus left as the default model" is a common cause of high API spend.)
- Setting precedence: `/model` (saved; `s` in picker for session only), `--model`, `ANTHROPIC_MODEL`, `model` setting, `ANTHROPIC_DEFAULT_MODEL` (v2.1.236+).
- `opusplan`: Opus in plan mode, Sonnet for execution. `opusplan[1m]` (v2.1.265+). Cost caveat from prompt-caching page: each plan-mode toggle is a model switch and starts a fresh cache (https://code.claude.com/docs/en/prompt-caching.md).
- Alias-to-ID env vars: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_`, `_FABLE_`. The Haiku one is documented as "the model to use for `haiku`, or background functionality". `ANTHROPIC_SMALL_FAST_MODEL` is deprecated in favour of `ANTHROPIC_DEFAULT_HAIKU_MODEL`. The env-vars page confirms the small/fast model generates session titles (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` skips that request). Full list of what else the background model does: unverified.
- Subagent model order (first match): per-invocation `model` parameter from Claude; `model` in the subagent definition; `CLAUDE_CODE_SUBAGENT_MODEL`; the parent's model. `model` accepts `sonnet|opus|haiku|fable`, a full ID, or `inherit`. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) forces one model, ignoring definitions and per-call choice; `CLAUDE_CODE_SUBAGENT_MODEL` alone does not change Explore or Plan.
- Built-in agent models (sub-agents page): Explore = the parent's model; when the parent is Fable, Explore runs on the `opus` alias model for subscription/Console/gateway users (on Bedrock, Agent Platform, Foundry, AWS platform, apps gateway it stays on Fable); Plan and general-purpose inherit; statusline-setup = Sonnet; claude-code-guide = Haiku. To make Explore cheaper, define a user or project subagent named `Explore` with `model: haiku`. Note this contradicts older folklore that Explore runs on Haiku; the page above is current.
- Skills: `model:` and `effort:` frontmatter apply for the rest of the current turn, not saved; a `model` differing from the session model is a model switch and misses the cache for that turn (https://code.claude.com/docs/en/skills.md, prompt-caching page).
- `availableModels` (managed): list of families, version prefixes or IDs; `enforceAvailableModels` (v2.1.175+) applies it to Default; `deniedModels` and `availableModelsMatch: "exact"` (v2.1.283+). Subagents blocked by the list fall back to the newest permitted version in the family, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the parent.
- Fallback: `--fallback-model sonnet,haiku` or `fallbackModel` setting; chain capped at three; triggers on overload or unavailability, not on cost. Separate classifier-based fallback (Fable/Opus 5.5 to Opus 5 or 4.8) with `switchModelsOnFlag: false` to ask first.
- Advisor tool (experimental; https://code.claude.com/docs/en/advisor.md): main model plus a stronger server-side advisor consulted at decision points. Enable with `/advisor <model>`, `advisorModel` setting, or `--advisor`; off with `/advisor off` or `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`. Advisor must rank at or above the main model; example pairings: Sonnet main + Opus advisor, Haiku main + Opus advisor. Anthropic API, AWS platform and Google-managed only (not Bedrock, Agent Platform, Foundry); needs feature-flag fetch. Toggling it keeps the main cache; the advisor's own read of the transcript is uncached each call. Doc claim: cheaper than running the stronger model throughout (no figures given).
- Context: Fable, Sonnet 5+, Haiku 5.5, Opus 4.7+ have native 1M. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` caps at 200K. Auto-compact: `/autocompact`, `--autocompact`, `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K-1M); native-1M models compact at about 967K by default, so a smaller window is a cost lever. (Context topics belong to another agent; listed because they interact with price.)

## 3. Reasoning effort and thinking

Sources: https://code.claude.com/docs/en/model-config.md, https://code.claude.com/docs/en/settings-reference.md, https://code.claude.com/docs/en/env-vars.md

- Levels: `low`, `medium`, `high`, `xhigh`, `max` on Fable, Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5, Sonnet 5, Opus 4.8, Opus 4.7; Opus 4.6 and Sonnet 4.6 have no `xhigh`. Unsupported level falls back to the highest supported at or below.
- Defaults: `medium` for Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5; `xhigh` for Opus 4.7; `high` otherwise.
- Resolution order (first wins): `CLAUDE_CODE_EFFORT_LEVEL` env; level picked in session (`/effort`, `/model` slider); `--effort`; `modelSettings` per model or `effortLevel` setting; model default. `auto` or `unset` in the env var sends no effort level.
- Set via `/effort [level|auto|status|ultracode]`, `/model` slider (Enter saves, `s` session only), `--effort`, `effort:` in skill or subagent frontmatter (subagent per-call `effort` parameter v2.1.292+; the env var overrides both). `max` is session-only unless set by env.
- Cap: `maxEffortLevel` setting (v2.1.267+) (global or per model in `modelSettings`); lowest scope wins; deployable in managed settings; applies on every provider and to frontmatter and model defaults. This is the enforcement lever for an org.
- Cache effect: on most models changing effort mid-session invalidates the cache; with API key or subscription it stays intact on Fable 5.1+, Opus 5.5, Sonnet 5.5, Haiku 5.5; not on Bedrock, Agent Platform, apps gateway (https://code.claude.com/docs/en/prompt-caching.md).
- Ultrathink: include `ultrathink` in a prompt to raise that turn's reasoning without changing the session level; `CLAUDE_CODE_DISABLE_ULTRATHINK=1` disables (v2.1.316+). Ultracode: `/effort ultracode` or `--effort ultracode`, sets `xhigh` plus ultracode behaviour (v2.1.203+; off via `/effort ultracode off`, v2.1.284+). Ultracode's exact cost behaviour: unverified (links to workflows page, not read).
- Thinking: on by default; billed as output tokens. Cannot be turned off on Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable (adaptive; effort controls depth). Toggle `Option+T`/`Alt+T`; `alwaysThinkingEnabled: false`; `MAX_THINKING_TOKENS=0` disables where allowed. `MAX_THINKING_TOKENS=<n>` only works on fixed-budget models (Opus 4.6 and Sonnet 4.6 with `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`); capped at one below max output tokens, floor 1,024. Adaptive models ignore nonzero budgets.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` caps output per request (defaults vary by model; raising it shrinks effective context before auto-compact).
- Spend visibility: `claude_code.cost.usage`, `token.usage` and `api_request` carry an `effort` attribute, so effort-level cost can be broken down in telemetry.

## 4. Fast mode

Source: https://code.claude.com/docs/en/fast-mode.md

- Same model, up to 2.5x faster, higher price; not a cost saver. Supported: Fable 5.2, Opus 5.5, Opus 5, Opus 4.8 (Opus 4.8 fast mode deprecated 2026-10-30, removed 2026-11-30); not Sonnet or Haiku. Toggle `/fast`, `"fastMode": true`, `CLAUDE_CODE_DISABLE_FAST_MODE=1` to disable.
- Prices per MTok input/output: Fable 5.2 $16/$80 (standard $8/$40); Opus 5.5 $8/$40 (standard $4/$20); Opus 5 and 4.8 $10/$50 (standard $5/$25). Flat across the 1M window.
- On subscriptions it bills to usage credits only, not plan limits, and requires credits to be on. Team/Enterprise: Owner must enable it. Console: group by Speed in Usage/Cost pages. Not on Bedrock, Foundry, AWS platform; Google Agent Platform only Fable 5.2 with conditions.
- Cache: separate cache from standard speed; turning it on mid-conversation reads the whole context uncached at fast rates; enable at session start. `fastModePerSessionOptIn: true` (any scope, deployable managed) makes each session start with it off, recommended for orgs with concurrent sessions. Rate-limit fallback to standard speed and pricing, automatic.
- Fast mode is not available with the Batch API (pricing page).

## 5. API prices (per MTok) that drive the model advice

Source: https://platform.claude.com/docs/en/about-claude/pricing

| Model | Input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|---|
| Fable 5.2 | 8 | 10 | 16 | 0.20 | 40 |
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 |
| Opus 5 / 4.8 / 4.7 / 4.6 | 5 | 6.25 | 10 | 0.50 | 25 |
| Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 | 10 |
| Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 |
| Sonnet 4.6 / 4.5 | 3 | 3.75 | 6 | 0.30 | 15 |
| Haiku 5.5, prompt up to 100K | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
| Haiku 5.5, prompt over 100K | 0.50 | 0.625 | 1 | 0.05 | 2.50 |

- Cache read is 0.1x base input generally, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1/5.2. Opus 5.5 is therefore half the price of Opus 5 and 4.x per token. (Haiku 5.5 cache-read multiplier is 0.1x of base.)
- Batch API: 50% discount on input and output; asynchronous. Data residency (`inference_geo: "us"`): 1.1x on Claude 4.6+; Claude Code applies 1.1x to its session cost figure and `--max-budget-usd` accounting.
- Whether Claude Code exposes the Batch API: no evidence on any page read; treat as unverified (probably not exposed).
- The `/usage` quoted sample line shows `claude-sonnet-4-6`; the docs' examples lag the current default.

## 6. Spend visibility

| Surface | What it gives | Source |
|---|---|---|
| `/usage` (aliases `/cost`, `/stats`) | Session block: total cost, API and wall duration, lines changed, per-model tokens and cost; `Prompt cache (main)` line (v2.1.251+, likely cause v2.1.260+); plan bars; attribution and recommendations; usage-credits row. Resets on `/clear` (v2.1.211+) | https://code.claude.com/docs/en/costs.md |
| Status line JSON | `cost.total_cost_usd`, `cost.total_duration_ms`, `cost.total_api_duration_ms`, lines added/removed; `context_window.*` incl. `used_percentage` (input tokens only); `fast_mode`; `effort.level`; `thinking.enabled`; `rate_limits.five_hour` and `seven_day` (`used_percentage`, `resets_at`; subscribers only); `rate_limits.spend_limit.*` behind the apps gateway; `prompt_cache` object | https://code.claude.com/docs/en/statusline.md |
| Spinner | Live approximate output-token count for the current turn | costs.md |
| `claude -p --output-format json` | Result carries `total_cost_usd` and per-model breakdown; `--continue`/`--resume` report the conversation total; `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` reveal TTL used. Client-side estimate | https://code.claude.com/docs/en/headless.md, prompt-caching.md |
| Console | Cost and Usage pages (group by Speed), Claude Code dashboard, Claude Code Analytics API (Admin key) | costs.md |
| Teams/Enterprise | Spend report in org analytics (per user and model, CSV, daily; covers usage-credit spend only), analytics dashboard, Enterprise Analytics API (`read:analytics`) | costs.md |
| OpenTelemetry | see below | https://code.claude.com/docs/en/monitoring-usage.md |
| `/insights` | session-behaviour report | costs.md |

OpenTelemetry (enable `CLAUDE_CODE_ENABLE_TELEMETRY=1`; `OTEL_METRICS_EXPORTER=otlp|prometheus|console`; `OTEL_LOGS_EXPORTER=otlp|console`; temporality default `delta`):
- Metric `claude_code.cost.usage` (USD) and `claude_code.token.usage` (tokens, `type` = `input|output|cacheRead|cacheCreation`; `input` excludes cache tokens). Attributes: standard ones plus `model`, `query_source` (`main|subagent|auxiliary|plugin_model_complete|plugin_model_classify`), `speed` (`fast` only), `effort`, and, with `OTEL_LOG_TOOL_DETAILS=1`, real `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`.
- Event `claude_code.api_request`: `model`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cache_creation_5m_tokens` and `cache_creation_1h_tokens` (v2.1.300+), `request_id`, `speed`, `query_source`, `effort`, attribution attributes. Also `api_error`, `api_refusal`; optional bodies behind `OTEL_LOG_RAW_API_BODIES`.
- `query_source=auxiliary` separates background small-model calls from main and subagent spend. The page text beyond the first 100K characters (sample queries, further metrics such as session count) was not read.

## 7. Spend limits and enforcement

Sources: costs.md, cli-reference.md, settings-reference.md, fast-mode.md

| Mechanism | Detail |
|---|---|
| `--max-budget-usd <n>` | Print mode only; stops once client-side estimated spend reaches the amount; subagent spend counts; can overshoot, leave headroom; after cap, new subagents fail with `Budget limit reached` and background subagents are stopped (v2.1.217+); totals restored by `--continue`/`--resume` do not count toward it; includes 1.1x residency multiplier |
| `--max-turns <n>` | Print mode only; no default limit |
| `maxEffortLevel`, `availableModels`/`deniedModels`/`enforceAvailableModels`, `fastMode:false`, `fastModePerSessionOptIn`, `CLAUDE_CODE_DISABLE_FAST_MODE`, `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` | Managed-settings levers that cap cost drivers without dollar limits |
| Console workspace spend limits and workspace rate limits | Set per workspace; Claude Code gets an auto-created "Claude Code" workspace (no API keys); its traffic counts toward org rate limits unless a workspace rate limit is set |
| Rate-limit recommendations (per user, org-level limits) | 1-5 users: 200-300k TPM, 5-7 RPM; 5-20: 100-150k, 2.5-3.5; 20-50: 50-75k, 1.25-1.75; 50-100: 25-35k, 0.62-0.87; 100-500: 15-20k, 0.37-0.47; 500+: 10-15k, 0.25-0.35 |
| Subscription | Per-seat allowance on rolling five-hour and weekly windows shared with chat and Cowork; seat tiers Standard/Premium on Teams and Enterprise. Limit messages: session, weekly (all models), per-family Opus or Sonnet (switching family keeps working). Wait-and-continue after reset (v2.1.234+; `autoContinueAtUsageLimit` managed setting) |
| Usage credits ("extra usage") | `/usage-credits` (not with API key auth); Pro/Max/Ultra monthly spend limit; Teams/Enterprise spend limits at org, group, member level in Organization settings > Usage; messages for individual, org monthly, or team budget limits |
| Claude apps gateway (self-hosted, for Bedrock/Agent Platform/Foundry) | Per-user spend limits, daily/weekly/monthly, surfaced in status line `rate_limits.spend_limit` (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits.md, linked, not read) |
| Bedrock/Agent Platform/Foundry | Spend caps live in the cloud provider's budget tools; Anthropic dashboards and Analytics API do not cover this usage; use OTel, the apps gateway or an LLM gateway such as LiteLLM (spend by key) |

No built-in per-session dollar cap exists in interactive mode; `--max-budget-usd` and `--max-turns` are print mode only. Per-user dollar caps on API-key usage via Claude Code itself: not found (use workspace limits or gateway).

## 8. Billing-mode differences that change advice

| Topic | Subscription | API key / Console | Bedrock, Agent Platform, Foundry | Source |
|---|---|---|---|---|
| Cost shown in `/usage` | Not meaningful for billing; plan bars shown | Estimate at list price | Estimate at list price | costs.md |
| Default cache TTL, main conversation | 1 hour within plan usage; 5 min once on usage credits | 5 min | 5 min | https://code.claude.com/docs/en/prompt-caching.md |
| Subagents, workflows, teammates, forks, compaction, titles | 5 min (a few server-controlled helper requests 1 hour) | 5 min | 5 min | same |
| TTL controls | `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL`; `subagentPromptCacheTtl` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`; `ENABLE_PROMPT_CACHING_1H=1`; `FORCE_PROMPT_CACHING_5M=1` (overrides all); subagent frontmatter `experimental.cacheTtl` (v2.1.248+); values `5m` or `1h` only; v2.1.242+ | same | `ENABLE_PROMPT_CACHING_1H` intended for these; Bedrock 1h support varies by model | same, env-vars.md |
| 1h write price | 1.6x of 5m write (e.g. Sonnet 5.5 $4 vs $2.50) so 1h only pays on idle gaps over 5 min | | | pricing page |
| Cache-keep on effort change | yes on newer models | yes on newer models | no on Bedrock/Agent Platform | prompt-caching.md |
| Fast mode | usage credits only | per-token, Console enablement | Foundry/Bedrock no; Agent Platform Fable 5.2 only | fast-mode.md |
| Advisor tool | yes | yes | no on Bedrock/Agent Platform/Foundry | advisor.md |
| Fable usage | may bill to usage credits (one-time consent) | normal | n/a | model-config.md |
| 1M context | Opus 4.6 1M included on Max+; Sonnet 4.6 1M and Pro need credits | full | pin `[1m]` per variable | model-config.md |
| Aliases resolve to older models | no | no | yes (Sonnet 4.5, Haiku 4.5); pin IDs with `ANTHROPIC_DEFAULT_*_MODEL` or `modelOverrides` | model-config.md |
| `--bare` auth | not supported (needs `ANTHROPIC_API_KEY` or `apiKeyHelper`) | supported | provider creds still read | headless.md |
| Feature-flag-dependent features | need flag fetch; `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and third-party providers may lack them | | | env-vars.md |
| LLM gateway | caching depends on gateway forwarding `cache_control` and the `anthropic-beta` header; gateways that strip markers make every turn fully uncached | | | prompt-caching.md |

## 9. Non-interactive and CI levers

Sources: https://code.claude.com/docs/en/headless.md, cli-reference.md, env-vars.md

- `--bare` (equals `CLAUDE_CODE_SIMPLE=1`): skips auto-discovery of hooks, skills, commands, subagents, plugins, MCP servers, auto memory, CLAUDE.md; only Bash, file read, file edit tools; also no system reminders, no background tasks, shorter prompt. Needs `ANTHROPIC_API_KEY` or `apiKeyHelper`. Docs call it the recommended mode for scripted calls and say it "will become the default for `-p` in a future release". Load needed pieces with `--append-system-prompt(-file)`, `--settings`, `--mcp-config`, `--agents`, `--plugin-dir`. Token savings are implied (smaller prompt, no tool definitions from MCP) but the docs frame the benefit as startup time and reproducibility; no token figure given.
- `--tools "Bash,Edit,Read"` restricts built-in tools (`""` disables all); `--disallowedTools` bare names remove tools from context (`"mcp__*"`, `"*"`). Fewer tool definitions means a smaller prompt.
- `--system-prompt` / `--system-prompt-file` replace the default prompt; append flags keep it. Replacing drops default tool guidance and safety text and the git status snapshot. `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1` selects a shorter prompt with abbreviated tool descriptions (newer models use it by default). `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` line in a replacement prompt keeps the static part cached (v2.1.275+). `--exclude-dynamic-system-prompt-sections` moves per-user context into the first user message to raise cache reuse across machines (default prompt only).
- `--model`, `--effort`, `--fallback-model`, `--max-turns`, `--max-budget-usd`, `--no-session-persistence` (no disk), `--settings '{...}'` inline (e.g. `fastMode`).
- `--output-format json|stream-json` give cost; `--json-schema` gives `structured_output` (no extra cost note). `--append-subagent-system-prompt` (v2.1.205+) for subagent rules.
- `claude -p` accepts `/model`, `/effort`, `/fast`, `/advisor` with arguments in the prompt string.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` removes background commands and subagents; `claude -p` otherwise waits up to 10 minutes for background work (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
- `BASH_MAX_OUTPUT_LENGTH` (default 30000 chars, max 150000), `MAX_MCP_OUTPUT_TOKENS` (default 25000) cap tool output entering context.
- Batch/async: Claude Code docs expose none that I found; the Messages Batch API (50% off) is an API feature only. Background agent sessions (`claude --bg`, `claude agents`) exist but are not a discount path. Unverified whether any Claude Code flag uses the Batch API.

## 10. Items not confirmed or not read

- Exact list of background requests that use the small/fast model beyond session titles (docs say "background functionality").
- Ultracode cost behaviour (https://code.claude.com/docs/en/workflows.md not read); workflows cost section.
- `claude-apps-gateway-spend-limits.md`, `agent-sdk/cost-tracking.md`, `analytics.md`, Claude Code Analytics API fields, Console workspace limit mechanics: linked only, not read.
- Remaining OpenTelemetry page after the first 100K characters; model-config sections after its first 100K characters were read in a second pass (env vars, prompt caching, version history) but "adjust effort level" detail such as when a new effort level starts relies on the fetcher's summary.
- Any per-user dollar cap for API-key users within Claude Code itself.
- Whether any Batch API path exists in Claude Code.
