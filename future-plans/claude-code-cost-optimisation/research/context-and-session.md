# Claude Code: context window and session management for token savings

Researched 2026-11-16 against the live Claude Code docs (code.claude.com/docs/en) and the Claude API docs (platform.claude.com). Version numbers in the docs are quoted where given. "Unverified" marks claims not confirmed on a live page.

Base URLs: CC = https://code.claude.com/docs/en ; API = https://platform.claude.com/docs/en

## 1. Summary of the mechanisms

| Mechanism | Saves tokens by | Main knob |
| - | - | - |
| Prompt caching | Re-reads unchanged prefix at cached rate | `promptCacheTtl`, `DISABLE_PROMPT_CACHING*` |
| Auto-compaction | Replaces history with a summary near the window limit | `autoCompactWindow`, `/autocompact`, `DISABLE_AUTO_COMPACT` |
| Idle compaction | Compacts before the 1h cache expires, so the first turn back is cheap | `idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` |
| `/compact [focus]` | Manual summary, with focus text | `/compact`, "Compact instructions" in CLAUDE.md |
| `/rewind` Summarize from here / up to here | Partial compaction | `/rewind` menu |
| `/clear` | Empty context, previous session kept | `/clear [name]` |
| `/btw` | Side question that never enters history | `/btw <q>` |
| Lazy memory (nested CLAUDE.md, path-scoped rules, topic files) | Load only when relevant files are touched | `paths:` frontmatter |
| Output caps (Read, Bash, MCP) | Large results truncated or persisted to disk | env vars below |

## 2. Prompt caching as Claude Code uses it

Source: CC/prompt-caching.md (primary), API/build-with-claude/prompt-caching.

**What is cached.** Claude Code re-sends the full context every request and orders it so stable content comes first: system prompt plus tool definitions, then project context (CLAUDE.md, auto memory, unscoped rules), then conversation. The API matches on exact prefix; a change anywhere recomputes everything after it. There is no per-file caching. Plan mode, skill loading, output-style change, permission-mode change and `/recap` append to the conversation instead of editing the prefix, so they keep the cache.

**Cache scope.** Effectively per machine and directory: the system prompt embeds auto-memory paths and the conversation opens with working directory, platform, shell and OS. Parallel sessions in the same directory share prefixes; sequential sessions share only when the startup git-status snapshot matches. Subagents start their own prefix (no read of parent cache); a fork inherits the parent's prefix exactly and does read it. (CC/prompt-caching.md "Cache scope", "Subagents and the cache".)

**TTL: who gets which.** The API offers 5 min and 1 h. Per the API docs, writes cost 1.25x (5m) or 2x (1h) base input price; reads cost 0.1x, except 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1/5.2 (API/build-with-claude/prompt-caching). Claude Code picks per request, in two buckets:

| Request bucket | Claude subscription, within plan usage | Usage credits, API key, cloud provider |
| - | - | - |
| Main conversation (interactive, `-p`, SDK, inline helpers) | 1 hour | 5 minutes |
| Everything else (subagents, workflows, teammates, forks, compaction, session titles) | 5 minutes, except server-controlled helper requests which get 1 hour | 5 minutes |

When a subscription goes over plan usage and draws on usage credits, the main conversation drops to 5 minutes.

**TTL knobs** (values `5m` or `1h` only; need v2.1.242+):
- Settings: `promptCacheTtl` (main), `subagentPromptCacheTtl` (everything else).
- Env: `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H=1` (1h for both buckets), `FORCE_PROMPT_CACHING_5M=1` (forces 5m for both, overrides everything).
- Precedence: `FORCE_PROMPT_CACHING_5M` > bucket env var > bucket setting > subagent frontmatter `experimental.cacheTtl` (v2.1.248+; a `1h` is ignored while on usage credits) > `ENABLE_PROMPT_CACHING_1H` > default.
- To verify: `claude -p "hello" --output-format json`, read `usage.cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`.
- Through an LLM gateway the `anthropic-beta` header must be forwarded unchanged for 1h to work.

**Disable caching** (debug only): `DISABLE_PROMPT_CACHING=1` (all), `DISABLE_PROMPT_CACHING_HAIKU|SONNET|OPUS|FABLE=1`. The per-family variables apply only to the model the alias resolves to. Also `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` sends the mid-conversation system-context block uncached.

