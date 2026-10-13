# Padding and margins: research, rule set, plan changes

2026-10-14. Applied the same day (third pass) to the spec (§2 "Padding and margins" and every mockup), plans 01, 04, 05, 06 and `shared-modules.md`; the line references below describe the plans before that pass. Answers the review note "keep attention on paddings in every view; text shouldn't be glued to display edges". `$PCA` = `node_modules/@earendil-works/pi-coding-agent/dist`, `$TUI` = `node_modules/@earendil-works/pi-tui/dist`, `CC` = the Claude Code 2.1.296 binary (read-only `strings`). Plan line numbers are a snapshot of 2026-10-14; the plans are being edited concurrently, so the quoted text is the anchor.

## A. pi's conventions

- Editor: `paddingX` default 0 (`$TUI/components/editor.js:266-267`, `core/settings-manager.js:1083`), so pi's own editor text starts at column 0; borders are `─` across the full width (`editor.js:386-391`); without padding the last column is reserved for the cursor (`editor.js:399`). Our composer frame adds `MARGIN = 1` plus `❯ ` (`extensions/composer/src/frame.ts:6,12-13`) and extends both borders by `chrome` to the full width (`frame.ts:16,27-29`; `core/adapter/pi-editor-frame.ts:38-41`): chevron at column 1, editor text at column 3.
- Transcript components: one setting, `outputPad` (0 or 1, default 1; `core/settings-manager.js:1090-1091`, `settings-selector.js:589-597` "Horizontal padding for messages, tool output, and command output"). `UserMessageComponent` → `Markdown(text, outputPad, 1)` (`user-message.js:15,31`); `AssistantMessageComponent` → `Markdown(..., outputPad, 0)` and `Text(..., outputPad, 0)` (`assistant-message.js:85,113,140`); `ToolExecutionComponent` → `Box(1,1)` re-padded with `setPaddingX(outputPad)` (`tool-execution.js:50,209-211,261`); `CustomMessageComponent` → `box.setPaddingX(outputPad)` (`custom-message.js:67`). `Text`, `Markdown` and `Box` pad both sides: content width `width - 2 * paddingX` (`$TUI/components/text.js:57-63`, `markdown.js:189,233-234`, `box.js:87-88`). So pi's transcript text sits at column 1 and ends at `width - 2`; the last column is blank.
- `renderShell: "self"` is not padded: only the `Box` shell gets `setPaddingX` (`tool-execution.js:208-211`); the self container is a bare `Container` (`tool-execution.js:54`). pi's type says so: "Renderers with `renderShell: "self"` apply it themselves" (`core/extensions/types.d.ts:377-378`, `ToolRenderContext.outputPad`, also passed at `tool-execution.js:92`).
- Custom entries (`registerEntryRenderer`): `CustomEntryComponent` adds `Spacer(1)` then the renderer's component unpadded (`custom-entry.js:52-55`); `EntryRenderOptions` has only `expanded` (`types.d.ts:1142-1144`), no `outputPad`. The setting is readable through `pi.getSettings().outputPad` (`types.d.ts:1262`, `settings-manager.d.ts:134`). Every entry gets its own leading blank line.
- Widgets below the editor: string-array widgets get `Text(line, 1, 0)` (`interactive-mode.js:1869-1873`, also `... (widget truncated)` at 1875); factory widgets (ours, `core/adapter/pi-ui.ts:333-347`) get no padding. No spacer between editor, below-widgets and footer (`interactive-mode.js:1937`, order editor → widgetsBelow → footer at `691-699`). pi's pending-messages list and status line use `paddingX 1` (`interactive-mode.js:3874-3882`, `3119`). The working line is a `Loader` = `Text("", 1, 0)` (`$TUI/components/loader.js:18`): column 1.
- Overlays: `custom(..., { overlay: true, overlayOptions: { width: "100%" } })` (`pi-ui.ts:399`) gets the full terminal width, no margin unless `margin` is given (`$TUI/tui.js:830-841`), no frame. pi's own dialogs are not consistent: model selector text at column 0, rows `→ ` at column 0, hint with two leading spaces (`model-selector.js:61-90,268`); extension selector title and hint at `paddingX 1` (`extension-selector.js:29,42-46`); `/resume` title at column 0 and the right-hand text ending in the last column (`session-selector.js:127-129,154`), rows right part flush to `width` (`session-selector.js:427`); `SelectList` rows `→ `/`  ` at column 0 with 2 columns reserved on the right (`select-list.js:138-157`). Every dialog draws full-width `─` rules (`dynamic-border.js:17-19`, `model-selector.js:57,93`, `session-selector.js:635,643`).
- Footer: pi's own footer starts at column 0 and right-aligns to `width` exactly (`components/footer.js:227`). Ours prefixes `PAD = " "` and adds one blank line at the bottom (`extensions/footer/src/render.ts:4,6,174-176`) and cuts at `width` (`core/adapter/pi-footer.ts:38`).

