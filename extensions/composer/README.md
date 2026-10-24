# composer

A pi extension that draws the input as two horizontal lines, edge to edge, with pi's `›` message cursor as the prompt in front of the first line:

```
────────────────────────────────────────
 › type here
   second line of input
────────────────────────────────────────
```

## What it does

- The lines reuse the editor's own border colour, so it follows pi's mode colours (thinking level, bash mode). The `›` prompt is bold in the same colour, so it changes with the thinking level as the lines do.
- The content sits one column in from the left edge (`MARGIN` at the top of `src/frame.ts`). The prompt sits on the first content line only; wrapped and further lines are indented under it. Scroll hints (`↑ 3 more`) stay in the top and bottom lines, which are extended to the full width, and the prompt is hidden while the editor is scrolled.
- Autocomplete lists below the editor start one column in, so pi's `→` sits under the prompt and the entries under the text.
- Pi's working status (spinner, activity, elapsed time) is drawn inside the top line, as in pi's own editor, so there is no gap between it and the input.
- Mouse clicks in the input move the cursor to the clicked character.
- On terminals narrower than the frame needs (11 columns with the default prompt and margin) pi's plain editor is drawn.
- It only applies in the interactive TUI, and never replaces an editor another extension has already set.
- The prompt is the `CHEVRON` constant at the top of `src/frame.ts` (default `›`). It must be a single-column character, since the gutter is measured by its length.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `pi-adapter/` (repository root). `src/composer.ts` sets the frame on session start, `src/frame.ts` decorates the editor's rendered lines (prompt gutter, rule extensions) as plain strings, given the rule positions the editor subclass reports. The editor subclass that renders through the frame is `pi-adapter/editor/pi-editor.ts`. Tests are under `tests/`.
