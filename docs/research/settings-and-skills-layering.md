# Settings layering, agent overrides and skills for subagents

Research note, 2026-10-17. Docs pages were fetched live on that date. Most pages show no "last updated" date, so dates below are release or changelog dates where one exists, and otherwise the fetch date. Quotes came through a summarising fetch tool and are near-verbatim; tables from specs are verbatim. Items the research looked for and could not find are listed under "Could not source" and marked "not sourced" in the text.

The question: how do comparable products layer user and project settings, let a project change one agent's model or tools, hand skills to subagents, and scope MCP servers per agent? The answers feed [orchestrator-model.md](../design/orchestrator-model.md).

## Layering per product

| Product | Layers, lowest to highest | Lists | Trust gate on project layer | Source and date |
| --- | --- | --- | --- | --- |
| Claude Code (~v2.1.302, npm 2026-10-16) | user `~/.claude/settings.json` < project `.claude/settings.json` < project local `.claude/settings.local.json` < `--settings` < managed | "combines the lists instead of picking one" (e.g. `permissions.allow`) | Inline MCP in project agent files loads "only after you trust the folder" | code.claude.com/docs/en/settings |
| Claude Code agents | plugin `agents/` < `~/.claude/agents/` < `.claude/agents/` < `--agents` < managed; nested project dirs: closest to cwd wins | Whole file | as above | code.claude.com/docs/en/sub-agents |
| OpenAI Codex (rust-v0.163.0, 2026-10-15) | built-in < system `/etc/codex/config.toml` < cloud-managed < user `~/.codex/config.toml` < `--profile` < project `.codex/config.toml` (closest wins) < CLI `-c` | not stated | "Codex loads project `.codex/` layers only when you trust the project" | learn.chatgpt.com/docs/config-file/config-basic |
| Gemini CLI (v0.64.0, 2026-10-13) | defaults < system-defaults < user `~/.gemini/settings.json` < project `.gemini/settings.json` < system overrides < env < CLI | not stated | not sourced | geminicli.com/docs/reference/configuration |
| Cursor (subagents since 2.4, 2026-01-22) | user `~/.cursor/agents/` < project `.cursor/agents/`; `.cursor/` beats `.claude/` and `.codex/`. Rules: User < Project < Team | n/a | not sourced | cursor.com/docs/context/subagents, /rules |
| Roo Code (v3.54.0, 2026-05-15) | defaults < global `custom_modes.yaml` < project `.roomodes` | Whole mode: "completely overrides ... ALL properties, not just some" | not sourced | roocodeinc.github.io/Roo-Code/features/custom-modes |
| Kilo Code (v7.8.14, 2026-10-16) | built-in < global config < project config < `.kilo/` files < `KILO_CONFIG_CONTENT` | "Properties merge rather than replace" | not sourced | kilo.ai/docs/customize/custom-modes |
| Cline (desktop-v0.0.48, 2026-10-17) | global `~/.cline/` and project `.cline/` for rules, workflows, skills, hooks; per-item toggles | n/a | not sourced | docs.cline.bot/customization/overview |

The common shape: built-in < extension or plugin < user < project < local or uncommitted < CLI, with managed policy on top. The closer to the work, the higher the priority. Gemini puts system overrides above project. Cline is the one exception on skills: a global skill beats a project skill of the same name. Of the products checked, only Codex documents a trust gate for the whole project config layer; pi has one too (see orchestrator-model.md, "Settings layering and per-field overrides").

## Project override of an agent's model or tools

| Product | Mechanism | Granularity |
| --- | --- | --- |
| Claude Code | `.claude/agents/<name>.md` shadows the user or plugin agent of the same name | Whole file; no settings key overrides one field |
| Codex | `.codex/agents/*.toml` sets `model`, `model_reasoning_effort`; custom agent named like a built-in replaces it. `[agents] default_subagent_model` and `default_subagent_reasoning_effort` are per-project fallbacks. `sandbox_mode` and `mcp_servers` in an agent file "don't override the parent configuration" | Whole file, plus global fallbacks; no tool allowlist field |
| Gemini CLI | `.gemini/agents/*.md` (model, tools, mcpServers). Built-in agents tuned per field in settings under `agents.overrides` (for `codebase_investigator`: model, maxTurns) | Whole file for custom agents; **per field for built-ins via `agents.overrides`** |
| Cursor | `.cursor/agents/*.md` (model, readonly); no tools field documented | Whole file |
| Kilo | `.kilo/agents/*.md` (model, permission, mode) | Properties merge |
| Roo | `.roomodes` sets tool groups; model is only "sticky" (last used in the UI), not declared | Whole mode |

Shadowing by name is universal. Gemini's `agents.overrides` is the only documented per-field override, and it covers built-in agents. Kilo's "properties merge" is the only other place where fields combine across layers.

## How skills reach subagents