Conclusion: pi's consistent, user-tunable convention is the transcript's `outputPad` 1, symmetric. Its widgets and working line use a fixed 1. Its pickers are the inconsistent part, so we do not copy them.

## B. Claude Code's conventions

- Panel below the prompt: `N1` box `{flexDirection:"column", marginTop:1, paddingRight:FC}` with `var FC=2` (CC, `N1`, near `descendantSuffix`); rows start with the pointer `te.pointer+" "` or `"  "` (`Yoe`/`zoe`), the glyph at column 2 (`vh()` = `2 + glyph + 1`). The `↓ N more` line is `` `  ${IP} ${yr} more` ``: two spaces, so the arrow sits in the glyph column. The footer row beside it has `paddingX: k1e` with `var k1e=2` (`v1e`).
- `/tasks` dialog: `_e` (title bold, subtitle dim, `gap:1`, children, then the key guide in a `marginTop:1` box) inside the pane `es`: a full-width coloured top rule (`Ol`), `paddingTop:1`, then content with `paddingX: Jw` (`var Jw=2`; `QP=1` in fullscreen). Rules full width, text inset 2 (1 in fullscreen), one blank line above the hints.
- Transcript: block glyph at column 0, text at column 2, result lines prefixed `"  ⎿  "` (CC `⎿` with two leading spaces).
- Our research files have no padding facts (`claude-code-agents-ux.md`, `claude-code-indicator-notifications.md`); the facts above are from the binary.

Claude's grid is 2 columns; pi's is 1. We live inside pi, next to pi's messages, editor and footer, so we take pi's 1 and copy Claude's structure (pointer gutter, glyph column, full-width rules, blank before hints).

## C. Our code today

- Panel (`progress-widget/model.ts:74-77`): header and rows at column 0; rows through `treeRow`, room `width - 2 - ...` (`components/agent-row.ts:168`), adapter cut at `width` (`pi-ui.ts:89,343`). No `PAD` exists in `agent-row.ts` today; plan 05 introduces it.
- List (`agent-list-view/view.ts:107-112`, `components/agent-list.ts:116-131`): title, rule `─`×`width`, headers, marker at column 0; rows `width - 2`; hint at column 0.
- View (`agent-view/view.ts:251-267,390-407`): header at column 0, rule `─`×`width`, prompt block wrapped at `width - 4` (`:327`), transcript `transcript.render(width)` (pi pads 1), hint plus position at column 0, not right-aligned.
- `run_agent` result: default shell, so pi's `Box` pads it (column 1), lines are a fixed 120 wide (`plugins/run-agent/tools.ts:199-206`, `current-ui-audit.md:171`); `textComponent` builds `Text(text, 0, 0)` (`core/adapter/pi-ui.ts:80-87`).
- Footer: `PAD` 1 left, cut at `width` (above). Working indicator: message only; pi's `Loader` places it at column 1.

## D. Plan audit (flags)

