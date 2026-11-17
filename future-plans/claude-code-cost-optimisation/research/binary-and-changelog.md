# Claude Code token and cost knobs: binary and changelog ground truth

Date of research: 2026-11-16. Sources: the installed binary and its `--help` output, the public JSON schema for settings, and the public CHANGELOG.md on the main branch. Documentation pages were deliberately not used.

## Installed version and how it was inspected

- Version: 2.1.325 (Claude Code). `which claude` resolves to a symlink in the user's local bin directory; the target is `~/.local/share/claude/versions/2.1.325`, a 347 MB Mach-O arm64 native executable (a Bun-compiled JavaScript bundle, so the JS is readable as strings).
- Inspection: `claude --version`, `claude --help`, `--help` of `agents`, `doctor`, `update`, `mcp`, `plugin`, `auto-mode`, `gateway`, `import`, `install`, `purge`; `strings` over the binary (about 498k lines) followed by pattern extraction of environment variable names (1,427 candidates matching the requested prefixes) and targeted context reads for the ones that bear on cost. No model session was started and no tokens were spent.
- Settings key names come from the public schema at json.schemastore.org (142 top-level properties) cross-checked against strings in the bundle. Note that the schema is lagging the binary: several keys that the binary validates (`autoCompactWindow`, `promptCacheTtl`, `subagentPromptCacheTtl`, `idleCompaction`, `maxEffortLevel`, `modelSettings`, `modelPricing`, `thinking`, `toolSearch*`) are not in the schema's top-level properties.
- Changelog: 10,690 lines, 441 version headings, no dates. The "last 12 months" window was taken as 2.0.32 (about November 2025) through 2.1.325; the entries below are drawn from roughly 8,900 bullet points in that range, keyword-filtered then read.
- Confidence: "observed" means the string or help text was seen in the binary, schema or changelog with that meaning; "inferred" means only the name was seen.

## CLI flags

Flags that affect tokens, context, model, effort, budget, turns, tools, system prompt, caching or output (from `claude --help`, 2.1.325).

| Flag | Effect (as printed in help) | Cost relevance |
|---|---|---|
| `--model <model>` | Session model; alias (`fable`, `opus`, `sonnet`) or full name | Largest single cost lever |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, `max` | Reasoning spend; `max` and `xhigh` are costly |
| `--fallback-model <model[,model]>` | Comma-separated fallback chain on overload or unavailability; retries primary at the start of each user turn | Avoids hard failure; may drop 1M window to 200K |
| `--autocompact <auto\|tokens>` | Auto-compact window, `auto` or 100k to 1M tokens | Compaction trigger point (new flag, matches `/autocompact`) |
| `--max-budget-usd <amount>` | Dollar cap on API calls, `--print` only | Hard budget; since 2.1.325 counts mod `$.model.complete` calls too |
| `--system-prompt`, `--append-system-prompt` | Replace or extend the default system prompt (file variants exist in `--bare` text) | Prompt size and cache identity |
| `--system-prompt-snapshot <on\|off>` | Records the rendered system prompt once per conversation and re-sends it verbatim on every request and resume until compaction; default on (except `--bare` outside cloud and background sessions) | Protects the prompt cache across resumes and launches with changed text |
| `--exclude-dynamic-system-prompt-sections` | Moves cwd, env info, memory paths and git status from the system prompt into the first user message | Cross-user prompt-cache reuse |
| `--tools <list>` | Restrict built-in tool set; `""` none, `default` | Fewer tool schemas in the prompt |
| `--allowedTools`, `--disallowedTools` | Allow or deny lists | Permission, also removes tools |
| `--bare` | Skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, CLAUDE.md auto-discovery; sets `CLAUDE_CODE_SIMPLE=1`; API-key auth only | Smallest-footprint scripted mode |
| `--safe-mode` | Disables CLAUDE.md, skills, plugins, hooks, MCP, agents, output styles, workflows (sets `CLAUDE_CODE_SAFE_MODE=1`) | Troubleshooting baseline |
| `--restricted` | Removes command-running tools and WebFetch, ignores user/project/local settings | Security, also trims tool set |
| `--disable-slash-commands` | Disables all skills and commands | Removes skill listing from context |
| `--strict-mcp-config`, `--mcp-config` | Only load MCP servers from given config | Controls MCP tool-schema load |
| `--agents <json-or-file>`, `--agent <agent>` | Custom subagent definitions; main-thread agent | Per-agent model and effort |
| `--betas <betas...>` | Beta headers (API-key users only) | Feature gating |
| `--brief` | Enables SendUserMessage tool | Agent-to-user channel |
| `--json-schema <schema>` | Structured output validation (print only) | Output shape |
| `--output-format text\|json\|stream-json`, `--input-format`, `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages` | Print-mode I/O shaping | JSON result carries cost and usage |
| `--forward-subagent-text` | Forward subagent text and thinking into stream-json | Visibility into subagent spend |
| `--no-session-persistence` | Do not save session (print only) | No resume, no cache continuity |
| `--prompt-suggestions [bool]` | Predicted next prompt after each turn | Extra background requests |
| `-c`, `-r`, `--fork-session`, `--session-id`, `--from-pr` | Resume and fork | Resume can miss cache (see changelog) |
| `-w/--worktree`, `--tmux` | Worktree sessions | Not cost |
| `--bg/--background`, `attach`, `logs`, `stop`, `respawn`, `rm`, `agents` | Background sessions and agent view | Background agents run autonomously; `claude agents` accepts `--model`, `--effort`, `--permission-mode`, `--mcp-config`, `--restricted` for dispatched sessions |
| `--permission-mode`, `--permission-prompts host\|none` | Includes `auto` and `dontAsk` modes; `none` denies anything that would prompt | Auto mode adds classifier calls |
| `--cloud`, `--environment`, `--teleport`, `--remote-control` | Cloud and remote sessions | Different billing surface |
| `--plugin-dir`, `--plugin-url` | Session-only plugins | Plugin component token cost |
| `-d/--debug`, `--debug-file` | Debug logs | Used to see cache and compaction decisions |

