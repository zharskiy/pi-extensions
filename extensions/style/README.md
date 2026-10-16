# style

A pi extension that switches the output style of the main session and of every subagent: `/style concise` makes them answer in short, result-first replies, `/style normal` turns it off, and `/style` alone lets you pick one from a list.

## What it does

- `/style <name>` sets the style for the main session and for every agent, at any depth, from their next run. A reply already being written finishes in the old style; agents pick the change up on their next start, wake or message.
- `/style` alone opens a list of every style in place of the editor, `normal` included, each with a few words describing it next to its name; the current one is marked `✓` and selected. Move with ↑/↓ (Home/End jump), pick with Enter or the digit in front of the name, or press Esc to leave everything as it is. A pick does exactly what `/style <name>` does. Outside the interactive terminal `/style` alone tells you the current style and the available ones instead.
- `/style normal` removes the style. An unknown name is an error that lists the available ones. The argument completes in the slash menu.
- The style is added as its own section of the system prompt (`<output_style>`, after the working directory), so it leaves pi's prompt, your `APPEND_SYSTEM.md` and the subagents prompts alone, and only that section changes when you switch.
- It works without the subagents extension; then it styles the main session only.

## Concise

`prompts/concise.md` asks for short, result-first replies: the first sentence states the result, no lead-in, no step-by-step narration and no closing recap, a simple question gets one to three sentences, and the engineering work stays as thorough as usual. Explanations you ask for, errors, failing test output, security concerns and confirmations before destructive actions keep their full content, and a background agent's final result still carries everything its caller needs. The style also applies to every subagent.

## Adding a style

Every markdown file in `prompts/` is a style named after the file: drop in `prompts/<name>.md` and `/style <name>` uses its text as the prompt section. Start the file with a front matter block holding a description of a handful of words; the picker shows it next to the name, and the block is stripped from the prompt:

```markdown
---
description: short, result-first replies
---

# Output style: <name>
...
```

Only the `description:` line is read; a file without front matter is used whole and shows no description. The files are read when the extension loads; run `/reload` after adding one. `normal` is reserved for no style.

## Settings

`/style` writes the choice to `~/.pi/agent/pi-style.json`:

```json
{
  "style": "concise"
}
```

The file is read at every session start, so the style survives `/new`, `/resume` and `/reload`. A trusted project can set its own style in `.pi/pi-style.json` (read after the user file, so it wins). `/style` still applies a new style live in such a project, warns that the project file wins at the next session start, and writes only the user file. An unknown style is reported once as a warning and ignored.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/style.ts` wires the command, the session start and the prompt section; `src/styles.ts` loads the style files (front matter description, prompt text); `src/settings.ts` holds the file name and schema and reads and writes the settings files through `core/manager/settings.ts`; `src/pick.ts` builds the list. All of them depend only on `core/adapter/contract.ts` and `core/manager/`. The list is `selectForm` from `core/manager/select.ts` (the one the questionnaire uses too), shown through `HostUi.showForm`. `Host.setPromptSection` (`core/adapter/pi-sections.ts`) puts the section into the main session's and every agent's prompt. Tests are under `test/`.
