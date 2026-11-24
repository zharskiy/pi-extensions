<div align="center">

# prune

**Removes old pi sessions and what these extensions wrote for them.**

Part of [pinata](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

Pi keeps every session file forever, and the extensions in this package add agent runs and handoff documents next to them. Over months that grows into gigabytes. This extension removes what nobody has touched for `days` days. It runs once per pi process, in the background after the session starts, and tells you in one line what it removed.

## What it removes

A session is old when its file was last written before the cutoff, now minus `days` days. For an old session it removes the session file in `<agent dir>/sessions/` and then, once that file is gone, its agent runs and its handoff folder in `<OS temp dir>/pi-handoff/`.

It also removes old agent runs and handoff folders whose session file is gone, and the markers of pi processes that have ended. When it runs at session start, it also clears empty handoff folders older than a day.

Only `<agent dir>/sessions/` is swept. Sessions in a custom session dir, or opened with `--session <path>`, are never touched.

## What it keeps

- Sessions written to within `days` days.
- Sessions open in a running pi that loads this extension, also one resumed but not yet written to.
- Every session linked to a kept one. Sessions linked by `parentSession`, in either direction and at any depth, form a chain, and a chain goes whole or not at all. Right before removing a chain it checks again: when a member was opened or written to since the scan, the whole chain stays.
- An agent run while any run of its handoff chain is recent, has no manifest, has one that cannot be read, or keeps a worktree or branch. A manifest that can be read but not parsed keeps nothing. Worktrees and branches are never removed.
- A session file without a readable pi header, and its agent runs.
- Anything reached through a symbolic link, and empty handoff folders that are a day old or less or named after an open session.

It removes nothing when a session file cannot be read, and nothing at the configured days while `pi-prune.json` has an error; the warning says why. It skips handoff folders when `<OS temp dir>/pi-handoff` is not a folder you own that others cannot write to.

## Settings

`<agent dir>/pi-prune.json`:

```json
{ "days": 180 }
```

`days` is a whole number from `0` to `36500`, `180` by default; `0` turns the sweep off. It is read only from your user file, so a file committed to a repository cannot remove your sessions. In a trusted project, a `.pi/pi-prune.json` is a settings error, which turns the sweep off until you delete that file. `Prune now` in `/prune` works either way.

`/prune` → `Auto-prune` writes this file for you. In the sandbox the launcher copies the choice back to the host, but only the listed intervals and off.

## Quick start

```bash
pi install npm:@zharskiy/pinata                    # the whole package
pi -e ./pinata/extensions/prune/index.ts   # this extension alone, from a checkout
```

| Try | What you see |
|---|---|
| `/prune` | `Scanning sessions...` above the editor, then a menu with `Prune now` and `Auto-prune`. Escape closes it. |
| `/prune` → `Prune now` | One row per interval (7, 30, 60, 90, 180 and 365 days) with what it would remove and its size. Pick one and confirm; it scans again, removes only what you confirmed that is still old, and says what it freed. No or Escape goes back. |
| `/prune` → `Auto-prune` | The same intervals and `Off`. A row that would remove something shows what the next start would remove, without the empty handoff folders it also clears. Your `days` is marked `✓`. Picking one saves it and removes nothing now. |
| Start pi with old sessions on disk | `pi-prune: removed 3 sessions, 5 agent runs, 2 handoff dirs older than 180 days, 4 empty handoff dirs, 12.4 MB freed`, once. |

Models never see `/prune` or its output. Outside the interactive terminal it only says that it needs one.

## Before you rely on it

- Age is the file's modification time. Copying sessions without their times, or restoring an old backup, changes what counts as old.
- Only a pi that loads this extension marks its session as open. A pi started before the package was installed, a `pi -e` with other extensions only, a pi on another machine that shares your agent dir, or a sandbox with `sessions.host` on is not seen, so its session is kept only by its age. Removing a session file under such a pi makes it start the file again without its header. Pick a short interval only when no such pi is running.
- Liveness and mtime are checked once per chain, right before its first removal, not per member, so a session of that chain that another pi opens while the chain is being removed is not seen.
- A reused process id can make an ended pi look open; its session is then kept longer, never removed early.
- Removal is permanent.

## Development

```bash
npm run test -- extensions/prune   # this extension's unit tests
npm run check                          # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pinata](https://github.com/zharskiy/pinata) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
