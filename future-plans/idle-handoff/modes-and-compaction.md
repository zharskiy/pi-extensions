# Modes and idle compaction: research

Date: 2026-10-17. Scope: two backlog ideas. (a) How plan mode and other operating modes should be entered: user toggle, main-model decision, or a cheap per-prompt classifier. (b) Whether to "compact before the session goes idle", meaning before the provider's prompt cache expires. Sources are official docs where possible. Web pages were read through a summarising fetcher, so quotes may be lightly paraphrased. Pi references are `docs/<file>.md` § heading in `node_modules/@earendil-works/pi-coding-agent`.

## 1. Plan mode across tools: who decides

| Tool | Entry | Who decides |
|---|---|---|
| Claude Code | `Shift+Tab`, a `/plan` prefix, `--permission-mode plan`, or `defaultMode: "plan"` ([permission modes](https://code.claude.com/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode)) | The user, and the model through the `EnterPlanMode` tool. The plan is exited with `ExitPlanMode`, which needs the user's approval. |
| Gemini CLI | `Shift+Tab`, `/plan`, or the model's `enter_plan_mode` tool (with user confirmation); `exit_plan_mode` presents the plan ([plan mode](https://geminicli.com/docs/cli/plan-mode)) | The user and the model |
| Cursor | `Shift+Tab`; the UI suggests plan mode when the prompt contains keywords for complex tasks ([blog](https://cursor.com/blog/plan-mode)) | The user, with a heuristic suggestion |
| Codex CLI | Approval and sandbox modes (`--sandbox read-only`, …) ([docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli)); a `/plan` command exists. Whether the model can enter it: unverified | The user |
| Kiro, Copilot | Spec mode in Kiro (requirements, design, tasks); no official docs verified | Unverified |

How Claude Code implements it matters more than the toggle. Its engineering post says the tool set never changes: `EnterPlanMode` and `ExitPlanMode` are ordinary tools, and plan mode is a system message. "because EnterPlanMode is a tool the model can call itself, it can autonomously enter plan mode when it detects a hard problem, without any cache break" ([Lessons from building Claude Code](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)). Its best-practices page also limits when to plan: "If you could describe the diff in one sentence, skip the plan" ([best practices](https://code.claude.com/docs/en/best-practices)).

A strong model for planning and a cheaper one for execution already exists as Claude Code's `opusplan` alias: "uses `opus` during plan mode, then switches to `sonnet` for execution" ([model config](https://code.claude.com/docs/en/model-config)). The caching doc states the cost: "each plan-mode toggle is a model switch and starts a fresh cache" ([prompt caching](https://code.claude.com/docs/en/prompt-caching)). The engineering post says that switching to a small model 100k tokens into a session "would actually be more expensive" because the cache must be rebuilt. It recommends a subagent with a hand-off message instead.

### Products that route with a classifier

- **Cursor Router ("Auto")** "runs a classifier on each agent request and routes it by task type and complexity". It has two stages: a complexity predictor, then a task taxonomy. A route needs 75% one-sided confidence, and the training accounts for the cache misses that model switches cause ([router docs](https://cursor.com/docs/cursor-router.md), [blog](https://cursor.com/blog/how-cursor-router-works)). Per-call cost and latency are not published.
- **ChatGPT GPT-5** has a real-time router that picks a model per turn. Only third-party summaries were found (unverified).
- **Claude Code auto mode** uses a second model as a classifier, but it reviews permissions, not modes ([permission modes](https://code.claude.com/docs/en/permission-modes)). Cost is not documented.

Every product that routes per request owns the model and the cache, and builds the cache penalty into its router. No tool found uses a classifier to decide whether to enter plan mode. Entering plan mode is left to the user, the main model, or a keyword hint.

## 2. Prompt-caching economics

| Provider | Default lifetime | Longer option | Read | Write |
|---|---|---|---|---|
| Anthropic ([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | 5 min, refreshed free on every hit | 1 h | 0.1× base (0.05× on the 5.5 models) | 1.25× (5 min), 2× (1 h) |
| OpenAI, GPT-5.6+ ([docs](https://developers.openai.com/api/docs/guides/prompt-caching)) | `ttl: 30m` after the latest write or reuse | none | 0.1× | 1.25× |
| OpenAI, older models | `in_memory`: 5–10 min idle, at most 1 h | `24h` (default without zero data retention) | up to 95% off | none |
| Google Gemini ([caching](https://ai.google.dev/gemini-api/docs/caching), [pricing](https://ai.google.dev/gemini-api/docs/pricing)) | implicit caching | explicit caches, billed per hour of storage ($0.50–4.50 per MTok·h) | about 90% off | none |

"Idle" therefore means that the time since the last request exceeds the lifetime: 5 minutes, 30 minutes or 1 hour depending on the provider. The next turn then pays a cache write (or full input) on the whole context, instead of a cache read.

### Cost of one turn on a 150k-token context

Input side only; the new user message and the output are the same in both cases. Prices are per MTok at Anthropic list prices, as a representative level.

| Price level | Warm turn (cache read) | Cold turn, 5-min write | Cold turn, 1-h write | Cold ÷ warm |
|---|---|---|---|---|
| Mid tier: $2 in, $0.10 read | $0.015 | $0.375 | $0.60 | 25× |
| Top tier: $4 in, $0.20 read | $0.03 | $0.75 | $1.20 | 25× |
| Older top tier: $5 in, $0.50 read | $0.075 | $0.94 | $1.50 | 12.5× |
| Generic 0.1× read / 1.25× write | 0.1 × base × 0.15 | 1.25 × base × 0.15 | n/a | 12.5× |

One cold restart of a large context costs as much as 12 to 25 warm turns. A session that sits idle overnight on a 150k context pays roughly $0.4–0.9 on its first message, and pays it again after every lunch break.

## 3. Compaction in other tools

- **Claude Code.** The auto-compact threshold is configurable (`autoCompactWindow`, `/autocompact`) ([model config](https://code.claude.com/docs/en/model-config)). Compaction is a cache-safe fork: it keeps the same system prompt, tools and history and appends the compaction prompt as the last user message. On a warm cache this costs about a tenth of a cold pass. After expiry, "`/compact` costs the most when you resume an old session". CLAUDE.md and invoked skills are re-injected afterwards ([prompt caching](https://code.claude.com/docs/en/prompt-caching), [context window](https://code.claude.com/docs/en/context-window)).
- **Claude Code idle compaction already exists.** "If you leave a long conversation idle in a terminal session while it is on the one-hour TTL, Claude Code can compact it shortly before the cache expires." It is on by default and turned off with `idleCompaction: false` ([prompt caching § compacting the conversation](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation)). It is limited to the 1-hour TTL, so it never fires five minutes after the user stops. No other tool with this feature was found.
- **Claude API.** Server-side compaction (beta) runs on demand or at an input-token trigger ([compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)). Context editing clears old tool results.
- **Codex CLI.** It has a local summary and a remote `responses/compact` endpoint, with auto-compaction near 90% of the window. These come from secondary sources only (unverified).
- **Downsides.** Detail is lost. Boundaries the user stated can disappear: Claude Code warns that a "don't push" instruction "can be lost if context compaction removes the message that stated it". Claude Code's own advice favours fresh sessions: "Use `/clear` frequently between tasks… A clean session with a better prompt almost always outperforms a long session with accumulated corrections" ([best practices](https://code.claude.com/docs/en/best-practices)).
- **Anthropic context engineering** ([post](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Context is "a finite resource with diminishing marginal returns", and recall degrades as the context fills ("context rot"). The post recommends three techniques: compaction (with tool-result clearing as the lightest form), structured note-taking outside the context window, and sub-agents that return "only a condensed, distilled summary".

## 4. What pi provides

**Compaction** (`docs/compaction.md`)
- Auto-compaction runs at `contextTokens > contextWindow − reserveTokens` (16384 by default), keeping `keepRecentTokens` (20k) (§ When It Triggers). There is also `/compact [instructions]`.
- Extensions get `session_before_compact`, which can cancel the compaction or supply a custom summary, and `session_compact_failed` (§ Custom Summarization via Extensions).
- `ctx.compact({ customInstructions, onComplete, onError })` triggers compaction (`examples/extensions/trigger-compact.ts`).
- **Pi's compaction is not cache-friendly.** Messages are serialised to plain text, with tool results cut to 2000 characters, and sent as a new prompt (§ Message Serialization). "Summarization requests disable prompt-cache writes" (§ Overview). A pi compaction therefore costs full input price on the summarised span whether the cache is warm or cold. Unlike Claude Code's fork, it gains nothing from running before expiry.

**Cache awareness and warming**
- A model declares `promptCache: { short, long }` lifetimes in seconds (`docs/models.md` § Describe model input and caching). `PI_CACHE_RETENTION=long` selects the long tier (`docs/environment-variables.md`).
- The `cacheWarming` setting takes `off`, `streaming` (the default) or `idle` (`docs/settings.md` § Model and thinking). Warming re-sends the last request with a one-token output cap at 90% of the lifetime (`dist/core/cache-warmer.js`).
- Idle warming assumes a 15% chance that the user continues, stops after 30 minutes, and refreshes only when the expected saving is at least $0.05.
- On the mid-tier row above, expected saving is 0.15 × (0.375 − 0.015) − 0.015 ≈ $0.039. That is below the threshold, so pi would not warm a 150k mid-tier context.
- Extensions can override each refresh decision with `cache_warming_decision` (`docs/extensions.md` § cache_warming_decision).
- Usage carries `cacheRead`, `cacheWrite` and `cacheWrite1h` (`pi-ai` types). The repo's adapter already passes these through (`core/adapter/contract.ts`, `usage.ts`), and `/context` shows the cache-hit rate.

**Events and timers** (`docs/extensions.md` § Respect the runtime lifecycle, § Events and concurrency)
- `agent_settled` marks the moment the session goes idle; the repo's `Host.onIdle` maps to it. `turn_end` and `agent_before_settle` are also available.
- Timers are allowed if started from `session_start` and cleared in `session_shutdown`.
- `input` can transform or handle raw user input before a run, so a classifier could see it.
- `before_agent_start` can change prompt sections, or replace the whole system prompt (a cache break).
- `pi.setModel`, `pi.setThinkingLevel` and `pi.setActiveTools` exist. Changing active tools appends a delta, but "providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix" (§ Activate tools dynamically).

**Classifiers and routing**
- Pi ships classifier models that answer typed questions with probabilities. Extensions call them through `ctx.modelRegistry.classify()` (`docs/models.md` § Use classifier models). So the cheap classifier the backlog waits for now exists in pi.
- `pi.registerVirtualModel` routes every request (`docs/virtual-models.md`). The docs warn that "switching models between turns is allowed but loses the prompt cache", and that a classifier call "adds latency before the first token".
- The example `examples/extensions/jev-router.ts` classifies only the first user message. It plans on a strong model, then after the first successful edit switches once to a cheap model, "accepting a single prompt-cache miss".

**Plan mode.** Pi has no built-in plan or read-only mode. `examples/extensions/plan-mode/` is a user toggle (`/plan`, `Ctrl+Alt+P`, `--plan`) that disables edit and write, allows only an allowlist of bash commands, extracts the plan, and tracks progress.

**This repo**
- session-limits (`extensions/session-limits/src/limits.ts`, `thresholds.ts`) already hands off before pi would compact. At `hardRatio` (0.75) it asks the model to write a handoff file in-session, then on idle switches to a new session seeded with that file.
- It uses `onTurnEnd`, `onIdle` and `onCompact`; the last only clears its cached size. It has no timers and no cache awareness.
- The handoff turn is cache-friendly: it appends one user message to the cached prefix.
- Subagent child sessions run with compaction disabled and cache warming off (ARCHITECTURE.md § A run_agent call, step 4).
- The main prompt already tells the model to "work out a plan first with the `planner` lead and the user before implementing" for multi-step work (`extensions/subagents/prompts/main-session.md`). Agents carry their own `model:`.

## Design options

### (a) Entering plan mode and other modes

The owner's actual need is strong-model requirements and cheaper implementation. The subagents extension already provides it: the `planner` lead runs on its own model, implementers on theirs, and each starts with a fresh context, so no cache is lost. What a mode would add is a hard guarantee that nothing gets edited while planning.

**A1. Per-prompt classifier.** A cheap classifier on every prompt picks the mode (or model).
- Pros: automatic, and now technically possible in pi.
- Cons: it decides from the prompt alone, while the main model sees the prompt plus the whole conversation at no extra cost. It adds latency to every turn. If it switches the main model, each switch is a cold turn (12–25× a warm one). Cursor needs a trained two-stage router with cache-aware training to make this pay; nobody uses a classifier for plan mode.

**A2. User toggle only.** A `/plan` command and a shortcut, as in pi's `plan-mode` example and Codex.
- Pros: simplest; the user stays in control.
- Cons: the user must remember to switch. The repo's main prompt already plans without a toggle.

**A3. User toggle plus model entry, user exit (the Claude Code and Gemini model).**
- A `/plan` toggle, and an `enter_plan_mode` tool the main model calls when it judges a task needs a plan.
- Leaving plan mode requires the user to approve the plan.
- While in plan mode, a `tool_call` handler blocks edit, write and non-allowlisted bash, and `run_agent` accepts only read-only agents (`scout`, `planner`).
- Pros: it uses the judgement the main model already exercises. It keeps tool definitions and the system prompt constant (send the mode as a message, block calls in `tool_call`), so there is no cache break.
- Cons: more surface than A2. The model may under-use it. That is acceptable, because the user toggle covers it.

**Recommendation: A3, with no per-prompt classifier.** The main model is the best and free classifier for "does this need a plan". Model routing belongs in subagent definitions, where it costs no cache. Do not switch the main session's model with the mode.

A classifier is worth it in one narrow place: picking the main model once, on the session's first message, as `jev-router` does. At that point there is no cache to lose. Treat that as a separate, optional feature. Other modes (for example review-only, or no delegation) fit the same mechanism: a named tool-call policy plus a message, never a tool-set or model change.

### (b) Idle compaction

The real cost is the cold restart: up to 25× a warm turn on a large context. Pi's compaction cannot reduce it, because its summary request is uncached. A compaction run just before expiry costs the same as one run after it, about $0.26 input plus about $0.03 output at mid tier for 130k tokens. The next turn then still writes the new context. The cache-friendly way to shrink the context is the handoff session-limits already does.

**B1. Pi `ctx.compact()` on a timer** at a fixed idle time.
- Pros: about 20 lines of code.
- Cons: no cache saving. The cost is paid even if the user never returns. Summaries lose detail, and the repo's design already prefers handoff to compaction.

**B2. Idle handoff while the cache is still warm.** This extends session-limits.
1. On `agent_settled`, if context ≥ `idleRatio` of the window (for example 0.4), arm a timer for the cache lifetime minus a margin, measured from the start of the last request. Take the lifetime from the model's `promptCache` tier.
2. If pi is idle-warming, fire instead when pi decides to stop warming (`cache_warming_decision` with `stop`, or the 30-minute horizon).
3. When the timer fires, send the existing handoff instruction. That turn reads the warm cache.
4. Switch to the seeded new session as today.
- Cost at mid tier: about $0.015 to read the cache, about $0.03 for a 3k-token handoff, and about $0.05 for the first write of the 20k seed. Total about $0.10, against $0.375 for a cold turn. If the user returns, this saves about $0.27, and each later turn reads about 20k tokens instead of 150k.
- Break-even is a return probability of about 15%, the same figure pi uses for idle warming.
- Pros: this is the user's idea, done at the one moment it saves money. It reuses the handoff file, validation, switch and busy channel. It also makes month-long sessions impossible.
- Cons: with a 5-minute lifetime it fires about 4.5 minutes after the user stops, which is a short coffee break. That is a loss of detail for a cheap saving. The turn runs while the user is away, and must wait while subagents are busy, as switches already do.

**B3. Handoff on return.** When the user's first prompt arrives after the cache has expired and context ≥ `idleRatio`, handle the input, run the handoff, then deliver the prompt to the new session.
- Pros: never wasted if the user does not come back.
- Cons: the handoff turn is itself cold (about $0.40 plus output), so it saves nothing on that turn. It delays the user's reply.

**Recommendation: B2, gated so it never fires early.** Fire only when the cache is about to expire for good. That means long retention (`PI_CACHE_RETENTION=long`, 30 minutes to 1 hour) or the end of pi's idle warming, and context ≥ `idleRatio`. With a 5-minute lifetime and no warming, do nothing by default. This is the same choice Claude Code made, limiting idle compaction to the 1-hour TTL. Do not use pi's `compact()` for it.

## Open questions for the owner

1. Is a hard read-only guarantee in plan mode wanted, or is the existing "plan with `planner` first" prompt enough, so that only the toggle is new?
2. Should the main session's model ever change with the mode, accepting one cold turn per switch? Or should strong and cheap models stay purely a matter of agent definitions?
3. Which cache tier do you actually run on: 5-minute default, 30-minute, or 1-hour/long? This decides whether B2 is useful by default.
4. What `idleRatio` makes a handoff worth it? A 40% floor is only a suggested starting point.
5. Should an idle handoff while subagents are running wait, as today, and so risk a cold restart? Or should it be skipped for that idle period?
6. Is a new session after a long break acceptable even when the user would have continued the same thread? This trades detail for cost.
7. Is "pick the main model once from the first message" (jev-router style) wanted as a separate feature?
