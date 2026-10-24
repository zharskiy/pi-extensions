# working-indicator structure

```
extensions/working-indicator/
├── index.ts                        # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts                # createManagedExtension (namespace pi-working-indicator, one plugin)
│   └── plugin.ts                   # createWorkingIndicator (agent start, phase and shutdown handlers, the tick), workingIndicatorPlugin
├── core/
│   └── indicator-state.ts          # TICK_MS, VERB_MS, Run, startRun, elapsedOf, rotateVerb, isVisibleIn
├── ui/
│   └── indicator-text.ts           # VERBS, pickVerb, workingText, interruptHint
├── tests/
│   └── working-indicator.test.ts   # message, rotation, visibility, idle and shutdown, modes
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```
