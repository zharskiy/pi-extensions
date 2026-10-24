<div align="center">

# mcp-import

**Copies MCP servers from Claude Code or Cursor into pi's `mcp.json`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Sources](#sources) · [Conversion](#conversion) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

Pi reads MCP servers from its own `mcp.json`, not from Claude Code's or Cursor's files. This extension reads them from either tool, user or project scope, converts them to pi's shape and adds them without overwriting a server you already have. `/mcp-import` lets you pick the source and the servers, `/mcp-import claude` shows what it would add, `/mcp-import claude apply` writes it.

## What it looks like

```
pi-mcp-import: dry run of /mcp-import claude, nothing written
read: ~/.claude.json (user scope)
target: ~/.pi/agent/mcp.json

would add 1 server:
{
  "mcpServers": {
    "github": {
      "command": "gh",
      "args": [
        "mcp",
        "serve"
      ]
    }
  }
}

run /mcp-import claude apply to write them
```

The notification a dry run prints in pi; it lists notes and skipped servers under it when there are any.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs mcp-import with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/mcp-import/index.ts
```

| Command | What happens |
|---|---|
| `/mcp-import` | Pick the source, then the servers; Enter writes the checked ones. |
| `/mcp-import claude` | A dry run: the `mcpServers` entries it would write, every note and every skipped server. Nothing is written. |
| `/mcp-import claude apply` | The entries are written to `~/.pi/agent/mcp.json`; run `/reload`, then `/mcp` to check them. |

## What it does

One command, `/mcp-import`, interactive without arguments or as `/mcp-import <claude|cursor> [project] [apply]`. The extension has no settings and keeps no state; arguments complete in the slash menu.

- **Interactive pick**: `/mcp-import` without arguments (interactive terminal only) checks Claude Code and Cursor, user and project scope, and keeps the ones with servers to add; project scope only in a trusted project. There is no dry run: the list is what gets written.
- **With arguments**: `/mcp-import <claude|cursor> [project] [apply]`. Without `apply` it is a dry run: it prints the `mcpServers` entries it would write, every note and every skipped server, and writes nothing. With `apply` it writes them.
- **Scope**: user scope (the default) reads the tool's user-level servers and writes `~/.pi/agent/mcp.json`. `project` reads the tool's project-level servers and writes `<cwd>/.pi/mcp.json`; writing needs a trusted project, since pi reads `.pi/mcp.json` only then.
- **Never overwrites**: an existing server name is never overwritten: it is skipped with a note, and so is a name that differs from an existing one only in `-` and `_` (pi treats them as the same server). Everything else in the file is kept, with its indentation.
- **After writing**: after `apply` it tells you to run `/reload` (pi reads `mcp.json` at session start) and `/mcp` to check the servers. HTTP servers without an `Authorization` header are listed for sign-in with `/mcp`: OAuth tokens never transfer from another tool.

<details>
<summary>The interactive pick, step by step</summary>

- With two or more sources it asks `Import MCP servers from` (`Claude Code · user`, `Claude Code · this project`, `Cursor · user`, `Cursor · this project`, each with how many are new and the target file).
- Then `Servers to add to <target>` lists every server with its transport, all checked: Space toggles, `a` checks all, `n` none, Enter writes the checked ones, Esc cancels; the strip under the list reads `↑↓ to select · space to toggle · a to check all · n to check none · enter to add · esc to cancel`.
- Unchecked servers show as `not selected` in the report.
- The target file is read again when you press Enter, so edits made to it while the list was open are kept.
- When nothing can be imported it says which files it checked, that every server is already in the target, or lists why each found server was skipped; in an untrusted project problems in project files are not reported, since those files are left out.

</details>

## Sources

| Tool | User scope | `project` |
| --- | --- | --- |
| Claude Code | top-level `mcpServers` in `~/.claude.json` | `projects["<cwd>"].mcpServers` in `~/.claude.json` (Claude's local scope), then `<cwd>/.mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `<cwd>/.cursor/mcp.json` |

- **Name clash**: when a name appears in both Claude project sources the local scope wins, as in Claude Code.
- **Credentials**: local-scope servers are private in Claude Code; the import notes that `.pi/mcp.json` may be committed, so check it for credentials.

## Conversion

Only fields pi knows are copied: `type`, `command`, `args`, `env`, `cwd` for stdio servers and `type`, `url`, `headers` for HTTP servers. Other fields are dropped with a note.

- **Variables**: pi expands `${VAR}` and whole-value `!command` only in `env` and `headers`, so a `${...}` left in `command`, `args`, `cwd` or `url` gets a note too. A literal `env` or `headers` value starting with `!` is written as `$!...` so pi does not run it.
- **Skipped with a reason**: `type` `sse` (use the server's streamable HTTP URL, often `/mcp`), `ws` and any other type than `stdio`, `http` or `streamable-http`; entries with neither `command` nor `url`; names with characters other than letters, digits, `_` and `-`.

<details>
<summary>Claude Code and Cursor specifics</summary>

- **Claude Code**: `${VAR:-default}` becomes `${VAR}` (pi has no defaults); `timeout` goes from milliseconds to whole seconds; `headersHelper` becomes an `Authorization` header whose `!command` runs the helper and takes the `Authorization` field from its JSON output (pi keeps the output for the session; other headers it prints must be added by hand; the command is a `node -e '…'` one-liner, so it assumes a POSIX shell's quoting and `node` on `PATH`); `oauth` keeps `clientId`, `callbackPort`, `authServerMetadataUrl` and `scope`.
- **Cursor**: `${env:X}` becomes `${X}`; `${userHome}` becomes `~` at the start of `command`, `args` or `cwd` and the home directory elsewhere; `${pathSeparator}` and `${/}` become the path separator; entries using `${workspaceFolder}` are skipped; `envFile` and `auth` are dropped with a note.

</details>

## Architecture

- `core/` holds the logic: `import-flow.ts` reads the sources and the target and plans each source and scope pair, scans the pairs for the interactive pick, narrows a plan to the picked servers and writes the target; `args.ts` parses and completes the arguments; `sources.ts` finds and reads each tool's files; `convert.ts` converts one entry; `plan.ts` merges the converted entries into the target file without overwriting.
- `ui/pick.ts` shows the source and server choice and `ui/report.ts` builds the messages; `api/plugin.ts` registers the command, runs the dry run, the apply and the interactive pick, and notifies.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`. Outside the extension its files depend only on `platform/pi-adapter/index.ts`, `platform/shared/index.ts`, `platform/ui-kit/index.ts` and `platform/extension-manager/index.ts`.
- It talks to no other extension and uses no channels. The only file it writes is the target `mcp.json`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/mcp-import   # this extension's unit tests
npm run check                           # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