**Actions that invalidate the cache** (CC/prompt-caching.md): switching model (each model has its own cache; includes `opusplan` plan-mode toggles, automatic model fallback, and a skill/command frontmatter `model:`); changing effort level (on most models; kept on Fable 5.1+, Opus 5.5, Sonnet 5.5, Haiku 5.5 with API key or subscription since v2.1.260); toggling fast mode (separate cache per speed); adding/removing tool definitions in the prefix (MCP server connect or removal without tool search, denying an entire tool without tool search); compaction; accumulating images or PDFs past the request limits (oldest batch removed, causing a re-read from the earliest affected message); upgrading Claude Code (new system prompt).

**Actions that keep the cache:** editing repo files (a `<system-reminder>` is appended), editing CLAUDE.md mid-session (the edit also does not apply until `/clear`, `/compact` or restart), permission-mode changes, output-style change (v2.1.251+), skills and commands, `/recap`, `/rewind` (truncates back to an already-cached prefix), spawning a subagent. With MCP tool search (default on supported models) Claude Code freezes the tool list from the first request, so servers connecting later do not invalidate the cache. Plugin skills, commands, agents, hooks, monitors and themes append rather than invalidate; plugin MCP servers follow MCP rules. `/reload-plugins` warns before a full re-read and needs `--force` to apply it.

**Warnings and visibility.**
- `/model` asks for confirmation only while the cache is warm and the target is not the model that produced the last response (v2.1.238+: no prompt once the TTL has passed). A `PreModelSwitch` hook can require or skip it. Effort changes also ask while warm on models where they invalidate.
- `/reload-plugins` warns when the reload would trigger a full re-read.
- `/usage` Session block gets a `Prompt cache (main)` line after the first response (v2.1.251+): request count, percent of input tokens from cache, miss count with last-miss age and tokens re-cached, "expected rebuilds" (compaction or tool-result clearing), and warm/cold with TTL. v2.1.260+ adds "likely cause" text, e.g. `likely cause: tool definitions changed`. Source: CC/costs.md "Prompt cache statistics".
- Status line scripts can read the `prompt_cache` object and `current_usage.cache_creation_input_tokens` / `cache_read_input_tokens` (CC/statusline.md, referenced from prompt-caching.md; not opened directly).
- I found no idle "cache about to expire" warning. The nearest feature is idle compaction (section 3).

**API-side facts useful for a pi extension** (API/build-with-claude/prompt-caching): max 4 explicit breakpoints; automatic caching via a top-level `cache_control` field (not supported on Bedrock `bedrock-runtime`); lookback of 20 positions per breakpoint; minimum cacheable prefix 512 tokens on current models (1,024 to 4,096 on older ones, e.g. 4,096 on Opus 4.6/4.5 and Haiku 4.5); invalidation order tools then system then messages; image add/remove, tool choice, and speed change invalidate upstream levels.

## 3. Compaction and lighter mechanisms

**Auto-compaction.** Source: CC/model-config.md "Context window and auto-compaction"; CC/settings-reference.md.
- Default threshold: no user window set means compaction near the model limit. Native-1M models (Fable, Sonnet 5+, Haiku 5.5, Opus 4.7+) compact at about 967K tokens. Sonnet 4.6 and Opus 4.6 without `[1m]` compact at 200K. With `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, native-1M models compact at 200K.
- Set the window (100K to 1M tokens, capped at the model window): `/autocompact 500k` (saves per model under `modelSettings.<model>.autoCompactWindow`, v2.1.221+, per-model since v2.1.288; `/autocompact auto` resets); `autoCompactWindow` in any settings file; `--autocompact` CLI flag (one launch); `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var (wins over the others; `200k`/`1M` suffixes v2.1.304+; bare `200` means 200 tokens in the env var but 200,000 in `/autocompact`); subagent frontmatter `autoCompactWindow` (v2.1.296+).
- Turn off: `autoCompactEnabled: false` (shown as Auto-compact in `/config`), `DISABLE_AUTO_COMPACT=1` (also disables idle compaction; manual `/compact` remains), `DISABLE_COMPACT=1` (all compaction including `/compact`).
- Other: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1-100, percentage of the window; can only lower the trigger, values above default ignored; default not stated in the page I read). Gateways: `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`.
- Thrashing guard: if a file or tool output refills context immediately several times in a row, auto-compaction stops with `Autocompact is thrashing: the context refilled to the limit...` (CC/troubleshooting.md, CC/how-claude-code-works.md). The number of attempts is "a few"; exact count unverified.

