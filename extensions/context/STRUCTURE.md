# Context structure

```
extensions/context/
├── index.ts                         entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts                 createManagedExtension: namespace pi-context, contextPlugin
│   └── plugin.ts                    contextPlugin, createContext: /context command, snapshot entry renderer, path shortening
├── core/
│   ├── buckets.ts                   context facts → breakdown (memory files, skills, prompt, tools by source, messages)
│   ├── breakdown.ts                 usage model: categories, scaling to pi's total, free space, cache figures
│   └── snapshot.ts                  Snapshot type and validation of a stored entry, its timestamp included
├── ui/
│   ├── grid.ts                      grid layout and painting, legend glyphs
│   ├── details.ts                   section titles, summaries and expanded item lines
│   ├── render.ts                    composes the transcript row from a snapshot
│   └── summary.ts                   plain one-line summary for modes without a transcript
├── tests/
│   ├── breakdown.test.ts            usage model and apportioning
│   ├── context.test.ts              command and entry renderer on a fake host
│   ├── render.test.ts               rendered rows and the summary line
│   └── support/context-snapshots.ts facts, breakdowns and snapshots for the tests
├── README.md                        user guide
├── ARCHITECTURE.md                  runtime behaviour
└── STRUCTURE.md                     this file map
```
