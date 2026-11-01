# Spec 03 idle handoff: review (Q6) and provider cache table (Q7)

Pi version: `@earendil-works/pi-coding-agent` 1.3.0. CW = `node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js`.

## Q6. Does 03 do what the owner expects?

### Trace
1. Arm (03:19): on `Host.onIdle`, if context ≥ `idleRatio` × window, record idle time and lifetime.
2. Fire (03:20): idle + lifetime − 60 s, only when lifetime ≥ 30 min. With `cacheWarming: idle`, first `stop` decision fires instead. 5 min lifetime, no warming: nothing.
3. Cancel (03:21): input, run, dialog, `pi:busy`, session switch.
4. Fire (03:22): sends `prompts/handoff.md` through `limits.ts:79-105`.
5. Switch: on settle, `check(true)` (`limits.ts:367-376`) sees a valid file and dispatches `/handoff` (`limits.ts:148-153, 176-187`); `performSwitch` calls `control.newSession({parentSession, seed})` (`limits.ts:235-277`).
6. Seeded session: adapter writes the seed with `triggerTurn: false` (`core/adapter/pi-adapter.ts:55-66`). No provider request; pi's warmer starts only on a real request (`sdk.js:262-271`). The new session costs nothing until the user types. This half of the expectation is met.

### Findings
- F1. `idleRatio` 0.4 never arms on current Claude models: `contextWindow` is 1,000,000 for Opus 5/5.5, Sonnet 5/5.5, Fable, Haiku 5.5 (`pi-ai/dist/providers/data/anthropic.json`), so the floor is 400k. `hardRatio` 0.75 = 750k. Use an absolute token floor (e.g. 60k) or a cold-turn cost floor from `model.cost`.
- F2. Wrong reference point: Anthropic measures the TTL "from the start of the request that writes or reads the entry, so time spent streaming a response counts against it". Pi's warmer uses request start (`startedAt`, CW:141). A spec-writing turn streaming 2–3 min plus a 60 s margin puts the fire after expiry. Use last request start; margin ≥ 120 s.
- F3. "Fire on first `stop`" misses pi's silent stops: `cache_warming_decision` is emitted only inside `refresh()` (CW:213); the 30 min idle limit stops warming silently in `onAgentSettled` (CW:149-160) and `schedule()` (CW:197), and after a missed deadline (CW:194). Opus 5.5, 150k, 5 min tier: pi warms at 4.5, 9 … 27 min, then stops silently at 31.5; 03 never fires. 1 h tier with warming: first refresh would be at 54 min, past the 30 min limit; pi stops at settle with no event. Fix: always keep a timer at last request start + lifetime − margin; re-arm after each `warm` decision; `stop` fires immediately.
- F4. With warming on, 03 fires on a 5 min cache: Sonnet 5.5 at 150k saving 0.15 × $0.36 − $0.015 = $0.039 < $0.05, so pi returns `stop` at 4.5 min and 03 fires with ~30 s left. Contradicts 03:20.
- F5. OpenAI and Bedrock get nothing: only `anthropic.json` carries `promptCache` (`{short:300, long:3600}`). `getPromptCacheTtlMs` (CW:26-33) returns undefined elsewhere; `Host.cacheLifetimeSeconds()` would be undefined. Needs `modelOverrides` `promptCache` (pi `models.md` lines 94-100) or a per-API default table.
- F6. Sleeping laptop: `setTimeout` does not run during sleep; fires late, cache cold. Pi guards with `refreshDeadlineMissed` (CW:194). 03 needs: if now > reference + lifetime, do not send. Lid closed at 18:00 never gets the 59-minute handoff. The one real argument for firing earlier.
- F7. Seed preface says the previous session "reached its context limit" (`extensions/session-limits/src/handoff.ts:14`); needs idle wording. `PI_CACHE_RETENTION=long` does nothing on GPT-5.6+ (pi sends `ttl: "30m"`, already default, `pi-ai/dist/api/openai-responses.js:94-101`).

### Fire at idle or at lifetime minus margin?
Sonnet 5.5, 150k: $2 input, $2.50 5-min write, $4 1-h write, $0.10 read, $10 output.
- Warm handoff turn: ≈ $0.05, paid whenever it fires.
- New session's first turn: ~25k tokens, $0.06 (5 min) or $0.10 (1 h), paid only if the user returns.
- Cold return without handoff: $0.375 (5 min) or $0.60 (1 h).
- Break-even: 0.05 / (0.375 − 0.06) ≈ 16% (1 h: 10%; Opus 5.5: 14%).
03:11's "$0.10 always, $0.27 saved" gives 27%, not 15%; 15% holds only with the seed write counted on return, which is what the code does. Correct the text.
Firing at idle: pays $0.05 every idle, loses detail; strictly worse than waiting except for sleep robustness.
Fixed 10-minute cold handoff on 5 min tier, no warming: ~$0.405 always; first return saves $0.315; net −$0.09 if the user returns once; breaks even after ~7 warm turns or one more cold restart. Roughly neutral if return certain, a loss otherwise. Cheaper alternative: fire warm at request + 4 min on the 5 min tier (same 16% break-even); research rejected it on detail loss, not cost.

