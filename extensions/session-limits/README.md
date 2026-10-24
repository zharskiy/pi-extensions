<div align="center">

# session-limits

**Hands the main session over to a new session before its context fills up, so it can run indefinitely.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [What it does](#what-it-does) · [Command](#command) · [Settings](#settings) · [Busy channel](#busy-channel) · [Architecture](#architecture) · [Development](#development)

</div>

## Why

A long session eventually fills the model's context window. Before that happens, or when you run `/session-handoff`, this extension has the model write a handoff file, and pi continues in a new session seeded with it. You keep typing; the instruction to the model is hidden, and one notice says what is happening. It knows nothing about other extensions: extensions that run work in the background (such as the subagents extension in this repository) tell it when something is running, so that the switch waits instead of ending that work.

## What it looks like

```
 » Handoff at 175k tokens · 142.3k used

 » Handoff from the previous session
   ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)
```

The first line is the notice right below the editor (above the footer block when the footer extension is on); the row below it is the seed at the top of the new session.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions
```

That installs session-limits with the rest of the package. To try it alone for a single run:

```bash
pi -e ./pi-extensions/extensions/session-limits/index.ts
```

| Command | What happens |
|---|---|
| `/session-handoff` | The model writes a handoff now, then pi switches to a new session started from it. |
| `/session-handoff finish the login tests` | The same, with the text folded into the instruction and repeated in the new session's preface. |

## What it does

Below the soft threshold nothing is shown. From the soft threshold a warning notice counts down to the hard threshold; at the hard threshold the model writes a handoff and pi switches to a new session started from it.

- **Thresholds**: the soft threshold is `softRatio` of the model's context window (45% by default) or `softTokens` (125,000), whichever is lower; the hard threshold is `hardRatio` (60%) or `hardTokens` (175,000), whichever is lower. See [Settings](#settings).
- **Warning notice**: from the soft threshold a one-line notice in the warning colour, drawn right below the editor (above the footer block when the footer extension is on), says `» Handoff at 175k tokens · 142.3k used`: the hard threshold in tokens, also when the ratio decides it (`120k` on a 200,000-token window), and the tokens the context holds now, so you can see how close it is. It disappears when the token usage is unknown, for example right after a compaction until the next reply, and when the context drops back below the soft threshold.
- **Handoff request**: at the first turn end at or above the hard threshold the extension sends one hidden message (custom type `pi-session-limits-request`, not shown in the chat; a follow-up while the session is busy) asking the model to write a handoff file with its write tool to `<OS temp dir>/pi-session-limits/<session id>-handoff.md`, so it needs no cleanup, and notifies once: `Context is nearly full; writing a session handoff to <path>, then switching to a new session.`
- **Checked on settle**: the file is judged when the session settles. A file that is missing, unchanged since the request, or invalid gets exactly one resend with the problems listed; a second failure gives one warning naming the path, and the notice says `✗ Handoff failed · run /session-handoff`.
- **Switch**: with a valid file and the session idle, the extension runs `/session-handoff`, which opens a new session linked to the old one (`/resume` shows the link) and seeds it with the handoff. No turn is started; your next message goes to the new session.
- **Out-of-date file**: if you kept talking after the file was written, the file is out of date: the extension asks for one fresh handoff instead of switching, and switches on the next settle with the newer file.
- **Running work**: while any source reports running work (see [Busy channel](#busy-channel)) the notice says `» Handoff waiting for running work` and the switch is held.
- **Failures**: if pi cancels the new session or it fails, you get one warning, the notice stays red, and nothing is retried automatically.
- **Modes**: the extension is active only in interactive and RPC sessions (pi modes `tui` and `rpc`). In print and JSON runs, and in sessions bound in print or json mode, such as subagents' child sessions, it does nothing.

<details>
<summary>The notices</summary>

Every notice follows one pattern, `Handoff <phase>` plus an optional ` · <detail>`, with pi's info marker `»`; all of them are in the warning colour except the failure, which takes the `✗` glyph and the error colour.

- `» Handoff at 175k tokens · 142.3k used` from the soft threshold.
- `» Handoff after this turn` while a `/session-handoff` waits for the current turn.
- `» Handoff writing the document` while the model writes the handoff.
- `» Handoff waiting for running work` while a source reports running work.
- `» Handoff switching to a new session` while the switch runs.
- `✗ Handoff failed · run /session-handoff` when the resent request fails too, or when a switch was started but its command never ran: at the next idle or turn end the notice says this instead of staying on `» Handoff switching to a new session`.

</details>

<details>
<summary>The handoff template</summary>

The template is `prompts/handoff.md`: six sections `Status` (done, partial or blocked), `Outcome`, `Evidence`, `Blocker`, `Next` (ending with a `Skills:` line when skills of the session fit the next steps), `Files touched`. It asks the model to point to files by path instead of copying them, to mark unverified claims, and to write `[redacted]` instead of secrets.

</details>

<details>
<summary>The seed in the new session</summary>

The new session is seeded with a displayed message of type `pi-session-limits-handoff`: a short preface naming the previous session file (and, for `/session-handoff`, that the user handed it off and what the next session is for), then the handoff.

The transcript draws it as one row: pi's info marker `»` and `Handoff from the previous session`, then on a `↳` line the preface's first sentence, cut so the `(ctrl+o to expand)` hint keeps its place (on a narrow terminal the hint gives way instead); expanded it shows the whole seed wrapped at column 4. The seed text the new session's model reads is unchanged.

</details>

<details>
<summary>Waiting for running work</summary>

When the last source reports idle and the session stays idle (no turn within a second), the switch runs; if a turn follows (for example background results arriving), that counts as new activity and a fresh handoff is requested first. A source that stays busy holds the automatic switch indefinitely; `/session-handoff` (with its confirmation) is the manual escape.

</details>

## Command

`/session-handoff [what the next session is for]` continues in a fresh session on demand: the model writes a handoff now, then pi switches to a new session started from it. The optional text is folded into the instruction ("Shape Outcome and Next around that") and repeated in the new session's preface (`The user said this session is for: …`).

- **Normally** it sends the hidden instruction and notifies `Writing a session handoff to <path>; the session switches to a new one when it is ready.` The notice says `» Handoff writing the document`. From then on it works like the automatic handoff: one resend with the problems, then `Session handoff failed: …`. When the file is valid the switch runs at once; if a source reports running work, it asks first ("Work reported by pi-subagents is still running and will be ended by the switch. Switch anyway?"). On No the switch waits for the work, as the automatic one does.
- **In print and JSON runs** it does nothing, since there is no session to switch to.

<details>
<summary>What it does in every other state</summary>

- **While the model's turn is running** (or pi is compacting) it holds the request instead of queueing it in pi: it notifies `The session handoff starts when the current turn ends; stopping the turn (esc) cancels it.`, the notice says `» Handoff after this turn` in the warning colour, and the instruction is sent when the turn ends; Esc (or any abort) drops it with `Session handoff cancelled.` Running it again meanwhile replaces the focus when text is given. If the context fills during that turn, this manual request is the one sent.
- **While a handoff is being written** it only notifies `A session handoff is already being written; the session switches when it is ready.`; a new focus is ignored.
- **While a valid handoff waits for running work**, `/session-handoff` without text switches now, behind the same confirmation; with text it asks for a fresh handoff.
- **After a failed or cancelled switch**, `/session-handoff` without text switches at once when the file at the path is valid and newer than the last request; otherwise, or with text, it asks for a fresh handoff.
- **Esc while the model writes the handoff** for `/session-handoff` cancels it: nothing is resent, the notice says `Session handoff cancelled.` and the notice below the editor goes away. A handoff started because the context is full is still asked for again after Esc.
- **A second `/session-handoff` while a switch is already running** is ignored, and a focus typed with it is dropped.

</details>

## Settings

Optional JSON in `~/.pi/agent/pi-session-limits.json`, and in `.pi/pi-session-limits.json` of a trusted project (project values win):

```json
{
  "softRatio": 0.45,
  "hardRatio": 0.6,
  "softTokens": 125000,
  "hardTokens": 175000
}
```

- **`softRatio` and `hardRatio`** are fractions of the model's context window, numbers above 0 and at most 1.
- **`softTokens` and `hardTokens`** are absolute token counts, numbers above 0 and at most 100,000,000.
- **Effective thresholds** are `soft = min(window × softRatio, softTokens)` and `hard = min(window × hardRatio, hardTokens)`, so the ratios decide on small windows (90,000 and 120,000 tokens on a 200,000-token window) and the caps decide on large context windows: on a 1,000,000-token window the warning starts at 125,000 and the handoff happens at 175,000 tokens instead of 750,000.
- **When read**: both files are read once, at session start (`/reload` or a new session applies changes).
- **Disabled for the moment**: a model context window of 0, or unknown token usage, disables the extension for that moment: no handoff is requested and the notice is cleared.

<details>
<summary>Partial and invalid settings</summary>

- A file with only the ratios keeps working; the caps take their defaults.
- An invalid value is reported once per extension instance (so again in each new session) as a warning and ignored.
- An effective soft threshold at or above the effective hard one skips the warning stage; this includes setting only `hardRatio` below the default soft ratio, or only `hardTokens` below the default `softTokens`.

</details>

## Busy channel

Any extension can hold the switch while its work runs by emitting on pi's event bus. Nothing is imported from this extension; when it is not installed the switch simply does not exist; other consumers, such as the notifications extension, still hear the signals.

```ts
pi.events.emit("pi:busy", { source: "my-extension", busy: true });
pi.events.emit("pi:busy", { source: "my-extension", busy: false });
```

- **`source`** is a non-empty string naming the extension; it is shown to the user in the confirmation of `/session-handoff`.
- **`busy`** is a boolean. Other payloads are ignored.
- **The set of busy sources**: the extension keeps the set of sources whose last signal was `busy: true`. The automatic switch waits while the set is not empty.
- **When to send**: send `busy: true` when work starts and `busy: false` when the last piece ends; repeated signals are harmless. The set starts empty in every session (pi creates a new extension instance per session), so a source that is busy when a session starts must announce it after session start, for example in its own `session_start` handler.
- **A confirmed manual switch** ends the old session, so work that is still running when the user confirms gets pi's normal `session_shutdown` with reason `new`.

## Architecture

- `core/` holds the logic: `limits.ts` the flow (phases, the handoff request, the switch, the busy channel), `thresholds.ts` the pure decisions, `handoff.ts` the path and seed, `settings.ts` the schema, defaults and `pi-session-limits.json`, and `conversation-host.ts` the `conversationOnly` host wrapper that passes the conversational modes `tui` and `rpc` only.
- `ui/threshold-text.ts` builds the notice text, `ui/seed-row.ts` draws the seed row and `ui/limit-messages.ts` is its message renderer; `api/plugin.ts` reads `prompts/handoff.md`, registers the seed message renderer and starts the flow.
- `index.ts` is the pi entry; `api/extension.ts` builds the extension with `createManagedExtension` from `platform/extension-manager/` on the shared pi adapter, seen only through `platform/pi-adapter/index.ts`, wraps the host with `conversationOnly` and has the manager read the settings files.
- It talks to other extensions only over pi's event bus: it listens on `pi:busy`. The handoff sections and validator live in `platform/shared/handoff-document.ts`, the busy channel name in `platform/shared/host-channels.ts`.

How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Where things are: [STRUCTURE.md](STRUCTURE.md).

## Development

```bash
npm run test -- extensions/session-limits   # this extension's unit tests
npm run check                               # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).