**What survives compaction** (CC/context-window.md): system prompt, output style, project-root CLAUDE.md and unscoped rules (re-injected from disk), auto memory, skill descriptions (v2.1.304+), fresh git status, plan-mode plan. Path-scoped rules and nested CLAUDE.md are not re-injected; they reload on demand, so a rule that must persist should lose its `paths:` frontmatter. After compaction Claude Code re-reads up to 5 recently modified files (a file over 5,000 tokens comes back as a path reference). Invoked skill bodies are re-injected, capped at 5,000 tokens per skill and 25,000 total, oldest dropped first, truncation keeps the file start. SessionStart hooks with the `compact` matcher run again.

**Cost of compaction itself.** The summary is a separate request carrying the system prompt, tools and full history plus a summarize instruction. While the cache is warm it reads the prefix from cache and is cheap; after the TTL has lapsed the whole history is reprocessed uncached, so `/compact` costs most when resuming an old session. The turn after compaction rebuilds the cache for only the short history. (CC/prompt-caching.md "Compacting the conversation".)

**Custom compaction instructions.** `/compact focus on the auth bug fix`; or a section titled "Compact instructions" in the project CLAUDE.md, e.g. "When you are using compact, please focus on test output and code changes" (CC/costs.md, CC/how-claude-code-works.md). The docs show only that example; whether the heading is matched literally is unverified.