Spec `00-ux-spec.md` (12):
1. §2 has no padding rule at all; every surface decides on its own.
2. §3 `run_agent` block (`:49`): `renderShell: "self"` without saying the renderer must apply `outputPad`; the mockups (`:117-158`) show column 1, so the text and the mechanism disagree.
3. §3 Line 1 "cut with `…` to the width" (`:63`): a string renderer never sees a width; undefined.
4. §3 completion lines (`:83-94`): no width bound (60 + 120 + details can pass 200 columns, wrapped by pi's `Text` back to column 0); mockup `:150-154` stacks three lines, but pi inserts a blank line before every entry (`custom-entry.js:54`).
5. §4 column rule "from the full width `W`" and "hard-cut to `W`" (`:178`), stats "right-aligned to the width" (`:176`): stats end in the last column.
6. §4 mockups (`:236-264`): right edges at 77, 75 and 78 columns, so no common right edge; markers at column 1 while Claude puts them in the glyph column.
7. §4: silent on vertical spacing; nothing separates the panel's last line from the footer's first (`interactive-mode.js:1937`).
8. §5 layout and mockup (`:271-339`): title, headers, feedback and hint at column 0; the overlay's top row is used.
9. §5 "Rows reuse the panel row grammar exactly ... at the overlay width" (`:292`): no margin.
10. §6 header and mockups (`:345-351,429-478`): header lines at column 0; the `▸ Request` line "starts at column 0" (`:481`) while pi's transcript text is at column 1.
11. §6 Request expanded "indented by 2 spaces and soft-wrapped at `width - 2`" (`:378`): JSON reaches the last column (mockup `:467` is 80 wide at 80).
12. §6 hint (`:389`): position right-aligned to `width` (mockup `:478` is 80 wide); "from 90 columns" (`:455`) assumes no margin; no blank line above the hint, so the last transcript line touches it.

Plan `01-adapter-foundations.md` (2; root causes, not in the requested list but needed):
1. `registerEntryRenderer` wraps lines in `new Text(lines.join("\n"), 0, 0)` (`:214`): column 0, wraps at full width.
2. `ToolRenderState` (`:240-253`) has no `outputPad`; `renderCall`/`renderResult` go through `textComponent` → `Text(..., 0, 0)` (`:276-277`): a `self` block draws at column 0 with no right margin.

Plan `04-main-transcript.md` (6):
1. Exact strings (`:203-211`) start at column 0; spec mockup starts at column 1.
2. `BLOCK_WIDTH = 100` (`:176,187,199`) bounds only the description; "pi truncates longer lines ... wraps below" (`:222,385`): wrapped continuations drop the tree connector and reach both edges.
3. Expanded error "indented by 3 spaces" (`:183`) is measured from column 0, not from the pad.
4. Completion line (`:264`): no width cut beyond 60/120, column 0 via plan 01.
5. Completion lines stack in the spec but pi spaces them (`custom-entry.js:54`); not addressed.
6. `components/format.ts` (`:77-100`) owns `truncateCols`/`padEndCols` but no `PAD`, no inner-width or right-align helper, so 05 and 06 each improvise.

Plan `05-agent-panel.md` (6):
1. `PAD` lives in `agent-row.ts` (`:63`), a row module, while the list's title and hint and the view also need it.
2. `W = width - 1` (`:75,85`): left pad only, no right margin; stats "right-aligned to `width`" (`:86`); "a correct line is exactly `width` columns" (`:89`).
3. Row tests (`:91-110`) expect 80-column lines at width 80.
4. Markers at `PAD` (`:170`), not in the glyph column.
5. Hint `PAD + dim(hint)` (`:170`) is not cut; at narrow widths the adapter cuts it in the last column.
6. No trailing blank line; the panel touches the footer.

Plan `06-list-and-agent-view.md` (8):
1. List title, headers, feedback and hint without `PAD` (`:113`); "rows ... sit one column right of the section headers" builds on that.
2. List: no top margin, no blank above the feedback/hint block; `height = max(1, api.rows() - 2 - footer.length)` (`:113`) must change with them.
3. View header: no `PAD`; description `truncateCols(..., width)` (`:172`); title line 1 and chain/worktree lines not cut at all (adapter cut in the last column).
4. Rule `─`.repeat(width) (`:187`): fine, but the plan does not say the text is inset while the rule is not.
5. Request expanded wrapped at `max(1, width - 2)` with a 2-space prefix (`:215`) and its test "every line has `displayWidth <= 40`" at width 40 (`:348`): JSON touches the last column; `▸` at column 0.
6. Hint right-aligned with `width - w(hint) - w(pos)` and fit test `<= width` (`:200`): position ends in the last column.
7. Body lines `data.error`, `(no transcript yet)` and the `stop failed: <msg>` notice (`:189-198`) at column 0, notice not cut.
8. `height = max(3, api.rows() - header.length - footer.length)` (`:198`) has no room for margins.

`research/shared-modules.md` (3):
1. "Every row starts with a one-column `PAD` (exported), in the panel and in the list" (`:65`): owner `agent-row.ts`, rows only.
2. `requestLines` doc "indented 2 and wrapped at width - 2" (`:79`).
3. `format.ts` signatures (`:9-24`) lack `PAD`, `innerWidth`, `alignRight`.

Total 37 flags (00: 12, 01: 2, 04: 6, 05: 6, 06: 8, shared: 3).

## Proposed rule set (paste into spec §2 as "Padding and margins")

- **Left pad.** Every line we draw in a widget or overlay starts with `PAD`, one column (pi's widgets, pending list, status line and working line use 1: `interactive-mode.js:1872,3874,3119`, `loader.js:18`; our footer uses 1; the composer chevron is at column 1). Transcript surfaces (the `run_agent` block, completion lines) use pi's `outputPad` instead (0 or 1, default 1), so they line up with pi's messages and follow the user's setting.
- **Right margin.** The same width on the right: no text past column `width - 1 - PAD` (0-based), the last column always blank. Content width `inner = width - 2 * PAD` (transcript: `width - 2 * outputPad`). Every cut is `truncateCols(text, inner - <prefix>)`, never `truncateCols(text, width)`.
- **What `width` is.** Widget: the terminal width pi passes to the factory (`pi-ui.ts:343`; pi adds nothing). Overlay: the terminal width (`width: "100%"`, no frame, `tui.js:841`). Transcript block and completion line: the chat width pi passes to the tool/entry component; the self shell adds no padding. The adapter's hard cut at `width` stays a safety net only; a correct line never reaches it.
- **Columns inside a pad.** Column `PAD` holds the pointer gutter (`› ` or two spaces) of a row and the first cell of every line that is not a row: title, section header, feedback, hint, view header, `▸ Request`. Row glyphs and the panel's `↑ N more` / `↓ N more` markers sit at `PAD + 2`, the glyph column (Claude's markers do the same, `` `  ${IP} ${yr} more` ``). Right-aligned parts end at `inner`: `PAD + padEndCols(left, inner - displayWidth(right)) + right`, shown only when `displayWidth(left) + 2 + displayWidth(right) <= inner`, else `PAD + truncateCols(left, inner)`.
- **Rules.** `─` rules are chrome, not text: full width, edge to edge, like pi's editor borders (`editor.js:386`), the composer's extension (`frame.ts:16`), pi's dialogs (`dynamic-border.js:17`) and Claude's pane rule. Only the agent view has one.
- **Blank lines.** Fullscreen overlays: one blank row at the top and one at the bottom (the footer leaves its last row blank, `render.ts:6`), one blank row between the body window and the feedback/hint block, always reserved so the hint never moves. List: title → blank → first section; section → blank → section. View: header → rule → `▸ Request` with no blank; Request block → blank → transcript (pi's components bring their own leading spacers). Panel: no blank above (the editor's bottom border separates it), rows, markers and hint with no blanks between them, one trailing blank line so the footer does not touch the last line.
- **Wrap widths.** pi-rendered transcripts get the full `width`: pi already pads 1 on both sides (`outputPad` defaults to 1 in `createTranscriptPane`, which passes none, `pi-ui.ts:133-182`), and `width - 2` would double the inset to column 2 and break the alignment with `▸ Request`. The expanded Request JSON starts at `PAD + 2` and wraps at `inner - 2` (continuations at `PAD + 2` too). The `run_agent` block and completion lines are cut per line at `width - 2 * outputPad` by the adapter, never wrapped, so tree rows keep their connectors.

Owner: `PAD`, `innerWidth(width)` and `alignRight(left, right, cols)` live in `extensions/subagents/src/components/format.ts` (plan 04), next to `truncateCols`/`padEndCols`; plans 05 and 06 import them. `agent-row.ts` stops exporting `PAD`.

## Change list

`00-ux-spec.md`
- §2: add the subsection above (the seven bullets plus the owner line).
- §3 block, after "(`renderShell: "self"`, …)": add "pi does not pad a self-rendered block; the adapter indents every line by pi's `outputPad` and cuts it at `width - 2 * outputPad` (no wrapping), so the block lines up with pi's messages." In Line 1 replace "cut with `…` to the width" with "cut with `…` so the line fits `BLOCK_WIDTH` (the adapter's per-line cut handles narrower terminals)".
- §3 completion lines: add "Indented by `outputPad` and cut at `width - 2 * outputPad` like the block. pi puts a blank line before every custom entry, so consecutive completion lines are one blank line apart." Redraw mockup 2 and 3 with blanks between the `✓`/`✗` lines.
- §4 column rule: replace "from the full width `W`" with "from `W = width - 2 * PAD`" and "hard-cut to `W` by the adapter" with "a correct line ends at `PAD + W`; the last column stays blank". Stats bullet: "right-aligned to `PAD + W`". Window bullet: "`↑ N more` / `↓ N more` start in the glyph column (`PAD + 2`)". Add "One blank line follows the panel's last line."
- §4 mockups: redraw at 80 with every row 79 wide, markers at column 3, hint at column 1, a trailing blank line; e.g. (column 0 is the first character inside the fence):

```
   ↑ 2 more
   ⠹ worker         Fix the login redirect       bash · 2m 10s · ↓ 30.1k tokens
 › ⠹ reviewer (+1)  Review the diff of PR 5       writing · 45s · ↓ 8.2k tokens
   └─ ⠹ explorer       Find callers of login         read · 12s · ↓ 1.1k tokens
   ○ worker         Rename parseDate callers                             queued
   ○ explorer       Find every date format in tests                      queued
   ↓ 1 more
 enter to view · x to stop · esc to deselect

```

- §5 layout block: prepend `(blank)`; insert `(blank)` between `(padding to the height)` and the feedback line; append `(blank)`. Replace "at the overlay width" with "at the overlay width with the §2 padding". Redraw the mockup with title, headers and hint at column 1 and rows as above (pointer at 1, glyph at 3, right edge 79):

```

 Agents · 4 running · 1 done

 Running
   ⠹ explorer       Map the auth module           grep · 1m 5s · ↓ 12.3k tokens
 › ⠹ worker (+1)    Fix the login redirect       bash · 2m 10s · ↓ 30.1k tokens
   └─ ⠹ explorer       Find callers of login         read · 12s · ↓ 1.1k tokens

 Needs input
   ⠹ reviewer       Review the diff of PR 5                         needs input
   …
 Press X again to stop all agents
 ↑/↓ to select · enter to view · x to stop · X to stop all · esc to close

```

- §6 header: "Lines at `PAD`, each cut at `inner`, then a `dim` rule of `─` across the full width (edge to edge; rules are not inset)". Request: replace "every line indented by 2 spaces and soft-wrapped at `width - 2` columns" with "every line starts at `PAD + 2` and soft-wraps at `inner - 2` columns". Replace the sentence at `:481` with "The `▸`/`▾` line starts at column `PAD` (1), aligned with pi's transcript text; request lines and their continuations start at column 3; nothing reaches the last column." Hint: "at `PAD`; the position ends at `PAD + inner` (column `width - 2`); one blank line above the hint". At `:455` replace "from 90 columns" with "from 92 columns"; note that at 80 the expanded hint (69 columns + 2 + `1-14/940`) needs 79 > 78, so the position drops there too. Redraw both mockups with header lines at column 1, the rule unchanged, `▸ Request` at column 1, JSON at column 3 wrapping at column 77, the hint at column 1, a blank above it and a blank top row.
- §7: "pi draws the working line at column 1 (`Loader`, `paddingX 1`); nothing to change." §4 Footer status: "drawn by the footer extension with its `PAD`."

`01-adapter-foundations.md` (needed by 04)
- `ToolRenderState`: add `outputPad: number` (from `ToolRenderContext.outputPad`, `types.d.ts:377`).
- `toPiTool`: when `spec.renderShell === "self"`, return a lines component that renders `" ".repeat(outputPad) + truncateToWidth(line, width - 2 * outputPad, "…")` per line instead of `Text(text, 0, 0)`.
- `registerEntryRenderer`: same lines component with `outputPad = pi.getSettings().outputPad ?? 1` (entries get no `outputPad`, `types.d.ts:1142`).

`04-main-transcript.md`
- Exact strings (`:203-211`): add "pi draws them indented by `outputPad` (1 by default); the strings above are what the renderer returns."
- `:222`, `:385`: replace "pi truncates longer lines (... `Text`, which wraps ...)" with "the adapter cuts each line at `width - 2 * outputPad` with `…` (plan 01); nothing wraps".
- `:183`: "indented by 3 spaces (relative to the block)".
- `format.ts` (`:77-100`): add `export const PAD = " ";`, `export const innerWidth = (width: number) => Math.max(1, width - 2 * PAD.length);`, `export const alignRight = (left: string, right: string, cols: number): string | undefined` (`padEndCols(left, cols - displayWidth(right)) + right`, `undefined` when `displayWidth(left) + 2 + displayWidth(right) > cols`), with tests `"aligns right inside the given columns"` and `"returns undefined when both parts do not fit"`.
- Completion lines: add "consecutive entries render one blank line apart (pi's entry spacer)".

`05-agent-panel.md`
- `:63`: delete `PAD` from `agent-row.ts`; import `PAD`, `innerWidth` from `./format.ts`.
- `:75`: replace "the row grammar gets `width - 1` columns" with "the row grammar gets `W = innerWidth(width)` columns; the last column stays blank".
- `:85-89`: `W = innerWidth(width)`; "right-aligned to `PAD + W`"; "a correct line is exactly `width - 1` columns when stats are present".
- Row test table: every expected string loses one space before the stats (79 columns at width 80).
- `:170`: markers `PAD + "  " + dim("↑ N more")`; hint `PAD + dim(truncateCols(hint, innerWidth(width)))`; append `""` as the last line when rows exist. Add tests `"ends every line before the last column"` and `"puts the markers in the glyph column"`.

`06-list-and-agent-view.md`
- `:113`: title, headers, feedback and hint as `PAD + …` cut at `innerWidth(width)`; replace "so they sit one column right of the section headers" with "the pointer gutter sits under the headers' first letter, glyphs two columns in"; layout `["", title, "", body…, padding, "", feedback?, hint, ""]`; `height = max(1, api.rows() - 5 - footer.length)`.
- `:172` and title/chain/worktree lines: `PAD + truncateCols(…, innerWidth(width))`; keep `:187` and add "full width on purpose; rules are not inset (spec §2)".
- `:189-198`: error, `(no transcript yet)` and notice lines at `PAD`, cut at `inner`; view layout `["", header…, rule, body window, "", notice?, hint, ""]`; `height = max(3, api.rows() - header.length - 4 - footer.length)` (header includes the rule).
- `:200`: `PAD + (alignRight(hint, pos, innerWidth(width)) ?? truncateCols(hint, innerWidth(width)))`.
- `:215`: `▸`/`▾` line `PAD + …`; JSON lines prefixed `PAD + "  "` and wrapped at `max(1, innerWidth(width) - 2)`. `:348`: "every line has `displayWidth <= 39`, starts with three spaces".
- Keep `transcript.render(width)` and add "full width: pi pads its components by 1 on both sides".

`research/shared-modules.md`
- `format.ts` block: add `PAD`, `innerWidth`, `alignRight` (signatures above).
- `:65`: replace with "`PAD` (one column) and `innerWidth` come from `format.ts`; every panel, list and view line starts with `PAD` and ends before the last column (spec §2 Padding and margins)."
- `:79`: "the `▸` line at `PAD`, the request at `PAD + 2`, wrapped at `innerWidth(width) - 2`, plus one blank line".
