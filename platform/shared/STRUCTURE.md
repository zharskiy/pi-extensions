# shared structure

Admission rule: a module lives here only if it imports nothing but node built-ins, other `platform/shared/` files and `platform/pi-adapter/index.ts` (types and the row geometry constants), takes no `Host` or `AgentRuntime`, and paints no theme. It may also hold a Markdown prompt asset read by its own module (`handoff/handoff-prompt.md`). Anything that needs a host belongs to `platform/extension-manager/`, anything that paints to `platform/ui-kit/`. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

Modules are grouped by concern; `index.ts` is the only import surface, so a move inside the folder never reaches a caller.

- `index.ts`: the public surface.
- `plugin/`: what the extension manager and every plugin agree on.
  - `plugin-contract.ts`: the plugin, disable, bus, service registry, event map and extension paths types.
  - `settings-files.ts`: the settings schema, file parsing and the user-then-project merge, `readText`.
- `handoff/`: the handoff format session-limits and subagents share.
  - `handoff-document.ts`: the handoff sections, `validateHandoff`, `HandoffToolRows`, the seed and request details and types, `handoffPath`.
  - `handoff-budget.ts`: `Limits`, `thresholdsFor`, `HandoffBudget` (request and warn lines), `StepBudget` (adds the abort policy), `budgetLevel`, `budgetStep`.
  - `handoff-prompt.ts`, `handoff-prompt.md`: the handoff instruction template, `HandoffAudience` and the builder, retry text and seed text.
  - `handoff-tool.ts`: `handoffTool`, `HandoffTarget`.
- `channels/`: how extensions talk without importing each other.
  - `host-channels.ts`: the busy, background-work, awaiting-input, usage, totals and limits (`LIMITS_CHANNEL`, `parseLimits`) channel names, payloads and parsers.
  - `status-keys.ts`: `HINT_STATUS_PREFIX`, `MIRROR_STATUS_PREFIX`, the status-key roles the footer reads.
- `text/`: theme-free text helpers.
  - `format.ts`: token, window, duration, error-text, `~/` and short path formatters, `noun`/`counted`, `formatCost` and `formatMoney`.
  - `text-layout.ts`: `DOT`, `ELLIPSIS`, `cutStart`, `prefixed`, `padded`, `fixedBlock`, `padRows`.
- `cache-hit.ts`: the cache hit rate of a request and of the session.
- `plain-object.ts`: `isPlainObject`.
- `tests/format.test.ts`: `format.ts`.
- `tests/handoff-budget.test.ts`: `budgetLevel`, `budgetStep` and `thresholdsFor`.
- `tests/handoff-tool.test.ts`: `handoffTool`.
- `tests/handoff-prompt.test.ts`: the instruction over test audiences, retry and seed text.
- `tests/handoff-document.test.ts`: `validateHandoff`.
- `tests/host-channels.test.ts`: the channel payload parsers.
- `tests/text-layout.test.ts`: `fixedBlock` and `padRows`.
