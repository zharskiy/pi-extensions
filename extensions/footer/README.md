<div align="center">

# footer

**A three-line status block below the editor: folder, branch, model, thinking level, context, cache, cost and a key-hint row.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

This extension replaces pi's footer with a status block right below the editor. Besides the main session's figures, it shows the cost of the whole session, subagents at every depth included, as reported to the [spending](../spending/README.md) extension. The status texts other extensions set get a line each; a status keyed under `hint:` joins the hint row instead, and one keyed under `mirror:` (a figure the footer already shows, such as spending's totals) is left out.

## What it looks like

```

 my-project on main · session-name                    model-name · thinking high
 working context 13.0k of 163k · cache 73%                 851.3k tokens · $0.34
 shift+tab to cycle thinking · ← to list agents

 <status text other extensions have set>

```

Everything is neutral grey: folder, branch, session and model are `muted`, labels and separators `dim`, the context token count and the total cost plain text. The thinking level carries the one accent, in the colour of its level. Colour otherwise marks state only: the context count turns warning at the soft threshold and error at the hard one of [session-limits](../session-limits/README.md), judged exactly as session-limits judges them. With it installed the figure counts toward its handoff point (`working context 13.0k of 163k`, so the 163k is not mistaken for the model window); without it the label is `context`, the figure is measured against the window and stays plain.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/footer/index.ts   # this extension alone, from a checkout
```

Start pi in a git checkout and read the block line by line:

| Try | What you see |
|---|---|
| Line 1 | The folder, the git branch and the session name when one is set, then the model and its thinking level on the right. |
| Line 2 | How full the context is (`working context` against the handoff point when session-limits is installed, `context` against the window otherwise) and the cache hit rate, then the tokens and cost of the whole session, agents included, on the right (with the main and agents cost split when agents spent something). The right side is hidden until spending reports. |
| Line 3 | Key hints: how to cycle the thinking level (hidden when the model does not reason) and how to list agents. The row is left out when it would be empty. |
| Narrow terminal | Each line drops its least important parts first: session name, thinking level, branch on line 1; token total, `on subscription` shortening to `on sub`, cache, the cost split, then `of <base>` on line 2. |
| Press `shift+tab` | The thinking level on line 1 changes. |

## Development

```bash
npm run test -- extensions/footer   # this extension's unit tests
npm run check                       # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
