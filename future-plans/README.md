# Future plans

One folder per research topic. Each folder holds its research and, where one exists, its spec. This README is the only overview.

## Folders

| Folder | Status | What it holds |
|---|---|---|
| [claude-code-cost-optimisation/](claude-code-cost-optimisation/README.md) | researched | What Claude Code 2.1.325 offers to cut tokens and spend and to audit a setup, ranked by evidence: cache health dominates the input bill, deferred tool definitions are well measured, output filtering and terse-output prompting measured far below their claims. Recommends, on the current adapter surface, a cache-miss line with a likely cause in `/context` and the footer, static waste hints under `/context`, and a prompt-size budget test; then spend notices and agent budgets, a return-after-idle notice, a `/spending` breakdown and spilling oversized tool results, most of which need new Host methods. Lists what is not worth adopting and the owner's questions. research/ holds seven fact sheets: context and caching, models and billing, tools and extensions, diagnostics, binary and changelog, community measurements and API features, and this repository's baseline. |
| [enterprise-workflow/](enterprise-workflow/README.md) | planned | Feature and epic workflows. company/ is primary: company-side.md, the example company package and the process research. harness/ lists the primitives the harness adds: `cwd`, the precedence sentence, the MCP filter. |
| [extension-independence/](extension-independence/README.md) | open | Whether each extension knows anything about another: imports, on-disk layouts, copied names and keys, runtime assumptions that another is on, and leaks into the platform. Holds the repeatable method, a checklist of all fifteen extensions, the rules for where shared knowledge moves (adapter, `platform/shared`, extension manager), the owner's questions and an enforcing test. findings/prune.md is the first check: prune imports no extension but hard-codes the subagents run layout and manifest meaning. |
| [no-host-pi/](no-host-pi/README.md) | open | Removing the need for a pi installed on the host. Records what the host pi does for the launcher today (credentials for the proxy, MCP and provider sign-in, config commands, the provider host table, the image version, `--no-sandbox`, the commands that start no session), how the two instances are kept in step, and what extension settings survive in the sandbox: user-scope `pi-*.json` files stay in one folder's volume and model picks are erased at the next launch. Lays out a replacement for each job with its cost and its effect on the threat model, the store of record once no pi runs on the host, and migration. Recommends getting there in eight independently shippable steps, starting with keeping model picks across the settings sync and a helper container; lists the questions that are the owner's to decide. |
| [plan-mode-and-guards/](plan-mode-and-guards/q4-q8-plan-mode-guards.md) | dropped | Harness-enforced plan mode, guards and project rules. Kept because the owner may reconsider. |
| [skills-in-main-session/](skills-in-main-session/README.md) | researched | Letting the main session use skills on demand without listing them all in its prompt. Deferred: a `skill` tool (modelled on OpenCode) that lists the inventory in its description and returns the body in pi's `<skill>` block, deferrable through `tool_search`. research.md holds the pi surface and the industry survey. |
| [workflow-mechanics/](workflow-mechanics/README.md) | planned (cwd), open (worktrees) | Where an agent runs and how its work gets back. cwd/spec.md: `cwd` on `run_agent`, an agent runs in a chosen directory under the session cwd, with trust checked per target; it replaces the dropped workspace and epic design, whose research is kept in cwd/research/. worktrees.md: a thinking document on agent worktrees, today's behaviour and its gaps, the use cases to choose between and the design questions, no decision made. The README lists the questions that span both. |

Dropped without a folder: the workflow engine (workflows are company skills), the code map (company business; its research sits in enterprise-workflow/company/code-exploration.md) and loading agent files from pi packages (excessive; agents are installed into the user agent dir or `.pi/agents` by script).

Done or in progress elsewhere, not tracked here: whole-session isolation, which became the launcher (`launcher/`), the `verifier` and `editor` chores with complexity-based delegation, and absolute token thresholds in session-limits.

## Delivery order

1. `cwd` on `run_agent` ([workflow-mechanics/cwd/spec.md](workflow-mechanics/cwd/spec.md)). Its worktree rule is subject to [workflow-mechanics/worktrees.md](workflow-mechanics/worktrees.md).
2. The precedence sentence in the main-session prompt: "When a skill or the user says who does a step, follow that over this guide." (harness-side.md 2.4)
3. Optional per-agent MCP filter, `mcp: [server, "server:pattern"]` (harness-side.md 2.3).
4. An examples folder in the repo with the company example as documentation, including its `install-agents.sh`.

Each step ships alone with docs and `npm run check` green.
