# Claude Code: setup diagnostics and tuning features

Fact sheet compiled 2026-11-16 from the live Claude Code docs (code.claude.com). Version numbers are the minimum Claude Code versions the docs state. Items marked "unverified" were not confirmed on a live docs page.

Base URLs: commands `https://code.claude.com/docs/en/commands.md`, costs `.../costs.md`, status line `.../statusline.md`, best practices `.../best-practices.md`, memory `.../memory.md`, skills `.../skills.md`, context window `.../context-window.md`, prompt caching `.../prompt-caching.md`, model config `.../model-config.md`, MCP `.../mcp.md`, settings reference `.../settings-reference.md`, errors `.../errors.md`, troubleshooting `.../troubleshooting.md`, debug config `.../debug-your-config.md`, analytics `.../analytics.md`, admin setup `.../admin-setup.md`.

## 1. Summary of the diagnostic surface

| Feature | Question it answers | Token cost itself | Applies changes? |
| :- | :- | :- | :- |
| `/context [all]` | What fills the window now? | None (local) (unverified: docs do not say; described as a visualisation) | No |
| `/usage` (aliases `/cost`, `/stats`) | What did the session cost, what counts against plan limits, which skills/subagents/plugins/MCP servers drive usage, what to change? | None; computed locally from session history | Yes, partly: `f` key |
| `/doctor` (alias `/checkup`) | Is the install, settings, extension set and CLAUDE.md healthy; where is context wasted? | Yes (bundled skill, a prompt Claude works through) | Yes, after confirmation |
| `/doctor prompt-audit [path]` | Are instruction files outdated, dangling or contradictory? | Yes (runs via the `/claude-api` skill) | Only on request |
| `claude doctor` (shell) | Is the install and the settings files valid? | None, no session | No (read-only) |
| `/skill-doctor` | What does each skill cost in listing context, how often is it used? | None stated | No |
| `/insights` | How do I work, where does friction occur? | Yes: tokens count against plan or API | No |
| `/fewer-permission-prompts` | Which read-only commands can be allowlisted? | Yes (bundled skill) | Yes: writes `.claude/settings.json` |
| Status line | Live context, cost, rate limit, cache numbers | None | No |
| `/memory`, `/mcp`, `/skills`, `/hooks`, `/permissions`, `/status` | Per-category inspection | None | Some toggles |
| Automatic warnings | See section 5 | Varies | No |

## 2. Commands, one by one

### /context
- What: "Visualize current context usage as a colored grid. Shows optimization suggestions for context-heavy tools, memory bloat, and capacity warnings." `/context all` expands the per-item breakdown; in fullscreen mode the per-item breakdown is collapsed by default. Source: commands.md.
- Inspects: system prompt, system tools, MCP tools, custom subagents (with the source each loaded from), memory files, skills (including bundled skills, which `/skills` does not list), and conversation messages. Source: debug-your-config.md.
- Warnings: when the conversation is past the window it prints at the top `Context exceeds the 200k-token limit by 94k tokens — run /compact or /clear to continue.`; for a compaction window below the model window: `Context is 94k tokens past the 200k-token compaction window — run /compact to reduce usage.` Source: errors.md#context-exceeds-the-token-limit.
- The Skills row reports the listing size after the budget is applied (since v2.1.196). Source: skills.md ("Skill descriptions are cut short").
- Use in troubleshooting: if autocompact thrashes, compare the `Messages` row with the rows above it. Largest `Messages` row means a file or tool output is refilling the window; otherwise startup content is too big. Source: troubleshooting.md.
- Token reduction role: first step before trimming CLAUDE.md, disabling MCP servers, or turning off skills.

