# command-aliases

A pi extension that gives friendlier names to built-in commands: `/continue` runs `/resume`, `/clear` runs `/new` and `/exit` runs `/quit`.

## What it does

- Each alias is listed as a command (`Alias for /resume`) and completes in the slash menu like any other command.
- pi runs its built-in commands in the editor's submit path, before extension commands, so an alias is turned into its target three ways, in this order:
  1. When the submit key is pressed and the editor holds exactly an alias (surrounding whitespace ignored), the editor text is swapped for the target before pi handles the key. An alias followed by arguments is not rewritten; the alias command then runs the target and ignores the arguments.
  2. Picking an alias in the slash autocomplete inserts the target instead.
  3. If the alias command still runs, it waits one tick, puts the target in the editor and submits it again through the focused editor. When the editor cannot be reached the target stays in the editor and an error says `Could not run /resume`; press Enter to run it.
- The rewriting works in tui mode only. In other modes the alias commands are registered but can only report the error.

## Configuration

`ALIASES` at the top of `api/plugin.ts` maps each alias to its target, both with the leading `/`.

## Layout

`index.ts` is the pi entry; it re-exports `api/extension.ts`, which builds the extension with `createManagedExtension` (`extension-manager/`) on the shared pi adapter in `pi-adapter/` (repository root). `api/plugin.ts` holds the aliases and the plugin that wires them to the host. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), where things are in [STRUCTURE.md](STRUCTURE.md). The editor plumbing (submit key, autocomplete wrapper, re-submitting through the focused editor) is in `pi-adapter/editor/input.ts`. Tests are under `tests/`.
