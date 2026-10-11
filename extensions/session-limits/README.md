# session-limits

A pi extension that lets the main session run indefinitely. Before the session's context fills up, the model writes a handoff file, and pi continues in a new session seeded with it. You keep typing; nothing is said in the conversation until the switch.

It knows nothing about other extensions. Extensions that run work in the background (such as the subagents extension in this repository) tell it when something is running, so that the switch waits instead of ending that work.

## What it does

- Below `softRatio` of the model's context window nothing is shown. From `softRatio` (60% by default) a footer segment in the warning colour says `ctx 62% · handoff at 75%`.
- At the first turn end at or above `hardRatio` (75%) the extension sends one user message (a follow-up while the session is busy) asking the model to write a handoff file with its write tool to `<session file without .jsonl>/main-handoff.md` (sessions without a file use `<tmpdir>/pi-session-limits/<session id>/main-handoff.md`). The template is `prompts/handoff.md`: six sections `Status` (done, partial or blocked), `Outcome`, `Evidence`, `Blocker`, `Next`, `Files touched`. The segment turns to the error colour: `writing handoff`.
- The file is judged when the session settles. A file that is missing, unchanged since the request, or invalid gets exactly one resend with the problems listed; a second failure gives one warning naming the path, and the segment says `handoff failed, run /session-handoff`.
- With a valid file and the session idle, the extension runs `/session-handoff`, which opens a new session linked to the old one (`/resume` shows the link) and seeds it with a displayed message of type `pi-session-limits-handoff`: a short preface naming the previous session file, then the handoff. No turn is started; your next message goes to the new session.
- If you kept talking after the file was written, the file is out of date: the extension asks for one fresh handoff instead of switching, and switches on the next settle with the newer file.
- While any source reports running work the segment says `handoff waits for running work` and the switch is held. When the last source reports idle and the session stays idle (no turn within a second), the switch runs; if a turn follows (for example background results arriving), that counts as new activity and a fresh handoff is requested first. A source that stays busy holds the automatic switch indefinitely; `/session-handoff` (with its confirmation) is the manual escape.
- If pi cancels the new session or it fails, you get one warning, the segment stays red, and nothing is retried automatically.
- The extension is active only in interactive and RPC sessions (pi modes `tui` and `rpc`). In print and JSON runs, and in sessions bound in print or json mode, such as subagents' child sessions, it does nothing.

## Command

`/session-handoff` switches to a new session from the current handoff file. Run it by hand after the automatic attempt gave up and the file is fixed. If a source reports running work, it asks first: "Work reported by pi-subagents is still running and will be ended by the switch. Switch anyway?"

## Settings

Optional JSON in `~/.pi/agent/pi-session-limits.json`, and in `.pi/pi-session-limits.json` of a trusted project (project values win):

```json
{
  "softRatio": 0.6,
  "hardRatio": 0.75
}
```

Both are fractions of the model's context window, numbers above 0 and at most 1. An invalid value is reported once as a warning and ignored. A soft ratio above the hard ratio skips the warning stage. The files are read again at every session start.

## Busy channel

Any extension can hold the switch while its work runs by emitting on pi's event bus:

```ts
pi.events.emit("session-limits:busy", { source: "my-extension", busy: true });
pi.events.emit("session-limits:busy", { source: "my-extension", busy: false });
```

- `source` is a non-empty string naming the extension; it is shown to the user in the confirmation of `/session-handoff`. `busy` is a boolean. Other payloads are ignored.
- The extension keeps the set of sources whose last signal was `busy: true`. The automatic switch waits while the set is not empty.
- Send `busy: true` when work starts and `busy: false` when the last piece ends; repeated signals are harmless. The set starts empty in every session (pi creates a new extension instance per session), so a source that is busy when a session starts must announce it after session start, for example in its own `session_start` handler.
- The switch ends the old session, so work that is still running when the user confirms a manual switch gets pi's normal `session_shutdown` with reason `new`.
- Nothing is imported from this extension; when it is not installed the signals simply go unheard.

## Layout

`src/index.ts` is the pi entry. `src/adapter/pi-adapter.ts` is the only file that imports pi; everything else depends on `src/adapter/contract.ts`. `src/limits.ts` holds the flow, `src/thresholds.ts` the pure decisions, `src/handoff.ts` the path, seed and validator, `src/settings.ts` the settings files. Tests are under `test/`.
