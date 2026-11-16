# Claude Code cost reduction: community techniques and Claude API features

Research date: 2026-11-16. Method: web search plus reads of the live platform.claude.com pages and Anthropic engineering posts. Each claim carries a URL. "Measured" means a named party ran an experiment and published the method; "claimed" means the author or vendor reports it without independent replication. Anything marked "unverified" rests on a secondary source that I could not trace to a primary one. Several secondary pages were reachable only through search snippets, not full reads; those are flagged.

## Summary of what matters most

1. Output filtering is the most hyped and least proven. The one large independent cost benchmark found no reliable saving (Quesma, section 1.1). Per-command compression is real; whole-task cost saving is not demonstrated.
2. Prompt caching dominates the bill, so cache health outranks prompt trimming. In the Quesma runs, cache reads were 94% of Fable input tokens and 30% of the bill.
3. The documented cost traps are cache-related: idle gaps past the TTL, mid-session changes to tools, thinking parameters or effort, and a client bug that Anthropic itself confirmed (section 1.8).
4. Terse-output skills save little in agentic coding: about 8.5% output tokens in the one rigorous paired test, against a 65% claim, and output is a small share of billed tokens (section 1.5).
5. Deferring tool definitions is the best-evidenced saving, and it is a pattern a harness can implement itself without breaking the cache (section 2.5).
6. Code-navigation indexes have no independent paired cost evidence for Serena or semantic-search MCPs; one published comparison of the official LSP plugin shows mixed results by model and task (section 1.6).
7. Several API features are cheap for a harness to copy: clearing old tool results, compaction, a file-based memory tool, effort as a single control, and cache-aware request layout. Others (batch, server-side tool search, programmatic tool calling) are Anthropic-hosted.

## Part 1. Community tools and techniques

### 1.1 Output-filtering proxies and hooks

| Tool | Mechanism | Evidence | Maturity |
|---|---|---|---|
| RTK (rtk-ai/rtk) | Single Rust binary; a Bash hook rewrites commands (git status becomes `rtk git status`) so output is compressed before the model sees it | Project claims 60-90%; independent benchmark found no reliable cost saving | Active; versions 0.43 to 0.46 cited in independent tests |
| context-mode (mksglu/context-mode) | Plugin plus MCP server; hooks route Bash, Read, WebFetch, Grep and Task into a sandbox; only stdout enters the conversation, the rest is indexed | Vendor figures only | Single-developer project, ELv2 licence |

**RTK, project claims.** The README advertises 60-90% reduction, "estimates based on medium-sized TypeScript/Rust projects". A secondary write-up of the project's own benchmark gives about 118,000 tokens falling to about 24,000 in a 30-minute session, git status about 3,000 to 600, cargo test about 25,000 to 2,500. Claimed, not independently measured. Sources: https://mer.vin/2026/05/cut-ai-coding-token-costs-80-with-rtk-cli-proxy-how-rust-token-killer-works/ and https://mintlify.com/rtk-ai/rtk/introduction (search snippets only).