| Product | Mechanism | Source |
| --- | --- | --- |
| Claude Code (field since 2.0.43, 2025-11-17; cap 32 since 2.1.295/296) | `skills:` in agent frontmatter **preloads the full SKILL.md body** at startup: "The full skill content is injected, not only the description." It "controls which skills are preloaded, not which skills the subagent can access": unlisted skills stay invocable through the Skill tool. Block skills by omitting `Skill` from `tools`. Skills the parent already invoked are not passed down. `disable-model-invocation: true` skills cannot be preloaded | code.claude.com/docs/en/sub-agents |
| Claude Agent SDK | `AgentDefinition.skills` has the same preload semantics. The session option `skills` takes names, `"all"` or `[]`: "The model doesn't see unlisted skills and the Skill tool rejects them" | code.claude.com/docs/en/agent-sdk/subagents, /skills |
| Codex | Subagents see the catalog by default: name and description, "at most 2% of the model's context window" (8,000 chars if unknown), descriptions shortened first when many are installed. A custom agent can disable skills with `skills.config` (a per-agent deny list) | learn.chatgpt.com/docs/build-skills, /subagents |
| LangChain Deep Agents | The general-purpose subagent "Automatically inherits skills from the main agent"; custom subagents "Do not inherit the main agent's skills" and take their own `skills` list. "Fewer well-scoped skills outperform many overlapping ones." | docs.langchain.com/oss/python/deepagents/skills |
| Roo Code | Scoping by directory: `skills-{mode}` (e.g. `.roo/skills-architect/`); mode-specific ranks above generic at the same level. Kilo "does not use mode-specific skill directories" | roocodeinc.github.io/Roo-Code/features/skills; kilo.ai/docs/customize/skills |
| Cursor, Gemini CLI, Cline | Whether subagents get skills: not sourced | |

**Agent Skills spec** (agentskills.io, fetched 2026-10-17) has no field or rule for attaching skills to agents. Scoping is the client's job. The client guide: metadata (~100 tokens per skill) at startup, body (under 5,000 tokens recommended) on activation, resources on demand. On filtering: "Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time", and omit the catalog when no skills are available. Subagent delegation of a skill is "an advanced pattern only supported by some clients."

Anthropic's engineering post (2025-10-16, updated 2025-12-18): "At startup, the agent pre-loads the name and description of every installed skill into its system prompt." Anthropic's platform best practices: Claude uses descriptions "to choose the right Skill from potentially 100+ available Skills." Neither mentions subagents or a skill-count cap.

## A call-time "skills for this task" parameter

- No product has one. Claude Code's Agent tool (per-call `model`, `effort`, `isolation`, `run_in_background` only), the Agent SDK, Codex spawn (per-call model and effort, not skills), Roo `new_task` (message and mode only) and Deep Agents all bind skills at definition time.
- No primary source says "do not load all skills into subagents" (not sourced).
- Nearest evidence: **"More Skills, Worse Agents? Skill Shadowing Degrades Performance When Expanding Skill Libraries"** (Song, Wei; ICML 2026 workshop, icml.cc/virtual/2026/77891, page undated). Pass rate drops up to 21% going from a small helpful set to a 202-skill library; "the skill selection failure, not the enlarged context, is the primary bottleneck"; context overhead was statistically indistinguishable from zero. (Summariser paraphrase of the abstract plus that one quote.)
- Codex's 2% catalog budget and Deep Agents' "fewer well-scoped skills" point the same way: narrowing the list helps selection, not context size.

## MCP tools per agent

| Product | Default for subagents | Per-agent scoping |
| --- | --- | --- |
| Claude Code | Inherit all tools, MCP included | `tools` / `disallowedTools` take `mcp__server__*` or `mcp__server`; since 2.1.299 (2026-10-14) naming a server in `tools` "take[s] only the named MCP server's tools". `mcpServers` frontmatter names a configured server or defines one inline, which keeps it out of the main conversation. MCP scopes: local > project `.mcp.json` > user > plugin; "fields are not merged across scopes" |
| Gemini CLI | Inherit all tools | Agent frontmatter `tools` with `mcp_*` / `mcp_server_*` wildcards and `mcpServers`; settings `includeTools` / `excludeTools` (exclude wins) |
| Codex | Inherit | Per server `enabled_tools` / `disabled_tools`; per-agent MCP scoping not documented, and an agent file's `mcp_servers` does not override the parent |
| Cursor | Inherit all parent tools including MCP | None; servers toggled globally |
| Roo | Per mode | An `mcp` tool group turns MCP on or off per mode; no per-server restriction found. Project `.roo/mcp.json` beats global |
| Cline | Subagents get no MCP | n/a |

## Could not source

- Claude Code: details of the removed `/agents` wizard's tool, model and scope pickers (wizard removed in 2.1.198, npm 2026-07-01: "ask Claude to create or manage subagents, or edit `.claude/agents/` directly"); the release that introduced `mcpServers` frontmatter; any per-call skills parameter (appears not to exist).
- Codex: publication dates of doc pages; per-feature release; whether `~/.codex/skills` still works; `max_depth` default; personal-vs-project agent name collision; an agent tool allowlist.
- Cursor: whether subagents get skills; whether nested `.cursor/rules` scope by folder; a per-subagent tools allowlist; MCP project-vs-global precedence; a per-project default model.
- Gemini CLI: whether subagents receive skills; exact CLI argument and env-var list; ship dates of subagents and skills.
- Roo, Kilo, Cline: Cline workflows format and invocation; Roo per-mode MCP server restriction; Kilo legacy `skills-{mode}` and pre-v7 orchestrator docs.
- Skills: a primary source recommending that an orchestrator pass a chosen skill set per call, or advising against giving subagents all skills; Google/ADK guidance on skills.
