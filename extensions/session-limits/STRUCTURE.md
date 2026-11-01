# Session-limits structure

```
extensions/session-limits/
├── index.ts                    entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts            createManagedExtension: namespace pi-session-limits, host conversationOnly, settings, sessionLimitsPlugin
│   └── plugin.ts               sessionLimitsPlugin, createLimits: registers the `handoff` tool, the request and seed renderers (from ui-kit), the kept-message entry renderers, starts watchLimits, publishes the settings on session start
├── core/
│   ├── conversation-host.ts    conversationOnly: Host wrapper limiting events (session info passed as is) and commands to tui and rpc
│   ├── limits.ts               watchLimits: handoff state machine, /session-handoff, switch (seed details `{ from: "session" }`, keeps the model and thinking level, continues after every automatic handoff), busy channel, pi:handoff-pending published, pi:held-results and the user messages kept through onInput carried into the new session's user prompts or editor through the lazy fill and shown in the TUI chat as kept-rule and kept-message entries (a request shows only the transcript row, no toast)
│   ├── thresholds.ts           handoff step, retry decisions
│   ├── kept-entries.ts         kept-rule and kept-message entry names, data types, parsers and keptRuleFor (which rule the state calls for)
│   ├── handoff.ts              HANDOFF_COMMAND, MAIN_AUDIENCE, sessionPreface, HELD_HEADING and withLateResults, userPrompts (kept messages as the new session's user prompts), handoff path, handoff validation
│   └── settings.ts             settings file name, defaults and schema
├── ui/
│   ├── kept-entries.ts         keptRule (labelled rule and its labels) and keptMessage (pi's user message look) entry renderers
│   └── threshold-text.ts       segmentFor: threshold warning and failure notice text and token
├── tests/
│   ├── conversation.test.ts    conversationOnly
│   ├── kept-entries.test.ts    the kept-message block and the kept entries' fallbacks
│   ├── handoff.test.ts         path, validation, main audience, session preface, late results and user messages
│   ├── limits.test.ts          the flow on a fake host, including the instruction's no-reply closing, the pending signal, held results in the seed and user messages kept during a handoff (chat entries, notices, new session prompts, editor restore)
│   ├── publish.test.ts         the limits published on session start
│   ├── settings.test.ts        settings files
│   └── thresholds.test.ts      decisions and notice text
├── README.md                   user guide
├── ARCHITECTURE.md             runtime behaviour
└── STRUCTURE.md                this file map
```
