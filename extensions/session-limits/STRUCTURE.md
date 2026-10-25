# Session-limits structure

```
extensions/session-limits/
├── index.ts                    entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts            createManagedExtension: namespace pi-session-limits, host conversationOnly, settings, sessionLimitsPlugin
│   └── plugin.ts               sessionLimitsPlugin, createLimits: reads the shared prompt template, registers the seed renderer (from ui-kit), starts watchLimits, publishes the settings on session start
├── core/
│   ├── conversation-host.ts    conversationOnly: Host wrapper limiting events and commands to tui and rpc
│   ├── limits.ts               watchLimits: handoff state machine, /session-handoff, switch, busy channel
│   ├── thresholds.ts           `mainBudget`, context level (through the shared `budgetLevel`), handoff step, retry decisions (`Limits` and `thresholdsFor` live in platform/shared)
│   ├── handoff.ts              handoff path, handoff validation
│   └── settings.ts             settings file name, defaults and schema
├── ui/
│   ├── threshold-text.ts       segmentFor: notice text and token per phase and level
├── tests/
│   ├── conversation.test.ts    conversationOnly
│   ├── handoff.test.ts         path and validation
│   ├── limits.test.ts          the flow on a fake host
│   ├── publish.test.ts         the limits published on session start
│   ├── settings.test.ts        settings files
│   └── thresholds.test.ts      decisions and notice text
├── README.md                   user guide
├── ARCHITECTURE.md             runtime behaviour
└── STRUCTURE.md                this file map
```
