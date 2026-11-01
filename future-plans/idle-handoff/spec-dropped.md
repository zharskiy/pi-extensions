# 03 Idle handoff

> Status: dropped. Date: 2026-10-18. The owner dropped idle handoff for now; context size is handled by absolute token thresholds in session-limits, built on their own branch. Kept as research in case the topic comes back.

## Goal

When the main session has been idle long enough that the provider's prompt cache is about to expire for good, and its context is above a floor, session-limits asks the model for the existing handoff document while the cache is still warm and switches to a fresh session seeded with it. No compaction. A session can no longer be kept open for a month.

## Why

- A cold turn on a 150k-token context costs 12–25× a warm one: about $0.375 against $0.015 at a mid-tier price (modes-and-compaction.md §2, "Cost of one turn").
- Pi's compaction is not cache-friendly: "Summarization requests disable prompt-cache writes", tool results are cut to 2000 characters and sent as a new prompt, so a compaction before expiry saves nothing (modes-and-compaction.md §4, option B1).
- The handoff turn is cache-friendly: it appends one user message to the cached prefix. An idle handoff costs about $0.10 and saves about $0.27 per return at mid tier, breaking even at a 15% return probability, the figure pi itself uses for idle warming (modes-and-compaction.md option B2).
- Claude Code made the same choice: idle compaction only on the one-hour TTL, never five minutes after the user stops (modes-and-compaction.md §3).
- Pi gives `agent_settled`, `cacheWarming: idle`, `cache_warming_decision` per refresh (`warm` or `stop`) and the model's `promptCache` lifetimes; it emits no "warming ended" event (pi-capabilities.md §1; spec-review.md feasibility).

## Design

| Step | What happens |
|---|---|
| Arm | On idle (`Host.onIdle`), if context ≥ `idleRatio` of the window and `idleHandoff` is on, record the idle time (the last response has just been written to the cache) and the cache lifetime of the current model. |
| Fire time | Idle time + lifetime − `idleMarginSeconds`, when the lifetime is at least 30 minutes. With pi's idle warming on, the first `cache_warming_decision` with action `stop` (pi's own, after its 30-minute horizon, or one returned by an extension) fires instead. With a 5-minute lifetime and no warming: nothing; this is intended, the saving is too small for the detail lost, and `PI_CACHE_RETENTION=long` is the lever. |
| Cancel | Any user input, a new run, a dialog, a busy source on `pi:busy` (agents running), or a session switch disarms the timer; it re-arms at the next idle. Agents still running at fire time mean skip, not wait. |
| Fire | Send the existing `prompts/handoff.md` instruction; the model writes the six-section file while the cache is warm. The footer segment says `idle handoff`. |
| Switch | The existing flow validates the file and runs `/handoff` when the session settles, seeding the new session. No turn starts; the next prompt goes to the new session. |
| Failure | The existing resend and `stuck` rules apply; an invalid file means no switch and a warning. |

Numbers to ship: `idleRatio` 0.4, `idleMarginSeconds` 60, lifetime floor 30 minutes (fixed, from the research: long retention or the warming horizon). Both thresholds sit below `hardRatio` 0.75, so the size handoff still wins when it comes first.

Handoff quality: the main prompt's "Session handoffs" rule already lists delegated agents and result files; 01-workflows.md adds the current workflow stage and artefact paths, so the fresh session continues the stage.

## User surface

- Nothing to run. A footer segment `idle handoff` appears while the file is written, then the usual switch.
- Settings (`pi-session-limits.json`):

```json
{
  "softRatio": 0.6,
  "hardRatio": 0.75,
  "idleHandoff": true,
  "idleRatio": 0.4,
  "idleMarginSeconds": 60
}
```

`idleHandoff: false` turns it off. `idleRatio` is a fraction of the window. The margin is clamped to at most half the lifetime. The cache tier is pi's: `PI_CACHE_RETENTION` unset by default, `long` when the company pays for it.

## Architecture

- `core/adapter/contract.ts`: two additions. `Host.cacheLifetimeSeconds()` returns the current model's `promptCache` tier honouring `PI_CACHE_RETENTION`; `Host.onCacheWarmingDecision(handler)` forwards pi's `cache_warming_decision` (`warm` or `stop`). No request-time or warming-mode surface: the idle time is the reference.
- `extensions/session-limits/src/idle.ts`: the timer (started at idle, cleared on cancel and shutdown, unref'd), the arm and cancel rules above; pure decisions in `thresholds.ts` (`idleDue(now, idleAt, lifetime, margin)`); settings in `settings.ts`.
- `limits.ts` gets one new phase, `idle-requested`, which reuses the request, validate and switch path of the size handoff.
- Rules kept: only the adapter imports pi; session-limits still knows nothing about other extensions (busy channel only); the only file is the existing handoff file in the OS temp dir, already in the file-location rule, so AGENTS.md is unchanged.

## Out of scope

Compaction on a timer; a handoff on return (B3); changing pi's cache warming; any change to agents (their sessions never compact and never warm, `cacheWarming: off` in the child).

## Open questions for the owner

1. Which cache tier does the company run: 5-minute, 30-minute or 1-hour? With the default 5-minute tier and warming off this feature does nothing (modes-and-compaction.md open question 3).

## Acceptance checks

- [ ] With a 60-minute lifetime, context at 50% and no activity, the handoff instruction is sent 59 minutes after idle.
- [ ] With a 5-minute lifetime and warming off, nothing is sent after any idle time.
- [ ] With `cacheWarming: idle`, the instruction is sent on the first `stop` decision.
- [ ] A keypress or a `pi:busy` source before fire time disarms; the timer re-arms on the next idle.
- [ ] Context below `idleRatio` never arms.
- [ ] The seeded session carries the same six sections as a size handoff; no compaction entry appears.
- [ ] `idleHandoff: false` registers no timer; `Host` gains exactly `cacheLifetimeSeconds` and `onCacheWarmingDecision`.
