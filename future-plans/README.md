# Future plans

One folder per research topic. Each folder holds its research and, where one exists, its spec. This README is the only overview.

## Folders

| Folder | Status | What it holds |
|---|---|---|
| [cwd/](cwd/spec.md) | planned | `cwd` on `run_agent`: an agent runs in a chosen directory under the session cwd, with trust checked per target. Replaces the dropped workspace and epic design, whose research is kept in cwd/research/. |
| [enterprise-workflow/](enterprise-workflow/README.md) | planned | Feature and epic workflows. company/ is primary: company-side.md, the example company package and the process research. harness/ lists the primitives the harness adds: `cwd`, the precedence sentence, the MCP filter. |
| [idle-handoff/](idle-handoff/spec-dropped.md) | dropped | Handing off while the cache is warm after a long idle. Spec and research kept in case the topic comes back. |
| [plan-mode-and-guards/](plan-mode-and-guards/q4-q8-plan-mode-guards.md) | dropped | Harness-enforced plan mode, guards and project rules. Kept because the owner may reconsider. |

Dropped without a folder: the workflow engine (workflows are company skills), the code map (company business; its research sits in enterprise-workflow/company/code-exploration.md) and loading agent files from pi packages (excessive; agents are installed into the user agent dir or `.pi/agents` by script).

Done or in progress elsewhere, not tracked here: the `verifier` and `editor` chores with complexity-based delegation, and absolute token thresholds in session-limits.

## Delivery order

1. `cwd` on `run_agent` (cwd/spec.md).
2. The precedence sentence in the main-session prompt: "When a skill or the user says who does a step, follow that over this guide." (harness-side.md 2.4)
3. Optional per-agent MCP filter, `mcp: [server, "server:pattern"]` (harness-side.md 2.3).
4. An examples folder in the repo with the company example as documentation, including its `install-agents.sh`.

Each step ships alone with docs and `npm run check` green.