Notably absent from this build: no `--max-turns` flag in the printed help, although the changelog still refers to it (2.1.205, 2.1.281, 2.1.285, 2.1.299, 2.1.304), so it exists as a hidden flag (turn limit is also available via env `CLAUDE_CODE_MAX_TURNS` (unverified: not in the changelog or help), agent frontmatter `maxTurns`), no `--thinking` or `--max-thinking-tokens` in help (but changelog 2.1.166 mentions `--thinking disabled`, so it is hidden), and no `--advisor` in help (schema mentions it).

Subcommands: `agents`, `attach`, `auth`, `auto-mode` (`config`, `critique`, `defaults`, `reset`), `doctor`, `gateway` (enterprise auth and telemetry gateway), `import` (from codex, gemini, cursor), `install`, `logs`, `mcp` (add, add-json, add-from-claude-desktop, get, list, login, logout, remove, reset-project-choices, serve), `plugin` (includes `details`, which "shows a plugin's component inventory and projected token cost", and `eval`, which runs plugin eval suites with a no-plugin baseline arm), `purge`, `respawn`, `rm`, `setup-token`, `stop`, `ultrareview` (cloud multi-agent review), `update`. `claude doctor` and `claude update` take no options. `claude plugin details` is the one CLI command whose stated purpose is token-cost projection and looks under-publicised.

## Environment variables

Only variables plausibly tied to tokens, context, compaction, caching, thinking, effort, model choice, output limits, tool search, background traffic, subagents, or cost telemetry. Defaults come from nearby strings or the changelog; where none was seen the cell says "not seen".

### Context, compaction, resume

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Percentage of window at which auto-compact fires; ignored by fork sessions per a nearby string | not seen | observed |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Auto-compact window size (accepts `200k`, `200000`); out-of-range values are clamped to min 100K or max 1M, unusable values ignored; subagent `autoCompactWindow` can only lower it | window tuned per model; Sonnet 5 about 967K of 1M | observed |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Tell Claude Code the real window of an unrecognised model (since 2.1.325 also applies to unknown `claude-` IDs) | unrecognised model assumed 1M (was 200K before 2.1.323) | observed |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Hold every 1M-native model to 200K via auto-compaction | off | observed |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | Stop forcing compaction within the assumed window of unrecognised models | off | observed |
| `DISABLE_AUTO_COMPACT` | Turn off auto-compact (manual `/compact` still works) | off | observed |
| `DISABLE_COMPACT` | Turn off all compaction including `/compact`; settings can only turn it off, not on (2.1.311) | off | observed |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | Minimum size for idle compaction | 200K tokens | observed (changelog 2.1.299) |
| `CLAUDE_CODE_SLEEP_COMPACT`, `CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS` | Idle-triggered compaction timing; terminal idle compaction runs after about 54 minutes | about 54 min | inferred from name plus changelog |
| `CLAUDE_CODE_COLD_COMPACT` | Compaction when cache is cold | not seen | inferred from name |
| `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` | Unclear; relates to pre-compact skip | not seen | inferred from name |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`, `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`, `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD`, `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` | Thresholds for the "resuming an inactive conversation will use a noticeable share of your 5-hour limit" warning | not seen | inferred (changelog 2.1.304) |
| `CLAUDE_CODE_RESUME_CACHE_WARM` | Resume cache warm-up | not seen | inferred from name |
| `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT` | Attach a token-usage note to the conversation | not seen | inferred from name |
| `CLAUDE_CODE_TOTAL_TOKENS_REMINDER` (+ `_AFTER_USER_TURN`, `_BUDGET`) | Reminder of total tokens used; string says "model with the total_tokens_reminder capability, else off; env var overrides" | off unless model capability | observed |
| `CLAUDE_AFTER_LAST_COMPACT` | Internal marker | not seen | inferred |

### Prompt caching

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `DISABLE_PROMPT_CACHING` and `_SONNET`, `_OPUS`, `_HAIKU`, `_FABLE`, `_MYTHOS` | Disable caching globally or per model family; a startup warning appears when set (2.1.108) | off | observed |
| `ENABLE_PROMPT_CACHING_1H` | Opt into 1-hour cache writes on API key, Bedrock, Vertex, Foundry (`_BEDROCK` variant deprecated) | off: 5 min on API key and cloud providers | observed |
| `FORCE_PROMPT_CACHING_5M` | Force 5-minute TTL | off | observed |
| `CLAUDE_CODE_PROMPT_CACHE_TTL` | `5m` or `1h` for main conversation; takes precedence over settings | automatic: 1 hour for subscription sessions within usage limits, 5 minutes for API key, Bedrock, Vertex, Foundry; 1-hour writes cost more | observed |
| `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | Same for subagents | automatic, 5 min unless `ENABLE_PROMPT_CACHING_1H=1` | observed |
| `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` | TTL for the messages portion | not seen | inferred from name |
| `CLAUDE_CODE_NORMALIZE_PREFIX_CACHE` (+ `_VERIFY`) | Normalise the request prefix for cache stability | not seen | inferred from name |
| `CLAUDE_CODE_SUBAGENT_CACHE_EVICT` | Evict subagent cache entries early; gated by a server flag | off | observed in code |
| `CLAUDE_CODE_SUBAGENT_PROMPT_SNAPSHOT` | Snapshot the system prompt for subagents | off | observed in code |
| `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` | WebFetch URL cache | 15 minutes | observed (changelog 2.1.233) |
| `CLAUDE_CODE_INCREMENTAL_REQUEST_BODY`, `CLAUDE_CODE_GZIP_REQUEST_BODIES` | Transport-level request body handling (network bytes, not tokens) | not seen | inferred |

