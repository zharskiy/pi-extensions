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
 Thinking (ctrl+t to expand)

 ✓ read src/stats.py:5-14
   ↳ 10 lines

 [skill] tdd (ctrl+o to expand)

 ✓ edit src/stats.py
   ↳ Added 1 line, removed 1 line (ctrl+o to expand)

 ✗ bash npm test -- --run · exit 1 · 9s
   ↳ ... (52 earlier lines, ctrl+o to expand)
     FAIL src/stats.test.ts > mean > counts the first value
     AssertionError: expected 2 to be 3
     Test Files  1 failed | 1 passed (2)

 The mean skipped the first value; both tests pass now.
```

A skill read keeps pi's `[skill]` look.

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
