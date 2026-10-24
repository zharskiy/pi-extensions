# Transcript structure

```
extensions/transcript/
├── index.ts                        entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts                createManagedExtension: namespace pi-transcript, transcriptPlugin
│   └── plugin.ts                   transcriptPlugin, createTranscript: tool rows and the hidden thinking label
├── core/
│   ├── tool-kinds.ts               call classification: arguments, read range, listed counts, missing file, edit diff text, duration
│   └── word-spans.ts               changed-word spans of a removed/added line pair
├── ui/
│   ├── tools.ts                    transcriptRows: look per tool, title, outcome and hint of every row
│   ├── tool-look.ts                Look, Context, Outcome types and the shared look helpers
│   ├── shell.ts                    bash and powershell rows
│   ├── codemode.ts                 codemode rows and their call list
│   ├── generic.ts                  MCP and unknown-tool rows
│   ├── output.ts                   output cleaning, shell status line, previews and count lines
│   └── diff.ts                     edit diff parsing, counts and rows
├── tests/
│   ├── diff.test.ts                diff parsing and rows
│   ├── output.test.ts              output helpers
│   ├── pi.test.ts                  rows through pi's components
│   ├── tools.test.ts               every tool's rows
│   ├── transcript.test.ts          tool rows registration and the thinking label on a fake host
│   └── support/transcript-rows.ts  rows and numbered helpers
├── README.md                       user guide
├── ARCHITECTURE.md                 runtime behaviour
└── STRUCTURE.md                    this file map
```
