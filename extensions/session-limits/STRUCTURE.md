# Session-limits structure

```
extensions/session-limits/
├── index.ts                    entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts            createManagedExtension: namespace pi-session-limits, host conversationOnly, settings, sessionLimitsPlugin
│   └── plugin.ts               sessionLimitsPlugin, createLimits: registers the `handoff` tool, the request and seed renderers (from ui-kit), starts watchLimits, publishes the settings on session start
├── core/
│   ├── conversation-host.ts    conversationOnly: Host wrapper limiting events (session info passed as is) and commands to tui and rpc
│   ├── limits.ts               watchLimits: handoff state machine, /session-handoff, switch (seed details `{ from: "session" }`), busy channel (a request shows only the transcript row, no toast)
│   ├── thresholds.ts           context level (the shared `budgetLevel` over the shared `mainBudget`), handoff step, retry decisions
│   ├── handoff.ts              HANDOFF_COMMAND, MAIN_AUDIENCE, sessionPreface, handoff path, handoff validation
│   └── settings.ts             settings file name, defaults and schema
├── ui/
│   ├── threshold-text.ts       segmentFor: threshold warning and failure notice text and token
├── tests/
│   ├── conversation.test.ts    conversationOnly
│   ├── handoff.test.ts         path, validation, main audience and session preface
│   ├── limits.test.ts          the flow on a fake host
│   ├── publish.test.ts         the limits published on session start
│   ├── settings.test.ts        settings files
│   └── thresholds.test.ts      decisions and notice text
├── README.md                   user guide
├── ARCHITECTURE.md             runtime behaviour
└── STRUCTURE.md                this file map
```
