# MCP-import structure

```
extensions/mcp-import/
├── index.ts                 entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts         createManagedExtension: namespace pi-mcp-import, mcpImportPlugin
│   └── plugin.ts            mcpImportPlugin, createMcpImport: /mcp-import command, dry run, apply, interactive pick, notices
├── core/
│   ├── args.ts              argument parsing, completion, usage
│   ├── sources.ts           finds and reads Claude Code and Cursor files per scope (`findServers` only)
│   ├── convert.ts           one entry to pi's shape, with notes and skip reasons
│   ├── plan.ts              merges converted entries into the target text without overwriting
│   └── import-flow.ts       prepare a pair, survey and scan all pairs, narrow to the picked servers, write the target (a new `.pi/` gets its `.gitignore`)
├── ui/
│   ├── pick.ts              source select form and server multi-select form
│   └── report.ts            dry-run, applied, picked and nothing-to-import messages
├── tests/
│   ├── args.test.ts         argument parsing and completion
│   ├── convert.test.ts      entry conversion
│   ├── plan.test.ts         merging into the target
│   ├── sources.test.ts      reading the source files
│   └── mcp-import.test.ts   the command on a fake host: dry run, apply, interactive pick, `.pi/.gitignore`, a `.pi` that is a file
├── README.md                user guide
├── ARCHITECTURE.md          runtime behaviour
└── STRUCTURE.md             this file map
```
