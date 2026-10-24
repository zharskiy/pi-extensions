# notifications

A pi extension that tells you, through your terminal, when pi is waiting for you.

## What it does

- When the main session finishes its work and you have not touched the keyboard for 20 seconds, it sends one notification: `pi is waiting for your input`. Each finished run notifies at most once; a key press or a new run cancels it; a busy extension holds it until the extension reports idle, then the full delay starts again.
- While background agents run (any extension that reports on the busy channel `pi:busy`, such as subagents; payload and rules: [session-limits › Busy channel](../session-limits/README.md#busy-channel)), the notification waits. When the agents finish, the main session usually starts a new run to read their results; the notification comes 20 seconds after that run ends, once.
- When a dialog waits for an answer (a confirmation, a choice or a text field of the main session; agents never ask), it sends `pi needs your input: <dialog title>` after 6 seconds without a key press. Each key press restarts the 6 seconds; answering or closing the dialog cancels it. Each dialog notifies at most once. Overlays such as `/agents` never notify.
- An extension waiting for your answer outside pi's dialogs, such as the questionnaire's form, counts as a dialog: it reports on the awaiting-input channel `pi:awaiting-input` (`{ "source": "pi-questionnaire", "waiting": true, "title": "questionnaire" }`, then `"waiting": false` when it is done; the name and parser live in `core/manager/channels.ts`), and the extension sends `pi needs your input: questionnaire` under the same 6-second rule. While it waits the idle notification is held, as for a dialog.
- Nothing is sent per agent, per batch or per tool.
- Active only in the interactive TUI; `--mode rpc`, `--mode json` and `-p` write nothing.

## Terminals

With the default channel `auto` the extension sends a desktop notification and rings no bell. iTerm2, WezTerm, Ghostty and kitty show it (they document OSC 9). When `TERM` or `TERM_PROGRAM` names rxvt it sends OSC 777 (title `pi`) instead, for rxvt-unicode with its notify extension. Other terminals, such as Apple Terminal, ignore the sequence, so `auto` shows nothing there. Inside tmux the desktop notification is dropped (no tmux passthrough is used), so `auto` shows nothing there either. The fallback is `"channel": "bell"`: it rings the terminal bell instead, which every terminal handles and tmux turns into a window flag. Whether the bell sounds, flashes or marks the tab is your terminal's setting. Some terminals show the notification only while their window is not focused.

## Settings

Optional JSON in `~/.pi/agent/pi-notifications.json`, or `.pi/pi-notifications.json` in a trusted project (read after the user file):

```json
{
  "channel": "auto",
  "idleDelayMs": 20000,
  "dialogDelayMs": 6000
}
```

- `channel`: `"auto"` (desktop notification, no bell), `"bell"` (bell only, for terminals without desktop notifications and inside tmux) or `"off"`.
- `idleDelayMs`: how long pi waits after the work is done before notifying, 0 to 600000 milliseconds (default 20000).
- `dialogDelayMs`: how long a dialog waits before notifying, 0 to 600000 milliseconds (default 6000).

Invalid values are reported once as a warning and ignored. The files are read at session start; run `/reload` or start a new session after editing them.

## Turning it off

Set `"channel": "off"`, or disable this extension's entry with `pi config` (it configures which package resources load; add `-l` for the current project only).

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `pi-adapter/` (repository root); `src/notifications.ts` holds the timers and the rules, `src/settings.ts` the settings schema and defaults, both depending only on `pi-adapter/index.ts` and `core/manager/`; `watchSettings` in `core/manager/settings.ts` reads the files. The busy and awaiting-input channel names are shared in `core/manager/channels.ts`. Tests are under `test/`.
