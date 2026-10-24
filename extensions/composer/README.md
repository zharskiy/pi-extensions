<div align="center">

# composer

**The input drawn as two horizontal lines, edge to edge, with pi's `›` as the prompt.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

Pi's input is a plain editor. This extension frames it between two full-width lines with pi's `›` message cursor in front of the first line, in the colours pi already uses for the editor border, and keeps pi's working status inside the top line.

## What it looks like

```
────────────────────────────────────────
 › type here
   second line of input
────────────────────────────────────────
```

The input area of the interactive TUI.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs composer with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/composer/index.ts
```

| You do | You see |
|---|---|
| Open pi in the interactive TUI | The input between two full-width lines, `›` in front of the first line. |
| Type a second line | It is indented under the first, with no prompt of its own. |
| Click in the input | The cursor moves to the clicked character. |

## What it does

The frame decorates the editor's rendered lines; the editor itself keeps working as before.

- **Colour**: the lines reuse the editor's own border colour, so it follows pi's mode colours (thinking level, bash mode). The `›` prompt is bold in the same colour, so it changes with the thinking level as the lines do.
- **Margin and prompt**: the content sits one column in from the left edge (`MARGIN` at the top of `ui/frame.ts`). The prompt sits on the first content line only; wrapped and further lines are indented under it. Scroll hints (`↑ 3 more`) stay in the top and bottom lines, which are extended to the full width, and the prompt is hidden while the editor is scrolled.
- **Autocomplete**: lists below the editor start one column in, so pi's `→` sits under the prompt and the entries under the text.
- **Working status**: pi's working status (spinner, activity, elapsed time) is drawn inside the top line, as in pi's own editor, so there is no gap between it and the input.
- **Mouse**: clicks in the input move the cursor to the clicked character.
- **Narrow terminals**: on terminals narrower than the frame needs (11 columns with the default prompt and margin) pi's plain editor is drawn.
- **Where it applies**: only in the interactive TUI, and it never replaces an editor another extension has already set.
- **Prompt character**: the prompt is the `CHEVRON` constant at the top of `ui/frame.ts` (default `›`). It must be a single-column character, since the gutter is measured by its length.

## Architecture

- `ui/frame.ts` decorates the editor's rendered lines (prompt gutter, rule extensions) as plain strings, given the rule positions the editor subclass reports; `api/plugin.ts` holds the plugin that sets the frame on session start.
- The editor subclass that renders through the frame is `platform/pi-adapter/editor/editor.ts`.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/composer   # this extension's unit tests
npm run check                         # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
