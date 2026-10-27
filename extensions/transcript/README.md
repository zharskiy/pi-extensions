<div align="center">

# transcript

**Tool calls as state rows: a glyph, a title and a one-line outcome you expand with `ctrl+o`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

This extension draws each tool call as one row: a glyph that says how it went, a title, and the outcome on a `↳` line. The details stay folded until you expand them. User and assistant messages keep pi's own look, and the agent view draws the same rows.

## What it looks like

A turn in the main session's transcript:

```
 ∴ Thinking (ctrl+t to expand)

 ✓ read src/stats.py:5-14
   ↳ 10 lines

 [skill] tdd (ctrl+o to expand)

 ✓ bash npm test · 9s
   ↳ Tests  2 passed (2)

 ∴ Thinking (ctrl+t to expand)

 ── worked 42s ────────────────────────────────────────────

 The mean skipped the first value; both tests pass now.
```

`ctrl+t` folds or shows the thinking, and pi remembers the choice. Once the work is done, a dim rule above the final answer says how long it took and sets the answer apart from the steps before it, if at least one tool ran; a turn that only answers gets none. Work you started in the background, such as subagents, belongs to the same turn: replies the model gives while agents still run get no rule, the answer to the last results does, and a prompt you type meanwhile joins the turn. Stopping the run with Esc ends the turn without a rule; a turn that ends on an error still gets one, under the error, since there is no answer to put it above. A skill read keeps pi's `[skill]` look.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/transcript/index.ts   # this extension alone, from a checkout
```

Give the model a task that touches files:

| Try | What you see |
|---|---|
| Let the model read, edit or run something | One row per call, its outcome on a `↳` line. |
| Press `ctrl+o` | The rows expand: the diff of an edit, the output of a command. |

## Development

```bash
npm run test -- extensions/transcript   # this extension's unit tests
npm run check                           # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
