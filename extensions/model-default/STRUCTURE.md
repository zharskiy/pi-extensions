# model-default structure

```
extensions/model-default/
├── index.ts                    # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts            # createManagedExtension (namespace pi-model-default, one plugin)
│   └── plugin.ts               # createModelDefault (the model-select handler and its warning), modelDefaultPlugin
├── tests/
│   └── model-default.test.ts   # save on every choice, warning on a failed save
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```
