<div align="center">

# spending

**What the whole session has cost, in the footer, subagents at every depth included.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Usage channel](#usage-channel) · [Totals channel](#totals-channel) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

Pi's own accounting covers the main session's messages. Background agents and other extensions spend money outside them, which that figure does not show. This extension adds the main session and everything other extensions spend on its behalf into one total, and keeps it across resume, fork and handoff. It knows nothing about agents or any other extension: they report their usage on a channel, and it adds it up.

## What it looks like

```
main $0.12 · agents $0.05 · total $0.17 (sub)
```

A segment in pi's footer, shown once a reporting source such as `agents` has spent something.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs spending with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/spending/index.ts
```

| You do | You see |
|---|---|
| Work in the main session only | No segment yet: it stays hidden while no reporting source has spent anything. |
| Run a background agent with [subagents](../subagents/README.md) | `main $x · agents $y · total $z` in the footer, refreshed as the agent works. |
| Quit and resume the session | The same totals as before you quit. |

## What it does

The segment shows one figure per source and their sum. `main` is pi's own accounting of the main session; each reporting source gets its own figure, named by the source's label (the subagents extension reports as `agents`); `total` is the sum.

- **Several sources** are each listed: `main $x · agents $y · jobs $w · total $z`.
- **` (sub)` suffix** for sessions on a subscription: pi reports OAuth sign-in for the main model and the provider marks that sign-in as a subscription, the same check pi's own footer makes.
- **Hidden** while every source total is zero; spend in the main session alone does not show it.
- **Money format** is the shared one from `platform/shared/format.ts` (`formatMoney`, over `formatCost`), the same as the footer extension: two decimals (`$0.12`), `<$0.01` for a cost under a cent, `$0.00` for nothing. `total` is the raw sum rounded once, so it can differ from the sum of the displayed figures by a cent.
- **Refreshed** on every report, on every turn end, after every compaction and whenever the session goes idle.
- **Persisted and resumed**: reported figures are written to the session file as custom entries of type `pi-spending:usage`. A resumed session restores them, so it shows the same totals.
- **Whole lineage**: compaction, `/tree`, `/fork`, `/clone` and handoff switches keep the totals. Only a plain `/new` starts again at zero.

<details>
<summary>When figures are written</summary>

At once when a report arrives while the main session is idle, otherwise on the next idle, and on shutdown. Only figures that changed since the last write are written.

</details>

<details>
<summary>Lineage: fork, clone, handoff and <code>--no-session</code></summary>

- Compaction and `/tree` navigation keep every entry in the session file.
- A `/fork`, `/clone` or handoff switch (see [session-limits](../session-limits/README.md)) inherits the totals of the session it came from. The parent's agent figures are copied in under ids prefixed with the parent session file name, so a new agent can never clash with a parent agent, and its main spend is kept as a `pi-spending:main-offset` entry.
- Only a plain `/new` starts again at zero.
- Without a session file (`pi --no-session`) there is no parent file to read: a fork starts from the copied messages only, and a handoff switch starts from zero, since session-limits passes no parent then.
- A parent file that cannot be read is treated the same way: the session keeps only its own entries and a warning is shown.

</details>

## Usage channel

Any extension can add its spend by emitting on pi's event bus. Nothing is imported from this extension; when it is not installed the reports simply go unheard.

```ts
pi.events.emit("spending:usage", { source: "agents", id: "a1b2", usage });
```

- **`source`** is a short non-empty display label of the reporting extension, shown in the footer.
- **`id`** is a non-empty string unique within the source for the whole session, earlier runs of a resumed session included, one per thing that spends (an agent, a job). The subagents extension sends the agent id, which is unique within the session's agents folder.
- **`usage`** is the absolute running total for that id so far, not an increment: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`, all non-negative numbers.
- **Idempotent**: the extension replaces the figure per `source`/`id` only when neither cost nor tokens go down and at least one goes up, and ignores every other report, so sending the same total twice is harmless.
- Other payloads are ignored.
- Report only spend that pi does not already count in the main session: anything that ends up in the main session's own messages is part of `main`.

<details>
<summary>Reporting at shutdown: load order matters</summary>

Reports are accepted until this extension's own shutdown. pi shuts extensions down one at a time in load order and the session goes read-only for an extension once its shutdown handler returns, so an extension that reports its final figures while shutting down must be listed before spending in `pi.extensions` (the subagents extension is).

</details>

## Totals channel

Spending also publishes what it adds up, for extensions that show it themselves (the [footer](../footer/README.md) extension in this repository).

```ts
pi.events.on("spending:totals", (totals) => {}); // { main: { cost, tokens }, sources: [{ source, cost, tokens }], subscription }
```

- **When**: on every refresh: session start, each accepted report, every turn end, every compaction and idle. pi sets up every extension before it starts the session, so a listener hears the session-start publish whatever the load order.
- **`tokens`** are chargeable tokens: `input + output + cacheRead + cacheWrite`.
- **`subscription`** is true when pi reports a subscription sign-in for the main model (the segment's ` (sub)` suffix).
- **Status key**: the footer segment keeps the status key `pi-spending`, exported as `SPENDING_STATUS_KEY` from `platform/shared/host-channels.ts`, so an extension that shows the totals itself can leave the segment out.

<details>
<summary>How the token figures relate to other views and to forks</summary>

- The subagents extension's own views count an agent's tokens as `input + output + cacheWrite`, without cache reads, so their per-agent figures do not add up to the agents tokens here.
- Main tokens carry over a fork or handoff like main cost, through a `pi-spending:main-tokens-offset` entry.
- When a parent session has no such entry, main tokens leave out what that parent's own parents spent, while main cost stays correct.

</details>

## Architecture

- `core/` holds the logic: `spending.ts` keeps the main offsets and totals, `ledger.ts` keeps the high-water figures per `source`/`id` and parses reports.
- `ui/footer-text.ts` formats the footer segment; `api/plugin.ts` wires the usage channel, the session hooks, the footer and persistence.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.
- It talks to other extensions only over pi's event bus: it listens on `spending:usage` and publishes `spending:totals`. The channel names, the report parser and the `pi-spending` status key live in `platform/shared/host-channels.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/spending   # this extension's unit tests
npm run check                         # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
