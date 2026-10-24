<div align="center">

# notifications

**Tells you, through your terminal, when pi is waiting for you.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Terminals](#terminals) · [Settings](#settings) · [Turning it off](#turning-it-off) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

When the main session finishes its work or a dialog waits for an answer, pi is waiting for you, possibly while you look at another window. This extension tells you so through your terminal, once per wait, and holds back while background agents run.

## What it looks like

```
pi is waiting for your input
pi needs your input: <dialog title>
```

A desktop notification from your terminal (or the terminal bell, with `"channel": "bell"`), the first after the main session finishes its work, the second while a dialog waits for an answer.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs notifications with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/notifications/index.ts
```

| You do | You see |
|---|---|
| Let the main session finish and leave the keyboard for 20 seconds | `pi is waiting for your input`, once per finished run. |
| Leave a confirmation, choice or text field unanswered for 6 seconds | `pi needs your input: <dialog title>`. |
| Press a key or start a new run first | Nothing: the notification is cancelled. |

## What it does

Two notifications, each sent at most once: one when the main session's work is done, one when a dialog waits for an answer. Nothing is sent per agent, per batch or per tool.

- **Idle**: when the main session finishes its work and you have not touched the keyboard for 20 seconds, it sends `pi is waiting for your input`. Each finished run notifies at most once; a key press or a new run cancels it; a busy extension holds it until the extension reports idle, then the full delay starts again.
- **Background agents**: while background agents run (any extension that reports on the busy channel `pi:busy`, such as subagents; payload and rules: [session-limits › Busy channel](../session-limits/README.md#busy-channel)), the notification waits. When the agents finish, the main session usually starts a new run to read their results; the notification comes 20 seconds after that run ends, once.
- **Dialogs**: when a dialog waits for an answer (a confirmation, a choice or a text field of the main session; agents never ask), it sends `pi needs your input: <dialog title>` after 6 seconds without a key press. Each key press restarts the 6 seconds; answering or closing the dialog cancels it. Each dialog notifies at most once. Overlays such as `/agents` never notify.
- **Waiting extensions**: an extension waiting for your answer outside pi's dialogs, such as the questionnaire's form, counts as a dialog (it reports on the awaiting-input channel, below) and gets `pi needs your input: questionnaire` under the same 6-second rule. While it waits the idle notification is held, as for a dialog.
- **Interactive TUI only**: `--mode rpc`, `--mode json` and `-p` write nothing.

<details>
<summary>Awaiting-input channel</summary>

An extension reports that it waits for your answer on the awaiting-input channel `pi:awaiting-input`:

```json
{ "source": "pi-questionnaire", "waiting": true, "title": "questionnaire" }
```

then `"waiting": false` when it is done. The name and parser live in `platform/shared/host-channels.ts`.

</details>

## Terminals

With the default channel `auto` the extension sends a desktop notification and rings no bell.

- **Desktop notification (OSC 9)**: iTerm2, WezTerm, Ghostty and kitty show it (they document OSC 9).
- **rxvt (OSC 777)**: when `TERM` or `TERM_PROGRAM` names rxvt it sends OSC 777 (title `pi`) instead, for rxvt-unicode with its notify extension.
- **Nothing shown**: other terminals, such as Apple Terminal, ignore the sequence, so `auto` shows nothing there. Inside tmux the desktop notification is dropped (no tmux passthrough is used), so `auto` shows nothing there either.
- **Bell fallback**: `"channel": "bell"` rings the terminal bell instead, which every terminal handles and tmux turns into a window flag. Whether the bell sounds, flashes or marks the tab is your terminal's setting.
- **Focus**: some terminals show the notification only while their window is not focused.

## Settings

Optional JSON in `~/.pi/agent/pi-notifications.json`, or `.pi/pi-notifications.json` in a trusted project (read after the user file):

```json
{
  "channel": "auto",
  "idleDelayMs": 20000,
  "dialogDelayMs": 6000
}
```

- **`channel`**: `"auto"` (desktop notification, no bell), `"bell"` (bell only, for terminals without desktop notifications and inside tmux) or `"off"`.
- **`idleDelayMs`**: how long pi waits after the work is done before notifying, 0 to 600000 milliseconds (default 20000).
- **`dialogDelayMs`**: how long a dialog waits before notifying, 0 to 600000 milliseconds (default 6000).

Invalid values are reported once as a warning and ignored. The files are read at session start; run `/reload` or start a new session after editing them.

## Turning it off

Set `"channel": "off"`, or disable this extension's entry with `pi config` (it configures which package resources load; add `-l` for the current project only).

## Architecture

- `core/` holds the logic: `notifications.ts` the timers and the rules, `settings.ts` the settings schema and defaults, both depending only on `platform/pi-adapter/index.ts` and `platform/shared/index.ts`.
- `api/plugin.ts` subscribes to the host and sends the terminal notifications; there is no `ui/`.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`, and the manager reads the settings files at each session start.
- It talks to other extensions only over pi's event bus: it listens on the busy channel `pi:busy` and the awaiting-input channel `pi:awaiting-input`, whose names are shared in `platform/shared/host-channels.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/notifications   # this extension's unit tests
npm run check                              # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
