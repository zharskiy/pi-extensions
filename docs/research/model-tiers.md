# Model tiers for subagent roles

Research note, 2026-10-16. The question is which roles in the subagents workflow need a stronger model, and which `provider/id:thinking` value each shipped agent file should carry. Candidates named by the owner are gpt-6.1-sol, Claude Opus and Claude Sonnet.

Facts marked **[verified]** were read from pi's local catalog, `node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json`, which ships with pi 1.3.0. Benchmark figures come from web sources. Most of those sources are third-party aggregators repeating vendor claims, so treat them as indicative only.

## Summary

- Spend more on the roles that make judgement calls with a small token footprint: **planner** and **reviewer**. Move both from `gpt-6-luna:high` to a frontier model.
- Keep **implementer** and **general** on `gpt-6.1-sol:medium`. These roles burn the most tokens, the model is already frontier-class, and checks catch implementation mistakes cheaply.
- Keep the chores (**scout**, **fetch**, **shell**, **image**) on `gpt-6-luna:low`. It accepts image input [verified], costs $0.10/$0.50, and every vendor positions its small model for exactly this kind of work.
- Use a different model family for the reviewer than for the implementer. A reviewer that shares the implementer's blind spots adds less than one that does not.

## Catalog facts used below [verified]

Prices are USD per million tokens: input / output / cache read. Context is the context window. Thinking lists the levels pi offers for the model, computed by `getSupportedThinkingLevels` in `pi-ai/dist/models.js`. All models listed here have `image` in `input`. The catalog has no release-date field.

- `openai/gpt-6.1-sol`: 2 / 10 / 0.10. 272k context. Thinking low to max, with no `off`. Price rises to 4/15 above 272k input tokens.
- `openai/gpt-6-sol`: 2 / 10 / 0.20. 272k context. Thinking off and low to max.
- `openai/gpt-6-luna`: 0.10 / 0.50 / 0.01. 272k context. Thinking off and low to max. The catalog also has a separate `classifier` entry with the same id, on the `openai-decisions` api, which subagents do not use.
- `openai/gpt-6-astra`: 10 / 50 / 1. 272k context. Thinking low to max.
- `anthropic/claude-opus-5-5`: 4 / 20 / 0.20. 1M context. Thinking low to max, with no `off` or `minimal`.
- `anthropic/claude-sonnet-5-5`: 2 / 10 / 0.10. 1M context. Thinking low to max, with no `off` or `minimal`.
- `anthropic/claude-haiku-5-5`: 0.10 / 0.50 / 0.01. 1M context. Thinking off and low to max. Price rises to 0.50/2.50 above 100k input tokens.
- `anthropic/claude-fable-5-1`: 10 / 50 / 0.25. 1M context. Thinking minimal to max.
- `google/gemini-3.5-flash`: 1.50 / 9 / 0.15. 1.05M context. Thinking minimal to high.
- `google/gemini-3.1-pro-preview`: 2 / 12 / 0.20. 1.05M context. Thinking low to high.
- `google/gemini-3.8-flash`: 0.75 / 3.75 / 0.075. 1.05M context. Thinking low to high.
- Other catalog rows, older or legacy models, are not candidates.
- **Credentials on this machine:** `~/.pi/agent/auth.json` has entries for `openai` and `anthropic` (key names only were read). There is none for google. `~/.pi/agent/settings.json` sets the default model to `openai/gpt-6-luna`. Google picks would need a key before they work here.

## Per-role recommendation

**planner**: `anthropic/claude-opus-5-5:high` ($4 / $20).
- Alternative: `openai/gpt-6.1-sol:high` ($2 / $10).
- Reason: a wrong decomposition sends every later batch down the wrong path. The planner emits few tokens, so a frontier model costs little in total. This mirrors Anthropic's Opus-lead and Cognition's frontier-lead patterns.
- Its read-heavy exploration already goes to scouts, which keeps the planner's input small.

**reviewer**: `anthropic/claude-opus-5-5:high` ($4 / $20).
- Alternative: `openai/gpt-6.1-sol:high` ($2 / $10), the reviewer setup in OpenAI's Codex subagent example.
- Reason: the reviewer's ranked findings decide what ships. A Claude reviewer over a GPT implementer adds model diversity, and Cognition reports gains from pairing frontier Claude and GPT models.
- If cost matters more, `anthropic/claude-sonnet-5-5:high` ($2 / $10) keeps the diversity at half the price.

