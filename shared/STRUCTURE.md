# shared structure

Admission rule: a module lives here only if it imports nothing but node built-ins, other `shared/` files and `pi-adapter/index.ts` (types and the row geometry constants), takes no `Host` or `AgentRuntime`, and paints no theme. Anything that needs a host belongs to `extension-manager/`, anything that paints to `ui-kit/`. The one exception, `rule` in `text-layout.ts`, is being moved out. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

- `index.ts`: the public surface.
- `plugin-contract.ts`: the plugin, disable, bus, service registry, event map and extension paths types.
- `settings-files.ts`: the settings schema, file parsing and the user-then-project merge, `readText`.
- `handoff-document.ts`: the handoff sections and `validateHandoff` (shared by session-limits and subagents).
- `host-channels.ts`: the busy, awaiting-input, usage and totals channel names, payloads and parsers, `SPENDING_STATUS_KEY`.
- `format.ts`: token, window, duration, error-text, `~/` and short path formatters, `noun`/`counted`, `formatCost` and `formatMoney`.
- `cache-hit.ts`: the cache hit rate of a request and of the session.
- `text-layout.ts`: `DOT`, `ELLIPSIS`, `cutStart`, `prefixed`, `padded` and the accent `rule`.
- `plain-object.ts`: `isPlainObject`.
- `tests/format.test.ts`: `format.ts`.
- `tests/handoff-document.test.ts`: `validateHandoff`.
- `tests/host-channels.test.ts`: the channel payload parsers.
