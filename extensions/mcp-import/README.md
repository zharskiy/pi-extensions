# mcp-import

A pi extension that copies MCP servers from Claude Code or Cursor into pi's `mcp.json`: `/mcp-import` lets you pick the source and the servers, `/mcp-import claude` shows what it would add, `/mcp-import claude apply` writes it.

## What it does

- `/mcp-import` without arguments (interactive terminal only) checks Claude Code and Cursor, user and project scope, and keeps the ones with servers to add; project scope only in a trusted project. With two or more it asks `Import MCP servers from` (`Claude Code · user`, `Claude Code · this project`, `Cursor · user`, `Cursor · this project`, each with how many are new and the target file). Then `Servers to add to <target>` lists every server with its transport, all checked: Space toggles, `a` checks all, `n` none, Enter writes the checked ones, Esc cancels. There is no dry run: the list is what gets written. Unchecked servers show as `not selected` in the report. The target file is read again when you press Enter, so edits made to it while the list was open are kept. When nothing can be imported it says which files it checked, that every server is already in the target, or lists why each found server was skipped; in an untrusted project problems in project files are not reported, since those files are left out.
- `/mcp-import <claude|cursor> [project] [apply]`. Without `apply` it is a dry run: it prints the `mcpServers` entries it would write, every note and every skipped server, and writes nothing. With `apply` it writes them.
- User scope (the default) reads the tool's user-level servers and writes `~/.pi/agent/mcp.json`. `project` reads the tool's project-level servers and writes `<cwd>/.pi/mcp.json`; writing needs a trusted project, since pi reads `.pi/mcp.json` only then.
- An existing server name is never overwritten: it is skipped with a note, and so is a name that differs from an existing one only in `-` and `_` (pi treats them as the same server). Everything else in the file is kept, with its indentation.
- After `apply` it tells you to run `/reload` (pi reads `mcp.json` at session start) and `/mcp` to check the servers. HTTP servers without an `Authorization` header are listed for sign-in with `/mcp`: OAuth tokens never transfer from another tool.
- Arguments complete in the slash menu. The extension has no settings and keeps no state.

## Sources

| Tool | User scope | `project` |
| --- | --- | --- |
| Claude Code | top-level `mcpServers` in `~/.claude.json` | `projects["<cwd>"].mcpServers` in `~/.claude.json` (Claude's local scope), then `<cwd>/.mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `<cwd>/.cursor/mcp.json` |

When a name appears in both Claude project sources the local scope wins, as in Claude Code. Local-scope servers are private in Claude Code; the import notes that `.pi/mcp.json` may be committed, so check it for credentials.

## Conversion

Only fields pi knows are copied: `type`, `command`, `args`, `env`, `cwd` for stdio servers and `type`, `url`, `headers` for HTTP servers. Other fields are dropped with a note. Pi expands `${VAR}` and whole-value `!command` only in `env` and `headers`, so a `${...}` left in `command`, `args`, `cwd` or `url` gets a note too. A literal `env` or `headers` value starting with `!` is written as `$!...` so pi does not run it.

- Skipped with a reason: `type` `sse` (use the server's streamable HTTP URL, often `/mcp`), `ws` and any other type than `stdio`, `http` or `streamable-http`; entries with neither `command` nor `url`; names with characters other than letters, digits, `_` and `-`.
- Claude Code: `${VAR:-default}` becomes `${VAR}` (pi has no defaults); `timeout` goes from milliseconds to whole seconds; `headersHelper` becomes an `Authorization` header whose `!command` runs the helper and takes the `Authorization` field from its JSON output (pi keeps the output for the session; other headers it prints must be added by hand; the command is a `node -e '…'` one-liner, so it assumes a POSIX shell's quoting and `node` on `PATH`); `oauth` keeps `clientId`, `callbackPort`, `authServerMetadataUrl` and `scope`.
- Cursor: `${env:X}` becomes `${X}`; `${userHome}` becomes `~` at the start of `command`, `args` or `cwd` and the home directory elsewhere; `${pathSeparator}` and `${/}` become the path separator; entries using `${workspaceFolder}` are skipped; `envFile` and `auth` are dropped with a note.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/mcp-import.ts` registers the command, reads and writes the files and notifies; `src/pick.ts` scans the sources and shows the source and server choice; `src/args.ts` parses and completes the arguments; `src/sources.ts` finds and reads each tool's files; `src/convert.ts` converts one entry; `src/plan.ts` merges the converted entries into the target file without overwriting; `src/report.ts` builds the messages. All of them depend only on `core/adapter/contract.ts` and `core/manager/`. Tests are under `test/`.
