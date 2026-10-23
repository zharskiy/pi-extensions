# working-indicator

A pi extension that replaces pi's plain `Working...` line with what the agent is doing right now and the elapsed time of the current prompt, next to pi's own spinner:

```
── ⠹ Running npm test -- --run · 12s (esc to interrupt) ──────────────────────
```

## What it does

- The spinner is pi's own braille spinner, drawn inside the input's top line in the input's rule colour (it follows the thinking level and bash mode). The extension never replaces it.
- While a prompt runs (from agent start until the run settles, across all its model calls and tool runs), the working line names the current activity, the time since the prompt started from 1 s on (`12s`, `1m 5s`), and the interrupt hint from pi's `app.interrupt` keybinding, in dim. The time advances every second.
- Activities, with the target as the transcript row titles show it (paths relative to the working folder or `~`):

  | Situation | Text |
  |---|---|
  | request sent, model streaming a tool call, between steps | `Waiting for the model` |
  | thinking | `Thinking` |
  | read / edit / write | `Reading src/stats.py` / `Editing src/stats.py` / `Writing ~/notes.md` |
  | bash, powershell | `Running npm test -- --run` (the first line of the command) |
  | grep / find / ls | `Searching TODO` / `Finding **/*.test.ts` / `Listing src` |
  | codemode | `Running codemode` |
  | MCP tool | `Calling notes/search` |
  | run_agent with `wait: true` | `Waiting for 2 agents` |
  | several tools at once | `Running 3 tools` |
  | any other tool | `Running <tool name>` |

- The line hides while the assistant's answer text streams in, and comes back as soon as the text stops. When the run settles the line disappears and the message goes back to pi's default.
- Narrow terminals: the message is composed to the terminal width (less the editor's border, the spinner and the composer's frame when it is on, as the host reports; wide characters count by their columns). The activity is cut first with `...`, paths at the start and commands at the end, down to 12 columns; if it still does not fit, the hint is dropped. The elapsed time is never dropped. At 40 columns:

  ```
  ── ⠹ Running npm test -- -... · 12s ───
  ```

  When pi does not report the terminal width the full text is sent and pi cuts it.
- Only the main session drives it; subagents never show, hide or change it.
- Active only in `tui` mode; in other modes it does nothing.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/working-indicator.ts` holds the activity names, the width rule and the prompt timer (`TICK_MS`, 1000), and depends only on `core/adapter/contract.ts` and `core/manager`, whose duration format (`12s`, `1m 5s`) it shares with subagents. Tests are under `test/`.
