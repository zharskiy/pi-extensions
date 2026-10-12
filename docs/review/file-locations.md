# Where the extensions read and write files

Answers to the owner's questions 5 (`worktree` field) and 6 (every file under ~/.pi). Bases:

- **agentDir**: pi's `getAgentDir()`, `~/.pi/agent` by default (`PI_CODING_AGENT_DIR` overrides it); `SessionInfo.agentDir`.
- **session data dir**: `sessionDataDir(info, namespace)` in `core/manager/paths.ts`: the session file path without `.jsonl` (`~/.pi/agent/sessions/--<cwd>--/<stamp>_<id>/`), or `<agentDir>/<namespace>/<session id>/` for a session without a file (`pi --no-session`). Never the project or the OS temp dir.
- **project**: the session cwd (the user's repo).

## Writes

| What | Path (code) | Base |
|---|---|---|
| Agent `manifest.json` | `<session data dir>/agents/<id>/manifest.json` (`agent-registry/registry.ts`, `model/paths.ts` `agentsDirFor`) | session data dir, namespace `pi-subagents` |
| Agent result | `<session data dir>/agents/<id>/result.md` (`run-agent/result.ts`) | same |
| Agent session file (pi writes it) | `<session data dir>/agents/<id>/*.jsonl` (`SessionManager.create(cwd, sessionDir)` in `core/adapter/pi-child.ts`, `sessionDir: record.dir` in `run-agent/runner.ts`) | same |
| Agent handoff (the agent writes it when told) | `<session data dir>/agents/<id>/handoff.md` (`agent-registry/registry.ts`) | same |
| Main-session handoff (folder created by the extension, file written by the model) | `<session data dir>/main-handoff.md` (`session-limits/src/handoff.ts` `handoffPath`, `limits.ts`) | session data dir, namespace `pi-session-limits` |
| Spending entries | `pi-spending:usage`, `pi-spending:main-offset` custom entries in the main session file (`spending/src/spending.ts`, `ledger.ts`) | pi's session file |
| Agent view mode | `<agentDir>/pi-subagents-view.json` (`agent-view/mode-store.ts`) | agentDir |
| Worktree checkout | `<session data dir>/agents/<id>/worktree` (`run-agent/worktree.ts`) | session data dir |
| Worktree branch `pi-agents/<id>-<base36 time>` | the user's repo, `.git/refs/heads/pi-agents/...` (`run-agent/worktree.ts`) | project (exception) |
| Worktree metadata | the user's repo, `.git/worktrees/worktree[N]/` (git names it after the checkout's basename) | project (exception) |

## Reads (never written)

| What | Path | Base |
|---|---|---|
| User agents | `<agentDir>/agents/*.md` (`agent-definitions/index.ts`) | agentDir |
| Project agents (trusted projects only) | `<cwd>/.pi/agents/*.md` (`agent-definitions/index.ts`) | project |
| Settings | `<agentDir>/pi-subagents.json`, `<agentDir>/pi-session-limits.json`; `<cwd>/.pi/pi-subagents.json`, `<cwd>/.pi/pi-session-limits.json` when trusted (`core/manager/settings.ts`) | agentDir / project |
| Shipped prompts and agents | `<package root>/prompts/*.md`, `<package root>/agents/*.md` | package |
| Parent session file on `/fork` or `/clone` (spending) | `forkedFrom` (`core/adapter/session-file.ts` `readSessionEntries`) | pi's sessions folder |
| Session files, manifests, handoff and result files | the session data dir paths above | session data dir |

## Question 6: is every produced file under ~/.pi?

Yes. The extensions write only under pi's agent dir: next to the session file in pi's sessions folder or, for a session without a file, under `<agentDir>/<namespace>/<session id>`. The one exception is `worktree: true`: the checkout lives under ~/.pi, but git records the branch and the `.git/worktrees/<name>` metadata in the user's repository, and both stay until the user removes them (a deleted session folder leaves a prunable worktree entry, cleared by `git worktree prune`). Outside the extensions' control: pi's `sessionDir` setting or `--session-dir` flag can put the sessions folder (and so every session data dir) anywhere, including inside the project; files the agents create with their own tools land wherever the agent puts them (that is the agent's work, not harness output); and `git worktree add` runs the repository's own `post-checkout` hook.

## Question 5: what is the `worktree` frontmatter field for?

Paths relative to `extensions/subagents/src`.

- An optional boolean switch, off when absent (`plugins/agent-definitions/fields.ts`, `model/agent-schema.ts`). All four shipped agents set `worktree: false`.
- On launch the placer acts only when `definition.worktree` is true (`plugins/run-agent/placement.ts`). A chain successor reuses its predecessor's worktree; otherwise `createWorktree` (`plugins/run-agent/worktree.ts`) checks that the session cwd is inside a git repository (`git rev-parse --show-prefix`) and runs `git worktree add -b pi-agents/<id>-<Date.now() in base 36> <agent folder>/worktree HEAD`. The base is the main checkout's `HEAD`; uncommitted and untracked files are not included.
- The agent's cwd is the same subdirectory inside the worktree as the main session's cwd in the repository.
- After a run nothing is merged or removed: the edits stay in the worktree. `git worktree remove --force` plus `git branch -D` run only when the agent never got to run (stopped while git created it, session ending, spawn failure: `abandon` in `plugins/run-agent/runner.ts`).
- The main session sees `Worktree: <path> (branch <branch>)` in the batch result (`plugins/run-agent/result.ts`); `agent_status`, the agent's `manifest.json` and the agent view show it too. No prompt tells the main model how to review, merge or clean up.

Opinion: it is the only thing that lets two code-editing agents (or an agent and the user) work in parallel without overwriting each other's files. No shipped agent uses it and nothing cleans up after a successful run, so it is worth keeping only if parallel implementers are a goal (then one main-prompt line on reviewing and merging the branch would complete it); otherwise it is the clearest deletion candidate (`worktree.ts`, `placement.ts`, the worktree fields on records, manifest, status and view, and their tests).
