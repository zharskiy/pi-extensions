# command-aliases structure

```
extensions/command-aliases/
├── index.ts                         # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts                 # createManagedExtension (namespace pi-command-aliases, one plugin)
│   └── plugin.ts                    # createCommandAliases (editor rewrites and alias commands), commandAliasesPlugin
├── core/
│   └── aliases.ts                   # ALIASES (alias -> built-in command), targetOf
├── tests/
│   └── command-aliases.test.ts      # rewrites, completion mapping, alias commands
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```

There is no `ui/`: `core/` holds the alias table and `api/` wires it to the host.
