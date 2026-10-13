# Plan 03: the global notifications extension

Implements D5 and UX spec §8/§9. Depends on plan 01 §F (`Host.onDialog`, `HostUi.onKeyPress`, fake drivers `dialog()`/`pressKey()`/`keyListeners`) and §G (`BUSY_CHANNEL = "pi:busy"`); both must be merged first. This plan only uses the `BUSY_CHANNEL` constant and writes `pi:busy` in docs.

Review resolution: Reviewed 2026-10-14: findings 7, 23, 32 applied; decisions P1 (no BEL on auto), P2 (idleDelayMs 20 000). Revised 2026-10-14 (fourth pass): agents never ask the user (decisions, fourth pass; spec §2 "Agents never ask"), so every dialog this extension sees is a main-session dialog; the forwarded-dialog wording is gone.

## 1. Goal and behaviour

New extension `extensions/notifications/` (namespace `pi-notifications`): one terminal notification when pi waits for the user after the work is done (main settled, no busy source, no keystroke for `idleDelayMs`), and one when a dialog waits unanswered (`dialogDelayMs`). TUI only. The subagents `notifications` plugin, its setting and the `session:closing` bus event go. Nothing per agent, batch or tool.

Texts (exact): `pi is waiting for your input`; `pi needs your input: <title>` (a dialog with no title: `pi needs your input`). `<title>` is pi's `ui_prompt_start.title` as is, e.g. `pi needs your input: Switch to a new session?` (the confirmation `/session-handoff` shows while agents run). Only the main session opens dialogs: an agent's dialogs resolve to their denial defaults inside the child and never reach the main UI (spec §2 "Agents never ask"), so there is no per-agent dialog notification.

Channels (`channel` setting): `auto` = OSC 9 `\x1b]9;<message>\x07`, or on rxvt (`TERM`/`TERM_PROGRAM` matches `/rxvt/i`) OSC 777 `\x1b]777;notify;pi;<message>\x07`, with no leading BEL (the trailing `\x07` only terminates the OSC string); `bell` = BEL only; `off` = the extension does nothing at all (no key listener, no timers). `auto` rings no bell because the idle notification also fires after ordinary replies the user is reading, and a bell every time is noise. Terminals without OSC 9/777 support get nothing on `auto`, as with Claude Code; `bell` is their fallback.

### State machine (`src/notifications.ts`)

Per extension instance (pi builds one per session):

| var | meaning | initial |
|---|---|---|
| `active` | session mode is `tui` and `channel !== "off"`; set in `onSessionStart` | false |
| `pending` | a settle that has not notified and was not cancelled | false |
| `sources` | `Set<string>` of busy sources whose last report was `busy: true` | empty |
| `dialog` | `{ title?: string; fired: boolean }` while a non-`custom` dialog is open | undefined |
| `idleTimer`, `dialogTimer` | cancel functions of unref'd `setTimeout`s | undefined |

Derived states: **quiet** (`!pending`), **held** (`pending`, `sources` non-empty: no timer), **armed** (`pending`, `idleTimer` set), plus the orthogonal **dialog-open** / **dialog-fired**.

| input | guard | effect |
|---|---|---|
| `onSessionStart(info)` | | load settings (warnings once); `active = info.mode === "tui" && channel !== "off"`; if `active` and no listener yet: `offKeys = host.ui.onKeyPress(key)` |
| `onIdle` | `active` | `pending = true`; `sources.size === 0` → `armIdle()` |
| `onAgentStart` | | `pending = false`; clear `idleTimer` |
| busy `{source, busy: true}` | parsed by `parseBusySignal` | `sources.add(source)`; clear `idleTimer` (`pending` stays) |
| busy `{source, busy: false}` | parsed | `removed = sources.delete(source)`; `removed && sources.size === 0 && pending` → `armIdle()` |
| keystroke (`onKeyPress`) | | `pending = false`; clear `idleTimer`; `dialog && !dialog.fired` → `armDialog()` |
| `onDialog({phase:"start", kind, title})` | `active`, `kind !== "custom"` | `dialog = { title, fired: false }`; `armDialog()` |
| `onDialog({phase:"end", kind})` | `kind !== "custom"` | `dialog = undefined`; clear `dialogTimer`; `pending && sources.size === 0` → `armIdle()` |
| `onSessionShutdown` | | `active = false`; `pending = false`; `dialog = undefined`; clear both timers; `offKeys?.()` |
| `idleTimer` fires | `active && pending && sources.size === 0 && !dialog && host.isIdle()` | `pending = false`; `send(IDLE_TEXT)`; otherwise nothing (`pending` kept, so a dialog end or a busy clear re-arms) |
| `dialogTimer` fires | `active && dialog && !dialog.fired` | `dialog.fired = true`; `send(dialogText(dialog.title))` |