**implementer**: `openai/gpt-6.1-sol:medium` ($2 / $10), unchanged.
- Alternative: `anthropic/claude-sonnet-5-5:medium` ($2 / $10).
- Reason: this is the largest token consumer, and it runs checks that catch its own mistakes. The marginal gain from Opus is small next to doubling the bill on the biggest line item.
- Raise thinking to `high` per call for hard tasks rather than changing the default.

**general**: `openai/gpt-6.1-sol:medium` ($2 / $10), unchanged.
- Alternative: `anthropic/claude-sonnet-5-5:medium`.
- Reason: as the fallback with all tools, it sees unpredictable work and should match the implementer.

**scout**: `openai/gpt-6-luna:low` ($0.10 / $0.50), unchanged.
- Alternative: `anthropic/claude-haiku-5-5:low` ($0.10 / $0.50 up to 100k input).
- Reason: search and extraction are high-volume and easy to check. Codex runs its read-only explorer on gpt-6-luna, and Claude Code's docs suggest Haiku for Explore.
- Consider `:medium` if scouts that run nested under the planner return thin answers. Codex's own explorer example uses luna at high effort.

**fetch**: `openai/gpt-6-luna:low`, unchanged.
- Alternative: `anthropic/claude-haiku-5-5:low`.
- Reason: turning a page into an answer is extraction with a short output. A small model is enough, and the caller judges the result.

**shell**: `openai/gpt-6-luna:low`, unchanged.
- Alternative: `anthropic/claude-haiku-5-5:low`.
- Reason: running commands and digesting output needs little reasoning. Inputs can be long logs, and luna stays at its base price up to 272k tokens, while Haiku's price rises above 100k.

**image**: `openai/gpt-6-luna:low`, unchanged.
- Alternative: `anthropic/claude-haiku-5-5:low`.
- Reason: both accept image input [verified] at the lowest price in the catalog. Use `:medium` if descriptions of dense UI screenshots or diagrams miss detail.

## Which roles need image input

- Only **image** strictly requires `image` in the model's `input`.
- **implementer** and **general** may receive screenshots in a task, so their models should accept images too.
- Every candidate above does [verified], as do all current openai, anthropic and google chat models in the catalog. The exceptions are legacy rows: `openai/o3-mini` and `openai/gpt-4` are text-only.
- So the image requirement does not constrain any of the picks.

## Where the extra spend pays and where it does not

**Where it pays**
- **Planning and orchestration.** Anthropic's multi-agent research system put an Opus 4 lead over Sonnet 4 workers. It beat single-agent Opus 4 by 90.2% on their internal research eval. Token usage alone explained about 80% of performance variance on BrowseComp, and multi-agent runs used about 15x the tokens of chat. Source: "How we built our multi-agent research system", Anthropic, 2025-06-13, https://www.anthropic.com/engineering/multi-agent-research-system.
  - The lesson for this repo: the lead is a small share of tokens and a large share of outcome. The workers are where the tokens go.
- **Frontier lead, cheap executor.** Cognition's "Multi-Agents: What's Actually Working" (Walden Yan, 2026-04-22) reports the following. Source: https://cognition.com/blog/multi-agents-working.
  - A weak primary model capped quality.
  - Calling a stronger model on hard steps helped.
  - Pairing frontier Claude and GPT models gave real gains on the trickiest cases.
  - Review works best from a clean context that shares nothing with the coder.
- Devin Fusion, previewed 2026-06-29, formalises a frontier "lead" for planning with a cheaper "sidekick" for execution. Cognition claims up to 39% better efficiency, roughly a 46% cost cut. This is unverified and reported second-hand: https://cryptobriefing.com/cognition-devin-fusion-multi-model-coding-agent/ (2026-09-11).
- **Review.** OpenAI's Codex subagent docs put the reviewer on gpt-6.1-sol and the read-only explorer on gpt-6-luna. Their effort guidance reserves high effort for "reviewer or security agents". Source: https://learn.chatgpt.com/docs/agent-configuration/subagents, undated, fetched 2026-10-16.

