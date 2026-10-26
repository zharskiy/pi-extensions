# Spending structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `createManagedExtension` with namespace `pi-spending` and `spendingPlugin`.
- `api/plugin.ts`: `spendingPlugin`; subscribes to the usage channel and the session hooks, sets the `mirror:spending` status and publishes the totals.
- `core/spending.ts`: `createSpending`; main offsets, parent inheritance, resume, report recording and the totals.
- `core/ledger.ts`: `createLedger`; high-water figures per `(source, id)`, persistence as `pi-spending:usage` entries, continuation marker.
- `ui/footer-text.ts`: `footerText`; the `main $x · agents $y · total $z (sub)` segment.
- `tests/spending.test.ts`: the extension booted on a fake host (channels, persistence, lineage).
- `tests/ledger.test.ts`: ledger unit tests.
- `tests/footer.test.ts`: footer segment text.
