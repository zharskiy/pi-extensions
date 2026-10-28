# model-default structure

```
extensions/model-default/
├── index.ts                    # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts            # createManagedExtension (namespace pi-model-default, one plugin)
│   └── plugin.ts               # createModelDefault (the model and thinking handlers and their warnings), modelDefaultPlugin
├── tests/
│   └── model-default.test.ts   # save on every model and thinking choice, warning on a failed save
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```