**Where it does not pay**
- **Search, fetch, shell digests and image description.** Vendors place their small models here.
  - Codex recommends gpt-6-luna for "fast, narrowly scoped agents handling clear, repeatable, or high-volume work".
  - Claude Code's docs suggest overriding Explore with `model: haiku` for cheaper exploration (https://code.claude.com/docs/en/sub-agents, undated, fetched 2026-10-16).
  - Anthropic reportedly positions Haiku 5.5 as a subagent that "pairs well with Opus 5.5 and Sonnet 5.5" (https://beam.ai/agentic-insights/claude-haiku-5-5-subagents, release reported 2026-10-07).
  - No 2026 study measuring search or extraction quality against model size was found. The evidence is vendor practice, not measurement.
- **Review is not monotonic in size.** "Bigger Isn't Always Better" (arXiv 2606.15689, 2026, https://arxiv.org/html/2606.15689v1, seen only as a search snippet) compared five models on 150 review samples.
  - Haiku 4.5 beat Sonnet 4.6 on F1 (0.365 vs 0.343), with 18% higher recall.
  - F1 on real PRs was only 0.066, against 0.847 on synthetic samples, and it fell about 15x from small to large diffs.
  - Conclusion: diff size and scoping matter at least as much as the model. Keep reviewer batches small whatever model the reviewer runs on.

**Token share.** No per-role token data exists for this workflow. The Anthropic figures above are the closest published data, and they put the bulk of tokens on workers.
- Pi records usage per session. Measuring per-agent token share from real runs under `~/.pi/agent` would settle the cost question (see open questions).

**Benchmarks**
- These are vendor claims from aggregators. They conflict on benchmark versions, and no SWE-bench Verified scores were found for the 2026 models.
- gpt-6.1-sol: DeepSWE v1.1 75.2% at high effort (https://www.datacamp.com/blog/gpt-6-1-sol). gpt-6-luna: 66.6% on the same benchmark (https://anotherwrapper.com/tools/llm-pricing/gpt-6-luna).
- claude-sonnet-5-5: SWE-bench Pro 81.3%.
- claude-opus-5-5: SWE-bench Pro 89.9%. This looks implausibly high; verify it before relying on it. Source: https://atomicagent.io/blog/claude-sonnet-5-5/.
- One source puts Sonnet 5.5 above Opus 5.5 on a Terminal-Bench variant (70.6% vs 66.4%).
- gemini-3.5-flash: SWE-bench Pro 55.1%, Terminal-Bench 2.1 76.2% (https://llm-stats.com/blog/research/gemini-3.5-flash-launch, launch 2026-05-19).
- None of these figures is strong enough to rank Opus 5.5 against gpt-6.1-sol for coding. The planner and reviewer picks rest on the role argument and family diversity, not on benchmark gaps.

## Open questions

- **Token share per role.** Pull usage from recent pi sessions to see what fraction goes to planner and reviewer. If it is under about 10%, the Opus upgrade is cheap insurance. If reviews are input-heavy because of large diffs, Sonnet 5.5 is the better reviewer default.
- **Opus vs Sonnet for review.** The arXiv result suggests recall does not grow with size. A small internal eval on past PRs with known bugs would decide this better than public numbers.
- **Planner model and nested scouts.** If the planner reads code itself instead of delegating it, the planner's input grows and the Opus price matters more. Check how often the planner starts scouts.
- **Scout effort.** Is `:low` enough for nested scouts, or do answers come back thin? Codex uses luna at high effort for its explorer.
- **Single-provider fallback.** Both openai and anthropic have credentials here. Users with only one provider need a documented swap: on OpenAI only, the planner and reviewer move to `openai/gpt-6.1-sol:high`; on Anthropic only, the implementer moves to `anthropic/claude-sonnet-5-5:medium` and the chores to `anthropic/claude-haiku-5-5:low`.
- **`off` levels.** `gpt-6.1-sol`, `claude-opus-5-5` and `claude-sonnet-5-5` reject `off`. Any agent file or call-time override that sets `:off` on them would be invalid. Check how pi handles that.
- **Unverified sources.** None of the 2026 benchmark figures came from primary vendor launch pages. The Cognition Fusion numbers are second-hand. The opusplan mode in Claude Code was not checked.
