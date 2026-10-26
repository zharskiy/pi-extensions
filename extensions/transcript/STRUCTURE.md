# Transcript structure

```
extensions/transcript/
├── index.ts                        entry: re-exports the default from api/extension.ts
├── api/
│   ├── extension.ts                createManagedExtension: namespace pi-transcript, transcriptPlugin
│   └── plugin.ts                   transcriptPlugin, createTranscript: tool rows, thinking label, answer rule and its turn
├── core/
│   ├── turn-summary.ts             turn work count, the answer entry's data, label and parsing
│   ├── tool-kinds.ts               call classification: arguments, read range, listed counts, missing file, edit diff text, duration
│   └── word-spans.ts               changed-word spans of a removed/added line pair
├── ui/
│   ├── answer-rule.ts              answerRule: the dim labelled rule of an answer entry
│   ├── tools.ts                    transcriptRows: look per tool, title, outcome and hint of every row
│   ├── tool-look.ts                Look, Context, Outcome types and the shared look helpers
│   ├── skill.ts                    collapsed skill-read row: [skill] label, name, range, one-line failure
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
│   ├── transcript.test.ts          tool rows registration, the thinking label and the answer rule on a fake host
│   └── support/transcript-rows.ts  rows and numbered helpers
├── README.md                       user guide
├── ARCHITECTURE.md                 runtime behaviour
└── STRUCTURE.md                    this file map
```
