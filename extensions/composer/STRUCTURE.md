# composer structure

```
extensions/composer/
├── index.ts                  # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts          # createManagedExtension (namespace pi-composer, one plugin)
│   └── plugin.ts             # createComposer (sets the frame on session start), composerPlugin
├── ui/
│   └── frame.ts              # createFrame, CHEVRON: decorates the editor's rendered lines (gutter, rule extensions)
├── tests/
│   ├── composer.test.ts      # the frame is set on session start
│   └── frame.test.ts         # decorate: gutter, rules, scroll, autocomplete, widths
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```

There is no `core/`: the frame is rendering only and the rest is wiring.
