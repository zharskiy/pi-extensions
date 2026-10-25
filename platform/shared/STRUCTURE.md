# shared structure

Admission rule: a module lives here only if it imports nothing but node built-ins, other `platform/shared/` files and `platform/pi-adapter/index.ts` (types and the row geometry constants), takes no `Host` or `AgentRuntime`, and paints no theme. It may also hold a Markdown prompt asset read by its own module (`handoff-prompt.md`). Anything that needs a host belongs to `platform/extension-manager/`, anything that paints to `platform/ui-kit/`. The one exception, `rule` in `text-layout.ts`, is being moved out. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

- `index.ts`: the public surface.
- `plugin-contract.ts`: the plugin, disable, bus, service registry, event map and extension paths types.
- `settings-files.ts`: the settings schema, file parsing and the user-then-project merge, `readText`.
- `handoff-document.ts`: the handoff sections and `validateHandoff` (shared by session-limits and subagents).
- `handoff-budget.ts`: `HandoffBudget`, `budgetLevel`, `budgetStep`.
- `handoff-prompt.ts`, `handoff-prompt.md`: the handoff instruction template and its builder, retry text, successor preface and seed text.
- `handoff-limits.ts`: `Limits`, `thresholdsFor`.
- `host-channels.ts`: the busy, awaiting-input, usage, totals and limits (`LIMITS_CHANNEL`, `parseLimits`) channel names, payloads and parsers, `SPENDING_STATUS_KEY`, `AGENTS_HINT_KEY`.
- `format.ts`: token, window, duration, error-text, `~/` and short path formatters, `noun`/`counted`, `formatCost` and `formatMoney`.
- `cache-hit.ts`: the cache hit rate of a request and of the session.
- `text-layout.ts`: `DOT`, `ELLIPSIS`, `cutStart`, `prefixed`, `padded`, `fixedBlock`, `padRows` and the accent `rule`.
- `plain-object.ts`: `isPlainObject`.
- `tests/format.test.ts`: `format.ts`.
- `tests/handoff-budget.test.ts`: `budgetLevel` and `budgetStep`.
- `tests/handoff-prompt.test.ts`: the instruction, retry, preface and seed text.
- `tests/handoff-document.test.ts`: `validateHandoff`.
- `tests/handoff-limits.test.ts`: `thresholdsFor`.
- `tests/host-channels.test.ts`: the channel payload parsers.
- `tests/text-layout.test.ts`: `fixedBlock` and `padRows`.
