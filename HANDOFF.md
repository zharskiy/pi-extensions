# Handoff: pi subagents extension

Date: 10 October 2026. Status: requirements settled, design not started.

## Purpose

A subagents extension for the pi coding agent (pi.dev), published as open source. It targets anyone writing code in very large repositories. The first version delivers the basic building blocks; new agents must be easy to add later. Pi already handles model and provider selection, so the extension does not implement routing.

## Environment

- Pi 1.1.0, managed install. Launcher: `~/.local/bin/pi`. Packages: `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/`. Settings: `~/.pi/agent/settings.json`.
- Package scope is `@earendil-works/pi-*`. The old `@mariozechner/*` scope is deprecated.
- Pi's docs have not been read yet. Read them before design.
- Claude Code is the UX reference for every view. Research its agent UX before designing any view.

## Architecture rules

- All pi integration lives in one adapter module. Every other part depends on the extension's own contract, because pi's API still changes.
- Each part is a plugin: run-agent, agent-view, agent-list-view, limits, spending-footer, and so on.
- One extensions manager enables plugins and owns every interaction between them. It is the single place to see what the extension adds to pi.
- Folder structure is a design decision in its own right and is settled during design.
- Vitest for unit tests. Biome for linting and formatting.
- Short README: what is needed, how to plug the extension into pi, how to update it.

## Agent model

- Agents run in the background. An agent takes a task and returns its output to the caller. Agents never talk to each other.
- Agents can run sequentially or in parallel.
- Results of a parallel batch are accumulated. The caller is woken once, when every agent in the batch is done, as if a single agent had run.
- Every agent at every level behaves identically and uses the same view components. The only difference between agents is their parent.
- The user can interact with the main session and with any agent at any level.
- Depth is configurable. Default is three levels: main session, child, grandchild. Four must be possible.
- The maximum number of agents running at the same time is configurable.
- A closed agent is final. It cannot be rerun and the user cannot interact with it. Continuation always means a new agent spawned from a handoff file.
- Communication contract between caller and agent is a defined interface, settled during design. Small outputs pass as text. Larger outputs and all handoffs pass as files, so a caller never has to read a handoff when a child reaches its limit and is respawned.
- An `agent_status` tool reports on one or several agents in a single call.

## Agent configuration

- Each agent is a file with frontmatter holding its metadata: system prompt additions, skills, tools, and how it receives input and returns output.
- All agents share one base system prompt. Each agent adds its own additions on top.
- The main session is the orchestrator. Its system prompt is a configurable file stored in this repository.
- The set of agents and all prompts are not yet designed.

## Limits and handoffs

- Each agent has a context budget, about 100k tokens by default, derived from the context window of the model it runs on. On reaching it the agent is stopped and writes a handoff file. The harness spawns a successor from that file and the work continues.
- The main session has its own limits in a separate plugin, with a soft and a hard limit. At the soft limit a warning turns orange. At the hard limit the session writes a handoff as its very next step and passes it to a new session.

## Spending

- Subagent spending is totalled together with main session spending and shown in the footer.
- Totals must be accurate regardless of the provider.

## Views

- Agent view: scrollable, built from pi's own components wherever possible, matching the main session UX as closely as pi allows. The first block shows the full effective system prompt, skills, tools, and tool guidelines as collapsible sections, including any changes made by other extensions. This block must be reliable; it is the record of what was sent to the model and will be used for debugging. A collapsible component is reused if pi has one, otherwise written.
- The user can stop an agent, continue it, or ask it a question. After the user stops an agent there is a configurable delay during which questions can be asked. When the delay ends the agent notifies its caller and closes.
- Agent list view shows all agents.
- Every agent reuses the same progress component.

## Caching

- An agent must never break its own prompt cache while working. Its prefix stays stable across turns. Design every plugin with this constraint.

## Next steps

1. Research Claude Code's agent UX.
2. Read pi's extension and SDK docs.
3. Inspect existing pi subagent extensions for spawning mechanics.
4. Design folder structure, the adapter contract, the caller-agent contract, and the plugin set.
5. Settle the agent set and prompts.
