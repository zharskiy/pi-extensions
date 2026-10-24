<div align="center">

# context

**`/context` shows what fills the main session's context window, per category, with cache hit rates.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Cache hit rate](#cache-hit-rate) · [Main session only](#main-session-only) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

A context window fills with more than the conversation: the system prompt, tool declarations, memory files and skills all take their share. `/context` prints a block into the transcript that shows what fills the main session's window, as a grid of one cell per percent and a legend of tokens per category, plus how much of the prompt the provider's cache served.

## What it looks like

```
 » Context usage · 14:32
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   model-name · 61.2k/200k tokens (31%)
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Cache hit: last turn 87% · session 91%
     ■ ■ ■ ■ ■ ■ ■ ■ ■ ■
     ■ · · · · · · · · ·   Estimated usage by category
     · · · · · · · · · ·   ■ System prompt: 4.1k tokens (2.1%)
     · · · · · · · · · ·   ■ System tools: 5.3k tokens (2.6%)
     · · · · · · · · · ·   ■ MCP tools: 1.8k tokens (0.9%)
     · · · · · · · · · ·   ■ Extension tools: 2.6k tokens (1.3%)
     · · · · · · · · · ·   ■ Memory files: 3.2k tokens (1.6%)
     · · ░ ░ ░ ░ ░ ░ ░ ░   ■ Skills: 1.4k tokens (0.7%)
                           ■ Messages: 42.8k tokens (21.4%)
                           · Free space: 122.4k (61.2%)
                           ░ Compaction reserve: 16.4k tokens (8.2%)

     Memory files · AGENTS.md
     ↳ 2 files · 3.2k tokens
     Skills · /skill:<name>
     ↳ 2 skills · 1.4k tokens
     MCP tools · /mcp
     ↳ 2 tools · 1.8k tokens · 1 loaded on demand
     Extension tools
     ↳ 1 tool · 2.6k tokens
     Messages
     ↳ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinki...
     ... (14 more items, ctrl+o to expand)
```