### Thinking and effort

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `CLAUDE_CODE_EFFORT_LEVEL` | Session effort; clamped by `maxEffortLevel` | per-model default | observed |
| `CLAUDE_CODE_SUBAGENT_EFFORT` | Effort for subagents when nothing else names one (2.1.316) | inherit | observed |
| `CLAUDE_CODE_MAX_EFFORT_REMINDER` | Reminder shown when running at max effort | not seen | inferred |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | Send effort even where capability detection says no | off | inferred |
| `MAX_THINKING_TOKENS` | Thinking budget; `0` disables thinking, including on models that think by default via the first-party API (2.1.166); `xhigh`/`max` effort errors if thinking is off | not seen | observed |
| `CLAUDE_CODE_DISABLE_THINKING` | Disable thinking | off | observed |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Disable adaptive thinking | off | observed |
| `DISABLE_INTERLEAVED_THINKING` | Disable interleaved thinking | off | observed |
| `CLAUDE_CODE_DISABLE_ULTRATHINK` | Turn off the `ultrathink` keyword (2.1.316) | off | observed |
| `CLAUDE_CODE_THINKING_DISPLAY_UPDATES` | Thinking display | not seen | inferred |

### Model selection

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `ANTHROPIC_MODEL` | Runtime model override | not seen | observed |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` (+ `_NAME`, `_DESCRIPTION`, `_SUPPORTED_CAPABILITIES`) | Pin what each alias resolves to | latest per alias | observed |
| `ANTHROPIC_SMALL_FAST_MODEL` (+ `_AWS_REGION`) | Background/small model (legacy name) | Haiku | inferred |
| `CLAUDE_CODE_SUBAGENT_MODEL`, `_FORCE` | Default subagent model; since 2.1.251 agent-definition `model:` and per-spawn model take precedence unless forced | inherit | observed |
| `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` | Model for workflow agents | not seen | inferred |
| `CLAUDE_CODE_BG_CLASSIFIER_MODEL`, `CLAUDE_CODE_AUTO_MODE_MODEL` | Model for background classifier and auto-mode permission classifier | not seen | inferred |
| `CLAUDE_CODE_NO_MODEL_FALLBACK`, `CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK`, `FALLBACK_FOR_ALL_PRIMARY_MODELS` | Fallback behaviour | not seen | inferred |
| `CLAUDE_CODE_DISABLE_FAST_MODE`, `CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE`, `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` | Fast mode controls (the last is deprecated per changelog) | fast mode off unless enabled | observed |
| `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` | Stop remapping legacy model names | off | inferred |
| `CLAUDE_CODE_MODEL_CATALOG`, `_URL`, `CLAUDE_CODE_MODEL_CAPABILITIES` | Custom model catalogue and capabilities | not seen | inferred |

### Output and tool-result limits

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Per-request output cap; cannot raise the non-streaming cap | per-model default, bounded by model upper limit | observed |
| `MAX_MCP_OUTPUT_TOKENS` | Cap on MCP tool output tokens | not seen in bundle (long-standing documented default 25,000) | observed name, default from memory |
| `ENABLE_MCP_LARGE_OUTPUT_FILES` | Set false to truncate large MCP results instead of saving to file | on | observed |
| `MCP_TRUNCATION_PROMPT_OVERRIDE` | Override the truncation instruction text | not seen | inferred |
| `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | Cap on MCP tool descriptions and server instructions loaded up front | 4,096 characters (2,048 until 2.1.296); 16,384 for descriptions loaded via tool search | observed (changelog) |
| `BASH_MAX_OUTPUT_LENGTH` | Sizes the Bash read-back window; a second, unnamed-in-my-scan variable sets inline output | inline output default 30,000 chars, clamped 4,000 to 128,000; overflow saved to file with a preview | observed |
| `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` | Bash timeouts | not seen | inferred |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | Read tool token cap per read | not seen | observed |
| `CLAUDE_CODE_FILE_READ_MAX_PDF_PAGES_PER_MESSAGE`, `_PER_TURN` | PDF page caps | not seen | inferred |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Parallel tool calls | not seen | inferred |
| `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` (+ `_REFILLS_PER_HOUR`) | Web search budget; error text tells the model to ask the user to raise it | not seen | observed |
| `CLAUDE_CODE_MAX_TURNS` | Turn limit, must be a positive integer | none | observed |
| `CLAUDE_CODE_MAX_RETRIES` | API retry count | not seen | observed |

