# footer

A pi extension that replaces pi's footer with a multi-line status block:

```
150.1k · $4.00 · <model name> (1M context)
Session total (agents included): 162.4k / $4.42
my-project • <session name>
feature-branch
▶▶ thinking high (shift+tab to cycle)

<status text other extensions have set>
```

## What it does

- Line 1: the main session's context-window occupancy (warning colour above 70 percent, error above 90, `?` while pi does not know it, for example right after a compaction), the main session's cost, and the model name pi reports with its context window.
- Line 2: the cumulative chargeable tokens (`input + output + cacheRead + cacheWrite`) and cost of the whole session, the main session plus everything reported to the spending extension, such as subagents at every depth.
- Line 3: the current folder name, plus the session name when one is set.
- Line 4: the git branch, only inside a repository.
- Line 5: the thinking level and the key that cycles it, or `thinking unavailable` for models without reasoning.
- Then, after a blank line, the status texts other extensions set, sorted by key, whitespace collapsed, on one line. Spending's own `main · agents · total` segment is left out, since lines 1 and 2 already show it, its ` (sub)` marker included.
- The block is indented by `PAD` (2 spaces) and followed by `PAD_BOTTOM` (1) blank lines; both are constants at the top of `src/render.ts`. Every line is cut to the terminal width with a dim `…`.
- Active only in tui mode; elsewhere it does nothing.

## Where the figures come from

Cost and token figures come only from the spending extension, over the `spending:totals` channel: spending publishes them on session start, every turn end, every accepted report and idle, and the footer keeps the last payload. pi sets up every extension before it starts the session, so the footer hears the first publish whatever the load order. Until spending publishes (or without spending installed) the main cost on line 1 and the whole of line 2 are hidden. Line 2 ends with a dim ` (sub)` when pi reports a subscription for the model. Context, model, thinking level, session name, branch and statuses are read live from pi on each render (the context usage is recomputed only when the session leaf or the model changes); the footer re-renders when the totals arrive, when the session goes idle and when the git branch changes.

## Layout

`src/index.ts` is the pi entry on the shared adapter in `core/adapter/` (repository root). `src/footer.ts` wires the channel and the footer, `src/render.ts` holds the pure formatting and line builders. The channel names, the totals parser and spending's status key are shared in `core/manager/channels.ts`. Tests are under `test/`.