### /usage (aliases /cost, /stats)
- What: session cost, plan usage limits, activity stats. Runs immediately even mid-response. Source: commands.md, costs.md.
- Session block: `Total cost`, `Total duration (API)`, `Total duration (wall)`, `Total code changes`, `Usage by model` (input, output, cache read, cache write per model). Cost is computed client-side at list price unless a managed `modelPricing` table is set (then labelled `at your organization's configured rates`). Resets on `/clear` (since v2.1.211). Source: costs.md.
- `Prompt cache (main)` line (v2.1.251+): request count, share of input tokens from cache, misses (with time since last, tokens re-cached), expected rebuilds after compaction or tool-result clearing, warm or cold with TTL, likely cause of last miss (v2.1.260+), e.g. `likely cause: tool definitions changed`. Main conversation only, not subagents. Example from docs: `14 requests · 91% of input tokens from cache · 2 misses (last 6m 10s ago, 310.2k tokens re-cached) · 1 expected rebuild ... · warm (1h TTL, last activity 40s ago)`. Source: costs.md#prompt-cache-statistics.
- Plan usage breakdown (Pro, Max, Ultra, Team, Enterprise): attribution of recent usage to skills, subagents, plugins and individual MCP servers as percentages (an MCP server counts only requests that consumed one of its tool results); `d`/`w` toggles 24 hours vs 7 days; computed from local session history on this machine only. Source: costs.md#plan-usage-breakdown.
- Recommendations: one per row, shown only when a behaviour accounts for at least 10% of recent usage, e.g. `25%  Trim ~/code/api/CLAUDE.md · 49k tokens per request`, `40%  Switch from max to high effort · /effort high`, `30%  Compact before you step away · run /compact`. The share says how much of your usage the row applies to, not how much the change saves; rows can sum above 100%. Docs name long context and cache misses as recommendation triggers. Source: costs.md, best-practices.md.
- Fix shortcut (v2.1.305+): footer hint like `f to fix 2 of 3`. Pressing `f` runs every `/effort ...` command shown in a row without `run`, then sends Claude one prompt with a step per other actionable row, asking it to show each change before making it. Rows ending in `run <command>` are not executed. Not offered while Remote Control is connected. Source: costs.md#apply-recommendations-with-the-fix-shortcut.
- Loops rows (v2.1.242+): heaviest `/loop` or session-scoped scheduled tasks, with fire frequency, run count, total and per-run tokens. Source: costs.md.
- Also: usage-credits row, last-known usage fallback for 60 minutes when the usage endpoint is rate limited (`r` retries). Source: costs.md.
- Cost: reads local history; no model call is described.

