# transcript

A pi extension that draws pi's transcript in the row style of Claude Code: one glyph per row, a two-column hanging indent, and tool results as short `⎿` summaries you expand with `Ctrl+O` (or a click, in pi's fullscreen mode).

```
 ❯ fix the failing stats test

 ∴ Thinking (ctrl+t expand)

 ● Read stats.py
   ⎿  Read 42 lines

 ● Update stats.py
   ⎿  Added 1 line, removed 1 line (ctrl+o expand)

 ● $ python3 -m unittest
   ⎿  ..
      ----------------------------------------------------------------------
      Ran 2 tests in 0.001s
      … +2 lines (ctrl+o expand)

 ● The mean skipped the first value; both tests pass now.
```

## What it does

- User messages start with a muted `❯` on pi's user background, which spans the whole width; pi's blank background lines above and below the text are dropped.
- Assistant text starts with `●` in the text colour, a thinking run with a dim `∴`, an error, abort or truncation notice with `●` in the error colour. Wrapped lines hang two columns in.
- A hidden thinking run reads `∴ Thinking (ctrl+t expand)`, naming pi's own `app.thinking.toggle` key (`∴ Thinking` when it is unbound); the key still hides and shows thinking, and a click on a run toggles it.
- Every tool call is one `●` title: dim while it streams or runs, the success colour when it succeeded, the error colour when it failed. pi's built-in tools get their own titles and one-line summaries:

| Tool | Title | Result |
|---|---|---|
| read | `Read path` (dim ` (lines a–b)`) | `Read N lines`, `Read image` |
| edit | `Update path` | `Added N lines, removed M lines`; expanded, the diff under it (below) |
| write | `Write path` | `Wrote N lines`; expanded, every line of the content as added lines |
| bash, powershell | `$ first line of the command` (`PS>`) | the first three output lines and `… +N lines`, `(No output)`, `Running…` with the last lines while it runs; expanded, pi's whole output |
| grep | `Grep pattern in path` | `Found N lines`, `No matches` |
| find | `Find pattern` | `Found N files` |
| ls | `List path` | `Listed N entries` |
| codemode | `codemode` and the first line of the script (after an `// @options:` line) | `N tool calls, M failed, K lines of output`, `Running… · N tool calls` while it runs, a failed script's first error lines; expanded, the whole script and pi's own call list and output, or the whole error |
| any other tool (MCP, …) | the bold tool name and up to three arguments | like shell output |

- An expanded edit draws its diff the Claude Code way: a `NN -` / `NN +` gutter, removed and added lines on a background that spans the width (pi's tool error and success backgrounds), the changed words of a removed line and the added line that replaces it on a brighter background (skipped when more than half of the pair changed), dim context lines and a dim `...` between hunks. Long lines are cut with `…`, not wrapped; tabs become three spaces, as in pi, and control characters (a CRLF file's `\r`) are dropped. A diff the rows cannot read falls back to pi's own.
- A failed call shows its error lines in the error colour, three of them until expanded: the first three, or for a shell command the last three, where the error usually is. Paths are shown relative to the working directory, or as `~/…` under your home directory.
- The dim `(ctrl+o expand)` hint names pi's own `app.tools.expand` key, and shows only where expanding adds something: edit and write (the diff), cut shell, generic and error output, and codemode. Read, grep, find and ls show none; their count already says what pi's output would list. On a narrow terminal the hint gives way to the content.
- Tools that already draw themselves (this package's own tools, and any other extension's tool with its own renderer or frame) keep their look; this package's tools use the same row language through `core/manager/row.ts`. Tools of pi's built-in extensions (e.g. codemode) get rows even though pi gives them a renderer; a third-party extension that replaces one of them keeps its own look. An extension that only restyles such a tool keeps its look when it loads before this one, and gets rows when it loads after.
- The agent view (`/agents`, subagents) draws its transcript with the same rows.
- Turn the extension off (pi's extension settings) and pi's own look returns; nothing is stored.

## Differences from Claude Code

Deliberate, not oversights:

- The bullet of a running tool does not blink: a changing row above the screen would make pi's regular-mode renderer clear and redraw the scrollback.
- Streaming text is not coalesced to 100 ms; pi's own 60 frames per second apply.
- Consecutive tool calls are not folded into one group row (`Read 2 files, ran 1 shell command`); pi draws one row per call.
- There is no `Thought for Ns` row; a hidden thinking run reads `∴ Thinking (ctrl+t expand)`.
- Diff lines are not syntax highlighted, and their colours come from pi's theme (the word background mixes the line background with the theme's diff colour) rather than Claude Code's fixed palette.
- An expanded write shows the new content only: pi does not report what the file held before.

## Limits

- The user and assistant rows restyle pi's own message components, which have no extension hook. The adapter checks their shape on every render and falls back to pi's look when a pi update changes it.

## Layout

`src/index.ts` is the pi entry. `src/transcript.ts` registers the tool rows and, at a tui session start, switches on the message rows and the thinking label. `src/tools.ts` builds each tool's title and summary over `core/manager/row.ts`, `src/output.ts` keeps the first or last lines of output and names the hidden ones, and `src/diff.ts` reads pi's edit diff, counts its added and removed lines and draws its rows, and `src/words.ts` finds the changed words of a line pair. The pi side (the tool renderer, the message component overrides) lives in `core/adapter/pi-tool-rows.ts` and `core/adapter/pi-message-rows.ts`. Tests are under `test/`.
