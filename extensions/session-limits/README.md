# session-limits

A pi extension that lets the main session run indefinitely. Before the session's context fills up, or when you run `/session-handoff`, the model writes a handoff file, and pi continues in a new session seeded with it. You keep typing; the instruction to the model is hidden, and one notice says what is happening.

```
 » Handoff at 175k tokens · 142.3k used

 » Handoff from the previous session
   ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)
```

It knows nothing about other extensions. Extensions that run work in the background (such as the subagents extension in this repository) tell it when something is running, so that the switch waits instead of ending that work.

## What it does

- Below the soft threshold nothing is shown. The soft threshold is `softRatio` of the model's context window (45% by default) or `softTokens` (125,000), whichever is lower; the hard threshold is `hardRatio` (60%) or `hardTokens` (175,000), whichever is lower. From the soft threshold a one-line notice in the warning colour, drawn right below the editor (above the footer block when the footer extension is on), says `» Handoff at 175k tokens · 142.3k used`: the hard threshold in tokens, also when the ratio decides it (`120k` on a 200,000-token window), and the tokens the context holds now, so you can see how close it is. Every notice follows one pattern, `Handoff <phase>` plus an optional ` · <detail>`, with pi's info marker `»`; all of them are in the warning colour except the failure, which takes the `✗` glyph and the error colour. The notice disappears when the token usage is unknown, for example right after a compaction until the next reply, and when the context drops back below the soft threshold.
- At the first turn end at or above the hard threshold the extension sends one hidden message (custom type `pi-session-limits-request`, not shown in the chat; a follow-up while the session is busy) asking the model to write a handoff file with its write tool to `<OS temp dir>/pi-session-limits/<session id>-handoff.md`, so it needs no cleanup, and notifies once: `Context is nearly full; writing a session handoff to <path>, then switching to a new session.` The template is `prompts/handoff.md`: six sections `Status` (done, partial or blocked), `Outcome`, `Evidence`, `Blocker`, `Next` (ending with a `Skills:` line when skills of the session fit the next steps), `Files touched`; it asks the model to point to files by path instead of copying them, to mark unverified claims, and to write `[redacted]` instead of secrets. The notice says `» Handoff writing the document`, then `» Handoff switching to a new session` while the switch runs; only a failure uses the error colour.
- The file is judged when the session settles. A file that is missing, unchanged since the request, or invalid gets exactly one resend with the problems listed; a second failure gives one warning naming the path, and the notice says `✗ Handoff failed · run /session-handoff`. The same happens when a switch was started but its command never ran: at the next idle or turn end the notice says `✗ Handoff failed · run /session-handoff` instead of staying on `» Handoff switching to a new session`.
- With a valid file and the session idle, the extension runs `/session-handoff`, which opens a new session linked to the old one (`/resume` shows the link) and seeds it with a displayed message of type `pi-session-limits-handoff`: a short preface naming the previous session file (and, for `/session-handoff`, that the user handed it off and what the next session is for), then the handoff. The transcript draws it as one row: pi's info marker `»` and `Handoff from the previous session`, then on a `↳` line the preface's first sentence, cut so the `(ctrl+o to expand)` hint keeps its place (on a narrow terminal the hint gives way instead); expanded it shows the whole seed wrapped at column 4. The seed text the new session's model reads is unchanged. No turn is started; your next message goes to the new session.
- If you kept talking after the file was written, the file is out of date: the extension asks for one fresh handoff instead of switching, and switches on the next settle with the newer file.
- While any source reports running work the notice says `» Handoff waiting for running work` and the switch is held. When the last source reports idle and the session stays idle (no turn within a second), the switch runs; if a turn follows (for example background results arriving), that counts as new activity and a fresh handoff is requested first. A source that stays busy holds the automatic switch indefinitely; `/session-handoff` (with its confirmation) is the manual escape.
- If pi cancels the new session or it fails, you get one warning, the notice stays red, and nothing is retried automatically.
- The extension is active only in interactive and RPC sessions (pi modes `tui` and `rpc`). In print and JSON runs, and in sessions bound in print or json mode, such as subagents' child sessions, it does nothing.

## Command

`/session-handoff [what the next session is for]` continues in a fresh session on demand: the model writes a handoff now, then pi switches to a new session started from it. The optional text is folded into the instruction ("Shape Outcome and Next around that") and repeated in the new session's preface (`The user said this session is for: …`). What it does depends on the state:

- Normally it sends the hidden instruction and notifies `Writing a session handoff to <path>; the session switches to a new one when it is ready.` The notice says `» Handoff writing the document`. From then on it works like the automatic handoff: one resend with the problems, then `Session handoff failed: …`. When the file is valid the switch runs at once; if a source reports running work, it asks first ("Work reported by pi-subagents is still running and will be ended by the switch. Switch anyway?"). On No the switch waits for the work, as the automatic one does.
- While the model's turn is running (or pi is compacting) it holds the request instead of queueing it in pi: it notifies `The session handoff starts when the current turn ends; stopping the turn (esc) cancels it.`, the notice says `» Handoff after this turn` in the warning colour, and the instruction is sent when the turn ends; Esc (or any abort) drops it with `Session handoff cancelled.` Running it again meanwhile replaces the focus when text is given. If the context fills during that turn, this manual request is the one sent.
- While a handoff is being written it only notifies `A session handoff is already being written; the session switches when it is ready.`; a new focus is ignored.
- While a valid handoff waits for running work, `/session-handoff` without text switches now, behind the same confirmation; with text it asks for a fresh handoff.
- After a failed or cancelled switch, `/session-handoff` without text switches at once when the file at the path is valid and newer than the last request; otherwise, or with text, it asks for a fresh handoff.
- Esc while the model writes the handoff for `/session-handoff` cancels it: nothing is resent, the notice says `Session handoff cancelled.` and the notice below the editor goes away. A handoff started because the context is full is still asked for again after Esc.
- A second `/session-handoff` while a switch is already running is ignored, and a focus typed with it is dropped.
- In print and JSON runs it does nothing, since there is no session to switch to.

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

`softRatio` and `hardRatio` are fractions of the model's context window, numbers above 0 and at most 1. `softTokens` and `hardTokens` are absolute token counts, numbers above 0 and at most 100,000,000. The effective thresholds are `soft = min(window × softRatio, softTokens)` and `hard = min(window × hardRatio, hardTokens)`, so the ratios decide on small windows (90,000 and 120,000 tokens on a 200,000-token window) and the caps decide on large context windows: on a 1,000,000-token window the warning starts at 125,000 and the handoff happens at 175,000 tokens instead of 750,000. A file with only the ratios keeps working; the caps take their defaults. An invalid value is reported once per extension instance (so again in each new session) as a warning and ignored. An effective soft threshold at or above the effective hard one skips the warning stage; this includes setting only `hardRatio` below the default soft ratio, or only `hardTokens` below the default `softTokens`. Both files are read once, at session start (`/reload` or a new session applies changes).

A model context window of 0, or unknown token usage, disables the extension for that moment: no handoff is requested and the notice is cleared.

## Busy channel

Any extension can hold the switch while its work runs by emitting on pi's event bus:

```ts
pi.events.emit("pi:busy", { source: "my-extension", busy: true });
pi.events.emit("pi:busy", { source: "my-extension", busy: false });
```

- `source` is a non-empty string naming the extension; it is shown to the user in the confirmation of `/session-handoff`. `busy` is a boolean. Other payloads are ignored.
- The extension keeps the set of sources whose last signal was `busy: true`. The automatic switch waits while the set is not empty.
- Send `busy: true` when work starts and `busy: false` when the last piece ends; repeated signals are harmless. The set starts empty in every session (pi creates a new extension instance per session), so a source that is busy when a session starts must announce it after session start, for example in its own `session_start` handler.
- The switch ends the old session, so work that is still running when the user confirms a manual switch gets pi's normal `session_shutdown` with reason `new`.
- Nothing is imported from this extension; when it is not installed the switch simply does not exist; other consumers, such as the notifications extension, still hear the signals.
- Changed in 0.4.0: the channel was named `session-limits:busy`; publishers using that literal name must switch to `pi:busy`.

## Layout

`src/index.ts` is the pi entry and builds the extension on the shared pi adapter in `pi-adapter/` (repository root); everything else depends on `pi-adapter/index.ts`. `src/conversation.ts` limits the extension to the conversational modes (`tui`, `rpc`). `src/limits.ts` holds the flow, `src/thresholds.ts` the pure decisions, `src/handoff.ts` the path and seed, `src/settings.ts` the settings schema and defaults; `watchSettings` in `extension-manager/watch-settings.ts` reads the files. The handoff sections and validator and the busy channel name are shared in `shared/handoff-document.ts` and `shared/host-channels.ts`. Tests are under `tests/`.
