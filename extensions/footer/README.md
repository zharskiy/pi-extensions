# footer

A pi extension that replaces pi's footer with a multi-line status block drawn right below the editor:

```

 150.1k · cache 91% · $4.00 · <model name> (1M context)
 session total (agents included) 162.4k / $4.42
 my-project git:(feature-branch) • <session name>
 ▶▶ thinking high (shift+tab to cycle)

 <status text other extensions have set>

```

## What it does

- Field labels (`cache`, `session total (agents included)`, `thinking`) are dim; the values keep their colours.
- Line 1: the main session's context-window occupancy (warning colour above 70 percent, error above 90, `?` while pi does not know it, for example right after a compaction), the session's cache hit rate, the main session's cost, and the model name pi reports with its context window.
- `cache 91%` is the share of the main session's prompt tokens read from the provider's cache, `cacheRead / (input + cacheRead + cacheWrite)` summed over every main-session request (agents, cache warming and compaction summaries left out), as an integer: success colour from 70 percent, warning from 30, error below. It stays hidden until the session reported any cache read or write (some providers never do), and it is the first segment dropped when the line does not fit the terminal. `/context` shows the same figure next to the last turn's.
- Line 2: the cumulative chargeable tokens (`input + output + cacheRead + cacheWrite`) and cost of the whole session, the main session plus everything reported to the spending extension, such as subagents at every depth.
- Line 3: the current folder name followed by `git:(<branch>)` when pi reports a git branch (just the folder name otherwise), plus the session name when one is set.
- Line 4: the thinking level and the key that cycles it, or `thinking unavailable` for models without reasoning.
- Then, after a blank line, the status texts other extensions set, one per line, sorted by key, whitespace collapsed. For example, the subagents extension contributes the `← to agents` line through its status while its panel is empty. Spending's own `main · agents · total` segment is left out, since lines 1 and 2 already show it, its ` (sub)` marker included.
- The block is indented one column (`PAD` is a single space), in line with the composer chevron, and is preceded and followed by one blank line, so pi's command list and the editor's bottom rule never touch line 1; `PAD` is a constant at the top of `src/render.ts`. Every line is cut to the terminal width with a dim `…`.
- Placement: the block is drawn as the first below-editor widget and pi's own footer slot is left empty, so below-editor widgets other extensions add later, such as the subagents panel, sit under the block (usage, thinking and statuses first, then the panel). pi keeps below-editor widgets in the order they were first set and clears them on reload and session switch; the footer sets its block at session start and only re-renders it afterwards, so it stays first unless another extension sets a below-editor widget during its own session start ahead of the footer.
- Active only in tui mode; elsewhere it does nothing.

## Where the figures come from

Cost and token figures come only from the spending extension, over the `spending:totals` channel: spending publishes them on session start, every turn end, every accepted report, compaction and idle, and the footer keeps the last payload. pi sets up every extension before it starts the session, so the footer hears the first publish whatever the load order. Until spending publishes (or without spending installed) the main cost on line 1 and the whole of line 2 are hidden. Line 2 ends with a dim ` (sub)` when pi reports a subscription for the model. Context, cache usage, model, thinking level, session name, branch and statuses are read live from pi on each render (the context usage is recomputed only when the session leaf or the model changes, the cache usage only when the leaf changes); the footer re-renders when the totals arrive, when the session goes idle and when the git branch changes.

## Layout

`src/index.ts` is the pi entry on the shared adapter in `core/adapter/` (repository root). `src/footer.ts` wires the channel and the footer, `src/render.ts` holds the pure formatting and line builders behind `renderFooter`. The channel names, the totals parser and spending's status key are shared in `core/manager/channels.ts`. Tests are under `test/`.
