# style

A pi extension that switches the output style of the main session and of every subagent: `/style concise` makes them answer in short, result-first replies, `/style normal` turns it off.

## What it does

- `/style <name>` sets the style for the main session and for every agent, at any depth, from their next run. A reply already being written finishes in the old style; agents pick the change up on their next start, wake or message.
- `/style normal` removes the style. `/style` alone tells you the current style and the available ones; an unknown name is an error that lists them. The argument completes in the slash menu.
- While a style is on, the footer block (with the footer extension) shows a dim `style concise` line; nothing is shown for `normal`.
- The style is added as its own section of the system prompt (`<output_style>`, after the working directory), so it leaves pi's prompt, your `APPEND_SYSTEM.md` and the subagents prompts alone, and only that section changes when you switch.
- It works without the subagents extension; then it styles the main session only.

## Concise

`prompts/concise.md` follows the behaviour Claude Code documents for its Concise output style: the first sentence states the result, no lead-in, no step-by-step narration and no closing recap, a simple question gets one to three sentences, and the engineering work stays as thorough as usual. Explanations you ask for, errors, failing test output, security concerns and confirmations before destructive actions keep their full content, and a background agent's final result still carries everything its caller needs. Unlike Claude Code, the style also applies to every subagent.

## Adding a style

Every markdown file in `prompts/` is a style named after the file: drop in `prompts/<name>.md` and `/style <name>` uses its text as the prompt section. The files are read when the extension loads; run `/reload` after adding one. `normal` is reserved for no style.

## Settings

`/style` writes the choice to `~/.pi/agent/pi-style.json`:

```json
{
  "style": "concise"
}
```

The file is read at every session start, so the style survives `/new`, `/resume` and `/reload`. A trusted project can set its own style in `.pi/pi-style.json` (read after the user file, so it wins). `/style` still applies a new style live in such a project, warns that the project file wins at the next session start, and writes only the user file. An unknown style is reported once as a warning and ignored.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/style.ts` loads the styles and holds the command, the status and the settings handling, `src/settings.ts` the file name and schema, both depending only on `core/adapter/contract.ts` and `core/manager/`. `Host.setPromptSection` (`core/adapter/pi-sections.ts`) puts the section into the main session's and every agent's prompt. Tests are under `test/`.