**RTK, independent measurement (Quesma).** RTK 0.45.0 on Terminal-Bench 2.1 through Harbor. Claude Code 2.1.220 with Fable 5.0, and OpenCode with DeepSeek V4 Pro. Five runs per task with RTK and five without; 85 Fable tasks and 89 DeepSeek tasks, 1,740 attempts, over $1,500 of token spend. Results:
- Fable total bill fell about 5%; pass rate 84% to 83%. DeepSeek bill rose about 5%; pass rate 71% to 69%. (The article's chart shows two dollar figures per row, Fable $596 and $731 versus $546 and $698, DeepSeek $26 and $51 versus $31 and $54, and does not define them; the earlier "$731 to $698" and "$51 to $54" reading is unverified.)
- Per-task average cost change on Fable was +1% with a 95% interval including zero. Almost all of the Fable saving came from one task; across the others it was under 1%.
- DeepSeek per-task cost rose 17% on average. Input per turn fell 7% but turns rose 18%, cancelling the gain.
- `rtk gain` reported 349.2M tokens saved (89%) but that is bytes removed divided by 4, not billed tokens. Tasks with large reported savings sometimes cost more.
- Terminal output was about 7% of Fable's input tokens (other tools another 4%; 26% and 14% for DeepSeek), so there is little to compress. Cache reads were 94% of Fable input tokens and 30% of its bill (98% and 26% for DeepSeek). Four Fable security tasks were dropped for refusals.
- One RTK 0.45.0 bug (a `find` rewrite loop, 339 consecutive errors) cost about 9x baseline on one attempt; fixed in 0.46.0.
- Authors' conclusion: they do not recommend RTK as a generic cost-saving tool.
Source: https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/ (full read). A JetBrains study of RTK 0.43.0 on 86 SkillsBench tasks exists (https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) but the page returned 403, so its result is unverified.

Reading for a harness author: per-command compression helps on noisy commands (test runners, build logs), but the model may react to terser output with extra turns, and the filter becomes part of the hot path (rewrite bugs, loops). Measure billed cost and turn count, never the tool's own savings counter.

**context-mode.** Mechanism: only a subprocess's stdout enters context; logs and API responses stay in a sandbox index (https://github.com/mksglu/context-mode). Vendor numbers: 315 KB to 5.4 KB (98%); a 56% case for a short session; 96% overall in its own BENCHMARK.md (https://glama.ai/mcp/servers/@mksglu/claude-context-mode/blob/46bc99d5a5e2839c553f7b1589726e2512693a30/BENCHMARK.md). The project says hook-capable platforms reach about 98% while instruction-file-only platforms reach about 60%, which is the useful design point: enforcement by hook beats asking the model. No rigorous independent benchmark found. Critiques: it adds nine MCP tool schemas to every conversation (a gist, unverified in detail), and it intercepts every tool call (https://github.com/anthropics/claude-code/issues/34391). All search-snippet level.

Related: a practitioner overview of RTK, headroom and caveman is at https://codepointer.substack.com/p/cutting-llm-token-costs-with-rtk (snippet only).

### 1.2 Context offloading and code-execution patterns

- File-based scratchpads and notes: Anthropic's own context-engineering post recommends structured note-taking (to-do lists, a NOTES.md) with notes read back later, and states that sub-agents may explore with tens of thousands of tokens but return summaries of often 1,000-2,000 tokens. Anthropic guidance, not measured savings. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Code mode (MCP exposed as code APIs): the agent loads only the tools it needs from a file tree and filters data in an execution environment. Anthropic's illustrative example drops from about 150,000 tokens to 2,000 (98.7%). The post itself frames this as one example, not a benchmark, and lists sandboxing and monitoring as costs. https://www.anthropic.com/engineering/code-execution-with-mcp
- The API-hosted variant is programmatic tool calling (section 2.7).

### 1.3 Usage analysers

| Tool | Reads | Reports | Notes |
|---|---|---|---|
| ccusage | Claude Code local JSONL logs | Daily, monthly, per-session and 5-hour block reports; cache creation and cache read tokens separately; estimated USD cost | Cost mode: use logged cost when present, or always calculate; excludes web search, code execution and image tool charges. https://npmjs.com/package/ccusage and https://www.mintlify.com/ryoppippi/ccusage |
| cc-token-usage (Rust) | Same logs | Cache savings versus API rates, 5-minute versus 1-hour TTL split, price overrides | https://docs.rs/crate/cc-token-usage/1.2.2/source/README.md |
| OpenTelemetry dashboards | Claude Code's native OTLP metrics | `claude_code.token.usage` split into input, output, cache read, cache creation; cost; sessions; Grafana, CloudWatch, Coralogix and Last9 templates exist | Cost is computed client-side from token counts and list prices, so it is an estimate, not the invoice. Cache efficiency is the cache-read to input ratio. https://grafana.com/grafana/dashboards/25255-claude-code-metrics-prometheus/ and https://aws.amazon.com/blogs/mt/analyzing-claude-code-usage-with-cloudwatch-and-opentelemetry/ |

I did not retrieve status-line packs or the Claude-Code-Usage-Monitor project; their content is unverified here. A harness should record the four usage fields the API returns (section 2.1) per request so it can compute its own hit rate, rather than depend on log scraping. The TTL split matters because 1-hour and 5-minute writes are priced differently.

### 1.4 Model routing

- claude-code-router (musistudio) routes Claude Code requests to other providers and models by rule. Its README setup tells users to set `DISABLE_PROMPT_CACHING=1`, and its OpenRouter transformer strips `cache_control` for non-Claude models. So routing to a cheaper non-Claude model gives up caching by design. https://github.com/musistudio/claude-code-router (snippet level; I found no report that it breaks caching on Claude-to-Claude routes).
- LiteLLM documents the underlying problem: a cache written on one deployment is not readable from another, so load-balancing consecutive requests across deployments causes misses. Its `prompt_caching` pre-call check pins follow-up requests to the deployment that wrote the cache. https://docs.litellm.ai/docs/tutorials/claude_code_prompt_cache_routing.md
- Anthropic's own cache page lists what a model switch implies: caches are per model and per workspace/organization, and the cache hierarchy is invalidated by changes to tools, tool_choice, images, thinking parameters or effort. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Design consequence: route at session or subagent boundaries (a cheap model for a whole subagent), not per turn inside one conversation. Per-turn switching rebuilds the prefix at write price. Effort is the in-model alternative (section 2.9) and per-message effort preserves the cache on supported models.
- Tool search (server-side) works only on listed Claude models; a router to a non-Claude model needs its own deferral (section 2.5). Not verified for any specific router.

### 1.5 Terse-output prompting ("caveman")

- Claim: the caveman skill reports about 65% fewer output tokens (up to 87%) on 86 coding tasks, and a third-party 10-prompt test reported 45% versus baseline and 39% versus a plain "be terse" instruction.
- independent measurement: JetBrains ran paired A/B tests; the small first run showed about 29.5% but at scale it converged to about 8.5% (82 paired tasks per JetBrains' blog; InfoWorld says 86), with no measurable quality difference. https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/ (403 on direct fetch; the 8.5%, 65% and 29.5% figures are secondhand, matched by search summaries of InfoWorld and TechTimes; the 592k to 542k token counts are unverified; the implicator.ai page does not contain the 8.5% figure).
- Why the saving is small: output is reported as 0.6 to 2.5% of a typical Claude Code session's billed tokens (https://www.implicator.ai/caveman-claude-code-skill-cuts-output-20-your-bill-barely-notices-2/, confirmed there as the article's own statement; a Reddit log is the only cited basis, so unverified), the skill text itself adds input tokens, and code and tool-call arguments are unaffected.
- Anthropic's docs agree effort does not reliably shorten replies on newer models: on Opus 5 changing effort does not reliably shorten responses, so prompt for length. https://platform.claude.com/docs/en/build-with-claude/effort
- Caution: Anthropic's April postmortem reverted a system-prompt change that limited text between tool calls; an ablation showed a 3% drop on one eval for Opus 4.6 and 4.7. Verbosity limits can cost quality. https://www.anthropic.com/engineering/april-23-postmortem

### 1.6 Code-navigation aids

- Serena (LSP-backed symbol retrieval and editing): docs claim token and time savings qualitatively, with no figures. A third-party fork, serena-slim, reduces tool schemas from 29 to 18 tools and 7,348 to 1,614 schema tokens (tiktoken estimate); that is schema size, not navigation benefit. https://glama.ai/mcp/servers/mcpslim/serena-slim
- Official LSP plugins: CircleCI measured tool-output tokens, grep versus LSP. On Opus, LSP used more on the "trigger" task (3,666 versus 3,041); on Sonnet 4.6 it was far lower on "track" (491 versus 3,808) and about even on "trigger". Task and model dependent. https://circleci.com/blog/claude-code-lsp/ (snippet level).
- agent-lsp reports 5x savings at 15K lines and 34x at 319K lines versus grep, counting input bytes only, not downstream reasoning. https://dev.to/daynablackwell/we-measured-it-lsp-saves-ai-agents-5-34x-tokens-vs-grep-427 (author measurement, not independent).
- Claude Context (Zilliz, hybrid BM25 plus vectors): claims about 40% token reduction at equivalent retrieval quality; the evaluation is the vendor's, and I found no independent grep comparison. https://zilliz.com/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens
- token-pilot (bundles ast-grep, claims 60-80%), vs-token-safer (87% on its own 150-file benchmark), token-savior (99% over 782 sessions) and tokensave (88%) are all self-reported; tokensave's figure is retrieval savings on its own repo, not session cost. See the search results at https://dev.to/comic_sans/tokensave-an-mcp-server-that-saved-me-millions-of-tokens-while-coding-4phl.
- Anthropic's stance: just-in-time retrieval with glob and grep plus a few up-front files is the baseline; indexes are a hybrid option. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Net: plausible for large repositories, unproven in cost terms. Any index also adds tool schemas to every request, so it must be deferred (section 2.5).

### 1.7 Workflow habits practitioners repeat

| Habit | Reasoning | Evidence | Status |
|---|---|---|---|
| One task per session, clear between tasks | Old turns are re-read every turn; cached reads are cheap but not free, and long context degrades quality | Practitioner posts; Anthropic calls context an attention budget with diminishing returns | Widely agreed. Source: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Handoff file then clear | Moves state out of context; matches Anthropic's progress-file pattern for multi-session work | One post has Claude write `.claude/session-handoff.md` (goal, changed files, decisions, next step); Anthropic memory docs describe the same initializer-plus-progress-log pattern | Agreed. https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool and https://dev.to/llm_link_top/5-tips-to-cut-claude-code-token-usage-by-30-1o15 (snippet) |
| Plan first | Catches scope errors before expensive edit loops | Anecdote only; claims such as "biggest saver" and "40-60% reduction" have no method | Contested in size, not in direction. https://composio.dev/blog/ways-to-cut-token-consumption-in-claude-code |
| Small CLAUDE.md and rules | Loaded every turn, and re-injected after compaction | A GitHub issue ties an autocompact refill loop to large auto-loaded `.claude/rules/*.md` plus CLAUDE.md | Agreed. https://claudeissues.com/issue/85489-autocompact-thrashing-warning-blames-a-file-or-tool-output-when-the-refill-came |
| Subagents for exploration | Exploration happens in a throwaway context; only a 1,000-2,000 token summary returns | Anthropic guidance; community figures that subagents cost 2-4x a single session (secondary, below) | Contested: saves lead-context growth but multiplies total tokens |
| Keep the cache warm, avoid cache busts | Cache read is 0.1x or 0.05x of input price | Strong, documented (section 2.1) | Agreed, but see the TTL dispute in 1.8 |
| Lower effort for easy work | Effort scales all output tokens including thinking and tool calls | Anthropic docs | Agreed. Thinking billed as output |
| Disable unused MCP servers; use tool search | Definitions are paid every turn | Measured numbers in 1.8 | Agreed |
| Batch edits, avoid reading whole files | Fewer turns means fewer cache reads of a growing prefix | Reasoning only; no measurement found | Unverified |

Contested advice: "always use plan mode" (no measurement); "use fast mode" (one source warns that switching mid-conversation charges the full uncached price for the whole context, unverified; Anthropic's cache table does list speed setting as invalidating the tools level); "keep-alive pings" (a controlled test reported they did not reliably keep the conversation cache alive past about 11 minutes, secondary: https://aident.ai/blog/fix-claude-code-cache-keepalive-5m-ttl).

### 1.8 Known cost traps

**Cache expiry after idle and TTL regressions.** Community reports from April 2026 say Claude Code's main-conversation cache moved from 1 hour to 5 minutes around early March, so any pause over 5 minutes means a full cache rewrite. Per The Register, a developer's bug report put the 1-hour TTL at about Feb 1 and the return to 5 minutes at about Mar 7; an Anthropic engineer said the switch lowered costs because many requests never reuse their cache; users said quotas drained. Sources disagree on which plans got which TTL, and an open issue says a later Claude Code release (2.1.218) stopped requesting the 1-hour TTL. Workarounds cited: `promptCacheTtl` or `CLAUDE_CODE_PROMPT_CACHE_TTL`; subagent, workflow and compaction requests reportedly stay at 5 minutes. Sources: https://www.theregister.com/2026/04/13/claude_code_cache_confusion/, https://claudeissues.com/issue/46829-cache-ttl-silently-regressed-from-1h-to-5m-around-early-march-2026-causing-quota, https://claudeissues.com/issue/84253-bug-claude-code-2-1-218-no-longer-requests-1h-prompt-cache-ttl-every-5-min-gap-f. All secondary or user reports; direct fetch of the issue failed. Cause and current defaults: unverified.

**Anthropic-confirmed bug (primary source).** On March 26 a change meant to clear old thinking from sessions idle over an hour cleared it on every later turn. Requests after the idle threshold became cache misses, which Anthropic believes drove faster usage-limit drain; fixed April 10 (v2.1.101), all three issues resolved by April 20 (v2.1.116), limits reset April 23. The same post records a default-effort change from high to medium (March 4, reverted April 7). https://www.anthropic.com/engineering/april-23-postmortem

**MCP bloat.** A blog (mcpplaygroundonline) attributes to an unnamed community measurement filed against Claude Code: seven MCP servers consumed 67,300 tokens of definitions (33.7% of a 200k window) before any user input; the post does not say it was a GitHub issue. The 12-server figures (about 63,186 tokens with tool search off, 5,848 on, 158 tools) are not on that page; a search summary traces them to an Apify blog post (https://use-apify.com/blog/claude-code-mcp-context-usage, not fetched). Both are secondary. The Agent SDK docs describe tool search as on by default when `ENABLE_TOOL_SEARCH` is unset; other sources describe an auto mode above 10% of the window, which I could not confirm. https://mcpplaygroundonline.com/blog/mcp-context-bloat-tool-search.md, https://platform.claude.com/docs/en/agent-sdk/tool-search

**Autocompact loops.** Many user reports (for example a loop reported in October 2025 at a claimed $1,027 over four days; thrashing within about 3 turns in 2.1.144 and 2.1.220). A changelog entry quoted in an issue says Claude Code now stops after context refills to the limit three times in a row after compaction. Version unconfirmed. https://claudeissues.com/issue/9579-bug-autocompacting-loop-causing-massive-token-usage-spikes-oct-15-2025 and https://github.com/anthropics/claude-code/issues/41796

**Subagent and agent-team multiplication.** Secondary sources cite Anthropic as saying agent teams use roughly 7x the tokens of a standard session when teammates run in plan mode; other estimates give 3-7x for teams and 2-4x for subagents. I did not confirm the 7x against Anthropic's page. https://www.mindstudio.ai/blog/claude-code-subagents-cost-tokens and https://claudefa.st/blog/guide/development/multi-agent-orchestration-cost

**Long-context tier.** Today's pricing page says Claude 4.6 and later models, except Haiku 5.5, include the full 1M window at standard pricing, so the old premium tier is gone for them. Haiku 5.5 is priced by prompt length: above 100,000 input tokens (cache reads and writes counted) the per-token prices rise (input $0.10 to $0.50, output $0.50 to $2.50 per MTok). https://platform.claude.com/docs/en/about-claude/pricing

**Thinking burn.** Thinking tokens are billed as output. Anthropic's effort page recommends effort over budgets as the control; `MAX_THINKING_TOKENS` is reported to be ignored on adaptive-thinking models (secondary, unverified). One analysis found a modest overhead at medium effort on Opus 4.6 (1.17x billed versus visible tokens), single source. https://platform.claude.com/docs/en/build-with-claude/effort

## Part 2. Claude API features

Model names, prices and header names below are as shown on the live pages on 2026-11-16 and may differ from earlier documentation. Opus 5.5 and Sonnet 5.5 have cache-read multipliers (0.05x) different from the older 0.1x.

### 2.1 Prompt caching

URL: https://platform.claude.com/docs/en/build-with-claude/prompt-caching and https://platform.claude.com/docs/en/about-claude/pricing

- What: the server reuses a processed prompt prefix. Prefix order is tools, then system, then messages. A cache entry is a cumulative hash of the prefix up to a breakpoint, and requires a 100% identical prefix (images included).
- Breakpoints: explicit `cache_control` on a block, up to 4 per request. There is now an automatic mode: one top-level `cache_control: {"type":"ephemeral"}` and the breakpoint moves to the last cacheable block as the conversation grows; it uses one of the four slots and is not supported on Bedrock's `bedrock-runtime`. Lookback window is 20 blocks; a run of consecutive tool_use blocks counts as one position and so does a run of tool_result blocks.
- TTL: 5 minutes default, refreshed free on each hit; 1 hour via `"ttl": "1h"`. Measured from request start. 1-hour entries must precede 5-minute entries.
- Price multipliers on base input: 5-minute write 1.25x; 1-hour write 2x; read 0.1x, except Opus 5.5 and Sonnet 5.5 at 0.05x and the Fable/Mythos 5.1 and 5.2 models at 0.025x. Examples from the pricing page: Opus 5.5 base $4, 5m write $5, 1h write $8, read $0.20, output $20 per MTok; Sonnet 5.5 base $2, writes $2.50 and $4, read $0.10, output $10; Haiku 5.5 (up to 100K prompt) base $0.10, read $0.01, output $0.50. Cache multipliers stack with Batch and data-residency (1.1x) multipliers.
- Minimum cacheable prompt: 512 tokens on the 5.x models listed, 1,024 on Sonnet 4.x/5 and Opus 4/4.1/4.8, 2,048 on Opus 4.7, 4,096 on Opus 4.5/4.6 and Haiku 4.5. Shorter prompts silently are not cached; check `cache_creation_input_tokens` and `cache_read_input_tokens`.
- Invalidation: any tool definition change invalidates tools, system and messages. Web search or citations toggle invalidates system and messages; `tool_choice`, images and `disable_parallel_tool_use` change invalidate messages (the page's tables differ slightly by level; read both pages). Thinking parameters and `output_config.effort` invalidate on some models; dropped thinking blocks invalidate. Preserved-thinking models (Opus 4.5+, Sonnet 4.6+, Haiku 5.5, Fable/Mythos) keep thinking blocks by default so the cache stays valid. A `{"role":"system"}` message appended to `messages` adds instructions without invalidating system or message caches on newer models. A beta (`inline-tools-2026-09-15`) allows tool additions mid-conversation without editing `tools`.
- Pre-warming: `max_tokens: 0` with a breakpoint writes the cache and bills only input and cache-write tokens.
- Usage fields: `input_tokens` is only the part after the last breakpoint; total input is read plus creation plus input; `cache_creation` splits 5m and 1h.
- Isolation: per organization, or per workspace on the Claude API.
- Portability: the idea (stable prefix, append-only history, no mid-session tool or system edits) is a pattern any harness can follow, but the price and TTL are Anthropic-specific. Providers with automatic prefix caching (no breakpoints) reward the same layout. Provider-specific parts are the field names and multipliers.

### 2.2 Context editing

URL: https://platform.claude.com/docs/en/build-with-claude/context-editing (beta; header `context-management-2025-06-27`).

- What: server-side removal of content from the prompt before the model sees it; the client keeps the full history.
- `clear_tool_uses_20250919`: triggers at 100,000 input tokens by default (or a tool_uses count); keeps the last 3 tool use/result pairs; options `clear_at_least`, `exclude_tools`, `clear_tool_inputs`. Cleared results become placeholder text.
- `clear_thinking_20251015`: `keep` defaults to 1 thinking turn when the strategy is present; older models default to keeping only the turn in progress.
- Saving mechanism: removes stale tool output, the bulk of context in coding sessions. Cost: clearing invalidates the cached prefix from the clearing point, so use `clear_at_least` to ensure each clear is worth a re-write. No saving figure on the page. Anthropic's engineering post calls tool-result clearing the safest, lightest form of compaction.
- Response includes `applied_edits` with `cleared_input_tokens`; `count_tokens` accepts the same config and returns `original_input_tokens`.
- Portability: pattern, easy to implement client-side (replace old tool results with a placeholder at a threshold, batch the clearing so the cache is rewritten rarely).

### 2.3 Compaction

URL: https://platform.claude.com/docs/en/build-with-claude/compaction (beta; header `compact-2026-09-04` for on-demand compaction).

- What: Claude writes a summary on the server that replaces older turns. Two forms: on demand (the application requests the summary, swaps in the returned block, can keep recent turns word for word and can run in the background) and at a token threshold (one parameter on ordinary requests, runs inside the triggering request, API drops what precedes the block). The docs say to prefer on-demand where available and recommend compaction over context editing for most long conversations.
- Saving mechanism: shrinks active context; the summary prefix then becomes the new cached prefix. No percentage given. Custom summarization prompts are supported.
- Portability: the pattern is portable (any model can summarise); the hosted version is Anthropic-specific. Claude Code's own compaction keeps the summary plus the five most recently accessed files (Anthropic context-engineering post).

### 2.4 Memory tool

URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (stable, no beta header; tool type `memory_20250818`).

- What: a client-side tool; Claude issues `view`, `create`, `str_replace`, `insert`, `delete`, `rename` against `/memories`, and the application executes them against its own storage. The API adds a system instruction to check memory first and to assume interruption.
- Saving mechanism: state lives outside the window and is loaded just in time, supporting a clear-and-resume workflow. Doc suggests combining with compaction (memory keeps what must survive summarisation) and with context editing. Multi-session pattern: initializer session writes a progress log and feature checklist; later sessions read them; mark features done only after end-to-end verification.
- Portability: the tool is a file API any harness can expose to any model; only the trained behaviour and the injected prompt are Anthropic-specific.

### 2.5 Tool search and deferred loading

URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool (stable) and https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching

- What: mark tools `defer_loading: true`; the model gets a search tool (regex or BM25 variant), the API returns up to 5 `tool_reference` blocks by default, expands them into full definitions inline, and keeps the prefix untouched so the cache is preserved. At least one tool must stay non-deferred; every tool definition is still sent in `tools` each request. Limits: 10,000 deferred tools, regex pattern 200 characters, BM25 query 500 characters. A deferred tool cannot carry `cache_control`.
- Numbers: the page says a five-server setup can use about 55k tokens of definitions and tool search typically reduces this by over 85%, loading 3-5 tools; selection accuracy degrades past 30-50 tools. Anthropic's post reports definitions dropping from about 77K to 8.7K tokens (85%) and MCP evaluation accuracy of Opus 4 rising 49% to 74% and Opus 4.5 79.5% to 88.1% (Anthropic internal testing). https://www.anthropic.com/engineering/advanced-tool-use. No separate metering; discovered definitions count as normal input.
- Use when: 10 or more tools, or definitions over 10k tokens. Keep the 3-5 most-used tools non-deferred and namespace tool names.
- Portability: highly portable. The docs show a custom client-side variant (return `tool_reference` blocks from your own search tool, with embeddings). For a harness on another provider the equivalent is a small search tool plus appending discovered definitions where the provider allows it without rewriting the prefix; where it does not, the cost is a cache rewrite.

### 2.6 Token-efficient tool use

URL: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/token-efficient-tool-use (page now redirected; the current platform.claude.com page did not load content for me).

- What: a beta header (`token-efficient-tools-2025-02-19`) introduced for Claude 3.7 Sonnet that changes tool-call output encoding; Anthropic reported an average 14% output-token saving, up to 70%, for 3.7 Sonnet (https://claude.com/blog/token-saving-updates).
- Status: conflicting versions of the docs say either that Claude 4 models support it by default or that it is a no-op on Claude 4. I could not confirm which is current. Treat as legacy and unverified for current models; it needs no work in a new harness.
- Related and current: `response_format` concise versus detailed on your own tools (Slack example 206 versus 72 tokens, about one-third) and a 25,000-token default cap on Claude Code tool responses, from https://www.anthropic.com/engineering/writing-tools-for-agents. Pattern, fully portable.

### 2.7 Programmatic tool calling

URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling (stable; needs code execution tool `code_execution_20260120` or later; not ZDR eligible, data retained up to 30 days).

- What: Claude writes code in a code-execution container that calls your tools, so intermediate results are processed in code and only the final output returns to the model. Tool results from programmatic calls do not count toward usage.
- Numbers on the page: a 75-tool project-management benchmark reduced billed input tokens by about 38% with no accuracy change; production traffic with 10-49 tool definitions sees typical savings of 20-40%; calling 10 tools directly uses roughly ten times the tokens. Anthropic's post: 43,588 to 27,297 average tokens (37%) on complex research tasks. Poor fit: strictly sequential reasoning, few small calls (container overhead can exceed saving). https://www.anthropic.com/engineering/advanced-tool-use
- Portability: Anthropic-hosted sandbox. The pattern (let the model write a script that calls tools and prints a summary) is implementable by any harness with a sandbox, as in the code-execution-with-MCP post.

### 2.8 Token counting

URL: https://platform.claude.com/docs/en/build-with-claude/token-counting

- Free, separate rate limits (5,000, 10,000, 20,000 RPM by tier). Accepts the full request shape (system, tools, images, PDFs, thinking, and the context-management config). It is an estimate; system-added tokens are not billed. Does not exercise caching. Errors on server tools (except advisor), the MCP connector, and URL or file sources.
- Warning: Claude 4.7 and later (and Fable/Mythos) use a newer tokenizer producing about 30% more tokens for the same text; recount rather than reuse old counts.
- Portability: concept is generic; a local tokenizer approximation is the usual harness substitute.

### 2.9 Effort parameter

URL: https://platform.claude.com/docs/en/build-with-claude/effort (stable).

- `output_config.effort`: low, medium, high, xhigh, max (availability varies). It affects all output tokens including text, tool call arguments and thinking; lower effort means fewer and terser tool calls. Defaults: high on most models, medium on Opus 5.5 and Haiku 5.5. Docs say it is a behavioural signal, not a token budget, and recommend low for subagents.
- Cache effect: changing top-level effort between requests can invalidate cached prefixes; per-message effort (a `system` message in `messages`) changes effort mid-conversation and preserves the cache on supported models (Fable 5.x, Opus 5/5.5, Sonnet 5.5, Haiku 5.5).
- No numeric saving published on this page. Anthropic's 3% quality drop from a verbosity limit (1.5) is a reminder to test.
- Portability: similar knobs exist elsewhere (reasoning effort); the idea of a per-subagent effort setting is portable, the parameter is not.

### 2.10 Batch API

URL: https://platform.claude.com/docs/en/build-with-claude/batch-processing and pricing page.

- 50% discount on input and output; most batches finish in under an hour; stacks with caching multipliers. Fast mode is not available with batch. Not zero-data-retention eligible (29-day retention). Not applicable to interactive coding; useful for evals, bulk review, or offline summarisation. Anthropic-specific.

### 2.11 Long-context pricing

URL: https://platform.claude.com/docs/en/about-claude/pricing

- Claude 4.6 and later (except Haiku 5.5) include the 1M window at standard rates (a 900k request costs the same per token as a 9k request). Haiku 5.5 charges higher rates above 100,000 prompt tokens, counting cache reads and writes, per request. Fast mode (up to 2.5x output speed) costs premium rates (Opus 5.5 $8 input, $40 output per MTok) across the full window.
- Consequence: long contexts are no longer penalised per token on most models, but each turn still re-reads the whole prefix at the cache-read rate, and quality degrades with size per Anthropic's context-engineering post.

### 2.12 Anthropic engineering posts

- Effective context engineering for AI agents: compaction, tool-result clearing, note-taking, sub-agents with clean context, just-in-time retrieval, minimal non-overlapping tools; "do the simplest thing that works". https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Writing tools for agents: pagination, filtering, truncation with sensible defaults; steer the agent when truncating; actionable errors; `response_format` enum; watch for redundant calls. https://www.anthropic.com/engineering/writing-tools-for-agents
- Advanced tool use: tool search, programmatic calling, tool-use examples (accuracy on complex parameters 72% to 90%, Anthropic internal). https://www.anthropic.com/engineering/advanced-tool-use
- Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- April 23 postmortem (cache and effort regressions): https://www.anthropic.com/engineering/april-23-postmortem

## Portability summary

| Feature | Provider-specific part | Pattern any harness can implement |
|---|---|---|
| Prompt caching | Breakpoint syntax, TTL, multipliers, thresholds | Stable prefix, append-only history, no mid-session edits to tools, system or effort; track cache read and write per request |
| Context editing | Server-side beta | Replace old tool results with placeholders in batches |
| Compaction | Hosted summary block | Summarise old turns, keep recent turns verbatim, reload CLAUDE.md-like files |
| Memory tool | Trained behaviour and injected prompt | A scoped file store and notes read at session start |
| Tool search | Server tool, `tool_reference` expansion | Search tool over a catalogue plus deferred definitions; cache-safe if appended after the prefix |
| Programmatic tool calling | Hosted container | Script-in-sandbox calling tools, returning summaries |
| Effort | Parameter | Per-subagent reasoning settings |
| Batch | 50% price | Offline queue for non-interactive work |
| Token counting | Endpoint | Local estimate |

## Could not verify

- JetBrains RTK study and JetBrains caveman study full text (403); figures come from search summaries and a secondary page.
- Any independent benchmark of context-mode, Serena, Claude Context, token-pilot, vs-token-safer, token-savior or tokensave; all figures are vendor or author numbers.
- Whether claude-code-router breaks caching on Claude-to-Claude routes; only the documented `DISABLE_PROMPT_CACHING` setup and non-Claude `cache_control` stripping were found.
- Cause and current default of the Claude Code cache TTL (1 hour versus 5 minutes) per plan type; the issues could not be fetched directly.
- Anthropic's own figure for agent-team token multiplication (the 7x number is cited secondhand).
- The 10% auto-enable threshold for MCP tool search in Claude Code.
- The version that added the autocompact three-strike stop.
- Whether token-efficient tool use is a no-op or default on current models.
- Status-line packs and Claude-Code-Usage-Monitor contents.
- Output tokens at 0.6-2.5% of session tokens (single secondary source).
- The Compaction, Context editing and Memory pages were read in full; the prompt-caching page was read only up to character 100,000 of about 167,000, so late-page details (examples, troubleshooting) were not reviewed.