### /doctor (alias /checkup)
- What: bundled skill; "Run a setup checkup that diagnoses installation, settings, extension, and CLAUDE.md problems and proposes fixes that Claude applies after you confirm." Claude reports findings first and asks before changing anything. Source: commands.md, skills.md#check-your-setup-with-/doctor.
- Checks (skills.md):
  - Installation health: duplicate or leftover installs, PATH problems, unparseable settings files, newer version on your channel.
  - Extensions: unused skills, MCP servers and plugins compared with their context cost; slow hooks.
  - CLAUDE.md files: local files that duplicate checked-in ones; checked-in content Claude can derive from the codebase; always-loaded guidance, with an offer to migrate it into skills and nested CLAUDE.md files that load on demand. Memory docs add: cuts directory layouts, dependency lists and architecture overviews; keeps pitfalls, rationale and non-default conventions (memory.md#my-claude-md-is-too-large).
  - Permissions: offer to make auto mode the default; offer to pre-approve read-only commands you frequently deny.
  - Usage (Pro/Max/Ultra/Team/Enterprise, v2.1.305+): the changes `/usage` would recommend, measured over the last 7 days; Claude proposes the ones it can make itself and reports the rest as advice. Left out while Remote Control is connected.
  - Skill listing: "Run `/doctor` for an estimate of the listing's context cost and its biggest contributors" (skills.md; settings-reference `skillListingBudgetFraction`).
  - Duplicate subagent names in the same directory (debug-your-config.md).
- Hide it: env `DISABLE_DOCTOR_COMMAND` or `skillOverrides` `"doctor": "off"` (skills.md; the env var was not found on the settings reference page).
- Cost: it is a prompt handed to Claude, so it consumes tokens in the session.

### /doctor prompt-audit [path] (v2.1.283+)
- Audits CLAUDE.md, CLAUDE.local.md, AGENTS.md, plus rules, skills, commands, subagents and output styles under `.claude/` and `~/.claude/` (or one path you pass). Flags instructions written for older models, references to files or commands that do not exist, and files that contradict each other. Output: a findings report with proposed edits; nothing changes until you ask. Runs through the bundled `/claude-api` skill, so it is unavailable if that skill is off via `skillOverrides` or `disableBundledSkills`. Source: memory.md#audit-your-instruction-files, best-practices.md.

### claude doctor (shell)
- "Print read-only installation and settings diagnostics from the terminal without starting a session, including install health, settings-file validation errors, and Remote Control eligibility." Also shows the Search (ripgrep) line, `OK (bundled)` or the system path. Invalid hook `matcher` arrays are listed here. Footer text `Auto-update failed · Run claude doctor` points to it. Source: cli-reference.md, debug-your-config.md, troubleshooting.md.

### /skill-doctor (v2.1.252+, needs feature-flag fetching)
- Shows "what each of your skills costs in context and how often it gets used, so you can find skills to turn off". Interactive: opens the `/plugin` manager's Stats tab (same as `/plugin stats`). `-p` mode: prints text. Covers your skills, not bundled or enterprise ones. Flags skills in the listing never invoked, says where to turn them off, starts with highest context cost; also lists plugins not used recently. Over Remote Control it replies `Skill usage reports are not available on this connection.` No documented thresholds. Source: skills.md#find-unused-skills, commands.md. The per-skill 7-day tokens/uses detail comes from the embedded reference given to the researcher, not a live page (unverified live).

### /skills
- Lists skills with filter; `t` sorts by token count; `Space`/`Enter` cycles visibility; `Esc` saves to `.claude/settings.local.json` as `skillOverrides`. Values: `"on"` (name and description), `"name-only"`, `"user-invocable-only"`, `"off"`. Plugin skills, skills with `disable-model-invocation: true` and managed `skillOverrides` entries cannot be cycled. Source: commands.md, skills.md#override-skill-visibility-from-settings.
- Listing budget: 1% of context window by default (`skillListingBudgetFraction`, default `0.01`, or env `SLASH_COMMAND_TOOL_CHAR_BUDGET`); each entry's `description` + `when_to_use` capped at 1,536 characters (`skillListingMaxDescChars`). On overflow Claude Code drops descriptions of the least-used skills first and writes a debug-log warning (visible with `--debug`). Source: skills.md, settings-reference.md.

### /memory
- Lists CLAUDE.md, CLAUDE.local.md and other memory file locations across user and project scopes (including files that do not exist yet), toggles auto memory (`autoMemoryEnabled`), opens the auto memory folder. Shows an `AGENTS.md` that Claude read (v2.1.280+). Source: memory.md#view-and-edit-with-/memory.
- Auto memory: first 200 lines or 25KB of `MEMORY.md` load each session. After a write, Claude Code measures the file against both limits; near the limit it reminds Claude to shorten; over the limit the write succeeds but an error tells Claude to rewrite the index. Source: memory.md#auto-memory.

### /init
- Generates a starter CLAUDE.md from the codebase (build commands, test instructions, conventions); if one exists it suggests improvements instead of overwriting. With env `CLAUDE_CODE_NEW_INIT=1` it becomes an interactive multi-phase flow: asks which artifacts to set up (CLAUDE.md files, skills, hooks), explores the codebase with a subagent, asks follow-up questions, presents a reviewable proposal before writing, and offers a personal `CLAUDE.local.md`. Also offers `/import` for Codex or Gemini configuration if found. Best-practices says the work after `/init` "is mostly removing lines" and the memory guide recommends under 200 lines. Source: commands.md, memory.md, best-practices.md.

### /insights
- "Generate an HTML report analyzing your recent sessions on this machine: which projects you work in, how you use Claude Code, where things go wrong, and features to try." Up to 200 not-yet-seen sessions per run, short ones skipped; header shows `200 sessions (412 total)` when truncated. May include an estimate of how many permission prompts auto mode could have handled. Output at `~/.claude/usage-data/report.html` plus timestamped copies; deleted after `cleanupPeriodDays` (default 30). Runs through the same provider and account; tokens count against plan or API. Not available in cloud sessions. Source: costs.md#analyze-your-usage-patterns, commands.md.

### /fewer-permission-prompts
- Bundled skill: "Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project `.claude/settings.json`." Fewer prompts, not fewer tokens. Source: commands.md, best-practices.md.

### /statusline
- Configures the status line; describe what you want, or run with no arguments to "auto-configure from your shell prompt". `/statusline delete` removes it. Source: commands.md, statusline.md.

### Other inspection or tuning commands
| Command | Behaviour | Source |
| :- | :- | :- |
| `/mcp [reconnect\|enable\|disable ...]` | Server list with status and tool counts; flags servers that advertise tools but expose none; toggle per project (`disabledMcpServers` in `~/.claude.json`). `-p` prints a text summary. | commands.md, mcp.md |
| `/hooks` | View hook configuration by event; confirm a hook loaded. | commands.md, debug-your-config.md |
| `/agents` | Now only prints a reminder to ask Claude or edit `.claude/agents/`; interactive UI on v2.1.197 and earlier. | commands.md |
| `/permissions` (alias `/allowed-tools`) | Rules by scope, working directories, recent auto mode denials, Auto mode classifier rule tab. | commands.md |
| `/status` | Settings interface Status tab: version, model, account, connectivity, active setting sources incl. managed. Also where the oversize instruction-file warning repeats. | commands.md, memory.md |
| `/config [key=value]` | Settings UI or direct set; `/config --help` lists keys; works in `-p`. | commands.md |
| `/model`, `/effort [level\|auto\|status]`, `/fast` | Model, effort (`low` to `max`), fast mode. Effort docs: higher levels generate more thinking tokens, charged even when collapsed; `medium` is default on Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5. Changes can invalidate the cache; `/model` asks confirmation while cache is warm. | commands.md, model-config.md, prompt-caching.md |
| `/autocompact [auto\|<tokens>]` (v2.1.221+) | Sets auto-compact window 100K to 1M; saved per model under `modelSettings` (v2.1.288+); `autoCompactWindow`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` also. Default on native 1M models: about 967K. | commands.md, model-config.md |
| `/compact [focus]`, `/clear [name]`, `/rewind`, `/recap`, `/btw` | Context control. `/clear` "costs nothing"; `/compact` is itself a large request (more so on a cold cache). `/recap` does not break the cache. | best-practices.md, prompt-caching.md |
| `/sandbox` | Toggle sandbox mode (OS-level filesystem and network limits). Security, not tokens. | commands.md |
| `/simplify [target]` | Four parallel review agents (reuse, simplification, efficiency, abstraction level); applies fixes; not a bug hunt. Costs tokens (multiple agents). | commands.md |
| `/security-review` | Diff against origin default branch for security issues. | commands.md |
| `/code-review [level] [--fix]` (alias `/review`) | Correctness review at chosen effort; `ultra` runs in the cloud. | commands.md |
| `/debug [description]` | Turns on debug logging mid-session and has Claude read the log. Logs start only from that point. | commands.md |
| `/bug`, `/feedback` | Send report with consent step; `/feedback` can open a queue of Claude-drafted reports. | commands.md |
| `/terminal-setup` | Shift+Enter binding, Option+Enter in Apple Terminal, iTerm2 clipboard; in VS Code-family editors sets `terminal.integrated.gpuAcceleration` off for garbled text. Not token related. | commands.md, troubleshooting.md |
| `/keybindings` | Opens the keybindings file. | commands.md |
| `/release-notes` | Version picker for the changelog; shown in transcript without entering the conversation Claude sees. | commands.md |
| `/powerup` | "Discover Claude Code features through quick interactive lessons with animated demos." No further detail on a live page beyond the commands table. | commands.md |
| `/team-onboarding` | Builds a teammate onboarding guide from the past 30 days of the user's sessions, commands and MCP usage; share link on Team/Enterprise. | commands.md |
| `/update-config` | Bundled skill editing settings.json from a plain-language request. | commands.md |
| `/auto-mode-setup` | Drafts `autoMode.environment` entries from project and recent sessions, saves to user settings after review. | commands.md |
| `/heapdump` (hidden) | Heap snapshot and memory breakdown for high memory use; share only the `-diagnostics.json`. | commands.md, troubleshooting.md |
| `/usage-credits`, `/rate-limit-options` | Plan-limit handling (see section 5). | commands.md |
| `claude update` | Updates to latest version (cli-reference). `/restart` (v2.1.288+) applies an installed update. | cli-reference.md, commands.md |
| `claude --safe-mode` | Starts with CLAUDE.md, skills, plugins, hooks, MCP, commands, agents, output styles, workflows, themes, keybindings and similar all disabled; use to test whether an extension causes slowness or a bug. Managed hooks and policy still apply. | cli-reference.md, debug-your-config.md |
| `claude --bare` / `CLAUDE_CODE_SIMPLE=1` | Skips hooks, skills, plugins, MCP, auto memory, CLAUDE.md for scripted runs. | cli-reference.md, best-practices.md |
| `--max-turns`, `--max-budget-usd` | Print-mode caps on turns or estimated spend. | cli-reference.md |

### claude plugin eval and claude plugin eval init
No public docs page exists. The following is from the reference embedded in the researcher's own system prompt, not a live page: unverified against live docs. It runs each eval case (prompt plus graders) in a fresh isolated `claude -p` session with only the plugin loaded, several runs (default 3), scores it, and optionally runs a no-plugin baseline arm and reports the delta. Graders: `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`. Outputs: summary table, `results/<timestamp>/aggregate-result.json`, `report.html`; flags include `--max-cost-usd`, `--runs`, `--ablation with-without`, `--json`. It tests behaviour (and costs tokens to run), unlike `claude plugin validate`, which checks structure. Relevance for setup tuning: it can show whether a skill or plugin earns its context cost.

## 3. Status line

Source: https://code.claude.com/docs/en/statusline.md. A status line is a shell command configured under `statusLine` in settings (`type: "command"`, `command`, optional `padding`, `refreshInterval` in seconds (min 1), `hideVimModeIndicator`). It receives JSON on stdin, prints text (multi-line, ANSI colours, OSC 8 links), runs locally and "does not consume API tokens". It runs at session start and again after a new assistant message, `/compact`, permission mode change, vim mode toggle, command change, `refreshInterval`, a rate-limit `resets_at` passing, or a warm prompt cache `expires_at` passing; debounced 300 ms; an in-flight run is cancelled by a new trigger. `COLUMNS` and `LINES` are set for sizing.

Context, cost and limit fields (exact names):

| Field | Meaning |
| :- | :- |
| `context_window.used_percentage` | Pre-calculated percent used; input tokens only (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`), output excluded; may be `null` early |
| `context_window.remaining_percentage` | Pre-calculated percent remaining; may be `null` early |
| `context_window.context_window_size` | Maximum window in tokens (e.g. 200000) |
| `context_window.total_input_tokens` | Tokens currently in the window from the most recent API response (sum of input, cache creation, cache read) |
| `context_window.total_output_tokens` | Output tokens of the most recent response |
| `context_window.current_usage.input_tokens`, `.output_tokens`, `.cache_creation_input_tokens`, `.cache_read_input_tokens` | Last API call by category; `null` before first call and after `/compact` until next call |
| `exceeds_200k_tokens` | Whether the last response's input+cache+output exceeds 200k; fixed threshold regardless of window size |
| `cost.total_cost_usd` | Estimated session cost, list price unless `modelPricing`; resets on `/clear` |
| `cost.total_duration_ms`, `cost.total_api_duration_ms` | Wall-clock and API wait time |
| `cost.total_lines_added`, `cost.total_lines_removed` | Lines changed |
| `rate_limits.five_hour.used_percentage`, `.resets_at` | claude.ai Pro/Max/Ultra only; 0 to 100; epoch seconds; absent until first API response; each window may be absent |
| `rate_limits.seven_day.used_percentage`, `.resets_at` | Same for the 7-day window |
| `rate_limits.spend_limit.used_percentage`, `.resets_at`, `.used_usd`, `.limit_usd`, `.period` | Behind a Claude apps gateway with spend limits (v2.1.251+; dollar fields v2.1.284+, may lag about five minutes, `period` is `daily`, `weekly` or `monthly`) |
| `fast_mode` | Whether fast mode is on |
| `effort.level` | `low`, `medium`, `high`, `xhigh` or `max`; absent if the model has no effort parameter |
| `thinking.enabled` | Whether extended thinking is enabled |
| `model.id`, `model.display_name` | Model |
| `session_id`, `session_name`, `prompt_id`, `transcript_path`, `version`, `output_style.name`, `agent.name`, `vim.mode`, `workspace.*`, `worktree.*`, `pr.*` | Session and environment metadata |