### Tool search, skills, MCP, memory

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `ENABLE_TOOL_SEARCH` | `true`, `false`, `auto` or `auto:N` (N = percent of window); invalid values are rejected. `true` also overrides a held-off state | auto at 10% of window since 2.1.7; on by default behind custom base URLs since 2.1.304; on for Vertex 4.5+ since 2.1.221 | observed |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `_CLAUDE_API_SKILL`, `_CLAUDE_CODE_SKILL`, `_POLICY_SKILLS` | Drop built-in skills from the listing | off | observed |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | Skill listing budget (schema text says `skillListingBudgetFraction` is "also configurable via the SLAS..." variable) | 1% of window | observed (truncated) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_ORG_MEMORY` | Turn off auto memory | on | observed |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | Drop built-in git workflow text from the system prompt | off | observed (schema) |
| `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` | Minimal mode and a shorter system prompt | off | observed |
| `MCP_TIMEOUT`, `MCP_CONNECT_TIMEOUT_MS`, `MCP_TOOL_TIMEOUT` | MCP timeouts | not seen | observed |
| `MCP_DISCOVERY_CACHE`, `_TTL_S`, `_MAX_STALE_S` | MCP discovery cache | not seen | inferred |
| `CLAUDE_CODE_ENABLE_REFRESH_MCP_TOOLS` | Refresh MCP tools mid-session (risks cache) | off | inferred |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Load claude.ai connectors | on when signed in | observed |

### Subagents, workflows, background

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `CLAUDE_CODE_FORK_SUBAGENT` | `0` turns fork subagents off; `1` forces subagents to background | fork on by default since 2.1.232/2.1.302 | observed |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | Concurrent subagent cap | 20 (2.1.217) | observed |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | Nesting depth; `1` disables nesting | 3 (2.1.219; was 1 in 2.1.217) | observed |
| `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` | Per-session spawn cap added 2.1.212 (200), the cap was removed in 2.1.224 but the name remains in the bundle | none now | observed |
| `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | Workflow concurrency, 1 to 256 | not seen | observed |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS`, `_TOKENS` | Thresholds for the large-workflow warning | not seen | observed |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_AUTO_BACKGROUND_TASKS`, `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` | Background task controls; background subagent shell commands move to background after 3 minutes (2.1.318) | 3 min | observed |
| `CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK`, `CLAUDE_CODE_SUBAGENT_HISTORY`, `CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT` | Subagent result and prompt handling | not seen | inferred |
| `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` | Same as flag `--forward-subagent-text` | off | observed |
| `CLAUDE_CODE_RETRY_WATCHDOG` (+ `_MAX_WAIT_MS`, `_MAX_USAGE_LIMIT_WAIT_MS`, `_USAGE_LIMIT_RECHECK_MS`) | Unattended persistent retry; fails fast on org spend limit | off | observed (changelog) |

### Background and non-essential traffic, telemetry, cost reporting