`armIdle()` = clear `idleTimer`, then `idleTimer = later(fire, settings.idleDelayMs)` (full delay each time). `armDialog()` = same with `dialogDelayMs`, so the dialog timer runs from the later of the dialog start and the last keystroke. `send(text)` = `host.ui.terminalNotify(text, channel)` (channel is `auto` or `bell` here). Busy bookkeeping runs even when inactive (cheap; the subscription is made at boot so the registry's `session_start` publish is heard). Repeated `busy: true` from one source is one entry; `busy: false` from an unknown source does nothing. Nested dialogs are folded into the outer one by pi, so a dialog opened while the `/agents` overlay (`custom`) is open does not notify (known limitation; the user is at the keyboard).

### Adapter contract change (required)

Today `terminalNotify(title, body)` always writes BEL + OSC 9/777 and OSC 9 carries `title: body`; a bell-only channel, a desktop notification without the bell, and "one text, title `pi` only on OSC 777" are all inexpressible. The only caller is the subagents plugin removed below, so the signature is replaced, not extended:

```ts
// core/adapter/contract.ts
export type NotifyChannel = "auto" | "bell";
// HostUi, replacing terminalNotify(title, body)
/** tui only. `bell` writes BEL. `auto` writes only a desktop notification with `message`, no BEL: OSC 9, or OSC 777 titled `pi` when TERM or TERM_PROGRAM names rxvt. Control characters in `message` become spaces. */
terminalNotify(message: string, channel: NotifyChannel): void;
```

`core/adapter/pi-ui.ts`: `notificationSequence(message: string, channel: NotifyChannel, env: TerminalEnv = process.env)`: `text = cleanText(message)`; `bell` → `"\x07"`; rxvt → `` `\x1b]777;notify;${OSC_777_TITLE};${text}\x07` `` with `const OSC_777_TITLE = "pi"`; else `` `\x1b]9;${text}\x07` `` (`auto` never starts with a BEL; the final `\x07` is the OSC terminator). `terminalNotify(message, channel)` keeps today's tui gate and writer (`lastTui.terminal.write`, else stdout).

`core/test/adapter/pi-ui.test.ts`, `describe("terminalNotify")` rewritten:
- `"writes one OSC 9 notification without a bell in tui mode"`: ghostty env, `("pi is waiting for your input", "auto")` → `[ESC]9;pi is waiting for your input + BEL]` (no BEL before `ESC`; the last BEL is the terminator).
- `"writes OSC 777 titled pi for rxvt terminals"`: `TERM: "rxvt-unicode-256color"` → `[ESC]777;notify;pi;pi is waiting for your input + BEL]`.
- `"writes only the bell for the bell channel"`: ghostty and rxvt env → `[BEL]` each.
- `"writes nothing in rpc, print or json mode, or once the session is stale"`: as today, both channels.
- `"replaces control characters in the message"`: `notificationSequence("a${ESC}]0;x\nline${BEL}", "auto", {})` → `${ESC}]9;a ]0;x line${BEL}`; with `{ TERM_PROGRAM: "urxvt" }` → `${ESC}]777;notify;pi;a ]0;x line${BEL}`.

`core/test/helpers/fakes.ts`: `terminalNotices: { message: string; channel: NotifyChannel }[]`; `terminalNotify: (message, channel) => host.terminalNotices.push({ message, channel })`.

### Settings rule change (`core/manager/settings.ts`)

`parseSettings` has no string rule. Add `type ChoiceRule = { type: "choice"; values: readonly string[] }` to `SettingsRule`; `isValid`: `typeof value === "string" && rule.values.includes(value)`; `expectation`: `` `one of ${rule.values.map((v) => `"${v}"`).join(", ")}` ``. Test in `core/test/manager/settings.test.ts`: `"accepts only listed strings for a choice rule"` (schema `{ mode: { type: "choice", values: ["a", "b"] } }`: `"b"` kept; `"c"` and `1` → `f.json: mode must be one of "a", "b"`).

## 2. Files to create

### `extensions/notifications/src/index.ts`

```ts
import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createNotifications } from "./notifications.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension((host) => { createNotifications(host); }, { root, namespace: "pi-notifications" });
```

### `extensions/notifications/src/settings.ts`

- `export type Channel = "auto" | "bell" | "off"`; `export type NotificationSettings = { channel: Channel; idleDelayMs: number; dialogDelayMs: number }`.
- `SETTINGS_FILE = "pi-notifications.json"`; `DEFAULT_SETTINGS = { channel: "auto", idleDelayMs: 20_000, dialogDelayMs: 6_000 }`.
- Schema: `channel: { type: "choice", values: ["auto", "bell", "off"] }`, `idleDelayMs` and `dialogDelayMs`: `{ type: "number", min: 0, max: 600_000 }`.
- `loadSettings(agentDir, cwd, projectTrusted)`: user file via `readSettingsFile(schema, userSettingsPath(agentDir, SETTINGS_FILE))`, project file only when trusted (`projectSettingsPath`), merged defaults → user → project; returns `{ settings, errors }`. Same shape as `extensions/session-limits/src/settings.ts`.
- `watchSettings(host): () => NotificationSettings`: copy of session-limits' `watchSettings` (reload on every `onSessionStart`, each distinct error notified once as `pi-notifications settings: <error>`, level `warning`), registered by `createNotifications` before its own `onSessionStart` so settings are loaded when `active` is computed.

### `extensions/notifications/src/notifications.ts`

Exports `IDLE_TEXT = "pi is waiting for your input"`, `dialogText(title?: string)` and `createNotifications(host: Host)`, implementing the table in §1. Imports only `contract.ts`, `core/manager/channels.ts` (`BUSY_CHANNEL`, `parseBusySignal`) and `./settings.ts`. Timers: `const later = (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); }`. The clock is injected the way working-indicator and session-limits do it, through vitest's fake timers; no timer parameter. Handlers register at boot: `watchSettings`, `onSessionStart`, `subscribe(BUSY_CHANNEL)`, `onIdle`, `onAgentStart`, `onDialog`, `onSessionShutdown`; only the key listener is registered at session start (it needs the tui context).

### `extensions/notifications/README.md` (full text)

```markdown
# notifications

A pi extension that tells you, through your terminal, when pi is waiting for you.

## What it does

- When the main session finishes its work and you have not touched the keyboard for 20 seconds, it sends one notification: `pi is waiting for your input`. Each finished run notifies at most once; a key press, a new run or a busy extension cancels it.
- While background agents run (any extension that reports on the busy channel `pi:busy`, such as subagents), the notification waits. When the agents finish, the main session usually starts a new run to read their results; the notification comes 20 seconds after that run ends, once.
- When a dialog waits for an answer (a confirmation, a choice or a text field of the main session; agents never ask), it sends `pi needs your input: <dialog title>` after 6 seconds without a key press. Each key press restarts the 6 seconds; answering or closing the dialog cancels it. Each dialog notifies at most once. Overlays such as `/agents` never notify.
- Nothing is sent per agent, per batch or per tool.
- Active only in the interactive TUI; `--mode rpc`, `--mode json` and `-p` write nothing.

## Terminals

With the default channel `auto` the extension sends a desktop notification and rings no bell. iTerm2, WezTerm, Ghostty and kitty show it (they document OSC 9). When `TERM` or `TERM_PROGRAM` names rxvt it sends OSC 777 (title `pi`) instead, for rxvt-unicode with its notify extension. Other terminals, such as Apple Terminal, ignore the sequence, so `auto` shows nothing there. Inside tmux the desktop notification is dropped (no tmux passthrough is used), so `auto` shows nothing there either. The fallback is `"channel": "bell"`: it rings the terminal bell instead, which every terminal handles and tmux turns into a window flag. Whether the bell sounds, flashes or marks the tab is your terminal's setting. Some terminals show the notification only while their window is not focused.

## Settings

Optional JSON in `~/.pi/agent/pi-notifications.json`, or `.pi/pi-notifications.json` in a trusted project (read after the user file):

    {
      "channel": "auto",
      "idleDelayMs": 20000,
      "dialogDelayMs": 6000
    }

- `channel`: `"auto"` (desktop notification, no bell), `"bell"` (bell only, for terminals without desktop notifications and inside tmux) or `"off"`.
- `idleDelayMs`: how long pi waits after the work is done before notifying, 0 to 600000 milliseconds (default 20000).
- `dialogDelayMs`: how long a dialog waits before notifying, 0 to 600000 milliseconds.

Invalid values are reported once as a warning and ignored. The files are read at session start; run `/reload` or start a new session after editing them.

## Turning it off

Set `"channel": "off"`, or disable this extension's entry with `pi config` (it configures which package resources load; add `-l` for the current project only).

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `core/adapter/` (repository root); `src/notifications.ts` holds the timers and the rules, `src/settings.ts` the settings files, both depending only on `core/adapter/contract.ts` and `core/manager/`. The busy channel name is shared in `core/manager/channels.ts`. Tests are under `test/`.
```

(Write the settings block as a fenced `json` block in the real file; it is indented here only to nest it. `pi config` is documented in pi's `docs/cli.md`.)

### `extensions/notifications/test/notifications.test.ts`

Setup: `vi.useFakeTimers()` / `vi.useRealTimers()` per test; `setup(mode = "tui", file?)` creates `mkdtempSync` agent dir and cwd, writes `file` to `<agentDir>/pi-notifications.json` when given, `createFakeHost({ mode, agentDir, cwd })`, `createNotifications(host)`, `host.start()`. `busy(host, source, value)` = `host.emit(BUSY_CHANNEL, { source, busy: value })`. `IDLE = { message: "pi is waiting for your input", channel: "auto" }`.

| test | steps → assertion |
|---|---|
| `fires once after the idle delay when the session settles with no busy source` | settle; advance 19_999 → `[]`; advance 1 → `[IDLE]`; advance 60_000 → still `[IDLE]` |
| `a keystroke after the settle cancels it` | settle; advance 5_000; `pressKey()`; advance 60_000 → `[]` |
| `a keystroke before the settle does not cancel it` | `pressKey()`; settle; advance 20_000 → `[IDLE]` |
| `a new run cancels it` | settle; advance 5_000; `agentStart()`; advance 60_000 → `[]` |
| `holds while a busy source is set and arms when the last source clears` | busy a/b true; settle; advance 60_000 → `[]`; busy a false; advance 60_000 → `[]`; busy b false; advance 19_999 → `[]`; advance 1 → `[IDLE]` |
| `hears a busy source reported before start` | create the host and `createNotifications(host)`, busy a true, then `host.start()`; settle; advance 60_000 → `[]`; busy a false; advance 20_000 → `[IDLE]` |
| `a busy source appearing cancels an armed timer` | settle; advance 5_000; busy a true; advance 60_000 → `[]`; busy a false; advance 20_000 → `[IDLE]` |
| `keeps busy sources by name and treats repeated reports as one` | busy a true twice; settle; busy a false once; advance 20_000 → `[IDLE]` |
| `ignores busy:false from an unknown source and invalid payloads` | busy a true; settle; busy x false; `emit(BUSY_CHANNEL, { source: "", busy: false })`; advance 60_000 → `[]` |
| `a busy source clearing after a keystroke does not notify` | busy a true; settle; `pressKey()`; busy a false; advance 60_000 → `[]` |
| `a wake run between settles does not double-notify` | busy agents true; settle; advance 60_000 → `[]`; busy agents false; advance 2_000; `agentStart()`; advance 30_000 → `[]`; settle; advance 19_999 → `[]`; advance 1 → `[IDLE]`; advance 60_000 → length 1 |
| `notifies a waiting dialog after the dialog delay` | `dialog("start", "confirm", "Allow bash?")`; advance 5_999 → `[]`; advance 1 → `[{ message: "pi needs your input: Allow bash?", channel: "auto" }]` |
| `each keystroke restarts the dialog timer` | dialog start; advance 5_000; `pressKey()`; advance 5_000 → `[]`; advance 1_000 → length 1 |
| `the dialog ending cancels it` | dialog start; advance 3_000; `dialog("end", "confirm")`; advance 60_000 → `[]` |
| `notifies a dialog at most once` | dialog start; advance 6_000 → length 1; `pressKey()`; advance 60_000 → length 1 |
| `uses the short text for a dialog without a title` | `dialog("start", "input")`; advance 6_000 → `[{ message: "pi needs your input", channel: "auto" }]` |
| `ignores custom dialogs` | `dialog("start", "custom", "Agents")`; advance 60_000 → `[]` |
| `skips the idle notification while a dialog is open and arms it when the dialog ends` | settle; advance 2_000; dialog start "confirm" "Allow?"; advance 18_000 (the idle timer fires with the dialog open and is skipped) → only the dialog notice; `dialog("end", "confirm")`; advance 19_999 → length 1; advance 1 → second notice `IDLE` |
| `rings only the bell with the bell channel` | file `{ channel: "bell" }`; settle; advance 20_000 → `[{ message: IDLE.message, channel: "bell" }]` |
| `sends nothing with the off channel` | file `{ channel: "off" }`; settle; dialog start; advance 60_000 → `[]`; `keyListeners.size === 0` |
| `does nothing outside tui` | for `rpc`, `print`, `json`: settle; dialog start; advance 60_000 → `[]`, `keyListeners.size === 0` |
| `sends nothing after shutdown` | settle; dialog start; `await shutdown()`; advance 60_000 → `[]`; `keyListeners.size === 0` |
| `uses the configured delays` | file `{ idleDelayMs: 0, dialogDelayMs: 1_000 }`; settle; advance 0 → `[IDLE]`; dialog start; advance 1_000 → length 2 |
| `warns once about invalid settings and keeps the defaults` | file `{ channel: "loud", idleDelayMs: -1 }`; `notices` equals `[{ message: "pi-notifications settings: <file>: channel must be one of \"auto\", \"bell\", \"off\"", level: "warning" }, { …idleDelayMs must be a number between 0 and 600000… }]`; settle; advance 20_000 → `[IDLE]` |

### `extensions/notifications/test/settings.test.ts`

- `has the defaults`: `loadSettings` on empty dirs → `{ channel: "auto", idleDelayMs: 20_000, dialogDelayMs: 6_000 }`, no errors.
- `merges the user file and a trusted project file, project last`: user `{ channel: "bell", idleDelayMs: 1_000 }`, project `{ idleDelayMs: 2_000 }` trusted → `{ channel: "bell", idleDelayMs: 2_000, dialogDelayMs: 6_000 }`.
- `ignores the project file when the project is not trusted`: same files, untrusted → `idleDelayMs: 1_000`.

## 3. Files to change (package and docs)

- `package.json`: `pi.extensions` gains `"./extensions/notifications/src/index.ts"` after working-indicator; `keywords` gains `"notifications"` after `"working-indicator"`; description: replace `a working line with a spinner, a playful verb and the elapsed turn time,` with `a working line with a spinner, a playful verb and the elapsed turn time, a terminal notification when pi waits for your input,`. `files` needs nothing (globs cover `extensions/*/src/**` and `extensions/*/README.md`); `.github/workflows/ci.yml` needs nothing (the pack check greps `/test/`).
- Root `README.md`: after the working-indicator bullet add `- [notifications](extensions/notifications/README.md): one terminal notification when pi waits for your input (after the work and any background agents are done) and one when a dialog waits unanswered.`; in the subagents bullet drop `terminal notifications and ` (→ `with a context breakdown per agent and MCP for every agent with tools`); add `pi -e ./pi-extensions/extensions/notifications/src/index.ts` after the working-indicator line.
- `STRUCTURE.md`: tree, after `working-indicator/`: `notifications/ # terminal notification when pi waits for you` with `src/ # index, notifications, settings`, `test/`, `README.md`; drop `notifications/      # completion notifications` from the plugin list; entry points `{subagents,session-limits,spending,working-indicator,notifications,command-aliases,composer,footer}`.
- `ARCHITECTURE.md`:
  - Line 3: `seven extensions` → `eight extensions`. "Extension manager" first line: add `notifications` to the list of extensions that wire functions directly.
  - "Startup and the adapter", the `terminalNotify` bullet becomes: "`terminalNotify(message, channel)` writes BEL for `bell`, and for `auto` only an OSC 9 notification (OSC 777 titled `pi` on rxvt), no BEL; tui only."
  - Bus events list: drop `session:closing`. Subagents plugin list: drop `notifications [run-agent], `. Shutdown bullet: drop `` `session:closing` silences notifications, ``.
  - Rename "Status, views, notifications" to "Status and views" and delete its last bullet (`Notifications (terminal escape sequence) fire for …`).
  - Session-limits "Busy sources" bullet: append "The notifications extension reads the same channel to hold its idle notification."
  - Persistence: `<agentDir>` list gains `pi-notifications.json`; `<cwd>/.pi/` "the same settings files" stays true.
  - New section after "Working-indicator":

```markdown
## Notifications

- Active only in `tui` mode and when `channel` is not `off`; otherwise it registers no key listener and arms no timer. `pi-notifications.json` is read at session start; nothing is persisted, timers are unref'd and cleared on shutdown.
- Idle notification: `Host.onIdle` (pi's `agent_settled`, once per run) marks the settle pending and, when no source is on the busy channel (`pi:busy`, kept as a set of source names like session-limits), arms an `idleDelayMs` timer. `Host.onAgentStart`, any key (`HostUi.onKeyPress`, observed without consuming) and a busy source appearing cancel it; the last busy source clearing or a dialog ending re-arms it with the full delay while the settle is still pending. At fire time it checks again (pending, no busy source, no dialog, `isIdle()`), sends `pi is waiting for your input` and clears the pending settle, so a settle notifies at most once.
- Agents and the wake: subagents holds the busy channel while any agent is open. Agents finishing while main is idle arm the timer, but the outbox's wake starts a run through a visible user line at once, which cancels it; that run's settle arms it again. One notification follows the finished work.
- Dialog notification: `Host.onDialog` (pi's `ui_prompt_start`/`ui_prompt_end`, outermost dialog only, main-session dialogs only since agents never open one; `custom` overlays ignored). `dialogDelayMs` after the later of the dialog start and the last key it sends `pi needs your input: <title>`, at most once per dialog; the dialog ending cancels it.
- Output: `HostUi.terminalNotify(message, channel)` with `auto` (OSC 9/777 only, no BEL: the idle notification follows ordinary replies too, and a bell each time is noise) or `bell`.
```

## 4. Removal from subagents

1. Delete `extensions/subagents/src/plugins/notifications/` and `extensions/subagents/test/plugins/notifications/`.
2. `src/plugins.ts`: remove the import and the `notificationsPlugin` entry. Nothing else imports it (grep `notifications` over `extensions/subagents/src`: only `plugins.ts` and `model/settings.ts`); `usage-report` and other plugins do not `require` it (it provides no service).
3. `src/model/settings.ts`: remove `notifications` from `Settings`, `defaultSettings()` and `settingsSchema`. An old `"notifications"` key in a user's `pi-subagents.json` is silently ignored (unknown keys are, `parseSettings` iterates the schema). Plan 05 edits the same file (linger keys): rebase, don't merge blindly.
4. `test/model/settings.test.ts`: first test, replace `notifications: "off"` with `stopGraceSeconds: "soon"` and its error with `` `${userFile}: stopGraceSeconds must be a number between 0 and 3600` `` (stays last, schema order); rename `"has notifications on and a chain length of 3 by default"` to `"has a chain length of 3 by default"` asserting `toMatchObject({ maxChainLength: 3 })` and `not.toHaveProperty("notifications")`.
5. `session:closing`: grep shows one emitter (`run-agent/runner.ts:901`, `deps.bus.emit("session:closing", undefined)`) and one listener (the deleted plugin). Remove the emit line and `"session:closing": undefined` from `model/events.ts`. `shuttingDown` in the runner stays (it guards other paths).
6. `runner.batchSettled`: its only caller was the deleted plugin. Remove it from `AgentRunner` (`model/types.ts:138`), `runner.ts:153-157` and the returned object (`:932`), and delete `describe("batchSettled")` in `test/plugins/run-agent/run-agent.test.ts:507-525`.
7. `extensions/subagents/README.md`:
   - Line 7: drop `terminal notifications, ` from the 0.3.0 sentence.
   - Replace the "Terminal notifications: …" bullet with: "- Notifications are not part of this extension: the notifications extension in this repository (`extensions/notifications/`) sends one terminal notification when pi waits for your input after the agents are done, and one when a dialog of the main session waits unanswered (agents never ask). It waits for agents through the busy channel this extension reports on (`pi:busy`, source `pi-subagents`)."
   - Settings "Other keys": delete `` `notifications` (true; `false` turns terminal notifications off), ``.
8. Docs that plan 01 §G already rewrites for `pi:busy` (session-limits README, subagents README busy bullet) need no further change here.

## 5. Interaction with the wake (spec §3, plan 01 §C)

Sequence when the user is away and agents run in the background:

1. Main run settles → `onIdle`: `pending = true`; the registry has `pi-subagents` busy, so **held** (no timer).
2. Agents work. They never open a dialog; only a main-session dialog would notify, on its own, after `dialogDelayMs`.
3. The last agent closes → registry `agent:changed` → `pi:busy { source: "pi-subagents", busy: false }` → sources empty, still pending → **armed** (20 s).
4. `batch:settled` → outbox → `sendHiddenMessage(..., "2 agents finished")` → idle path → `sendUserMessage` → pi `agent_start` → `onAgentStart`: `pending = false`, timer cleared (**quiet**).
5. Wake run settles → `onIdle` → **armed** → 20 s without a key → `pi is waiting for your input`, once.

Covered by the test `a wake run between settles does not double-notify`. If the main session is busy when agents finish, step 3 finds `pending` already false (cleared by the run's `agent_start`), and the hidden follow-up joins the run; its settle notifies once. Known gap: the batch settles only after worktree cleanup, so a `git worktree remove` slower than `idleDelayMs` between steps 3 and 4 would let the idle notification fire just before the wake. Acceptable at the defaults; if it shows up, subagents can keep `busy: true` until the outbox has delivered (subagents plan, not here).

Other events in spec §8's "must not notify" table need no code: the extension listens to nothing per agent, batch, tool or child `notify`.

## 6. Order of work

1. Confirm plan 01 §F and §G are merged (`Host.onDialog`, `HostUi.onKeyPress`, fakes `dialog`/`pressKey`/`keyListeners`, `BUSY_CHANNEL === "pi:busy"`).
2. §4 removal from subagents (steps 1–7). `npm run check`.
3. `core/manager/settings.ts` choice rule + test. `npm run check`.
4. Adapter: `NotifyChannel`, `terminalNotify(message, channel)`, `notificationSequence`, `pi-ui.test.ts`, fake `terminalNotices`. `npm run check` (typecheck catches any leftover caller).
5. `extensions/notifications/`: `settings.ts`, `notifications.ts`, `index.ts`, both tests, README. `npm run check` (`test/architecture.test.ts` picks the new folder up automatically: entry imports `pi-adapter.ts`, the rest only `contract.ts`, `core/manager`, own files).
6. `package.json`, root `README.md`, `STRUCTURE.md`, `ARCHITECTURE.md`. `npm run check`; `npm pack --dry-run | grep notifications` lists `extensions/notifications/src/*.ts` and `README.md`, no `test/`.
7. Manual checks below with `~/.pi/agent/pi-notifications.json` = `{ "idleDelayMs": 3000, "dialogDelayMs": 2000 }`, `pi -e ./extensions/notifications/src/index.ts -e ./extensions/subagents/src/index.ts`.

### Manual checklist (iTerm2, WezTerm, Ghostty, kitty; then tmux inside one of them; Apple Terminal with `bell`)

- [ ] Ask something short, switch to another app at once: one desktop notification `pi is waiting for your input` about 3 s after the reply, with no bell sound or flash; nothing more after a minute.
- [ ] Same, but press any key within 3 s: nothing. Scrolling with the mouse wheel alone does not cancel.
- [ ] Ask the main session to run two background agents and leave: nothing at the main reply, nothing while they run; the `2 agents finished` line starts a run; one notification 3 s after that reply.
- [ ] A dialog that waits (with agents running, `/session-handoff` asks to confirm): notification `pi needs your input: <title>` with the dialog's title as pi shows it, after 2 s; an agent whose extension asks a confirmation sends nothing (the agent gets the denial at once); pressing `↓` repeatedly keeps deferring it; answering within 2 s sends nothing.
- [ ] `/agents` left open for 10 s: nothing.
- [ ] `"channel": "bell"` + `/reload`: bell only (sound, flash or tab mark per terminal settings), no desktop notification; Apple Terminal with `auto` shows nothing, with `bell` rings. `"channel": "off"`: nothing.
- [ ] `"channel": "loud"`: one warning at session start, defaults used.
- [ ] `pi -p "hi" | cat -v` and `--mode rpc`: no `^G` or `^[]9` in the output.
- [ ] tmux with `auto`: nothing, no stray characters in the pane; with `"channel": "bell"`: the window gets the bell flag.
- [ ] `/new` within the 3 s: no notification from the old session.
- [ ] rxvt-unicode (optional): OSC 777 notification titled `pi`.