Prompt cache object `prompt_cache` (v2.1.251+, appears after first main-conversation response, excludes subagents; works on every provider):

| Field | Meaning |
| :- | :- |
| `warm` | Cached prefix still within TTL |
| `caching_observed` | Any response this session reported cache tokens (false: caching off or provider does not report) |
| `ttl` | `"5m"` or `"1h"` |
| `expires_at` | Epoch seconds when it goes cold; `null` if no cache tokens last response |
| `requests` | Main-conversation API requests |
| `misses` | Requests that reprocessed cached content: more than 5% and at least 2,000 tokens of what could have been read, with no compaction or tool-result clearing to explain it |
| `expected_rebuilds` | Rebuilds after compaction or clearing |
| `hit_ratio` | Cache read tokens over all input tokens (0 to 1); `null` while counts are zero |
| `cache_write_tokens` | All tokens written to cache this session |
| `miss_recache_tokens` | Tokens written by requests counted as misses |
| `last_miss_at` | Epoch seconds of last miss, or `null` |
| `last_miss_cause` (v2.1.260+) | `{causes: [...], tools_added, tools_removed, system_char_delta}`; cause names include `tools_changed`, `system_prompt_changed`, `ttl_expired_5m`, `likely_server_side`; `null` if none or unidentified |
| `miss_causes` (v2.1.260+) | Counts per cause name |
| `recache_tokens_if_cold` | Tokens the next request would re-cache if the cache has gone cold; `null` right after compaction |

