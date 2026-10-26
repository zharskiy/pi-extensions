# Footer structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `createManagedExtension` with namespace `pi-footer` and `footerPlugin`.
- `api/plugin.ts`: `footerPlugin`; sets the footer at session start and refreshes it on new totals, on a `session-limits:limits` payload and on idle.
- `core/status.ts`: `watchChannel`; subscribes to a bus channel (`spending:totals`, `session-limits:limits`) and keeps the last valid payload.
- `core/segments.ts`: `FooterState`, `footerState` (live host values and the session cache hit), `folderName`, `sessionSpend`, `statusLines` (statuses outside the hint and mirror prefixes), `hintTexts` (statuses under the hint prefix), `contextBase` (the window with no level, so untoned, or the handoff point of the shared `mainBudget` with the shared `budgetLevel` of the count).
- `ui/layout.ts`: `Segment` and `spread`; fit prioritised segments to a width, left and right aligned; the gap is the width left over once the sides fit.
- `ui/render.ts`: `renderFooter`; builds the place, model, context (compact token count of the base), cache, money and hint-row segments and the status lines.
- `tests/footer.test.ts`: the extension booted on a fake host.
- `tests/render.test.ts`: `renderFooter` token roles, layout, drop order and hint row.
