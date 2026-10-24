<div align="center">

# mcp-import

**Copies MCP servers from Claude Code or Cursor into pi's `mcp.json`.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi reads MCP servers from its own `mcp.json`, not from Claude Code's or Cursor's files. This extension reads them from either tool, at user or project scope. It converts them to pi's shape and adds them. It never overwrites a server you already have.

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

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/mcp-import/index.ts   # this extension alone, from a checkout
```

Start with a dry run, then write:

| Try | What you see |
|---|---|
| `/mcp-import` | A pick of the source, then the servers. Enter writes the checked ones. |
| `/mcp-import claude` | A dry run like the one above. Nothing is written. |
| `/mcp-import claude apply` | The servers are written. Run `/reload`, then `/mcp` to check them. |

<details>
<summary>What you need</summary>

- Claude Code: `~/.claude.json`. For a project, its entry in `~/.claude.json` and `<cwd>/.mcp.json`.
- Cursor: `~/.cursor/mcp.json`. For a project, `<cwd>/.cursor/mcp.json`.

</details>

## Development

```bash
npm run test -- extensions/mcp-import   # this extension's unit tests
npm run check                           # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