**Idle compaction.** Compacts a long, idle conversation shortly before the 1h cache expires so the next message sends a summary. On by default when all hold: interactive terminal, VS Code panel or desktop Code tab; `autoCompactEnabled` on; conversation on the 1h TTL; context at least 200,000 tokens; about one hour idle with the computer awake. Notice text: `Compacted while idle, before the prompt cache expired`. Knobs: `idleCompaction` (v2.1.290+; `/config` row v2.1.302+), `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (default 200000, floor 100000). Where Claude Code cannot fetch feature flags (before v2.1.314) it does not run. Source: CC/settings-reference.md `idleCompaction`; CC/prompt-caching.md.

**Tool-result clearing in Claude Code.** The costs page and the `Prompt cache (main)` line mention an "expected rebuild (compaction or tool-result clearing)" and "clearing old tool results from context", so the client does clear old tool results. I found no Claude Code doc page describing its trigger, thresholds, or any setting or env var for it, and no mention of the word "microcompact". Treat the mechanism and tuning as unverified. The underlying API feature is documented (below).

**API context editing** (API/build-with-claude/context-editing; beta header `context-management-2025-06-27`): strategy `clear_tool_uses_20250919` clears oldest tool results first once context passes `trigger` (default 100,000 `input_tokens`), keeps the last 3 tool uses by default (`keep`), optional `clear_at_least`, `exclude_tools`, `clear_tool_inputs` (default false); `clear_thinking_20251015` with `keep: {type: thinking_turns, value: N}`. Clearing invalidates the cached prefix, so `clear_at_least` exists to ensure each clear is worth the cache write. Responses carry `context_management.applied_edits`; `count_tokens` accepts the same config. Whether Claude Code uses these exact parameters is unverified. The API docs also point to server-side compaction as the primary strategy (page not read).

**Rewind and partial compaction** (CC/checkpointing.md). `/rewind` (aliases `/checkpoint`, `/undo`; or Esc Esc on an empty prompt) lists prompts. Actions: restore code and conversation; restore conversation; restore code; **Summarize from here** (compress from the selected message forward); **Summarize up to here** (compress earlier messages, keep later ones); never mind. Typing text on the Summarize row guides the summary (number key skips guidance). Summarize does not touch files and the originals stay in the transcript. Checkpoints: one per prompt that starts a turn, snapshots kept for the 100 most recent, retained per `cleanupPeriodDays` (default 30 days). Not tracked: Bash-only changes to files Claude never edited, most subagent edits, external edits, symlinks and hard links. Cache effect: plain rewind truncates to an already-cached prefix and is cache-safe (CC/prompt-caching.md); the cache effect of Summarize is not stated and is unverified (it should behave as compaction).

**/clear.** `/clear [name]` (aliases `/reset`, `/new`) starts an empty conversation, saves the old one for `/resume`, and resets `/usage` session totals (v2.1.211+). The costs page states `/clear` costs nothing. Previous session is also reachable from the rewind menu in the same process.

**/context.** `/context [all]` shows a coloured grid of usage with suggestions for context-heavy tools, memory bloat and capacity warnings; in fullscreen mode the per-item breakdown is collapsed unless `all` is passed. It lists which CLAUDE.md and auto-memory files loaded (CC/context-window.md, CC/commands.md). The exact category names ("Messages" row and others) are only partly visible in the troubleshooting page; a full category list is unverified.

**/btw side questions** (CC/interactive-mode.md "Side questions with /btw"). Answered from the existing conversation with no tools; question and answer never enter history; runs while Claude is working; single response; replays the newest 20 earlier side-question exchanges with each ask until cleared; "while the prompt cache is warm, a side question costs little beyond the answer". Press `f` to fork into a background subagent with tools. `/btw` inside an open subagent transcript answers from that transcript (v2.1.314+).

**Handoff-like features.**
- `/recap`: one-line summary (max 400 characters) generated on demand; also automatic after 3 minutes away on an unfocused terminal with at least 3 turns; appended as output, cache-safe; off via `/config` "Session recap" or the `awaySummaryEnabled` setting (known from the settings index line only). Background recap and idle compaction can spend tokens while idle (CC/costs.md "Background token usage").
- `/branch [name]` / `claude --continue --fork-session`: copy of the conversation, new session ID, original kept. `/fork [prompt]`: copies the conversation into a background session; the copy gets an isolation instruction appended at the end so the original cache stays intact. `/subtask`: hand a side task to a subagent that reports back (named in commands page; not read in detail).
- `/export`: copies or saves a plain-text transcript.
- `claude -p --resume <id> "summarize what we changed"` for scripted summaries. No dedicated "handoff document" command found.

## 4. Sessions: resume and continue

Source: CC/sessions.md.
- `claude --continue` (latest in directory), `claude --resume [name|id|path]`, `/resume`, `--from-pr <n>`, `-n/--name`, `/rename`. `-p`, SDK and `/loop` sessions are hidden from the picker and from `--continue` (except `claude -p --continue`).
- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`; `cleanupPeriodDays` (default 30) retention; `CLAUDE_CODE_SKIP_PROMPT_HISTORY` suppresses writes; `--no-session-persistence` for one `-p` run; `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` bounds `-p`/SDK transcript growth.
- A compacted session resumes from the last summary plus messages after it; messages the summary covered are not loaded again.
- Resume cost: Claude Code resends the whole conversation; unchanged prefix reads from cache only within the TTL. After a long break or a model change, a "Resume this conversation?" dialog on Pro/Max/Ultra shows the share of the 5-hour limit the saved conversation alone would use, with Resume or Start new. A resumed session keeps its original system prompt (so cache still matches) until it is compacted, when it switches to the current prompt and rebuilds that layer once. `--append-system-prompt` differences or upgrades change the prompt (CC/prompt-caching.md "Resuming a session").
- Not restored on resume, must be passed again: `--mcp-config`, `--plugin-dir`, `--add-dir`, `--settings`, `--fallback-model`.
- Two terminals on one session write to one transcript; use `--fork-session`.

## 5. Context window sizes and 1M

