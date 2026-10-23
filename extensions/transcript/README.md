# transcript

A pi extension that draws pi's transcript in the row style of Claude Code: one glyph per row, a two-column hanging indent, and tool results as short `⎿` summaries you expand with `Ctrl+O` (or a click, in pi's fullscreen mode).

```
 ❯ fix the failing stats test

 ∴ Thinking…

 ● Read stats.py
   ⎿  Read 42 lines (ctrl+o expand)

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
- A hidden thinking run reads `∴ Thinking…` (pi's `Ctrl+T` still hides and shows thinking, and a click on a run toggles it).
- Every tool call is one `●` title: dim while it streams or runs, the accent colour when it succeeded, the error colour when it failed. pi's built-in tools get their own titles and one-line summaries:

| Tool | Title | Result |
|---|---|---|
| read | `Read path` (dim ` (lines a–b)`) | `Read N lines`, `Read image` |
| edit | `Update path` | `Added N lines, removed M lines`; expanded, pi's diff under it |
| write | `Write path` | `Wrote N lines` |
| bash, powershell | `$ first line of the command` (`PS>`) | the first three output lines and `… +N lines`, `(No output)`, `Running…` with the last lines while it runs; expanded, pi's whole output |
| grep | `Grep pattern in path` | `Found N lines`, `No matches` |
| find | `Find pattern` | `Found N files` |
| ls | `List path` | `Listed N entries` |
| any other tool (MCP, codemode, …) | the bold tool name and up to three arguments | like shell output |

- A failed call shows its error lines in the error colour, three of them until expanded. Paths are shown relative to the working directory, or as `~/…` under your home directory.
- The dim `(ctrl+o expand)` hint names pi's own `app.tools.expand` key, and shows only when expanding would show more.
- Tools that already draw themselves (this package's own tools, and any other extension's tool with its own renderer or frame) keep their look; this package's tools use the same row language through `shared/row.ts`.
- The agent view (`/agents`, subagents) draws its transcript with the same rows.
- Turn the extension off (pi's extension settings) and pi's own look returns; nothing is stored.

## Differences from Claude Code

Deliberate, not oversights:

- A successful tool's bullet uses pi's `accent` colour (violet in the default theme) instead of green, so it follows your pi theme.
- The bullet of a running tool does not blink: a changing row above the screen would make pi's regular-mode renderer clear and redraw the scrollback.
- Streaming text is not coalesced to 100 ms; pi's own 60 frames per second apply.
- Consecutive tool calls are not folded into one group row (`Read 2 files, ran 1 shell command`); pi draws one row per call.
- There is no `Thought for Ns` row; a hidden thinking run reads `∴ Thinking…`.

## Limits

- The user and assistant rows restyle pi's own message components, which have no extension hook. The adapter checks their shape on every render and falls back to pi's look when a pi update changes it.

## Layout

`src/index.ts` is the pi entry. `src/transcript.ts` registers the tool rows and, at a tui session start, switches on the message rows and the thinking label. `src/tools.ts` builds each tool's title and summary over `shared/row.ts`, `src/output.ts` keeps the first or last lines of output and names the hidden ones, and `src/diff.ts` counts an edit's added and removed lines. The pi side (the tool renderer, the message component overrides) lives in `core/adapter/pi-tool-rows.ts` and `core/adapter/pi-message-rows.ts`. Tests are under `test/`.