| Name | Meaning | Default if seen | Confidence |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Disables non-essential network calls (telemetry, updates, publishing, startup warm-up since 2.1.290, usage metrics). Strings confirm it suppresses telemetry and artifact publishing | off | observed |
| `DISABLE_TELEMETRY`, `DO_NOT_TRACK` | Telemetry opt-out; the traffic mode resolves to default, no-telemetry or essential-traffic | off | observed |
| `DISABLE_COST_WARNINGS` | Hide cost warnings | off | observed |
| `DISABLE_EXTRA_USAGE_COMMAND`, `DISABLE_DOCTOR_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, `DISABLE_BUG_COMMAND` | Hide commands | off | observed |
| `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*` | OpenTelemetry export; `cost.usage`, `token.usage`, `api_request` carry `effort`, `speed` and cache-write split (`cache_creation_5m_tokens`, `cache_creation_1h_tokens`) | off | observed |
| `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` | Detail in telemetry; content truncated at 60 KB by default | 60 KB | observed |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS` | Opt in to `x-claude-code-*` request headers for gateways (request class, agent type, compaction) | off | observed |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | Prompt suggestions (extra background requests) | not seen | observed |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | Skip history; skip the Haiku auto-title in headless | off | observed |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Strip experimental beta headers (also disables tool search on some paths) | off | observed |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | Override the hard blocking context limit | not seen | observed in code |
| `ANTHROPIC_BETAS`, `ANTHROPIC_CUSTOM_HEADERS`, `API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | API plumbing | not seen | observed |

The bundle also holds hundreds of names derived from unrelated internal codenames (for example `CLAUDE_CODE_PEWTER_OWL`, `CLAUDE_CODE_COZY_TEAPOT`); these look like feature-flag gates and carry no usable meaning.

## Settings keys

Top-level keys from the public schema (142) that bear on cost or context, with meaning from the schema text.

| Key | Meaning | Notes |
|---|---|---|
| `model`, `availableModels`, `enforceAvailableModels`, `modelOverrides` | Default model, allowlist, provider mapping | `enforceAvailableModels` since 2.1.175 |
| `fallbackModel` | Array, up to three fallbacks; also retries once on an unexpected non-retryable error (2.1.166) | |
| `effortLevel` | Persisted effort: low, medium, high, xhigh; `max` and `ultracode` session-only | Per-model since 2.1.251 |
| `alwaysThinkingEnabled`, `showThinkingSummaries` | Extended thinking default; thinking summaries are not generated by default in interactive sessions | Summaries are a cost-neutral display toggle but generating them is opt-in |
| `fastMode`, `fastModePerSessionOptIn` | Fast mode (higher per-token rate, needs extra usage); per-session opt-in "useful for controlling costs" | Fast mode default model is Opus 5 since 2.1.219 |
| `autoCompactEnabled` | Auto-compact on or off | Env equivalent `DISABLE_AUTO_COMPACT` |
| `autoCompactWindow` (binary only) | Window 100k to 1M or `auto`; per model via `modelSettings.<model>.autoCompactWindow`; also valid in agent frontmatter | `/autocompact` writes it |
| `maxEffortLevel` (binary) | Cap on effort across providers; lowest value wins across files and combines with an org cap | 2.1.267 |
| `promptCacheTtl`, `subagentPromptCacheTtl` (binary) | `5m` or `1h`; for API-key and cloud-provider users | 2.1.243 |
| `idleCompaction` (binary) | `false` disables idle compaction | 2.1.299 |
| `skillListingMaxDescChars` | Per-skill cap on description plus when_to_use in the listing | Default 1,536 (observed in string) |
| `skillListingBudgetFraction` | Fraction of the window (in characters) for the skill listing | Default 0.01; was 2% in 2.1.32 |
| `skillOverrides` | Per skill: `on`, `name-only`, `user-invocable-only`, `off` | Hides skills from the model to save context |
| `disableBundledSkills`, `disableSkillShellExecution`, `disableWorkflows` | Remove built-in skills and workflows | |
| `autoMemoryEnabled`, `autoMemoryDirectory`, `claudeMdExcludes`, `claudeMd` | Memory load controls; excludes are globs against absolute paths | `MEMORY.md` index truncates at 200 lines or 25 KB |
| `includeGitInstructions` | Drop built-in git/PR instructions from the system prompt | Env `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` |
| `respondToBashCommands` | When false, `!` command output enters context without a model response | 2.1.186; saves a turn |
| `showClearContextOnPlanAccept` | Offer "clear context" when approving a plan | Default false |
| `cleanupPeriodDays` | Retention for sessions, tasks, backups | Min 1 |
| `advisorModel` | Model for the server-side advisor tool | Extra spend by design |
| `teammateDefaultModel` | Default model for agent-team teammates | Removed from `/config` in 2.1.234 but the key remains |
| `agent` | Main-thread agent (its model and tool restrictions apply) | |
| `statusLine` | Command run for the status line | Stdin JSON fields below |
| `outputStyle` | Output style; fixed at session start since 2.1.73 for cache stability | |
| `workflowKeywordTriggerEnabled`, `workflowSizeGuideline` | `ultracode` keyword trigger and advisory workflow size (small, medium of fewer than 10 agents, large) | Pro default small |
| `permissions`, `autoMode`, `useAutoModeDuringPlan`, `disableAutoMode` | Auto mode classifier calls cost tokens | |
| `env` | Sets any environment variable above for every session | Primary home for the knobs in the tables |
| `modelPricing` (managed, binary) | Contracted rates used by `/cost`, status line and telemetry | 2.1.243 |
| `hooks`, `disableAllHooks`, `fileCheckpointingEnabled`, `spinnerTipsEnabled`, `awaySummaryEnabled` | Hooks run outside the model; away summary is a small background request | |
| `verbose`, `viewMode` | Display only | |

Status line stdin JSON fields seen in the changelog: `context_window.used_percentage` and `remaining_percentage` (2.1.6), `current_usage` (2.0.70), `effort.level` and `thinking.enabled` (2.1.119), repo and PR info (2.1.145), `prompt_cache` object with hit ratio, misses, tokens re-cached, warm or cold and a likely miss cause (2.1.251, 2.1.260), `rate_limits` with `spend_limit` for gateway users (2.1.251, 2.1.284), plus cost data.

## Changelog by theme

Entries are newest first within each theme. "Why it matters" is the cost implication. Items marked NEW flag features added in the last roughly 30 versions (2.1.296 to 2.1.325) or that look absent from commonly cited lists.

### Prompt cache

| Version | Change | Why it matters |
|---|---|---|
| 2.1.318 | Background subagents move a shell command to background after 3 minutes on all providers so the cache does not expire | Avoids uncached re-reads |
| 2.1.314 / 2.1.299 | NEW: idle compaction: a 200K+ conversation idle about 54 minutes is compacted before the one-hour cache expires; summary used on the next message if cache has expired; `idleCompaction: false` and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` control it; `/config` row (2.1.302); extended to telemetry-off and cloud providers once 1-hour cache is on | Cuts the cost of returning after a break |
| 2.1.311 / 2.1.260 / 2.1.251 | NEW: `/cost` and status line `prompt_cache` show hit ratio, misses, re-cached tokens, warm or cold, and the likely cause; `/usage` shows large cache misses under "What's contributing to your limits usage?" | Direct visibility into cache loss |
| 2.1.304 | Self-paced `/loop` wakeups at the 1-hour maximum no longer fire just after the 1-hour cache expires | Loop cost |
| 2.1.302, 2.1.281, 2.1.280, 2.1.277, 2.1.275, 2.1.269, 2.1.267, 2.1.261 | A run of fixes for cache misses on tool re-load via ToolSearch, MCP disconnect, resume, model switch, `/clear` with SessionStart output, memory-age note drift, output-limit resume, claude.ai connector tool change | Shows which events invalidate the prefix |
| 2.1.292 | NEW: `$.model.complete` for mods accepts `cache: true` on a block | Mod authors can cache |
| 2.1.275 | `--system-prompt` containing a `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` line caches the text above it globally | Custom system prompts can share a cache |
| 2.1.260 | Fable 5.1 caching now covers context attached after tool results; `/effort` mid-session no longer invalidates the cache on Fable 5.1 | |
| 2.1.257 | `/fork` keeps the original conversation's cache; advisor-model sessions stop re-sending history uncached on background requests | |
| 2.1.248 | NEW: `experimental.cacheTtl` (`5m` or `1h`) in agent frontmatter | Per-agent TTL |
| 2.1.243 | `promptCacheTtl` and `subagentPromptCacheTtl` settings | 1h main, 5m subagents |
| 2.1.169 | `/cd` moves a session without breaking the cache | |
| 2.1.129 | Fixed 1-hour TTL silently downgraded to 5 minutes | |
| 2.1.128 | Sub-agent progress summaries hit the cache (about 3x less cache creation) | |
| 2.1.108 | `ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`; startup warning if caching is disabled; telemetry-off subscribers no longer fall to 5 minutes | |
| 2.1.98 | `--exclude-dynamic-system-prompt-sections` | Cross-user cache |
| 2.1.92 | `/cost` per-model and cache-hit breakdown for subscribers; footer hint on returning to an expired-cache session showing uncached tokens the next turn will send | |
| 2.1.73 | `/output-style` deprecated; style fixed at session start for caching | |
| 2.1.72 | SDK `query()` cache invalidation fixed, "reducing input token costs up to 12x" | |
| 2.1.70 | Compaction keeps images in the summarizer request to reuse cache | Cheaper compaction |
| 2.1.42 | Date moved out of the system prompt | Hit rate |

