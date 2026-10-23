# Claude Code transcript rendering: design spec

Describes Claude Code CLI 2.1.309 as researched on 2026-10-23.

Sources: `bin@N` = character offset in a `strings -n 6` dump (binary string table) of the installed Claude Code 2.1.309 binary (Bun binary; UI chunks are minified JS, some chunks are bytecode-only). `docs:interactive` = code.claude.com/docs/en/interactive-mode, `docs:fullscreen` = code.claude.com/docs/en/fullscreen, `CL x.y.z` = CHANGELOG.md in github.com/anthropics/claude-code. Facts not traceable are marked **unverified**.

## The reference screenshot (dark theme)

1. User row: `❯ test_stats.py fails. Read stats.py and test_stats.py, run python3 -m unittest, fix the bug and run the tests again.` on a grey background spanning the full terminal width; chevron dim, text white.
2. Blank line. Green bullet row `● Read 2 files, ran 1 shell command (ctrl+o expand)`, hint dim.
3. Blank line. White bullet, assistant prose: `● mean skips the first element (values[1:]).` with inline code in a blue-ish tint.
4. Blank line. Green bullet `● Update stats.py`; child line `└ Added 1 line, removed 1 line` dim, indented 2 columns; then a syntax-highlighted diff with line numbers 1–8, `4 -` line on a dark red full-width background with changed characters in brighter red, `4 +` line on dark green with changed characters in brighter green, then `...`.
5. Blank line. Green bullet `● $ python3 -m unittest 2>&1 | tail -5 (ctrl+o expand)`.
6. Blank line. White bullet `● I fixed the bug and both tests now pass.`, following paragraphs hang-indented 2 columns with blank lines between paragraphs.

Note: the screenshot shows a `└` child glyph and a green bullet on the "Read 2 files…" row; the 2.1.309 binary renders `⎿` and no bullet on a finished collapsed row (see A.6, B). Treat those two screenshot details as from a different build (**unverified**).

## A. Row anatomy

Common layout: every row is `Box row, alignItems:flex-start, marginTop: addMargin?1:0`; first child `Box minWidth:2` holding the glyph, second child a column (bin@50037286, 50048300). `addMargin` is false only for the first message (`addMargin: lo===0`, bin@51014951). The 2-column glyph box is what produces the hanging indent.

1. **User message** (bin@50084377): `Box column backgroundColor:"userMessageBackground" paddingRight:1 marginTop:addMargin?1:0` wrapping `Text color:"inactive"` `❯` (`figures.pointer` U+276F, fallback `>`; bin@15074187) + `" "` + `Text color:"text"` content. The Box is full width so the background covers the whole line. Print mode: continuation lines indented 2 spaces (bin@30217853).
2. **Assistant text** (bin@50037286/50040317): glyph `ko` in `Text color:"text"` with `aria-label:"claude:"`; body is the markdown renderer `ol` with `capProseWidth:!0`. `ko` = U+23FA `⏺` on macOS, U+25CF `●` elsewhere (bin@15074187).
3. **Thinking** (`Ls`, bin@50040694): glyph `∴` (`Y6t`) `dimColor italic`; body: in transcript view or verbose → markdown `ol dimColor capProseWidth`; otherwise one line, `dimColor italic`, whitespace collapsed (`trim().replace(/\s+/g," ")`); `marginTop: addMargin?1:0`. What is shown is the API thinking summary (setting text: "Request API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o)", bin string table). While streaming, the live collapsed row reads `Thinking for <bold Ns>` ticking every 1000 ms (`ig`, bin@50155841; header `ih=M?"Thinking":"Thought"`, bin@50148746); after the turn it reads `Thought for Ns` (CL 2.1.286 "collapsed row (such as "Thought for 4s")"). Per-token streaming of thinking text: **unverified** (only `streamingThinking` state exists, bin@52352611).
4. **Tool call title** (bin@50048300–50052600): `userFacingToolName` in `gb` with `bold`, `wrap:"truncate-end"`, optional background `userFacingToolNameBackgroundColor`; width `max(columns - 2 - width(name) - 2, 20)`. Per tool:
   - Read: title `Read <bold path>` + optional ` (…)` (bin@50106762); result child `Read <bold N> lines` / `Read image (size)` / `Read <bold N> cells` / `Read PDF (size)` / `Read <bold N> pages (size)`; unchanged file → dim `Already in context (…)` (bin@61551065–61551265), each in a `Ge` child of `height:1`.
   - Edit ("Update"): child summary `Added <bold N> line(s), removed <bold M> line(s)` ("Removed" capitalised when N===0); collapsed & not verbose & N+M>0 → summary + `(ctrl+o expand)`; expanded → summary + diff hunks `C5` at `columns-12` width; `style:"condensed"` → summary only (bin@61412665).
   - Bash: title `$ <command>` — **screenshot only, string not located in JS** (bash tool chunk is bytecode). Output rows are truncated with the `… +N lines` rule (A.8).
   - Write, Grep: titles **unverified** (bytecode). Grep/Glob/Read/Bash/MCP calls normally never show individually; they fold into the collapsed row (A.6).
   - Agent/Task: rows built by `Oas` with `agentType` (or `@name` for teammates), `description`, `toolUseCount`, `tokens`, `isAsync`, `color`, `lastToolInfo` (bin@50222850); exact layout **unverified**. Agent is the only tool with `renderGroupedToolUse` (bin@50227900), so consecutive Agent calls from one message merge via `Im` (bin@50359600) into one `grouped_tool_use` row.
