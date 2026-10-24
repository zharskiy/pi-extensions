<div align="center">

# style

**Switches the output style of the main session and of every subagent with one command.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Concise](#concise) · [Adding a style](#adding-a-style) · [Settings](#settings) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

This extension switches the output style of the main session and of every subagent at once: `/style concise` makes them answer in short, result-first replies, `/style normal` turns it off, and `/style` alone lets you pick one from a list. The style is its own section of the system prompt, and a new style is one markdown file in `prompts/`.

## What it looks like

```
──────────────────────────────────────────────────────────────
 Output style

 › 1. concise ✓  short, result-first replies
   2. normal  no style, pi's default replies

 ↑↓ to select · 1-9 to pick · enter to choose · esc to cancel
──────────────────────────────────────────────────────────────
```

The list `/style` alone opens in place of the editor, the current style marked `✓` and selected.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs style with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/style/index.ts
```

| Command | What happens |
|---|---|
| `/style concise` | The main session and every agent answer in short, result-first replies from their next run. |
| `/style` | A list of every style in place of the editor; a pick does what `/style <name>` does. |
| `/style normal` | The style is removed. |

## What it does

One style at a time applies to the main session and to every agent, at any depth. It works without the subagents extension; then it styles the main session only.

- **`/style <name>`** sets the style for the main session and for every agent, at any depth, from their next run. A reply already being written finishes in the old style; agents pick the change up on their next start, wake or message.
- **`/style` alone** opens a list of every style in place of the editor, `normal` included, each with a few words describing it next to its name; the current one is marked `✓` and selected. Move with ↑/↓ (Home/End jump), pick with Enter or the digit in front of the name, or press Esc to leave everything as it is. The strip under the list reads `↑↓ to select · 1-9 to pick · enter to choose · esc to cancel`. A pick does exactly what `/style <name>` does. Outside the interactive terminal `/style` alone tells you the current style and the available ones instead.
- **`/style normal`** removes the style. An unknown name is an error that lists the available ones. The argument completes in the slash menu.
- **Own prompt section**: the style is added as its own section of the system prompt (`<output_style>`, after the working directory), so it leaves pi's prompt, your `APPEND_SYSTEM.md` and the subagents prompts alone, and only that section changes when you switch.

## Concise

`prompts/concise.md` asks for short, result-first replies. The style also applies to every subagent.

- **Short**: the first sentence states the result, no lead-in, no step-by-step narration and no closing recap; a simple question gets one to three sentences.
- **Thorough work**: the engineering work stays as thorough as usual.
- **Full content kept**: explanations you ask for, errors, failing test output, security concerns and confirmations before destructive actions keep their full content, and a background agent's final result still carries everything its caller needs.

## Adding a style

Every markdown file in `prompts/` is a style named after the file: drop in `prompts/<name>.md` and `/style <name>` uses its text as the prompt section. Start the file with a front matter block holding a description of a handful of words; the picker shows it next to the name, and the block is stripped from the prompt:

```markdown
---
description: short, result-first replies
---

# Output style: <name>
...
```

- **Front matter**: only the `description:` line is read; a file without front matter is used whole and shows no description.
- **Loading**: the files are read when the extension loads; run `/reload` after adding one.
- **Reserved**: `normal` is reserved for no style.

## Settings

`/style` writes the choice to `~/.pi/agent/pi-style.json`:

```json
{
  "style": "concise"
}
```

- **Survives sessions**: the file is read at every session start, so the style survives `/new`, `/resume` and `/reload`.
- **Project style**: a trusted project can set its own style in `.pi/pi-style.json` (read after the user file, so it wins). `/style` still applies a new style live in such a project, warns that the project file wins at the next session start, and writes only the user file.
- **Unknown style**: reported once as a warning and ignored.

## Architecture

- `core/` holds the logic: `style.ts` sets the prompt section, `styles.ts` loads the style files (front matter description, prompt text), `settings.ts` holds the file name and schema and reads and writes the settings files through `platform/shared/settings-files.ts`.
- `ui/pick.ts` builds the list: `selectForm` from `platform/ui-kit/select.ts` (the one the questionnaire uses too), shown through `HostUi.showForm`. `api/plugin.ts` wires the command, the session start and the settings.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`. All of its files depend only on `platform/pi-adapter/index.ts`, `platform/shared/index.ts`, `platform/ui-kit/index.ts` and `platform/extension-manager/index.ts`.
- It reaches agents without talking to the subagents extension: `Host.setPromptSection` (`platform/pi-adapter/prompt/sections.ts`) puts the section into the main session's and every agent's prompt.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/style   # this extension's unit tests
npm run check                      # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
