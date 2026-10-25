# ui-kit structure

- `index.ts`: the public surface.
- `row.ts`: the pi-native row layout: the 0/2/4 grid, `row`/`rowChildren`, `titleLine`, `failureSuffix`, `wrapChild`, `preview`, `rowText`.
- `glyphs.ts`: the state marks `MARKS` (`◌ ✓ ✗ ⊘ » ↳ ›`), `Mark`, `markGlyph`, `markOf`, `pointerMark`.
- `key-hints.ts`: the hint grammar: `EXPAND_BINDING`, `expandHint`, `appendHint`, `countLine`, `keyHints` and `hintLines` (bottom strips), `framed` (rule, lines, hints, rule).
- `list.ts`: the selectable list: lines, keys, the shared hints.
- `select.ts`: `selectForm`; a single-choice form over the list, optionally `unfocused` (no preselected row).
- `tabs.ts`: the tab bar and Tab/←→ keys (questionnaire, `/agents setup`).
- `multi-select.ts`: the checkbox list (Space, `a` all, `n` none, scroll window) and `multiSelectForm`.
- `cache-tone.ts`: the cache rate's colour thresholds and the coloured percentage.
- `tests/row.test.ts`: `row.ts` and `glyphs.ts`.
- `tests/layout.test.ts`: `key-hints.ts` and the `shared` text layout it builds on.
- `tests/list.test.ts`: `list.ts`.
- `tests/select.test.ts`: `select.ts`.
- `tests/tabs.test.ts`: `tabs.ts`.
- `tests/multi-select.test.ts`: the `multi-select.ts` lines and keys.
- `tests/multi-select-form.test.ts`: `multiSelectForm`.
- `tests/cache.test.ts`: `cache-tone.ts` and the `shared` cache hit rate.