### Context, compaction, context window

| Version | Change | Why it matters |
|---|---|---|
| 2.1.325 | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` also sets window for unrecognised `claude-` IDs | Gateway users |
| 2.1.323 | Unrecognised model ID now assumed 1M (was 200K); use `/autocompact` or `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | Silent cost and latency growth risk |
| 2.1.312 | Subagent `autoCompactWindow` can lower `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | |
| 2.1.311 | Compaction retries once when the reply has no summary; `DISABLE_COMPACT` in settings can only disable | |
| 2.1.304 | Compaction re-sends the skill list; `/reload-skills` sends only changes | Skill listing is re-paid after compaction |
| 2.1.301 | Switching to a smaller-window model summarizes first with the previous model | |
| 2.1.296 | NEW: `autoCompactWindow` in subagent frontmatter and `--agents` | Subagents compact earlier |
| 2.1.288 | `/autocompact` saves per model | |
| 2.1.287, 2.1.285 | Opus 4.7+ and Fable default to 1M on Bedrock, Vertex, Foundry, gateway and custom base URLs | Larger sessions by default |
| 2.1.260 / 2.1.247 | Auto-compact for 1M models fires shortly before the limit (about 967K for Sonnet 5) | Sessions can run very large; tune with `/autocompact` |
| 2.1.223 | `CLAUDE_CODE_DISABLE_1M_CONTEXT` holds any 1M-native model to 200K | |
| 2.1.198 | Subagents and compaction inherit the session's thinking configuration | |
| 2.1.169 | "CLAUDE.md is too long" warning scales with window | |
| 2.1.105 / 2.1.76 | PreCompact (can block) and PostCompact hooks | |
| 2.1.86 | Read tool uses compact line-number format and dedups unchanged re-reads | Token reduction |
| 2.1.51 | Tool results over 50K characters are persisted to disk (was 100K) | Context saving |
| 2.1.50 | `CLAUDE_CODE_DISABLE_1M_CONTEXT` added | |
| 2.1.32 | Skill budget scales with window (2% then) | |
| 2.0.64 | Auto-compacting made instant | |

### Effort and thinking

| Version | Change | Why it matters |
|---|---|---|
| 2.1.317 | Subagents on a different model use that model's saved effort | |
| 2.1.316 | NEW: `CLAUDE_CODE_SUBAGENT_EFFORT`; `CLAUDE_CODE_DISABLE_ULTRATHINK` | Cheap-subagent knob |
| 2.1.311 | `ultrathink` runs the turn at xhigh on current models | Keyword silently raises spend |
| 2.1.299 | `/usage` warnings for max effort, workflows, always-on context, large tool results | |
| 2.1.292 | NEW: Agent tool takes an `effort` parameter | Model-chosen effort per subagent |
| 2.1.284 | Ultracode is a separate toggle, stays on at any effort | Standing dynamic-workflow orchestration |
| 2.1.267 | `maxEffortLevel` cap, including on Bedrock, Vertex, Foundry | Admin cost ceiling |
| 2.1.251 | Per-model saved effort | |
| 2.1.247 | NEW: `/claude-api cost-optimize` profiles API spend across caching, token hygiene, batch, effort, model choice | |
| 2.1.166 | `MAX_THINKING_TOKENS=0` and `--thinking disabled` disable thinking on default-thinking models | |
| 2.1.154 | Opus 4.8 defaults to high effort; xhigh for hard tasks | |
| 2.1.133 / 2.1.120 / 2.1.119 | Effort exposed to hooks, `${CLAUDE_EFFORT}` in skills, status line `effort.level` | Effort-aware tooling |
| 2.1.117 | Default effort for Pro and Max on Opus 4.6 and Sonnet 4.6 raised to high (was medium) | Higher default spend |
| 2.1.111 | `xhigh` level added (Opus 4.7) | |
| 2.1.68 | Opus 4.6 default medium for Max and Team | |

### Model defaults and fast mode

| Version | Change | Why it matters |
|---|---|---|
| 2.1.322 | Fast mode on Vertex | |
| 2.1.321 | Claude Fable 5.2 default Fable: 1M, $8/$40 per Mtok, $0.20 cache reads | Price reference |
| 2.1.316 | Fast mode on Opus 4.8 deprecated Oct 30 2026, removed Nov 30 2026, no fallback to standard | Fails after removal |
| 2.1.295 | Gateway background requests use Haiku 4.5 | |
| 2.1.293 | Haiku 5.5 default Haiku: $0.10/$0.50 per Mtok ($0.50/$2.50 over 100K prompt) | |
| 2.1.284 | Sonnet 5.5 default Sonnet: $2/$10, $0.20 cache reads (2.1.296 lowers cost accounting to $0.10) | |
| 2.1.280 | Opus 5.5 default Opus: $4/$20; default model on Pro and Team Standard changed from Sonnet to Opus | Raises spend for those plans |
| 2.1.257 | Fable 5.1: $10/$50 | |
| 2.1.219 | Opus 5 default Opus; fast mode at $10/$50; Opus 4.7 removed from fast mode | |
| 2.1.198 | Built-in Explore agent inherits the session model (capped at opus) instead of Haiku | Exploration now costs more |
| 2.1.197 | Sonnet 5 default with 1M context | |
| 2.1.166 | `fallbackModel` setting, up to three | |
| 2.1.154 | Fast mode on Opus 4.8 at 2x the rate for 2.5x speed; lean system prompt default for newer models (not Haiku, Sonnet or Opus 4.7 and earlier) | Smaller prompt |
| 2.1.36 | Fast mode introduced for Opus 4.6 | |

### Tool search, MCP, skills and memory loading

| Version | Change | Why it matters |
|---|---|---|
| 2.1.304 | Tool search on by default behind custom `ANTHROPIC_BASE_URL`, retried without it on 400 or 422 | |
| 2.1.296 / 2.1.295 | Up-front MCP description cap 2,048 to 4,096 characters; via tool search 16,384 | Bigger prompts per server |
| 2.1.287 / 2.1.121 | `alwaysLoad` per MCP server; `alwaysLoad: false` defers all that server's tools | Per-server context control |
| 2.1.293 | NEW: mods can register tools with `isDeferred` | |
| 2.1.280 | `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | |
| 2.1.268 | Tool list kept byte-stable across a conversation on Bedrock, Vertex, Foundry | Cache |
| 2.1.84 | MCP descriptions and server instructions capped at 2 KB; global system-prompt caching works with ToolSearch | |
| 2.1.9 / 2.1.7 | `auto:N` threshold; MCP tool search auto on for everyone when tool descriptions exceed 10% of window | Biggest MCP context saver |
| 2.1.319 | `/context` table limited to the 10 largest rows per list; on-demand MCP tools share one row per server | |
| 2.1.287 | Large MCP results: less memory, no extra token-count upload | |
| 2.1.248 | Workflow tool description cut from 5.7k to about 1k tokens (reference moved to `workflow-authoring` skill) | Fixed per-turn cost |
| 2.1.234 | Built-in `claude-api` skill load cost from 200k+ to about 25k tokens | |
| 2.1.178 / 2.1.144 | Skill listing truncation warnings; full breakdown in `/doctor` | |
| 2.1.129 | `skillOverrides` works | |
| 2.1.111 | `/skills` sortable by estimated tokens | |
| 2.1.105 / 2.1.86 | Skill description cap 250 then raised to 1,536 characters with truncation warning | |
| 2.1.83 | `MEMORY.md` index truncates at 25 KB as well as 200 lines | |
| 2.1.81 | `--bare` flag | |
| 2.1.74, 2.1.59 | `autoMemoryDirectory`; auto-memory introduced | |
| 2.1.69 | `InstructionsLoaded` hook | Observability of CLAUDE.md and rules loading |
| 2.0.64 | `.claude/rules/` | |

