# composer

A pi extension that draws the input box with a rounded border and a bold chevron prompt in front of the first line:

```
╭──────────────────────────────────────────────╮
│ ❯ type here                                  │
╰──────────────────────────────────────────────╯
```

## What it does

- The border reuses the editor's own border colour, so it follows pi's mode colours (thinking level, bash mode).
- The chevron sits on the first content line only; wrapped and further lines are indented under it. Scroll hints (`↑ 3 more`) stay in the top and bottom borders.
- Autocomplete lists below the editor are indented to line up with the box.
- On terminals narrower than the box needs (14 columns with the default chevron) pi's plain editor is drawn.
- It only applies in the interactive TUI, and never replaces an editor another extension has already set.
- The chevron is the `CHEVRON` constant at the top of `src/composer.ts` (default `❯`).

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root). `src/composer.ts` sets the frame on session start, `src/frame.ts` decorates the editor's rendered lines (rule detection, pipes, chevron gutter, corner caps) as plain strings. The editor subclass that renders through the frame is `core/adapter/pi-editor-frame.ts`. Tests are under `test/`.
