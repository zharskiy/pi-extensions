<div align="center">

# retention

**Removes old pi sessions and what these extensions wrote for them.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi keeps every session file forever, and the extensions in this package write next to them: agent runs with their child sessions and logs, handoff documents in the OS temp dir. Over months that grows into gigabytes and tens of thousands of folders. This extension removes what nobody has touched for `retentionDays` days, once per pi process, in the background after the session starts, and tells you in one line what it removed.

## What it removes

A session is old when its file was last written before the cutoff (now minus `retentionDays` days). Pi appends to a session file on every message, so its modification time is its last activity. For an old session it removes:

- the session file, `<agent dir>/sessions/<project>/<timestamp>_<uuid>.jsonl`;
- then, only once that file is gone, its agent runs, `<session file without .jsonl>/agents/<agent id>/` (manifest, result, the agent's own session, logs), the folders left empty, and its handoff folder, `<OS temp dir>/pi-handoff/<session id>/`.

It also removes old agent runs in folders whose session file is gone and under `<agent dir>/pi-subagents/<id>/` (sessions without a file), handoff folders whose files are all older than the cutoff and whose session is not kept, and the markers of pi processes that have ended.

Only `<agent dir>/sessions/` is swept. Sessions elsewhere, in a custom session dir (the `sessionDir` setting, `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`) or opened with `--session <path>`, are never touched; a handoff folder whose session lives elsewhere is judged by its own age.

## What it keeps

- Sessions written to within `retentionDays` days.
- Sessions open in a running pi process. Each pi process records its session in `<agent dir>/pi-retention/live/<session id>.<pid>.json` while it runs, and the sweep keeps every session a running process names, also one resumed but not yet written to, and checks again right before it removes each session. Removing a session file pi is still writing to would make pi start it again without its header.
- The parent session of every kept session (one level), since a session shows its parent's agents.
- An agent run, and its whole chain of handoff successors, while any link was touched within `retentionDays` days or keeps a worktree or branch. A run folder without a manifest yet, or one that cannot be read, keeps its whole chain. Worktrees and branches are never removed: the run's manifest stays as the pointer to them.
- A session file whose first line is not a pi session header (or is longer than 64 KiB) is never touched, and neither are its agent runs; it is reported as unreadable. Its handoff folder and `pi-subagents/<id>/` folder are judged by their own age, because its id is unknown.
- Anything reached through a symbolic link.

It removes nothing at all when a session file cannot be read (for example, permission denied), when `<agent dir>/pi-retention/live` is not a real folder, or when `pi-retention.json` has an error; `/retention` says why. Handoff folders are skipped when `<OS temp dir>/pi-handoff` is not a folder you own that others cannot write to.

## Settings

`<agent dir>/pi-retention.json`:

```json
{ "retentionDays": 60 }
```

`retentionDays` is a number from `0` to `36500`, `60` by default; `0` turns the sweep off. It is read only from your user file, so a file committed to a repository cannot remove your sessions of every project. In a trusted project, a `.pi/pi-retention.json` is reported as a settings error, which turns off the sweep and `/retention apply` until you delete that file; in an untrusted project it is silently ignored. While the settings have any error, nothing is removed.

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/retention/index.ts   # this extension alone, from a checkout
```

| Try | What you see |
|---|---|
| `/retention` | The cutoff, how many sessions, agent runs and handoff folders would be removed, how many sessions are kept and why (`fresh`, `live`, `parent`), and the unreadable files. Nothing is removed. |
| `/retention apply` | Removes them now and prints the counts. |
| Start pi with old sessions on disk | `retention: removed 3 sessions, 5 agent runs, 2 handoff dirs older than 60 days`, once. |

## Before you rely on it

- Age is the file's modification time. Copying sessions without keeping times, a restored backup, or a tool that touches files changes what counts as old; restoring an old backup lets the next pi start remove it again.
- A pi process on another machine that shares your agent dir is not seen as running: its marker names a process that does not exist here, and the sweep removes that marker. Its session is kept only while it is written to within `retentionDays` days.
- A reused process id can make an ended process look running; its session is then kept a while longer, never removed early.
- Removal is permanent. Run `/retention` first to see what would go.

## Development

```bash
npm run test -- extensions/retention   # this extension's unit tests
npm run check                          # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