### Subagents, forks, background agents, workflows

| Version | Change | Why it matters |
|---|---|---|
| 2.1.325 | Subagents cut off by output limit are asked again, more briefly | |
| 2.1.318 | `effort` option for mod `$.model.fork` | |
| 2.1.307, 2.1.302, 2.1.232 | Fork subagents (`subagent_type: "fork"`) inherit the full conversation and prompt cache, on by default everywhere; `CLAUDE_CODE_FORK_SUBAGENT=0` disables | Cache-sharing delegation; a fork carries all parent context |
| 2.1.302, 2.1.232, 2.1.198 | Subagents always run in the background by default | |
| 2.1.299 | Background agent notifications say when stopped by usage limit | |
| 2.1.281 | Background workflow row shows total tokens and large-workflow warning | |
| 2.1.271 / 2.1.219 / 2.1.202 | Dynamic workflow size guideline (default small on Pro, medium under 10 or 15 agents otherwise), advisory not a cap; workflows pause at usage limit and continue | |
| 2.1.269 | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | |
| 2.1.251 | `CLAUDE_CODE_SUBAGENT_MODEL` becomes a default, not an override | |
| 2.1.246 | Subagents stopped at `maxTurns` return partial output with a `SendMessage` hint | |
| 2.1.243 | `/usage` Loops breakdown (runs, tokens, tokens per run) | Finds runaway loops |
| 2.1.224 / 2.1.217 / 2.1.212 | Per-session spawn cap added then removed; concurrency cap 20; nesting depth default 3 | |
| 2.1.218 | Skills with `context: fork` run in the background by default | |
| 2.1.212 | `/fork` copies the conversation into a new background session; the old in-session behaviour is `/subtask` | |
| 2.1.143 / 2.1.142 | `claude agents` flags for dispatched sessions | |

