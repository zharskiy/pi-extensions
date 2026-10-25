# shared architecture

Pi-free, theme-free, host-free helpers that more than one extension, or an extension's `core/`, needs. It imports only `platform/pi-adapter/index.ts` and node built-ins, and every other layer may import it through `index.ts`, including an extension's `core/`. That is why the plugin contract types live here rather than in `platform/extension-manager/`: `core/` may not import the manager, but its plugins and events need the types.

## What may enter

A module belongs in `platform/shared/` only when all of these hold:

- It imports nothing but node built-ins, other `platform/shared/` files and `platform/pi-adapter/index.ts`, and from the adapter only types and the row geometry constants.
- No function takes a `Host` or an `AgentRuntime`; a module that needs one belongs to `platform/extension-manager/` (or to the extension).
- It paints no theme. Measuring text through `ThemeLike`'s `width` and `wrap` is fine; calling `fg`, `bg`, `bold` or `inverse` is not, and such a module belongs to `platform/ui-kit/`.

The accent rule that used to live here (`rule`) now sits in `platform/ui-kit/key-hints.ts` next to its only caller, so the rule holds without exceptions.

## Modules

- The plugin contract (`plugin-contract.ts`): `Plugin`, `Disable`, `Bus`, the service registry type, the event map type and `ExtensionPaths`; `platform/extension-manager/` implements them.
- Settings files (`settings-files.ts`): the schema type, `parseSettings`, `readText`, `readSettingsFile`, the user and project paths, `readSettingsFiles` and `loadSettingsFiles`, the user-then-project merge with its error list.
- The cross-extension contract. Extensions never deep-import each other, so the formats two of them share live here. `handoff-document.ts` holds the handoff sections, `HandoffValidation` and `validateHandoff`, used by session-limits and subagents. `handoff-limits.ts` holds the `Limits` settings type and `thresholdsFor` (the handoff thresholds for a window), used by session-limits and the footer. `handoff-prompt.ts` and `handoff-prompt.md` hold the handoff instruction template (the first non-TypeScript file here, a prompt asset read by its own module), the main and agent audiences, `handoffInstruction`, `handoffRetry`, `successorPreface` and `seedText`, used by session-limits and subagents. `handoff-budget.ts` holds the pure handoff budget evaluator: `HandoffBudget`, `budgetLevel` (unknown, normal, soft or hard for a token count) and `budgetStep` (none, warn, request or abort from the tokens and the request state), used by session-limits for its level and by subagents for its steps. `host-channels.ts` holds the channel names of pi's shared event bus (`pi:busy`, `pi:awaiting-input`, `spending:usage`, `spending:totals`, `session-limits:limits`), their payload types and parsers, `SPENDING_STATUS_KEY` and `AGENTS_HINT_KEY` (the subagents hint status the footer shows in its hint row).
- Formatting (`format.ts`): `formatTokens` and `formatDuration` (footer, working indicator, context, subagents); `formatWindow`, the context window in whole thousands or tenths of a million (footer, context); `errorText` (the settings loader, session-limits, subagents); `homeRelative`, a path under the home directory as `~/…` (context, mcp-import); `shortPath`, a path relative to the working directory or else home-relative (transcript rows); `noun` and `counted` (`1 agent`, `3 agents`); `formatCost` (`$0.04`, `<$0.01`, zero omitted) and `formatMoney` (the same with zero as `$0.00`; footer, spending).
- The cache hit rate (`cache-hit.ts`): `reportedCache`, `cacheHitPercent`, `sessionCacheHit` over the adapter's prompt token figures; its colour is `platform/ui-kit/cache-tone.ts`.
- Text layout (`text-layout.ts`): `DOT`, the one ` · ` separator; `ELLIPSIS`, pi's ASCII `...` and the only cut mark; `cutStart`, a cut at the start by columns; `prefixed`/`padded`, wrapped lines behind a lead; `fixedBlock`, text wrapped to exactly N rows with the last cut by `...` and short text padded with blank rows; `padRows`, lines padded with blank rows or cut to exactly N.
- `isPlainObject` (`plain-object.ts`), the guard the parsers share.
