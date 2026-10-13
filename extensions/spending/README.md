# spending

A pi extension that shows what the whole session has cost: the main session plus everything other extensions spend on its behalf, such as the subagents extension in this repository with agents at any depth.

It knows nothing about agents or any other extension. Extensions that spend money outside the main session's own messages report their usage on a channel, and this extension adds it up.

## What it does

- A footer segment `main $x · agents $y · total $z`. `main` is pi's own accounting of the main session; each reporting source gets its own figure, named by the source's label (the subagents extension reports as `agents`); `total` is the sum. With several sources each is listed: `main $x · agents $y · jobs $w · total $z`. Sessions on a subscription get a ` (sub)` suffix.
- The segment is hidden while every source total is zero. `total` is the sum of the displayed (3-decimal) figures, so the footer always adds up.
- The figures are refreshed on every report, on every turn end and whenever the session goes idle.
- Reported figures are written to the session file as custom entries of type `pi-spending:usage`: on idle and on shutdown, and only for figures that changed since the last write. A resumed session restores them, so it shows the same totals.
- The totals cover the session's whole lineage: compaction and `/tree` navigation keep every entry in the session file, and a `/fork`, `/clone` or handoff switch (see session-limits) inherits the totals of the session it came from (the parent's agent figures are copied in under ids prefixed with the parent session file name, so a new agent can never clash with a parent agent, and its main spend is kept as a `pi-spending:main-offset` entry). Only a plain `/new` starts again at zero. A fork of a session without a file (`pi --no-session`) has no parent file to read and starts from the copied messages only.

## Usage channel

Any extension can add its spend by emitting on pi's event bus:

```ts
pi.events.emit("spending:usage", { source: "agents", id: "a1b2", usage });
```

- `source` is a short non-empty display label of the reporting extension, shown in the footer. `id` is a non-empty string unique within the source for the whole session, earlier runs of a resumed session included, one per thing that spends (an agent, a job); the subagents extension sends the agent id, which is unique within the session's agents folder.
- `usage` is the absolute running total for that id so far, not an increment: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`, all non-negative numbers. Reports are idempotent: the extension keeps the highest figure per `source`/`id` (higher cost or more tokens) and ignores lower or repeated ones, so sending the same total twice is harmless.
- Other payloads are ignored.
- Report only spend that pi does not already count in the main session: anything that ends up in the main session's own messages is part of `main`.
- Nothing is imported from this extension; when it is not installed the reports simply go unheard.
- Reports are accepted until this extension's own shutdown. pi shuts extensions down one at a time in load order and the session goes read-only for an extension once its shutdown handler returns, so an extension that reports its final figures while shutting down must be listed before spending in `pi.extensions` (the subagents extension is).

## Totals channel

Spending also publishes what it adds up, for extensions that show it themselves (the footer extension in this repository):

```ts
pi.events.on("spending:totals", (totals) => {}); // { main: { cost, tokens }, sources: [{ source, cost, tokens }], subscription }
```

- The totals are published on every refresh: session start, each accepted report, every turn end and idle. pi sets up every extension before it starts the session, so a listener hears the session-start publish whatever the load order.
- `tokens` are chargeable tokens: `input + output + cacheRead + cacheWrite`. Main tokens carry over a fork or handoff like main cost, through a `pi-spending:main-tokens-offset` entry. A parent session forked before that entry existed has none, so main tokens leave out what its own parents spent, while main cost stays correct; every session forked from now on writes the entry, so new chains count fully.
- `subscription` is true when pi reports a subscription for the model (the segment's ` (sub)` suffix).
- The footer segment keeps the status key `pi-spending`, exported as `SPENDING_STATUS_KEY` from `core/manager/channels.ts`, so an extension that shows the totals itself can leave the segment out.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); everything else depends on `core/adapter/contract.ts`. `src/spending.ts` wires the channel, the footer and persistence, `src/ledger.ts` keeps the high-water figures and parses reports, `src/footer.ts` formats the segment. The channel name and report parser are shared in `core/manager/channels.ts`. Tests are under `test/`.