5. **Tool result child** (`Ge`, bin@43835136): `Box fromLeftEdge flexShrink:0` + `Text dimColor` `"  ⎿ \xA0"` (2 spaces, U+23BF, space, nbsp = 5 columns), then a content box `flexShrink:1 flexGrow:1`, optional `height:c overflowY:hidden`. Variants: `"\xA0\xA0⎿ \xA0"` with continuation `marginLeft:5` (bin@49994896/49997439). `fromLeftEdge` → `alignSelf:"stretch"`, `noSelect:"from-left-edge"` (bin@34618231). Hook child: `"  ⎿  "` + `Ran <N> PreToolUse hook(s) (<duration>)` dim (bin@50155800 region).
6. **Collapsed group row** ("Read 2 files, ran 1 shell command") = message type `collapsed_read_search` rendered by `ag` (bin@50137011–50155800). Parts joined with `", "`, first part capitalised, counts bold; verbs (done/live): `searched for|searching for N pattern(s)`, `read|reading N file(s)`, `listed|listing N director(y|ies)`, `called|calling <MCP labels> [N times]`, `ran|running N agent(s)` (or `agent · <description>`), `called|calling N tool(s)`, `ran|running N shell command(s)` (only when a feature gate `v` is on), `recalled N memories`, `searched memories`, `wrote N memories`, `edited|editing N files +A -R`, `committed …`, `pushed to …`, `published`; thinking contributes `Thought for Ns` first. Live row adds `…` and after 2 s a dim ` · <elapsed>` (`lg`, bin@50155841); it may also show the latest display hint (search arg, file path, MCP progress `… (NN%)`) as a dim child under `"  ⎿  "` (width 5). Trailing: `" "` + `(ctrl+o expand)`. Glyph: active → animated `Ro`; finished → empty `Box minWidth:2` (no bullet) and the whole text `dimColor`. Grouping rule: a reducer (bin@28333039, 28340029, 28341906) folds consecutive tool calls whose tool is collapsible (`Qnn(...).isCollapsible`, bin@50380266) across assistant messages, until a non-collapsible message (text, Edit, etc.) ends the segment; group is "active" while any of its tool ids is in `inProgressToolUseIDs` (`E2n`, bin@28331084). Docs: "`Ctrl+O` … expands lines that collapse by default, such as MCP calls, shown as a single `Called slack 3 times` line" (docs:interactive). Note the separate `work_segment` type renders via module `tt`, which is `null` in this build (bin@50195393).
7. **Error rows**: resolved tool with `erroredToolUseIDs` → `Ro` bullet colour `error`; error content via `renderToolUseErrorMessage` (bin@50142xxx). Generic line rows `Zbe` (bin@43845286): `{tone,text,detail,subLines}`; tone `red` → colour `error`, `gold` → `warning`, `dim` → dimColor; text italic; `detail` appended as dim `" · detail"`. Warning system rows: `ko` in colour `warning` (bin@50168276).
8. **Truncation**: `CN()` truncates outputs over 3 lines or 3×width×4 chars; 3 lines shown, rest replaced with `… +N lines` (`dse`, bin@15548904) and a dim `(ctrl+o to expand)` (bin@23460802).
9. **Interrupted**: `Zbe` row model `{tone:"dim", text:"Interrupted"}` (bytecode line 396750); CL 2.1.288 "Interrupted row" with hint "What should Claude do instead?"; interrupted tool results carry text "Interrupted" (bin@47360957) and `Qq.isInterruptedCall` adds an `Nh` element under the group (content **unverified**).

## B. Bullet glyph and colour per state

