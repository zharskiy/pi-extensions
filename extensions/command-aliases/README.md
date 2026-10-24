<div align="center">

# command-aliases

**Friendlier names for built-in commands: `/continue`, `/clear` and `/exit`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Configuration](#configuration) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

Three built-in commands get a second name: `/continue` runs `/resume`, `/clear` runs `/new` and `/exit` runs `/quit`. Typing an alias, picking it in the slash menu or running it as a command all end in the built-in.

## What it looks like

```
→ clear       Alias for /new
  continue    Alias for /resume
  exit        Alias for /quit
```

The slash menu after typing `/`, pi's own commands left out.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs command-aliases with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/command-aliases/index.ts
```

| Command | What happens |
|---|---|
| `/continue` | Runs `/resume`. |
| `/clear` | Runs `/new`. |
| `/exit` | Runs `/quit`. |

## What it does

Each alias is listed as a command (`Alias for /resume`) and completes in the slash menu like any other command.

Pi runs its built-in commands in the editor's submit path, before extension commands, so an alias is turned into its target three ways, in this order:

1. **Submit key**: when the submit key is pressed and the editor holds exactly an alias (surrounding whitespace ignored), the editor text is swapped for the target before pi handles the key. An alias followed by arguments is not rewritten; the alias command then runs the target and ignores the arguments.
2. **Autocomplete**: picking an alias in the slash autocomplete inserts the target instead.
3. **Fallback**: if the alias command still runs, it waits one tick, puts the target in the editor and submits it again through the focused editor. When the editor cannot be reached the target stays in the editor and an error says `Could not run /resume`; press Enter to run it.

The rewriting works in tui mode only. In other modes the alias commands are registered but can only report the error.

## Configuration

`ALIASES` in `core/aliases.ts` maps each alias to its target, both with the leading `/`.

## Architecture

- `core/aliases.ts` holds the aliases; `api/plugin.ts` holds the plugin that wires them to the host.
- The editor plumbing (submit key, autocomplete wrapper, re-submitting through the focused editor) is in `platform/pi-adapter/editor/input.ts`.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/command-aliases   # this extension's unit tests
npm run check                                # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
