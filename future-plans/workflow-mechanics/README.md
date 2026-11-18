# Workflow mechanics

Where an agent runs and how its work gets back to the main session. Two plans live here: `cwd` on `run_agent`, which chooses the directory an agent runs in, and worktrees, which give an agent its own checkout. They belong together because both decide an agent's working directory, and the cwd spec already carries a rule for using both at once.

## Documents

| Document | Status | What it holds |
|---|---|---|
| [cwd/spec.md](cwd/spec.md) | planned | `cwd` on `run_agent`: a directory under the session cwd, trust checked per target. Its rule on `worktree: true` with `cwd` is subject to worktrees.md. cwd/research/ keeps the dropped workspace and epic research as evidence. |
| [worktrees.md](worktrees.md) | open, to be decided | How agent worktrees work today, what is weak, the use cases to choose between and the design questions, with no choice made. Ends with the questions the owner answers before a spec. |

## Questions that span both

- May `cwd` point outside the session cwd? The cwd spec says no. Outside it, trust, the session's agent registry and settings, and the sandbox all get harder: a directory outside the mounted folder does not exist in the sandbox.
- Is a worktree a property of the agent file, of the call, or both? `cwd` is a call argument; today `worktree` is only an agent file field.
- Is the worktree built from the repository at the target `cwd`, and where does its checkout live: the target's `.pi/worktrees/`, the repository root, elsewhere?
- What does a nested agent inherit? The cwd spec says the caller's cwd. Today every agent is placed from the main session's cwd, so a nested agent does not see its caller's worktree.
- A handoff successor keeps its predecessor's cwd and worktree. Both plans agree; it stays that way unless one of them changes.
- How does the main session learn where an agent worked and what it changed? Today: one `Worktree:` line, and nothing about `cwd` yet.

Whether `cwd` ships before the worktree decision, for example with the combination refused at first, is itself open.
