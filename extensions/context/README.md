# context

A pi extension that adds `/context`: a block printed into the transcript that shows what fills the main session's context window, the way Claude Code's `/context` does, plus how much of the prompt the provider's cache served.

```
 Context Usage · 14:32
 ⛁ ⛁ ⛀ ⛁ ⛁ ⛀ ⛀ ⛁ ⛀ ⛁   <model name> · 61.2k/200k tokens (31%)
 ⛀ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Cache hit: 87% last turn · 91% session
 ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁
 ⛁ ⛁ ⛁ ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category
 ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 4.1k tokens (2.1%)
 ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 5.3k tokens (2.6%)
 ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ MCP tools: 1.8k tokens (0.9%)
 ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Extension tools: 2.6k tokens (1.3%)
 ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Memory files: 3.2k tokens (1.6%)
 ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Skills: 1.4k tokens (0.7%)
                       ⛁ Messages: 42.8k tokens (21.4%)
                       ⛶ Free space: 122.4k (61.2%)
                       ⛝ Compaction reserve: 16.4k tokens (8.2%)

 Memory files · AGENTS.md
 └ 2 files · 3.2k tokens
 Skills · /skill:<name>
 └ 2 skills · 1.4k tokens
 MCP tools · /mcp
 └ 2 tools · 1.8k tokens · 1 loaded on demand
 Extension tools
 └ 1 tool · 2.6k tokens
 Messages
 └ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinking 1.8k
 ctrl+o to expand
```

## What it does

- `/context` appends the block to the transcript as a custom entry. It stays in the scrollback, is drawn again from the same figures when the session is resumed (the time in the title says when it was taken), and is never sent to the model.
- The grid has one cell per percent of the window (10 × 10; 20 × 10 for windows of 1M from 72 columns; 5 × 5 below 50 columns), filled row by row in legend order: `⛁` a full cell, `⛀` a partly filled one, then free space `⛶`, then the compaction reserve `⛝` at the end. Each category has its own colour from pi's theme, repeated on its legend line. Rows without tokens are hidden. Below 60 columns the legend goes under the grid.
- Categories: System prompt (every prompt section except the two below), System tools (pi's built-in tools), MCP tools (tools of pi's bundled MCP extension), Extension tools (every other extension's tools, the subagents tools `run_agent`, `message_agent` and `agent_status` included), Memory files (the `AGENTS.md` and other context files in the prompt), Skills (the skill list in the prompt), Messages (the conversation), Free space and Compaction reserve (pi's `compaction.reserveTokens`, 0 and hidden when compaction is off).
- The header total is the figure pi reports (the same one the footer shows). Every category but Messages is a local estimate (characters / 4, pi's own estimator, which overcounts code and JSON a little), and Messages gets the rest of the total, so the legend adds up to the header. Right after a compaction pi does not know the total until the next response; the block then sums the estimates and marks the header `~… · estimated`.
- Under the grid one summary line per section. `Ctrl+O` (pi's tool-expansion key, named in the last line) expands every `/context` block to list each memory file (paths shortened to `./` and `~`), skill, tool (built-in tools included) and message kind, by tokens. MCP tools that pi loads only on demand (deferred, behind tool search or codemode) count 0 and are listed as `loaded on demand`. `/context all` stores the block expanded, as Claude Code's `/context all` does.
- When the context no longer fits beside the reserve the free row reads `Free space: 0 (0%)` in the warning colour; past the window a red line says by how much and points to `/compact`.
- Outside tui mode (rpc, print) nothing is drawn; `/context` shows a one-line summary as a notification instead.

## Cache hit rate

- A request's hit rate is `cacheRead / (input + cacheRead + cacheWrite)`: the share of its prompt tokens read from the provider's cache. pi reports the four buckets without overlap for every provider, and its `/session` uses the same formula.
- `last turn` is the last completed request on the current branch (aborted and failed requests skipped). `session` sums every request of the main session. Cache-warming reads, compaction and branch summaries and agents are left out, so it can differ a little from pi's `/session`, which counts warming reads and summaries too.
- Shown only once the session reported a cache read or write; providers that never do show no cache line. A last request that missed the cache entirely in a session that had it shows `0% last turn` in the warning colour; pi's own cache-miss notices explain big misses when `showCacheMissNotices` is on.
- Colours: success from 70 percent, warning from 30, error below. The footer extension shows the session figure as `cache 91%` on its first line.

## Main session only

Nothing of this package boots inside an agent, so agents have no `/context`, and their usage never enters the figures: it lives in their own session files.

## Layout

`src/index.ts` is the pi entry on the shared adapter in `core/adapter/` (repository root). `src/context.ts` registers the command and the entry renderer, `src/breakdown.ts` is the pure model (categories, percentages, free space, grid cells, cache figures), and `src/render.ts` draws the block from a stored snapshot. The measuring is in `core/adapter/pi-context.ts` (`Host.contextBreakdown()`, `lastRequestUsage()`, `mainRequestUsage()`), the cache formula and colours in `core/manager/cache.ts`. Tests are under `test/`.