Tool bullet `Ro` (bin@50017947), glyph always `ko`:
- Queued (not started, not resolved): `ko` `dimColor` (bin@50048300).
- In progress: `color` undefined + `dimColor` (dim grey) and it **blinks**: `YT` hook toggles visibility every `fP=600` ms (`Math.floor(elapsed/600)%2===0`, bin@50017824), rendering `ko` or `" "`. Blink only when `shouldAnimate`, terminal focused (`vc()` = `isTerminalFocused`, bin@30526320), not reduced motion (`it()`, **inferred**) and not static/transcript (`kp()`, **inferred**). In the static-but-animating case the bullet is solid colour `text`.
- Success: `color:"success"`. Error: `color:"error"`. Bell fires when a tool took >5000 ms (`ch=5000`, bin@49986599).
- Assistant text: `text`. Thinking: `∴` dim italic. Warning: `warning`. Finished collapsed group: no glyph.

Theme tables (bin@21664637 dark, 21655038 light; names inferred from values):

| token | dark | light |
|---|---|---|
| text | rgb(255,255,255) | rgb(0,0,0) |
| inactive | rgb(153,153,153) | rgb(102,102,102) |
| subtle | rgb(80,80,80) | rgb(175,175,175) |
| success | rgb(78,186,101) | rgb(44,122,57) |
| error | rgb(255,107,128) | rgb(171,43,63) |
| warning | rgb(255,193,7) | rgb(150,108,30) |
| claude | rgb(215,119,87) | rgb(215,119,87) |
| permission | rgb(177,185,249) | rgb(87,105,247) |
| userMessageBackground | rgb(55,55,55) | rgb(240,240,240) |
| userMessageBackgroundHover | rgb(70,70,70) | — |
| bashMessageBackgroundColor | rgb(65,60,65) | rgb(250,245,250) |
| diffAdded / diffRemoved | rgb(34,92,43) / rgb(122,41,54) | rgb(105,219,124) / rgb(255,168,180) |
| diffAddedDimmed / diffRemovedDimmed | rgb(71,88,74) / rgb(105,72,77) | rgb(199,225,203) / rgb(253,210,216) |
| diffAddedWord / diffRemovedWord | rgb(56,166,96) / rgb(179,89,107) | rgb(47,157,68) / rgb(209,69,75) |

`dimColor` is the terminal's SGR 2, not a theme colour. ANSI and daltonized tables also exist (bin@21657390, 21659756, 21662152, 21667115).

## C. Spacing

- One blank line between rows: `marginTop:1` on every row except the first (A, bin@50037286, 51014951). Paragraph gaps inside markdown come from the markdown renderer.
- Hanging indent 2 columns: glyph `Box minWidth:2` (bin@50017947, 50037286); verbose/transcript variant also `minWidth:2`, `marginTop:1` (bin@50001799).
- Tool-result child indent: 5 columns (`"  ⎿ \xA0"`), continuation lines `marginLeft:5` (bin@43835136, 49997439). Hook/group hints: `Box width:5` + `"  ⎿  "`.
- User row background: full row width (column Box, default stretch) with `paddingRight:1` (bin@50084377).
- Prose width: `min(columns - je, maxProseWidth ?? Infinity) - zr` (bin@43795985); `maxProseWidth` setting, min 40, prose only, code/tables keep full width (bin@15161368; CL 2.1.282). Diff width `columns-12` (bin@61412665). Verbose mode adds a left gutter via `D4t`/`pp fromLeftEdge minWidth` (bin@50387170 region; width **unverified**).

## D. The "(ctrl+o expand)" hint

- Component `vp` (bin@34778295): `Text dimColor` rendering the keybinding chord with `{action:"expand", parens:true, keyCase:"lower"}` → `(ctrl+o expand)`; returns nothing inside the transcript screen. Older text form `(ctrl+o to expand)` on truncated output (bin@23460802).
- Shown on: every collapsed group row (`ag`), Edit summaries when collapsed and lines changed, truncated tool output, condensed agent rows (bin@50218911).
- `ctrl+o` = global action `app:toggleTranscript` (bin@18097426; docs:interactive "Toggle transcript viewer"). It is **global, not per-row**: it switches to a dedicated Transcript screen (`NB`, bin@51027145) with footer `Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in editor · ? for shortcuts`, where all rows render `verbose:true, isTranscriptMode:true` (bin@51021195). In the transcript, `ctrl+e` = `transcript:toggleShowAll` (classic renderer only), `q`/`Esc`/`ctrl+c` exit, `j/k`, `g/G`, `{`/`}`, `/`, `n/N`, `[`, `v` (docs:interactive, docs:fullscreen, bin@51029501).
- Mouse: only in fullscreen rendering ("Click a collapsed tool result to expand it … Click again to collapse. The tool call and its result expand together. Only messages that have more to show are clickable", docs:fullscreen; CL 2.1.274/2.1.286). The Ink fork's `Box` accepts `onClick/onMouseEnter/onMouseLeave/onPointer/onWheel` (bin@30505328); SGR mouse mode is enabled via a terminal-mode stack (`mouse` entry, bin@30509263) and parsed with `/^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])$/` (bin@30661555). Classic renderer has no mouse. Hover tint uses `userMessageBackgroundHover` on the scrolled-up prompt header (`Iu`, bin@50285635).

