---
name: readme
description: Write or revise a README in this repository, in the repo's fixed six-part shape (header with pitch and nav line, Why, What it looks like, Quick start, Development, Contributing), for a new extension, an existing extension, or the root. Use it whenever the user asks for a README, asks to document, describe or introduce an extension, adds, renames or removes an extension, or changes code under extensions/<name>/ (test/docs-sync.test.ts fails until that extension's README changes too), even when the word README never comes up. Also use it to decide which docs a code change obliges you to touch.
---

# README

A README here answers two questions for a reader who has not opened the code: what is this extension for, and how do I start using it. Everything else has another home. ARCHITECTURE.md says how it works, STRUCTURE.md says where things are, and the README links to both from Contributing. A README that also explains internals, lists settings or catalogues commands forces every later change to be written twice and buries the pitch under reference material. Keep it to the two questions and it stays one screen long and true.

## The six parts, in order

Every README under `extensions/<name>/` has exactly these parts and nothing else. `extensions/spending/README.md` is the exemplar: read it before writing, and shape yours on it rather than on this description.

1. **Header**. Inside `<div align="center">`: a `# name` heading with the folder name, one bold sentence that says what the extension does for the user, then the nav line `Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)`. The pitch is the sentence the root README reuses in its extension list, so write it to stand alone.
2. **Why**. Two to five sentences on the gap in plain pi and what this extension puts there. Present tense, as the extension is today. No history, no roadmap.
3. **What it looks like**. One fenced block of what the user actually sees: the footer segment, the overlay, the command's output, the transcript rows. Real output, trimmed, not a feature list and not a screenshot. Fence it with plain backticks, no language tag.
4. **Quick start**. The two install lines in a `bash` block (the whole package, then this extension alone from a checkout, with the extension's own path), then a one-line lead-in (usually `Start pi and try:`; name a precondition instead when there is one) and a `| Try | What you see |` table with two to four rows. Each row is one thing to do and the visible result. Commands belong here only as things to try; the moment the table starts listing every flag it has become a reference and belongs in ARCHITECTURE.md. A `<details>` block for prerequisites is fine when the extension needs something outside pi (see `extensions/mcp-import/README.md`).
5. **Development**. A `bash` block with `npm run test -- extensions/<name>` and `npm run check`, then the sentence pointing at the root README's Development section and AGENTS.md. Copy it from the exemplar.
6. **Contributing**. The fixed paragraph from the exemplar: issues and pull requests at the GitHub URL, then read ARCHITECTURE.md and STRUCTURE.md before changing code. Those two files must exist next to the README.

Skeleton, with the fixed text in place:

````markdown
<div align="center">

# <name>

**<one sentence: what it does for the user>**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

<the gap in plain pi, and what this fills>

## What it looks like

```
<real output, trimmed>
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/<name>/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| <action> | <visible result> |

## Development

```bash
npm run test -- extensions/<name>   # this extension's unit tests
npm run check                       # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
````
## What stays out, and where it goes

If a sentence answers "how does it work" or "where is it" instead of "what is it for" or "how do I start", it is in the wrong file.

| Leave out of the README | Put it in |
|---|---|
| How it works: hooks, events, state, algorithms, data flow | the extension's ARCHITECTURE.md |
| Folder layout, file lists, which file holds what | the extension's STRUCTURE.md |
| Settings, config keys, environment variables, defaults | the extension's ARCHITECTURE.md |
| Command, flag, tool or frontmatter reference tables | the extension's ARCHITECTURE.md |
| Version numbers, version history, release notes, "new in", "since" | nowhere, ever. A README describes the extension as it is now, never which version this is or what changed when |
| Provider or model names | nowhere, in any doc or prompt (see AGENTS.md) |
| Extra headings beyond the six | nowhere; fold the content into one of the six or move it |

Links to ARCHITECTURE.md and STRUCTURE.md are the only trace of that material the README keeps.

## The root README

`README.md` at the root has the same six parts and the same voice, with these differences, all visible in the file itself:

- The header pitches the whole package, adds a line with the extension count and the package name, the CI and licence badges, and a nav line without the "Part of" link whose last entry is `[Contributing and licence](#contributing-and-licence)`. No version badge and no version line: the package version lives in package.json and nowhere in the docs.
- What it looks like composes several extensions into one terminal view and credits each one by link underneath.
- Quick start opens with the four install lines, then the extension list: three groups (Agents and tools, Session awareness, Look and feel), one bullet per extension with its bold linked name and its one-sentence pitch, then the try table and the "Coming from another tool" details block.
- Development has the full command set, including the live tests and evals, and the details block on credentials.
- The last part is "Contributing and licence" and ends with the MIT line.

When an extension is added, removed or renamed, or its pitch changes, the root README changes with it: the count in the header and in Quick start, the group list, and the line in What it looks like if that extension is credited there.

## When a README must change

`test/docs-sync.test.ts` runs in `npm run check` and in CI. It diffs the working tree against the merge base with main (or the commit in `DOCS_SYNC_BASE`) and fails when any changed or new file under `extensions/<name>/`, other than the three docs themselves, is not accompanied by changes to all five of: that extension's README.md, ARCHITECTURE.md and STRUCTURE.md, and the root ARCHITECTURE.md and STRUCTURE.md. It checks that each file changed, not what changed. Changes under `platform/` or `test/` oblige nothing. The root README is not on its list; the previous section says when it changes anyway.

So with every code change under an extension, reread its README against the new behaviour. If the pitch, Why, the sample or a try row no longer tells the truth, fix it. If the change is invisible to the user, the test still wants the file touched: make a real improvement a reader would benefit from (a truer sample, a sharper row, a clearer Why) rather than a whitespace or wording-only edit, because a cosmetic touch satisfies the test and leaves the README exactly as stale as before. Do the same for the other four docs; what to write in each is the author's call.

## Voice

Read two existing READMEs and match them. Short declarative sentences in the present tense. "You" for the reader, "pi" in lowercase, the extension named by its folder name. Inline code for commands, paths and keys. Relative links to files in the repo. No emoji, no exclamation marks, no marketing adjectives, no headings deeper than the six `##`. An extension README runs forty to seventy-five lines; if yours is longer, something from the stays-out table has crept in.

## Before you finish

- The six headings are present, in order, with nothing before the header div and nothing after Contributing.
- The nav anchors, the install paths and the `npm run test` path all name this extension.
- Every try row has an action and a visible outcome.
- Nothing from the stays-out table remains, and ARCHITECTURE.md and STRUCTURE.md exist beside the README for the Contributing links.
- No version number and no history anywhere in the file, including the header, Why and Quick start.
- For a new, renamed or removed extension, the root README's count and list are updated.
- `npm run check` passes, which includes the docs-sync rule.
