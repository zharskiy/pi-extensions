# Footer structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `createManagedExtension` with namespace `pi-footer` and `footerPlugin`.
- `api/plugin.ts`: `footerPlugin`; sets the footer at session start and refreshes it on new totals and on idle.
- `core/status.ts`: `watchTotals`; subscribes to `spending:totals` and keeps the last valid payload.
- `core/segments.ts`: `FooterState`, `footerState` (live host values and the session cache hit), `folderName`, `sessionSpend`, `statusLines`.
- `ui/render.ts`: `renderFooter`; paints the stats, session total, place, thinking and status lines.
- `tests/footer.test.ts`: the extension booted on a fake host.
- `tests/render.test.ts`: `renderFooter` lines and colours.