### Recommendation
- Replace `idleRatio` with `idleMinTokens` (default 60k) or a cold-turn cost floor.
- Reference = last request start. Timer always; re-arm on `warm`; fire on `stop`; skip when the deadline has passed (sleep).
- `idleMinLifetimeSeconds` setting (default 1800); set 0 for "never come back cold" on the 5 min tier.
- Optional `idleFireAfterSeconds` cap: fire at min(lifetime − margin, cap) for laptops that sleep. 15 min cap on 1 h tier costs an extra $0.05 when the user returns between 15 and 60 min.
- OpenAI lifetime fallback (F5). Fix seed wording and break-even text.

## Q7. Prompt cache behaviour by provider (October 2026)

| Provider | Default TTL | Max TTL / how | Write / read vs input | Refreshed on hit? | Source |
|---|---|---|---|---|---|
| Anthropic direct | 5 min from request start | 1 h via `cache_control: {type:"ephemeral", ttl:"1h"}`; no longer tier documented | 5 min write 1.25×, 1 h write 2×; read 0.1× (0.05× Opus/Sonnet 5.5, 0.025× Fable/Mythos 5.1) | Yes, free; no SLA | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Anthropic on Bedrock | 5 min | 1 h on current Claude models (Jan 2026) | same | Yes | https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching |
| Anthropic on Vertex | 5 min | 1 h via `ttl:"1h"` | 1.25× / 2× / 0.1× | Yes | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching |
| OpenAI GPT-5.6+ | 30 min after latest write or reuse | 30 min only (`prompt_cache_options.ttl:"30m"`) | write 1.25×, read 0.1× (0.05× GPT-6.1 Sol) | Yes, "refreshes its lifetime without another cache-write charge" | https://developers.openai.com/api/docs/guides/prompt-caching |
| OpenAI ≤5.5 | `24h` (no ZDR) or `in_memory` (5–10 min idle, ≤1 h) | `prompt_cache_retention:"24h"`: "typically ~30 min, up to 24 h" | no write charge; cached read rate | Yes; best-effort | same |
| OpenAI on Azure | same split; GPT-5.6+ `ttl:30m` | `prompt_cache_retention:"24h"` (deprecated on 5.6+) | same | Yes | https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching |
| Gemini implicit | on by default 2.5+; no stated lifetime (~3–5 min observed) | Gemini 4 Argon+: implicit only | read 0.1× (3.1 Pro, 3.6/3.8 Flash), 0.05× (4 Argon); no write fee | undocumented | https://ai.google.dev/gemini-api/docs/caching |
| Gemini explicit | 1 h | any `ttl` / `expire_time` | read 0.1× plus storage per MTok·h | No; fixed TTL | https://ai.google.dev/gemini-api/docs/generate-content/caching |
| OpenRouter | passes upstream; sticky routing 10 min idle | Anthropic `ttl:"1h"` passes; OpenAI ttl dropped | upstream | upstream | https://openrouter.ai/docs/guides/best-practices/prompt-caching |
| xAI | not published; best-effort | `x-grok-conv-id` header | no write fee; read ~0.25× | not stated | https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works |
| Mistral | not published; `prompt_cache_key` no guarantee | none | read 0.1× | not stated | https://docs.mistral.ai/studio/conversations/advanced/prompt-caching |
| DeepSeek | disk cache, cleared within hours to days | none | no write premium; read ~0.1× | usage-based | https://api-docs.deepseek.com/guides/kv_cache |
| Groq | "expires after 2 hours without use"; GPT-OSS only | none | no write fee; read 0.5× | implied | https://console.groq.com/docs/prompt-caching |
| Local / Ollama | no billed cache; `keep_alive` default 5 min | `OLLAMA_KEEP_ALIVE` | $0 | n/a | https://docs.ollama.com/faq |

Caveats: DeepSeek and xAI rates from OpenRouter or secondary sources; Groq page about a year old.

### Implications for 03
- Anthropic 1 h (`PI_CACHE_RETENTION=long`): fire at last request start + 3600 − margin (≥ 120 s); re-arm on every warm request. Pi passes retention to Bedrock (`bedrock-converse-stream.js:634-645`) but carries no `promptCache` for Bedrock or Vertex models; without `modelOverrides`, 03 is inert there.
- OpenAI GPT-5.6+: sliding 30 min, no longer option; `PI_CACHE_RETENTION` changes nothing. Fire at request start + 1800 − margin; the 30 min floor is borderline, state "≥ 1800". Needs `modelOverrides: {promptCache: {short: 1800, long: 1800}}` or a built-in fallback.
- OpenAI ≤5.5 with 24h: "typically" 30 min, best-effort to 24 h; use the conservative 1800 s.
- Lifetime-minus-margin is wrong for: Gemini implicit, xAI, Mistral (best-effort, unpublished); DeepSeek and Groq (hours-long, cheap cold read, nothing to save); Gemini explicit (fixed TTL, not refreshed, pi does not create); local (no money). For all: do nothing unless a lifetime is declared; state it.
- `Host.cacheLifetimeSeconds()` should mirror `getPromptCacheTtlMs` (CW:26-33): `promptCache[PI_CACHE_RETENTION === "long" ? "long" : "short"]`, honour per-request `cacheRetention`, undefined for `none`. Deadline = last request start + value − margin. Sliding re-arm on warm or any user turn matches every provider that refreshes on hit.
