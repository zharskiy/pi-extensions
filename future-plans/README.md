# Future plans

One folder per research topic. Each folder holds its research and, where one exists, its spec. This README is the only overview.

## Folders

| Folder | Status | What it holds |
|---|---|---|
| [claude-code-compat/](claude-code-compat/README.md) | researched | Running skills and plugins written for Claude Code in pi. Finding: tool names cannot be redirected at runtime and aliases are not worth it; a prompt-level mapping table covers the rare references. Recommended: an import extension that discovers `~/.claude/skills`, `.claude/skills` and installed plugins, offers `/name` commands with Claude Code's argument substitutions, hands plugin agents to subagents through the publish channel, and (last) bridges `hooks.json` through new `tool_call`/`tool_result` host methods. research.md holds the two formats side by side, pi's surface with citations and a survey of 1,029 skill files. |
| [cwd/](cwd/spec.md) | planned | `cwd` on `run_agent`: an agent runs in a chosen directory under the session cwd, with trust checked per target. Replaces the dropped workspace and epic design, whose research is kept in cwd/research/. |
| [enterprise-workflow/](enterprise-workflow/README.md) | planned | Feature and epic workflows. company/ is primary: company-side.md, the example company package and the process research. harness/ lists the primitives the harness adds: `cwd`, the precedence sentence, the MCP filter. |
| [idle-handoff/](idle-handoff/spec-dropped.md) | dropped | Handing off while the cache is warm after a long idle. Spec and research kept in case the topic comes back. |
| [plan-mode-and-guards/](plan-mode-and-guards/q4-q8-plan-mode-guards.md) | dropped | Harness-enforced plan mode, guards and project rules. Kept because the owner may reconsider. |
| [sandbox/](sandbox/README.md) | researched | Running the main session and every agent in a sandbox. Whole-session isolation first (OpenShell, Docker Sandboxes, plain Docker, no code), per-agent tool policy through a `sandbox` extension second, one sandbox per agent deferred. research/ holds the pi surface, the OpenShell fact sheet and the landscape survey. |
| [skill-autosetup/](skill-autosetup/README.md) | researched | `/agents setup` proposes each lead's skills for the current project from the skill inventory as pi finds it on the machine, with no extra frontmatter and no catalogue conventions. When no agent has a skills override yet the proposal runs unasked; otherwise a Yes/No step with nothing preselected comes first. The main session classifies the project, picks at most five skills per lead (most useful first, project-level preferred) and answers through a model-only tool; the user confirms in the existing setup form; the result goes to `.pi/pi-subagents.json` through the existing write path. Chores never reach the model; skills that name interactive tools are filtered out. Release 1 is this flow alone; automatic re-runs are release 2, if ever. Claude Code files, company catalogues and the main session are out of scope. research.md holds this package's mechanics and pi's surface; implementation.md says what it takes to build. |
| [skills-in-main-session/](skills-in-main-session/README.md) | researched | Letting the main session use skills on demand without listing them all in its prompt. Deferred: a `skill` tool (modelled on OpenCode) that lists the inventory in its description and returns the body in pi's `<skill>` block, deferrable through `tool_search`. research.md holds the pi surface and the industry survey. |

Dropped without a folder: the workflow engine (workflows are company skills), the code map (company business; its research sits in enterprise-workflow/company/code-exploration.md) and loading agent files from pi packages (excessive; agents are installed into the user agent dir or `.pi/agents` by script).

Done or in progress elsewhere, not tracked here: the `verifier` and `editor` chores with complexity-based delegation, and absolute token thresholds in session-limits.

## Delivery order

1. `cwd` on `run_agent` (cwd/spec.md).
2. The precedence sentence in the main-session prompt: "When a skill or the user says who does a step, follow that over this guide." (harness-side.md 2.4)
3. Optional per-agent MCP filter, `mcp: [server, "server:pattern"]` (harness-side.md 2.3).
4. An examples folder in the repo with the company example as documentation, including its `install-agents.sh`.

Each step ships alone with docs and `npm run check` green.
