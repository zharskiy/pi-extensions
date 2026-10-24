<div align="center">

# transcript

**Tool calls as state rows: a glyph, a title and a one-line outcome you expand with `ctrl+o`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Differences](#differences) · [Limits](#limits) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

This extension draws pi's tool calls as rows: a state glyph, a title, and the outcome on a `↳` line you expand with `ctrl+o` (or a click, in pi's fullscreen mode). User and assistant messages keep pi's own look.

## What it looks like

```
 Thinking (ctrl+t to expand)

 ✓ read src/stats.py:5-14
   ↳ 10 lines

 ✓ edit src/stats.py
   ↳ Added 1 line, removed 1 line (ctrl+o to expand)

 ✗ bash npm test -- --run · exit 1 · 9s
   ↳ ... (52 earlier lines, ctrl+o to expand)
     FAIL src/stats.test.ts > mean > counts the first value
     AssertionError: expected 2 to be 3
     Test Files  1 failed | 1 passed (2)

 The mean skipped the first value; both tests pass now.
```

A turn in the main session's transcript; the agent view draws the same rows.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs transcript with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/transcript/index.ts
```

| You do | You see |
|---|---|
| Let the model read, edit or run something | One row per call: `✓ read src/stats.py:5-14` and its outcome on a `↳` line. |
| Press `ctrl+o` | The rows expand: the diff of an edit, the output of a command. |
| Turn the extension off in pi's extension settings | pi's own look returns; nothing is stored. |

## What it does

Every tool call is one row on a two-column grid: the state glyph at column 0, the title at 2, `↳` at 2 on the first outcome line, and the outcome and any body at 4.

- **Messages**: user and assistant messages are pi's own: the user's text on pi's user background, the assistant's markdown at pi's text column, notices in pi's colours.
- **Thinking**: a hidden thinking run reads `Thinking (ctrl+t to expand)`: `Thinking` in pi's italic thinking colour, the hint dim and upright, naming pi's own `app.thinking.toggle` key (`Thinking` alone when it is unbound); the key still hides and shows thinking, and a click on a run toggles it. The label is composed with the theme at session start, so after a theme switch it keeps the old hint colour until the next session.
- **State glyph**: the glyph says the state by shape first: `◌` (dim) while the arguments stream or the call runs, `✓` (success) when it succeeded, `✗` (error) when it failed, `⊘` (muted) when you stopped it. A stopped call's title ends in ` · stopped`.
- **Duration**: a finished call that took 5 s or more ends its title in ` · 12s`, from the duration pi recorded, so it survives a resume. A running row shows no ticking time.
- **Failure reason**: goes on the title as ` · reason` in the error colour when it is one short line and fits beside a title of at least 8 columns: `exit 1` and `timed out after 30s` for shell commands (from pi's own status line), `file not found` for a missing file, otherwise the error as given. A longer reason is the `↳` line, wrapped at column 4.
- **Failed non-shell call**: shows its error in the error colour, three rows until expanded (two and a count line when there is more).
- **Agent view**: the agent view (`/agents`, subagents) draws its transcript with the same rows.
- **Off switch**: turn the extension off (pi's extension settings) and pi's own look returns; nothing is stored.

pi's built-in tools get their own titles and outcomes:

| Tool | Title | Outcome |
|---|---|---|
| read | `read path:5-14` (the range muted, pi's form) | `10 lines`, `Image`, `0 lines`; expanded, pi's body under it |
| edit | `edit path` | `Added N lines, removed M lines`; expanded, the diff (below); pi's body when the diff does not parse |
| write | `write path` | `12 lines`, `Empty file`; expanded, every line as an added line |
| bash, powershell | `bash command` (`powershell`); a multi-line command is its first line and a muted ` ...` | the last three output lines under `... (N earlier lines, ctrl+o to expand)`, in every state, muted even on failure; `No output`; expanded, pi's body without its `Took` line |
| grep | `grep pattern in path` | `12 matching lines`, `No matches` |
| find | `find pattern` | `3 files`, `No files` |
| ls | `ls path` | `8 entries`, `Empty directory` |
| codemode | `codemode` and the first script line (after an `// @options:` line), muted | `3 calls, 1 failed · 1611 lines of output`, `2 calls` while it runs, a failed script's error; expanded, the script, its calls as nested rows (`✓ grep {"pattern":"login"} 12ms`, the error under a failed one) and the output |
| MCP tools | `server/tool` in accent bold, as pi names it, and up to three `key=value` arguments | the first three output lines, each cut, then `... (N more lines, ctrl+o to expand)`; expanded, every line wrapped |
| any other tool | the bold tool name and its arguments | as MCP tools |