## E. Streaming text

- Transport → UI: deltas are pushed into a coalescer `fSt` (bin@52352204): the first delta schedules one flush after `flushIntervalMs` (default **100 ms**, `gSt`); deltas arriving meanwhile are merged; `flushNow` on rewrites. So the preview updates at most ~10×/s, not per token. Constant observed as default only; no override found (**inferred** that 100 ms is used).
- Flush writes `previewStore.raw` (bin@50250744; state `raw/transformed/rewrite/salvage`). The preview component `vl` (bin@50387170) subscribes with `useSyncExternalStore`, renders `ko` in `text` + `eeo`, `marginTop:1`. The preview is suppressed in the transcript screen (`sQr` → "hidden", bin@50250744) and counted as "shown" only once a line is complete or nearly full (`BBo`, width-2, bin@52352611).
- Markdown **is rendered while streaming** (`eeo`, bin@43804975): it keeps a `stablePrefix` of already-stable tokens, re-lexes only the tail, tracks an open code fence (`openFence`) so unclosed fences highlight, and renders via `ol` with `skipTokenCache`, `skipHighlightCache`, `capProseWidth`, `tailWrap:"wrap-stream"`. A regex fast path (`Ns`, bin@43798029) skips the markdown lexer for text without markdown characters. Docs/CL: "long bulleted or numbered replies: they stream" (CL 2.1.292).
- After the final message arrives the preview is replaced by the committed assistant row (same glyph/colour).

## F. Working/spinner line

Lives below the transcript, above the input (queued messages render "above the spinner", CL >2.1.280). Not researched. Related glyphs: live-row frames `["∴","∷","∵","∷"]` (`vor`, bin@15074187) used by `Zbe` live rows; braille frames `cm`; `◐◑` 960 ms for the terminal title (bin@52279856).

## G. Other design language

- Bold: tool names (`gb bold`), file paths in Read titles, counts in summaries, durations.
- Dim: hints, child `⎿` lines, finished collapsed rows, ` · ` separators, thinking. Italic: thinking, live `Zbe` rows.
- Inline code colour: **unverified** (screenshot shows blue; no theme token identified).
- Diff (bin@43751707, 43771090, 43774005): full-line backgrounds `diffAdded`/`diffRemoved` (dimmed variants when a `t` flag is set), word-level highlights `diffAddedWord`/`diffRemovedWord` as `backgroundColor` on changed spans, disabled when the changed ratio exceeds a threshold; `+`/`-` markers and line numbers (`i`) in a gutter (`renderSplit` gutters/contents); syntax highlighting unless `syntaxHighlightingDisabled` (bin@15161368). Diffstat `+N`/`-N` coloured `diffAddedWord`/`diffRemovedWord` (bin@53145521).
- Links: URLs in backticks clickable in fullscreen (CL 2.1.302); hovered link underlined (CL >2.1.295).

## Confidence

Verified from binary/docs: glyphs, theme rgb values, row layouts (user, assistant, thinking, tool, `⎿` child, collapsed group), `Ro` colours and 600 ms blink, 5 s bell, Edit/Read summaries, truncation rule, `(ctrl+o expand)` component and ctrl+o = global transcript screen, grouping types, 100 ms coalescer default, live markdown streaming, mouse click-to-expand (fullscreen only), maxProseWidth.
Inferred: `it()`=reduced motion, `kp()`=static/transcript, theme table ↔ theme names, 100 ms is the interval actually used, `isCollapsible` tool set (Read/Grep/Glob/Bash/MCP/Agent).
Unknown/unverified: Bash `$` title string, Write/Grep/Agent row text, inline code colour, verbose gutter width, `Nh` interrupted element, thinking per-token streaming, why the screenshot shows `└` and a green bullet on the finished group row.