### Usage limits, cost reporting, status line, /usage, /insights, /doctor

| Version | Change | Why it matters |
|---|---|---|
| 2.1.325 | `/cost`, `$.session.usage()`, `--max-budget-usd` and metrics count mod `$.model.complete` and `$.model.classify` | Budget cap now covers mods |
| 2.1.319 / 2.1.317 / 2.1.316 / 2.1.284 / 2.1.268 | Claude apps gateway: spend in `/usage` and status line, pooled group budgets, cost report API, `pricing:` pushed to clients | Enterprise cost control |
| 2.1.305 | NEW: `/usage` warnings become one-line fixes; `f` applies them; same fixes in `/doctor` and VS Code | |
| 2.1.304 | NEW: warning on Pro and Max when resuming an inactive conversation would use a noticeable share of the 5-hour limit | Cache-expiry cost surfaced |
| 2.1.301 / 2.1.305 | Retry watchdog limits for usage-limit waits | Unattended runs |
| 2.1.281 | `/insights` auto-mode recommendation | |
| 2.1.243 | `modelPricing` managed setting | |
| 2.1.239 | Cost estimates include the 1.1x premium for US-only inference | |
| 2.1.234 | Session continues automatically when a usage limit resets (setting in `/config`) | Can resume spend unattended |
| 2.1.205 | `/doctor` is a full checkup and can fix issues; `/checkup` alias | |
| 2.1.283 / 2.1.206 | NEW: `/doctor prompt-audit` audits CLAUDE.md, skills, agents and commands for outdated prompting; check proposes trimming derivable CLAUDE.md content | Context hygiene |
| 2.1.261 | `/context` falls back to a local token estimate instead of small-model requests | |
| 2.1.216 | `/context` warns when over the window | |
| 2.1.174 | `/usage` usage attribution: cache misses, long context, subagents, per skill, agent, plugin, MCP over 24h or 7d (VS Code first) | |
| 2.1.119 | Status line: `effort.level`, `thinking.enabled` | |
| 2.1.6, 2.0.70, 2.0.65 | Status line: `context_window` percentages, `current_usage` | |

## Candidates that look new or under-documented

- `--autocompact <auto|tokens>` flag, `/autocompact` per-model window, subagent `autoCompactWindow` frontmatter.
- `--system-prompt-snapshot` (on by default): the system prompt is frozen per conversation until compaction, so changing `--append-system-prompt` on resume has no effect.
- Idle compaction (about 54 minutes, 200K token minimum) and the resume-after-idle usage warning.
- `/cost` and status line `prompt_cache` object with a miss-cause string.
- `CLAUDE_CODE_SUBAGENT_EFFORT`, Agent-tool `effort` parameter, `experimental.cacheTtl` frontmatter, `promptCacheTtl` and `subagentPromptCacheTtl`.
- `claude plugin details` (projected token cost of a plugin) and `claude plugin eval`.
- `CLAUDE_CODE_GATEWAY_HINT_HEADERS` request headers (`x-claude-code-compaction`, `x-claude-code-context-compacted`).
- `/claude-api cost-optimize` and `/doctor prompt-audit`.
- Hidden or unlisted: `--thinking` flag, `--advisor`, `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`, `CLAUDE_CODE_MAX_EFFORT_REMINDER`, `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT`.

## Limits of this research

- Defaults for many variables are not printed in the bundle; "not seen" means unknown, not zero. `MAX_MCP_OUTPUT_TOKENS` had no adjacent default string; the 25,000 figure is from prior knowledge, not observed.
- The changelog has no dates, so "last 12 months" is approximate by version number.
- The settings schema on schemastore lags the binary, so keys marked "(binary)" were found only in the bundle and their exact top-level versus per-model placement may differ.