<details>
<summary>Paths, commands and arguments</summary>

Paths are shown relative to the working directory, or as `~/…` under your home directory; a long path is cut at the start so the file name stays (`...th/middleware/session.ts`). Commands, patterns and arguments are cut at the end with pi's `...`.

</details>

<details>
<summary>The expanded edit diff</summary>

- An expanded edit draws its diff with pi's gutter: the `+`/`-` mark, the line number right-aligned, a space.
- Removed and added lines sit on pi's tool error and success backgrounds from column 4 to the right edge, the changed words of a line pair on a brighter background (skipped when more than half of the pair changed); context lines and the `...` between hunks are muted with no background.
- A long line wraps under a blank gutter that keeps its background.
- On a theme without panel backgrounds (pi's system theme without a terminal colour report) the diff falls back to pi's own look: changed lines in the success or error colour, the changed words inverted.
- Tabs become three spaces and control characters are dropped.

</details>

<details>
<summary>Expand hints</summary>

- Hints use pi's wording and show only where expanding adds something: `(ctrl+o to expand)` after an edit or write summary or a codemode summary, and pi's count line, `... (37 more lines, ctrl+o to expand)` or `... (37 earlier lines, ...)`, where output is cut.
- Read, grep, find and ls show none: the count is the result.
- The key is pi's own `app.tools.expand`; when it is unbound there is no hint.
- On a narrow terminal the hint gives way to the content, and a count line drops only its `, ctrl+o to expand` part.

</details>

<details>
<summary>Which tools get rows</summary>

- Tools that already draw themselves (this package's own tools, and any other extension's tool with its own renderer or frame) keep their look.
- Tools of pi's built-in extensions (e.g. codemode) get rows even though pi gives them a renderer; a third-party extension that replaces one of them keeps its own look.
- An extension that only restyles such a tool keeps its look when it loads before this one, and gets rows when it loads after.

</details>

## Differences

Deliberate, not oversights:

- **No ticking time**: a running row does not tick its elapsed time: a changing row above the screen would make pi's regular-mode renderer clear and redraw the scrollback. Finished rows show the recorded duration from 5 s on.
- **No denied state**: a call another extension blocked shows as `✗` with the block reason, not as a separate denied state: the adapter cannot see another extension's block decision.
- **`⊘` glyph**: its font coverage is unmeasured; it is single-width (East Asian Width N) like every glyph here, so alignment holds when a fallback font draws it.
- **No grouping**: consecutive tool calls are not folded into one group row; pi draws one row per call.
- **No thinking duration**: there is no per-run thinking duration: pi has one hidden-thinking label for every message.
- **No syntax highlighting**: diff lines are not syntax highlighted.
- **Write shows new content only**: an expanded write shows the new content only: pi does not report what the file held before.

## Limits

- **Messages follow pi**: messages are pi's default, so they follow pi. With pi's system theme and no colour report from the terminal, pi's panels have no background, and a user message then reads like assistant text; that is pi's behaviour for every pi user and belongs upstream, so this package adds no prefix of its own.

## Architecture

- `core/` holds the theme-free logic: `tool-kinds.ts` classifies a call (arguments, read range, listed counts, missing file, edit diff, duration) and `word-spans.ts` finds the changed words of a line pair.
- `ui/` paints: `tools.ts` picks each tool's look and builds the title (state glyph, failure reason, duration) and the outcome over `platform/ui-kit/row.ts`; `tool-look.ts` holds the shared look types and helpers, `shell.ts` the bash and powershell rows, `codemode.ts` the codemode rows and their call list, `generic.ts` the MCP and unknown-tool rows; `output.ts` cleans output lines, strips pi's shell status line and builds the previews and count lines; `diff.ts` reads pi's edit diff, counts its added and removed lines and draws its rows.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`; `api/plugin.ts` registers the tool rows and, at a tui session start, sets the thinking label.
- The pi side (the tool renderer, the thinking label) lives in `platform/pi-adapter/tools/tool-rows.ts` and `platform/pi-adapter/ui/thinking-label.ts`. It uses no settings, bus channels or session entries.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/transcript   # this extension's unit tests
npm run check                           # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
