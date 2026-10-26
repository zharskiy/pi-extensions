# shared architecture

Pi-free, theme-free, host-free helpers that more than one extension, or an extension's `core/`, needs. It imports only `platform/pi-adapter/index.ts` and node built-ins, and every other layer may import it through `index.ts`, including an extension's `core/`. That is why the plugin contract types live here rather than in `platform/extension-manager/`: `core/` may not import the manager, but its plugins and events need the types.

## What may enter

A module belongs in `platform/shared/` only when all of these hold:

- It imports nothing but node built-ins, other `platform/shared/` files and `platform/pi-adapter/index.ts`, and from the adapter only types and the row geometry constants.
- No function takes a `Host` or an `AgentRuntime`; a module that needs one belongs to `platform/extension-manager/` (or to the extension).
- It paints no theme. Measuring text through `ThemeLike`'s `width` and `wrap` is fine; calling `fg`, `bg`, `bold` or `inverse` is not, and such a module belongs to `platform/ui-kit/`.

The accent rule that used to live here (`rule`) now sits in `platform/ui-kit/key-hints.ts` next to its only caller, so the rule holds without exceptions.

## Modules

Modules are grouped by concern in four folders, plus two single-purpose modules at the top; `index.ts` re-exports them all and stays the only import surface.

- `plugin/`, the contract between the extension manager and the plugins.
  - `plugin-contract.ts`: `Plugin`, `Disable`, `Bus`, the service registry type, the event map type and `ExtensionPaths`; `platform/extension-manager/` implements them.
  - `settings-files.ts`: the schema type, `parseSettings`, `readText`, `readSettingsFile`, the user and project paths, `readSettingsFiles` and `loadSettingsFiles`, the user-then-project merge with its error list.
- `handoff/`, the handoff format. Extensions never deep-import each other, so the formats two of them share live here; session-limits and subagents share these.
  - `handoff-document.ts`: the handoff sections, `HandoffValidation`, `validateHandoff`, the `HandoffToolRows` type of the handoff tool's rows, the `HandoffSeedDetails` and `HandoffRequestDetails` types of the seed and request messages (a manual request carries its `command` label, so the row names the command without knowing it), their custom types `HANDOFF_REQUEST_TYPE` and `HANDOFF_SEED_TYPE`, and `handoffPath` (`<OS temp dir>/pi-handoff/<session id>/main-handoff.md` or `<agent id>-handoff.md`).
  - `handoff-budget.ts`: the handoff thresholds and the pure budget evaluator. `Limits` is the settings type and `thresholdsFor` the soft and hard thresholds for a window (session-limits and the footer); `HandoffBudget` (the request and warn lines), `StepBudget` (that plus the abort policy: ceiling, grace turns and the turn cap, which only agents have), `budgetLevel` (unknown, normal, soft or hard for a token count) and `budgetStep` (none, warn, request or abort from the tokens and the request state), used by session-limits for its level and by subagents for its steps.
  - `handoff-prompt.ts` and `handoff-prompt.md`: the handoff instruction template (the only non-TypeScript file here, a prompt asset read by its own module through `import.meta.dirname`), the `HandoffAudience` type (statuses, status hint, reader, extra rules, next hint), `handoffInstruction` (which loads the template itself and fills it from the audience it is given), `handoffRetry` and `seedText`. The audiences and successor prefaces belong to their consumers: the main audience and the session preface to session-limits, the agent audience and the chain preface to subagents; each passes its audience's `statuses` to `validateHandoff`.
  - `handoff-tool.ts`: `handoffTool`, the `handoff` tool both consumers use (a `target()` for the path and whether a handoff was requested, a `validate`, injected rows and an `onSaved` callback; it refuses unless requested, writes the content, validates it and reports the result).
- `channels/`, how extensions talk at run time.
  - `host-channels.ts`: the channel names of pi's shared event bus (`pi:busy`, `pi:background-work`, `pi:awaiting-input`, `spending:usage`, `spending:totals`, `session-limits:limits`), their payload types and parsers. `pi:background-work` is `{ source, count }`: the units of work a source has in flight that will reach the main session on their own (subagents counts background batches until the model has answered their wake); a consumer keeps the last count per source and treats the session as settled only when every count is 0 (the transcript's answer rule).
  - `status-keys.ts`: the status-key roles, never a concrete key: `HINT_STATUS_PREFIX` (`hint:`, a status the footer draws in its hint row and leaves out of its status lines) and `MIRROR_STATUS_PREFIX` (`mirror:`, a status that mirrors a figure the footer draws itself, hidden by it); each extension builds its own key under one of them.
- `text/`, theme-free text helpers.
  - `format.ts`: `formatTokens` and `formatDuration` (footer, working indicator, context, subagents); `formatWindow`, the context window in whole thousands or tenths of a million (footer, context); `errorText` (the settings loader, session-limits, subagents); `homeRelative`, a path under the home directory as `~/…` (context, mcp-import); `shortPath`, a path relative to the working directory or else home-relative (transcript rows); `noun` and `counted` (`1 agent`, `3 agents`); `formatCost` (`$0.04`, `<$0.01`, zero omitted) and `formatMoney` (the same with zero as `$0.00`; footer, spending).
  - `text-layout.ts`: `DOT`, the one ` · ` separator; `ELLIPSIS`, pi's ASCII `...` and the only cut mark; `cutStart`, a cut at the start by columns; `prefixed`/`padded`, wrapped lines behind a lead; `fixedBlock`, text wrapped to exactly N rows with the last cut by `...` and short text padded with blank rows; `padRows`, lines padded with blank rows or cut to exactly N.
- `cache-hit.ts`: `reportedCache`, `cacheHitPercent`, `sessionCacheHit` over the adapter's prompt token figures; its colour is `platform/ui-kit/cache-tone.ts`.
- `plain-object.ts`: `isPlainObject`, the guard the parsers share.