A block in the transcript, appended where you run `/context`.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs context with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/context/index.ts
```

| Command | What happens |
|---|---|
| `/context` | Appends the block to the transcript: the grid, the legend per category, the cache hit rates and one summary per section. |
| `ctrl+o` | Expands every `/context` block to list each memory file, skill, tool and message kind, by tokens. |
| `/context all` | Stores the block expanded, with every item listed and no toggle hint. |

## What it does

`/context` appends the block to the transcript as a custom entry. It stays in the scrollback, is drawn again from the same figures when the session is resumed (the time in the title says when it was taken), and is never sent to the model.

- **Grid**: one cell per percent of the window, filled with the categories in legend order, then free space, then the compaction reserve.
- **Categories**: System prompt (every prompt section except the two below), System tools (pi's built-in tools), MCP tools (tools of pi's bundled MCP extension), Extension tools (every other extension's tools, the subagents tools `run_agent`, `message_agent` and `agent_status` included), Memory files (the `AGENTS.md` and other context files in the prompt), Skills (the skill list in the prompt), Messages (the conversation), Free space and Compaction reserve (pi's `compaction.reserveTokens`, 0 and hidden when compaction is off).
- **Figures**: the header total is the figure pi reports (the same one the footer shows). Every category but Messages is a local estimate, and Messages gets the rest of the total, so the legend adds up to the header.
- **Full context**: when the context no longer fits beside the reserve the free row reads `Free space: 0 (0%)` in the warning colour; past the window a red line says by how much and points to `/compact`.
- **Outside tui mode** (rpc, print) nothing is drawn; `/context` shows a one-line summary as a notification instead.

<details>
<summary>The grid and its colours</summary>

- The grid has one cell per percent of the window (10 × 10; 20 × 10 for windows of 1M when the header and legend still fit beside it; 5 × 5 below 50 columns), filled row by row in legend order: `■` a used cell, then free space `·`, then the compaction reserve `░` at the end.
- These three shapes are in common fonts, so the grid reads the same in monochrome; there is no partial cell.
- As many cells are filled as the rounded percentage in use, shared between the categories by largest remainder.
- Each category has its own colour, repeated on its legend line: pi's thinking-level colours from slate to magenta (system prompt, system tools, MCP tools, extension tools, memory files, skills, in that order), messages in the text colour, free space muted and the reserve in warning; pi's red thinking colour is left out, so red only means a failure.
- Rows without tokens are hidden.
- When the header or the longest legend line does not fit beside the grid, the header, cache line and legend go under it, and a header that is still too wide drops its `tokens` word (`61.2k/200k (31%)`).

</details>

<details>
<summary>How the figures are estimated</summary>

- The local estimate is characters / 4, pi's own estimator, which overcounts code and JSON a little.
- When the estimates alone exceed the total, they are scaled down to it and Messages is 0.
- Right after a compaction pi does not know the total until the next response; the block then sums the estimates and marks the header `~… · estimated`.
- MCP tools that pi loads only on demand (deferred, behind tool search or codemode) count 0 and are listed as `loaded on demand`.

</details>

<details>
<summary>The row, its sections and <code>ctrl+o</code></summary>

- The block is a transcript row like the [transcript](../transcript/README.md) extension's: pi's info marker `»` in the accent colour before the title (informational, not a call that succeeded), the body at column 4.
- Under the grid one title per section with its summary on a `↳` line (text at column 6); a line too long for the terminal is cut with `...`.
- `ctrl+o` (pi's tool-expansion key, named in the last line while collapsed, `... (14 more items, ctrl+o to expand)` in pi's own wording, counting the items expanding would list; the key gives way first on a narrow terminal) expands every `/context` block to list each memory file (paths shortened to `./` and `~`), skill, tool (built-in tools included) and message kind, by tokens.
- `/context all` stores the block expanded, with every item listed and no toggle hint.

</details>

## Cache hit rate

The cache line shows how much of the prompt the provider's cache served, for the last turn and for the whole session.

- **Formula**: a request's hit rate is `cacheRead / (input + cacheRead + cacheWrite)`: the share of its prompt tokens read from the provider's cache. pi reports the four buckets without overlap for every provider, and its `/session` uses the same formula.
- **`last turn`** is the last completed request on the current branch (aborted and failed requests skipped).
- **`session`** sums every request of the main session. Cache-warming reads, compaction and branch summaries and agents are left out, so it can differ a little from pi's `/session`, which counts warming reads and summaries too.
- **Shown** only once the session reported a cache read or write; providers that never do show no cache line. A last request that missed the cache entirely in a session that had it shows `last turn 0%` in the warning colour; pi's own cache-miss notices explain big misses when `showCacheMissNotices` is on.
- **Colours**: success from 70 percent, warning from 30, error below.

<details>
<summary>The same figure in the footer</summary>

The footer extension shows the session figure as `cache 91%` on its first line; both compute and paint it with the same functions (`sessionCacheHit` in `platform/shared/cache-hit.ts` and `cachePercentText` in `platform/ui-kit/cache-tone.ts`), so the two always agree.

</details>

## Main session only

Nothing of this package boots inside an agent, so agents have no `/context`, and their usage never enters the figures: it lives in their own session files.

## Architecture

- `core/` holds the logic: `buckets.ts` turns the adapter's facts into the breakdown (memory files, skills, system prompt, tools by source, message buckets, chars / 4, tools loaded on demand at 0), `breakdown.ts` is the usage model (categories, scaling to the total, free space, cache figures) and `snapshot.ts` validates a stored entry.
- `ui/grid.ts` lays out and paints the grid, `ui/details.ts` the section and message lines, `ui/render.ts` composes the block and `ui/summary.ts` is the plain one-line summary for modes without a transcript; `api/plugin.ts` registers the command and the entry renderer and shortens the memory file paths.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.
- The adapter only reports what pi exposes (`Host.contextFacts()`: prompt sections with their text, tools with their source, on-demand flag and declaration size, per-message estimates, pi's total, window and compaction reserve; `platform/pi-adapter/context/context-facts.ts` and its `pi-context-*.ts` parts), and everything `/context` decides is in this extension.
- It uses no bus channels. The cache formula is in `platform/shared/cache-hit.ts`, its colours and the coloured percentage in `platform/ui-kit/cache-tone.ts`, the window format in `platform/shared/format.ts`, all shared with the footer.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/context   # this extension's unit tests
npm run check                        # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