Caveats: if `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, `used_percentage` is still measured against the model's full window, so it does not indicate when compaction will run (model-config.md). Verbose mode adds a token counter to the notification area showing context size from the last response (statusline.md, "Notifications share the status line row"); notifications such as the context-low warning share the row. With a custom status line the footer hides most keyboard hints.

## 4. Spinner token counter
While Claude works, the spinner line can end with e.g. `(10m 27s · ↓ 5.5k tokens)`: live, approximate output tokens of the current turn only (text, tool calls, thinking, foreground subagent output); excludes prompt and history; resets each turn and on compaction. Source: costs.md#read-the-token-count-beside-the-spinner.

## 5. Automatic warnings and nudges

| Signal | Trigger and text | Action suggested | Source |
| :- | :- | :- | :- |
| Oversize instruction file | A CLAUDE.md, rules file or `@path` import over 200 lines: warning at startup and in `/status`; also a warning when files each within the limit add up past a combined limit at session start (limit value not stated). Files over 4 MiB are skipped. | Path-scoped rules, trim, `/doctor` | memory.md#my-claude-md-is-too-large |
| Subdirectory or on-demand file over per-file limit | Claude receives only the start plus a note to Read the rest (limit not captured here) | Shrink file | memory.md |
| MEMORY.md near or over 200 lines / 25KB | Reminder to Claude; error on over-limit write | Keep one line per entry, topic files | memory.md |
| Agent descriptions over 15.0k tokens | Startup notice `Agent descriptions are over the 15.0k-token limit (~16.2k tokens) · ask Claude to trim agent descriptions in .claude/agents/` (all agents still load) | Shorten descriptions, remove unused agents | errors.md#configuration-warnings |
| Skill listing over budget | Descriptions dropped for least-used skills; debug-log warning only | `/skill-doctor`, `/doctor`, `skillOverrides`, raise `skillListingBudgetFraction` | skills.md |
| Instruction file not loaded | Notice when a Read deny rule or read restriction blocks a memory file | Fix rule | errors.md |
| Unrecognized model ID | warning sign, then `Model "..." isn't recognized · context assumed to be 1m tokens` | `modelOverrides`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | model-config.md |
| MCP tool output | Warning when one MCP tool output exceeds 10,000 tokens; hard default cap 25,000 (`MAX_MCP_OUTPUT_TOKENS`); text results over 50,000 characters saved to a file | Raise cap or narrow queries | mcp.md |
| MCP tool definitions size | No dedicated warning found. Tool search (default on) defers definitions so only names and server instructions load; `ENABLE_TOOL_SEARCH=auto` loads upfront while definitions are under 10% of window, `auto:N` custom percent. Server instructions capped at 4,096 chars, deferred tool descriptions 16,384 (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`). `/context` is the place to see MCP cost. Costs.md says CLI tools are "more context-efficient than MCP servers" and to disable unused servers via `/mcp`. | | mcp.md#scale-with-mcp-tool-search, costs.md |
| Context low | "Transient notifications such as the context-low warning" appear in the notification area; exact text and threshold not found on a live page (unverified). | | statusline.md |
| Context at limit | `Context limit reached · /compact or /clear to continue` (names only `/clear` when `DISABLE_COMPACT`); with auto-compact off in user settings adds `· auto-compact is off · /config to turn it on`; `-p` shows `Prompt is too long` | `/compact`, `/clear` | errors.md#prompt-is-too-long |
| Autocompact thrashing | `Autocompact is thrashing: the context refilled to the limit...` after several refills; Claude Code stops retrying | Read files in chunks, `/compact` with focus, subagent, `/clear` | troubleshooting.md |
| Memory | Critical warning when heap passes 2.5GB | Restart and `claude --continue`; `/compact` outside fullscreen | troubleshooting.md |
| Cold cache and idle compaction | If the conversation is on the 1-hour TTL, over the threshold (default 200,000 tokens, unverified on live settings page) and idle about an hour, Claude Code compacts it before the cache expires; notice `Compacted while idle, before the prompt cache expired`. Disable with `idleCompaction: false` (v2.1.290+). Best-practices: after lunch you continue from a summary. | Fresh session if history not needed | settings-reference.md#idlecompaction, prompt-caching.md |
| Model or effort switch with warm cache | `/model` asks for confirmation only while cache is warm (since v2.1.238); changing effort on most models asks too; `PreModelSwitch` hook can require or skip confirmation | | prompt-caching.md |
| `/reload-plugins` that would force full re-read | Warns and skips unless `--force` | | commands.md, prompt-caching.md |
| Usage limits | `You've hit your session limit`, `weekly limit`, `Opus limit`, `Sonnet limit`; automatic wait-and-continue (v2.1.234+) shows `Usage limit reached · limit resets 3:45pm` and `Continuing automatically at 3:45pm · Esc to cancel`; stops after three continuations; `/rate-limit-options`, `/usage-credits`. No pre-limit "approaching" warning found in captured docs (unverified). Setting `autoContinueAtUsageLimit`. | | interactive-mode.md, errors.md, costs.md |
| Prompt suggestions | Skipped when cache is cold or account near limit; notice `Showing fewer prompt suggestions · use one to bring them back`; each suggestion is a background request (mostly cache reads); off via `promptSuggestionEnabled: false` or `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` | | interactive-mode.md |
| Session recap | One-line recap after 3+ minutes away, 3+ turns; capped at 400 characters; uses tokens in background; `awaySummaryEnabled`; `/recap` on demand | | interactive-mode.md, costs.md |
| Spinner tips | Rotating feature tips while working; `spinnerTipsEnabled` (default true, `/config` "Show tips"), `spinnerTipsOverride` (`tips`, `tipsFile`, `label`, `excludeDefault`; v2.1.247+). Tip content is generic feature advice, not analysis of your setup. | | settings-reference.md |
| "You should know" mod | Optional built-in mod (v2.1.287+, off by default, `/plugin enable cc-plugin-you-should-know@builtin`): a side agent rereads the conversation and shows a note above the prompt. It spends tokens: instructions of several thousand tokens billed in full per check. | | interactive-mode.md |
| `/model` startup | Bedrock and Vertex startup model check shows fallback notice | | model-config.md |

## 6. Official guidance that reduces waste

From best-practices.md and costs.md; reason as stated by the docs.

| Recommendation | Reason given |
| :- | :- |
| Keep CLAUDE.md short (under 200 lines); write only what Claude cannot find by reading the repo; test: "Could it find this by reading the code? Would it actually go and look? If both yes, leave it out." | "Every line in it takes a little of Claude's attention on every task"; longer files "consume more context and reduce adherence" |
| Do not describe architecture and file layout in CLAUDE.md | "Claude reads the repo itself" (best-practices, "What you can stop doing") |
| Scope rules with `.claude/rules/*.md` and `paths:` frontmatter; nested CLAUDE.md load on demand; `claudeMdExcludes` in monorepos | Load only when Claude works in matching files; `@path` imports "don't reduce its context cost" |
| Move workflow-specific instructions from CLAUDE.md into skills | Skills load on demand; the listing shows only name and description until invoked |
| Mark side-effect skills `disable-model-invocation: true` | Claude cannot start them itself |
| `/clear` between unrelated tasks (`/rename` first to find it later) | "Stale context wastes tokens on every subsequent message"; `/clear` "costs nothing" |
| `/compact` with a focus, at natural breaks, or "Compact instructions" section in CLAUDE.md | Compaction reads the whole conversation and is a large request, more so on an expired cache; choose when the overhead happens |
| After two failed corrections, `/clear` and rewrite the prompt | A third correction adds to a conversation containing two failed attempts |
| Use `/rewind` to abandon a path instead of compacting | Rewinding returns to a prefix that is already cached |
| Prefer CLI tools (`gh`, `aws`, `gcloud`, `sentry-cli`) to MCP servers | "Don't add any per-tool listing" |
| Disable unused MCP servers via `/mcp`; run `/context` to see what consumes space | Connected servers add tool names and instructions even when unused |
| Delegate verbose operations (tests, docs fetching, logs) to subagents; ask for short summaries | Output stays in the subagent's context; but "every subagent sends its own requests" and counts against usage, and delegating does not improve the answer |
| Set `model: haiku` for simple subagents; restrict `tools:` | "Haiku costs a lot less per request"; limit enforced by harness |
| Choose model and effort deliberately: Sonnet for most work, Opus for hard problems; lower effort with `/effort` or `/model`; `max` only for hard unattended problems | Thinking tokens bill as output tokens; `max` "is prone to overthinking" (model-config.md) |
| Pick model and effort at session start; avoid mid-task switches | Each model and (on most models) each effort level has its own cache |
| Use plan mode (Shift+Tab) for complex tasks; course-correct early with Esc; give verification targets; specific prompts | Avoid expensive rework; vague prompts "trigger broad scanning" |
| Offload preprocessing to hooks (example: PreToolUse rewriting test commands to `| tail -n 100`) | Cuts tens of thousands of tokens to hundreds |
| Install code intelligence plugins for typed languages | "Go to definition" replaces grep plus reading candidate files |
| Watch background consumers: `/loop`, goal check-ins, cross-session messages, subagents, agent teams (about 7x tokens in plan mode) | They keep sending full context while idle |
| Keep the cache warm: a break longer than the TTL (about one hour on subscription main conversation, five minutes on API key, cloud, or credits; subagents five minutes) causes a full-price re-read | Docs: first message after a long break "misses the cache and reprocesses your full context". Controls: `promptCacheTtl`, `subagentPromptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL` (v2.1.242+) |
| Move rules that cannot have exceptions to hooks or deny rules, keep enforced set small | "If you keep adding emphasis to a CLAUDE.md line... it belongs in a hook"; hooks "for preferences" should be deleted |
| For unattended runs set `--max-turns`, `--max-budget-usd` | Cap spend |
| `--bare` for scripted runs | Skips auto-discovery so runs start faster and behave the same everywhere |
| Stop doing: aggressive context management on 1M windows, IMPORTANT in caps, think hard phrases, "keep going" prompts | Models changed; effort controls reasoning; emphasis causes over-application |
| First look at `/usage` when a task costs more than expected | Breaks down by skill, subagent, plugin, MCP server and flags behaviours behind 10% or more of usage |

## 7. Team and admin tooling

- Managed settings (admin-setup.md): delivered by server-managed (claude.ai admin console or Claude apps gateway), plist or registry policy, `managed-settings.json` file, Windows user registry. Managed values beat user and project; arrays like `permissions.allow` merge. Cost and setup relevant keys: `modelPricing` (contracted rates for figures in `/usage`, status line and OTel; v2.1.242+), `availableModels`, `enforceAvailableModels`, `maxEffortLevel` (effort cap), `minimumVersion`, `requiredMinimumVersion`/`requiredMaximumVersion`, `allowedMcpServers`/`deniedMcpServers`/`managedMcpServers`, `strictPluginOnlyCustomization`, `strictKnownMarketplaces`, `syncClaudeAiSkills`, `promptSuggestionEnabled`, `autoContinueAtUsageLimit`, `promptCacheTtl` via `env`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Managed CLAUDE.md applies to all users and cannot be excluded. Verify with `/status` ("Setting sources").
- Analytics dashboard, Teams and Enterprise (claude.ai/analytics/claude-code; Admins and Owners): usage metrics (lines of code accepted, suggestion accept rate, daily active users, sessions); contribution metrics (public beta; needs GitHub app and Owner setup; PRs with CC, Lines of code with CC, PRs with Claude Code (%), PRs per user, pull request breakdown, leaderboard of top 10 with CSV export); attribution matches PR lines against session output from 21 days before to 2 days after merge, labels PRs `claude-code-assisted`, excludes lock files, generated code and build dirs; not available with Zero Data Retention or GitHub Enterprise Server. Spend report (per user and model, CSV) is in org analytics settings, not the dashboard. Enterprise Analytics API requires `read:analytics` key. Source: analytics.md, costs.md.
- Console (API) dashboard (platform.claude.com/claude-code): lines accepted, accept rate, active users, sessions, daily spend, per-member spend table (default 30 days); Claude Code Analytics API with an Admin key. Cloud-provider usage is not covered by these dashboards.
- Spend controls: seat allowance (rolling five-hour and weekly windows), usage credits with org, group and member limits; Console workspace limits; recommended TPM and RPM per user by team size (for example 1-5 users: 200k-300k TPM, 5-7 RPM; 500+ users: 10k-15k TPM, 0.25-0.35 RPM). Source: costs.md.
- Docs benchmark: average about $13 per developer per active day, $150-250 per developer per month, below $30 per active day for 90% of users. Source: costs.md.
- OpenTelemetry (name only): export of per-user token, cost, tool metrics and events incl. cache read and creation tokens (`https://code.claude.com/docs/en/monitoring-usage.md`).
- Claude apps gateway: per-user spend limits and usage attribution for Bedrock, Vertex, Foundry.
- `/team-onboarding` generates a ramp-up guide from a user's last 30 days of usage.

## 8. Observations relevant to a third-party agent

- The richest idea is `/usage` attribution plus recommendations: attribute spend to extension categories (skill, subagent, plugin, MCP server), show each as a share of recent usage, surface only rows at or above a threshold (10%), and label each row as auto-fixable or advisory. A single keypress then applies only the safe subset (effort changes) and hands the rest to the model with a show-before-change instruction.
- `/context` is a read-only breakdown by category with named suggestions; `/doctor` is a model-driven checkup that proposes edits and asks before changing; `claude doctor` is the non-model, read-only, no-session counterpart.
- Cheap startup warnings (CLAUDE.md over 200 lines, agent descriptions over 15k tokens, skill listing over budget) are static size checks, not model calls.
- The status line exposes pre-computed percentages plus raw token categories, cache hit ratio, miss cause and time to cache expiry, which allows idle and cold-cache hints without any model call.
- Cache-awareness is built into switching commands: confirm before an action that would discard a warm cache.

## 9. Could not verify

- Exact text and threshold of the transient "context-low" warning in the notification area (statusline.md mentions it exists).
- Combined size limit for instruction files, and per-file limit for on-demand files (memory.md names them without the number in captured text).
- Any pre-limit "approaching usage limit" warning (none found in captured text; errors.md was only read in part: 100K of about 638K characters via fetch, plus targeted greps).
- Whether `/context` consumes tokens (docs describe it only as a visualisation).
- `DISABLE_DOCTOR_COMMAND` on the settings reference (named in skills.md only).
- `/powerup` behaviour beyond its one-line description; `/sandbox`, `/fast` internals not read in depth (fast mode page not fetched).
- `claude plugin eval` and the `/skill-doctor` per-skill 7-day figures: from the embedded reference only, no public docs page.
- `/hooks` menu and `/simplify` and `/debug` internals beyond the command-table descriptions.
- Tool-search `ENABLE_TOOL_SEARCH` full value table beyond `auto` and `auto:N` (rows `true` and `false` seen only partly).
- Frequency or logic of spinner tips (documented as rotating generic tips).
