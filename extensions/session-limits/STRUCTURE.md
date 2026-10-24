# Session-limits structure

```
extensions/session-limits/
├── index.ts                    entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts            createManagedExtension: namespace pi-session-limits, host conversationOnly, settings, sessionLimitsPlugin
│   └── plugin.ts               sessionLimitsPlugin, createLimits: reads the prompt, registers the seed renderer, starts watchLimits
├── core/
│   ├── conversation-host.ts    conversationOnly: Host wrapper limiting events and commands to tui and rpc
│   ├── limits.ts               watchLimits: handoff state machine, /session-handoff, switch, busy channel
│   ├── thresholds.ts           thresholds, context level, handoff step, retry instruction
│   ├── handoff.ts              handoff path, seed text, handoff validation
│   └── settings.ts             settings file name, defaults and schema
├── ui/
│   ├── threshold-text.ts       segmentFor: notice text and token per phase and level
│   ├── seed-row.ts             seed message row
│   └── limit-messages.ts       seedMessage: message renderer for the handoff seed
├── prompts/
│   └── handoff.md              handoff instruction template
├── tests/
│   ├── conversation.test.ts    conversationOnly
│   ├── handoff.test.ts         path, seed and validation
│   ├── limits.test.ts          the flow on a fake host
│   ├── seed-row.test.ts        seed row
│   ├── settings.test.ts        settings files
│   └── thresholds.test.ts      decisions and notice text
├── README.md                   user guide
├── ARCHITECTURE.md             runtime behaviour
└── STRUCTURE.md                this file map
```