Source: CC/model-config.md "Extended context".
- Native 1M window with no suffix: Fable models, Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later (also on Bedrock, Agent Platform, Foundry, gateway sessions). Opus 4.6 and Sonnet 4.6 reach 1M only via `[1m]` (`/model opus[1m]`, `sonnet[1m]`, `opusplan[1m]` via `/model` needs v2.1.265+).
- Pricing: on the Anthropic API the 1M window has standard pricing, no premium past 200K. Exception: Haiku 5.5 costs more per token on prompts over 100K tokens ($0.50 input / $2.50 output per MTok over 100K, versus $0.10 / $0.50 below; checked on the pricing page 2026-11-16).
- Plans (Opus 4.6/Sonnet 4.6 `[1m]`): Opus 4.6 1M included on Max, Ultra, Team, Enterprise; needs usage credits on Pro. Sonnet 4.6 1M needs usage credits on every subscription plan. API and pay-as-you-go: full access. Plan limits for the newer native-1M models: the page says only that on plans where extended context is included usage stays covered; per-plan detail for Sonnet 5+/Opus 4.7+ unverified.
- Turn off: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` removes `[1m]` variants and holds native-1M models to a 200K window (auto-compact then at 200K; with auto-compact off the session stops at 200K with the context-limit error).
- Practical angle: best-practices says that with 1M on most models and compaction near the top, "you'll rarely run out of context", but "you can still pay for context you don't need" because every request re-reads everything; lowering `autoCompactWindow` (e.g. 200000 to 500000) is the lever to cap per-request size. (CC/best-practices.md "Keep cost and context down".)

## 6. Memory and instructions cost

Source: CC/memory.md, CC/features-overview.md, CC/context-window.md.
- Hierarchy: managed (org) CLAUDE.md, user `~/.claude/CLAUDE.md`, project `CLAUDE.md` / `.claude/CLAUDE.md`, `CLAUDE.local.md`; files in directories above the working directory load at launch; files in subdirectories load on demand when Claude reads, writes or edits a file there. AGENTS.md is read in place of CLAUDE.md by default (`/config` "Project instructions": `claude-md-or-agents-md` default, `claude-md-and-agents-md`, `claude-md`, `managed-only`).
- Size guidance: target under 200 lines per CLAUDE.md; startup warning and a `/status` warning when over, plus a combined-size warning. Files up to 4 MiB load whole; over 4 MiB none of the file loads. `@path` imports (max depth 4 hops) "do not reduce context cost" because they load with the importing file. Block-level HTML comments are stripped before injection (free maintainer notes).
- On-demand per-file limit (v2.1.309+): nested CLAUDE.md, subdirectory rules and path-scoped rules are truncated at 40,000 characters on a 200K window, 150,000 characters on a 1M window (200,000 on Opus 4.6 / Sonnet 4.6 with 1M), with a note telling Claude to Read the rest.
- `.claude/rules/*.md`: all files discovered recursively; those with `paths:` frontmatter (globs) load only when Claude reads, writes or edits a matching file (also single-file `cat`/`head` style reads); unscoped rules load at launch. User-level rules live in `~/.claude/rules/`.
- `claudeMdExcludes`: array of absolute-path globs, any settings layer, arrays merge; cannot exclude managed CLAUDE.md.
- Disable loading entirely: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (includes auto memory). `--add-dir` directories do not load CLAUDE.md unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
- Auto memory: on by default; toggle in `/memory` (writes `autoMemoryEnabled` in user settings), per-project `autoMemoryEnabled: false`, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`0` forces on). Directory `~/.claude/projects/<project>/memory/` (shared across worktrees of a repo), relocatable with `autoMemoryDirectory`. Only the first 200 lines or 25KB of `MEMORY.md` load at start, whichever comes first; topic files are never loaded at startup, Claude reads them on demand. After writes Claude Code measures MEMORY.md against both limits and reminds Claude to shorten it; over the limit the write succeeds but an error asks for a rewrite. Memory files are excluded from the transcript retention sweep.
- Skills: descriptions in every request; bodies on invocation; `disable-model-invocation: true` removes the description from context until invoked; `skillOverrides` setting does the same for skills you did not write. Costs doc: "Aim to keep CLAUDE.md under 200 lines" and move workflow-specific instructions to skills.
- `includeGitInstructions: false` removes built-in commit/PR instructions from the system prompt. `omitClaudeMd: true` in subagent frontmatter starts the subagent without user/project/local CLAUDE.md.
- `InstructionsLoaded` hook logs which instruction files load and why (debugging lazy loading).
- `/usage` recommendation rows quantify cost, e.g. `Trim ~/code/api/CLAUDE.md · 49k tokens per request` (CC/costs.md).

## 7. Limits that cap what enters context

| Limit | Value | Knob | Source |
| - | - | - | - |
| Read tool, per call | 25,000 tokens; whole file over 256 KB refused; over-token file returns first page with `PARTIAL view` notice | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | CC/tools-reference.md "Large files" |
| Read with `allow_large: true` | Sized against room left in context window instead of default limits (v2.1.296+) | none (model-chosen) | same |
| Read of images | PNG/JPEG/GIF/WebP, resized/recompressed; refused over 128 MB | n/a | tools-reference.md |
| Read of PDFs | Short PDFs whole; over 10 pages read in ranges of up to 20 pages via `pages`; needs `pdftoppm` | n/a | same |
| Read of notebooks | Error over 256 KB of cells or over the token limit; refused over 100 MB | n/a | same |
| Images and PDFs per request | API count limits plus a Claude Code total-size cap; oldest batch dropped when exceeded (causes one cache miss per batch) | n/a | CC/prompt-caching.md "Accumulating many images" |
| Bash output, success | Inline up to about 30,000 chars; beyond that a file path in the session directory plus up to 2,000-char preview; file truncated past 64 MiB; process killed past 5 GB | `bashOutputMaxChars` (4,000 to 128,000, v2.1.261+; wins over env var) or `BASH_MAX_OUTPUT_LENGTH` (default 30,000, max 150,000) | tools-reference.md "Output limits"; settings-reference.md |
| Bash output, failure | Inline up to about 10,000 chars as head and tail excerpt, no file path | raising `BASH_MAX_OUTPUT_LENGTH` enlarges the window it is cut from | tools-reference.md |
| Glob | Capped at 100 files, sorted by mtime, truncation flag | n/a | tools-reference.md |
| Grep | `head_limit` and `offset` params; `count` mode totals all matches | n/a | tools-reference.md |
| MCP tool output | Default 25,000 tokens, warning above 10,000 (fixed); text results over 50,000 chars saved to a file; per-tool `_meta["anthropic/maxResultSizeChars"]` up to 500,000 | `MAX_MCP_OUTPUT_TOKENS` | CC/mcp.md "MCP output limits and warnings"; env-vars.md |
| MCP tool descriptions and server instructions | 4,096 chars upfront, 16,384 for tools loaded through tool search | `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | CC/mcp.md |
| MCP tool definitions | Deferred by default (tool search): only names and server instructions load | `ENABLE_TOOL_SEARCH` = unset/`true` (defer), `auto` (defer once definitions reach 10% of window), `auto:N` (custom percent), `false` (load upfront); per-tool `anthropic/alwaysLoad` | CC/env-vars.md; CC/mcp.md |
| Output tokens | per model cap | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; thinking budget `MAX_THINKING_TOKENS` (fixed-budget models only; floor 1,024; 0 disables where allowed; ignored for adaptive-reasoning models, use `/effort`) | env-vars.md; costs.md |
| `@file` mentions | expanded into content; `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` sends plain text | env var | env-vars.md |

Large tool output is therefore persisted to disk and replaced by a path plus preview for Bash and MCP; Read instead paginates with `offset`/`limit` or errors. I did not find the persist-to-disk threshold for other built-in tools (WebFetch, Grep); unverified.

## 8. Other cost levers from the costs page (for context only)

CC/costs.md "Reduce token usage": clear between tasks (`/rename` first, `/resume` later); keep CLAUDE.md under 200 lines; prefer CLI tools (`gh`, `aws`) over MCP; disable unused MCP servers with `/mcp`; code-intelligence plugins to avoid grep-then-read chains; PreToolUse hook that rewrites commands to pipe through `tail -n 100` using `hookSpecificOutput.updatedInput`; delegate verbose operations to subagents; plan mode before implementation; `/rewind` or Esc Esc to abandon a bad path. Long-session cost drivers listed: long context, cache misses after a break longer than the TTL, scheduled `/loop` tasks, cross-session messages (`crossSessionInbound: hold`), goal check-ins (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`, max 3 idle check-ins per goal), subagents and workflows, agent teammates (about 7x tokens in plan mode), compaction. Enterprise average quoted: about $13 per developer per active day, $150-250 per month, under $30/day for 90% of users.

## 9. Unverified or not found

- Claude Code client-side tool-result clearing / "microcompact": only referenced indirectly in costs.md; no trigger, threshold, setting or env var documented. No page uses the term "microcompact".
- Whether Claude Code's "Compact instructions" CLAUDE.md heading is matched literally (docs only show the example).
- Default value of `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and exact meaning of "a few attempts" in the thrashing guard.
- Cache effect of rewind's Summarize options.
- Full list of `/context` categories and token counts (the live page is interactive).
- Per-plan 1M availability for Sonnet 5+ and Opus 4.7+ (page documents only the `[1m]` plan table for 4.6 models).
- `/subtask` behaviour, API server-side compaction page, and statusline `prompt_cache` field names (pages not opened).
- Exact `awaySummaryEnabled` semantics (settings index line only).
- Persist-to-disk thresholds for WebFetch and Grep.
