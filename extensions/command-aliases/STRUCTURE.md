# command-aliases structure

```
extensions/command-aliases/
├── index.ts                         # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts                 # createManagedExtension (namespace pi-command-aliases, one plugin)
│   └── plugin.ts                    # ALIASES, createCommandAliases (editor rewrites and alias commands), commandAliasesPlugin
├── tests/
│   └── command-aliases.test.ts      # rewrites, completion mapping, alias commands
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```

There is no `core/` or `ui/`: the extension is only wiring to the host.
