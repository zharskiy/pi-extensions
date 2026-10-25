# Claude Code skills and plugins in pi

Research date: 2026-10-22. Question: what it takes to run skills and plugins written for Claude Code in pi, and whether the difference in tool names needs a tool mapper or runtime tool replacement.

- README.md (this file): the answer, the options for tool names, the recommended design, the decisions left to the owner.
- research.md: the facts behind it: Claude Code's skill and plugin formats, pi 1.4.0's surface, a survey of 1,029 real skill files, and how other agents handle Claude Code skills.

## Summary

1. **Tool names are a smaller problem than assumed.** Skills are written in actions ("read the file", "run the script"), not tool calls. Of 1,029 skill and command files surveyed, 1 in 20 general-purpose skills names a Claude Code tool in its body. Tool names cluster in two places: `allowed-tools` frontmatter (a permission pre-approval list, which pi can ignore) and plugin commands written by Claude Code's own team. A short mapping table in the system prompt covers the rest; this is what obra/superpowers, the most widely used skill library in the survey, already ships for pi. On pi's Anthropic OAuth provider path the model is already declared the tools as `Read`, `Write`, `Edit`, `Bash` and `Grep`, so there the names match without any work.
2. **Runtime tool replacement is not available the way the question imagines.** Pi looks the tool up by exact name before the `tool_call` hook runs, so a call to `Read` never reaches an extension; the hook can rewrite the arguments of a known tool and block it, not redirect it. Aliases are possible (pi exports every built-in tool definition and an extension may register it under another name), but doubling the tool list has real costs and is not recommended (Option B below).
3. **The real gaps are elsewhere:** discovery (`.claude/skills`, `~/.claude/skills`, plugin skill folders), invocation (`/name` with `$ARGUMENTS`, `$N`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`), tools that Claude Code has and pi does not (subagents, todo list, ask-the-user, web fetch and search; this package supplies subagents, `questionnaire` for asking the user, and `fetch` for agents that list it), and frontmatter with runtime semantics (`context: fork`, `hooks`, `paths`). All but `hooks` are small.
4. **Plugins decompose well, except hooks.** Skills, commands, agents, MCP servers and output styles have pi analogues. Hooks match on Claude Code tool names, receive Claude Code's argument schemas on stdin and can rewrite arguments; a faithful shim is the single biggest piece of work. LSP servers, `bin/`, `userConfig`, monitors, workflows and mods have no analogue.

The recommendation is a new extension that imports what Claude Code has on disk, in four phases: skills, then plugin skills, commands and MCP servers, then plugin agents, then hooks last and only if a plugin the owner wants needs them.

## Tool names: four options

| Option | Possible in pi 1.4.0 | Verdict |
|---|---|---|
| A. Mapping table in the prompt | Yes, `Host.setPromptSection` reaches the main session, no adapter change (note: sections no longer reach agents; the table would have to reach them another way, such as the subagents extension's `promptAppend`) | **Recommended.** Matches how skills are written and how superpowers already targets pi. Zero context cost beyond the table. |
| B. Alias tools under Claude Code names | Yes, `pi.registerTool({ ...createReadToolDefinition(cwd), name: "Read" })` with Claude's parameter schema and a `prepareArguments` translator | Rejected. Doubles the declared tool list (context and cache), two tools for one action confuses routing, agent `tools:` lists and `skills` validation (needs `read`) see only pi names, and it collides with pi's own wire renaming on the Anthropic OAuth path, where `read` and `Read` would map to the same wire name. |
| C. Rename pi's built-ins to Claude Code names | Yes, registering under a built-in's name replaces it, but under a new name it is a second tool | Rejected. Every prompt, agent file and test in this package names pi tools, and other skills written for pi would break. |
| D. Redirect at runtime (`tool_call`) | No for unknown names: lookup precedes the hook and returns "Tool X not found". Yes for argument rewriting of known tools | Not applicable to the name problem. Useful later for hooks (Phase 4). |

A variant of D, rewriting the provider payload in `before_provider_request`, is unverified (payload types are `unknown`) and is exactly what pi-ai already does for one provider; doing it generally would be provider knowledge, which this package avoids.

The table for Option A, as one prompt section (name `claude_code_tools` or similar):

| Skill says | Pi has |
|---|---|
| Read, Write, Edit, MultiEdit, Bash | `read`, `write`, `edit` (several edits in one call), `bash` |
| Grep, Glob, LS | `grep`, `find`, `ls` (or `bash` when those are off) |
| Task, Agent, "dispatch a subagent" | `run_agent` when present; otherwise do the work in sequence, never fabricate a call |
| AskUserQuestion | `questionnaire` when present; otherwise ask in the reply |
| TodoWrite, TaskCreate, "create a todo" | no tool; keep the list in the reply or a plan file |
| WebFetch, WebSearch | `fetch` via the `fetch` agent when `run_agent` is present; no search |
| Skill, `/name`, "invoke the skill" | read the skill's `SKILL.md` from `<available_skills>` |
| EnterPlanMode, ExitPlanMode, NotebookEdit, KillShell | none; say so and continue |

The section is static text, so it names tools by the string the model would see; it does not need to know which extensions are loaded. The precedence sentence planned in future-plans/README.md (delivery order item 2) belongs next to it.

## What works today with no code

- Point pi at Claude Code's skill folders in settings: `"skills": ["~/.claude/skills"]` in `~/.pi/agent/settings.json`. Pi's loader reads the agentskills.io core (`name`, `description`, `disable-model-invocation`), ignores every other field silently, lists the skills in `<available_skills>` and the model reads the body with `read`. Relative references resolve because pi tells the model to resolve them against the skill directory. Caveats: a project `.claude/skills` entry in project settings resolves against `<cwd>/.pi`, a missing settings path is skipped silently (only a missing `--skill` path is an error diagnostic), and `/skill:name` appends arguments after the body instead of substituting `$ARGUMENTS`.
- Skills in the superpowers style (actions, a per-harness reference file) work unchanged. So do the anthropics/skills document skills, whose bodies are prose plus `python scripts/...` lines.
- A project `CLAUDE.md` is already read by pi as a context file, but only in a directory with no `AGENTS.md`, and `~/.claude/CLAUDE.md` is not read (pi's global file lives in `~/.pi/agent`). `/mcp-import` already converts `~/.claude.json` and `.mcp.json` servers.

What does not work today: `/name` invocation (pi uses `/skill:name`), argument substitution, `${CLAUDE_*}` variables, `!`command`` preprocessing, `context: fork`, `allowed-tools` as anything, plugin discovery, commands, agents and hooks.

## Recommended design

One new extension. Working name `claude-import`; see decision 1. It reads Claude Code's files, writes nothing outside pi's agent dir, and reports what it skipped, in the style of `/mcp-import`.

### Phase 1: skills

- **Discovery.** Add `Host.discoverResources(handler)` to the adapter over pi's `resources_discover` event (startup and `/reload`), returning `skillPaths`. Paths: `~/.claude/skills` always; `.claude/skills` from cwd up to the repo root in a trusted project only; enterprise managed dir is out of scope. Going through pi's loader means the skills appear in `<available_skills>`, `/skill:name` works, and the subagents inventory sees them for `skills:` allowlists. Known limit: pi merges `resources_discover` skills even under `--no-skills`; the extension should honour a `skills: false` setting of its own.
- **Invocation.** For every imported skill that is not `user-invocable: false`, register `/name` through `Host.registerCommand`. Extension commands run before pi's skill expansion, so `/name` does not clash with `/skill:name`; it can clash with pi's built-in commands (`/settings`, `/model`, `/export`, `/new`, ...) and with this package's `/agents` and `/style`, so the importer skips those names with a diagnostic. The handler strips the frontmatter, substitutes `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name` (from `arguments:`), `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, appends `ARGUMENTS: <value>` when nothing consumed them, wraps the result in pi's own `<skill name location>` block and sends it with `Host.sendUserMessage`. `argument-hint` becomes the command description. This is about 60 lines of pure code with a table test.
- **Tool-name section.** The Option A table via `Host.setPromptSection`, set once at session start. Shipped as a prompt file like `extensions/subagents/prompts/*.md`.
- **Frontmatter policy** (what the extension does with each Claude Code field):

| Field | Handling |
|---|---|
| `name`, `description`, `disable-model-invocation` | pi's loader already honours them |
| `user-invocable: false` | no `/name` command; the skill stays listed |
| `argument-hint`, `arguments` | used by the command |
| `allowed-tools`, `disallowed-tools` | ignored; in Claude Code they pre-approve permissions, pi has no permission prompts |
| `model`, `effort` | ignored; a provider or model name in a skill file is the user's, not ours, but switching models per skill is out of scope |
| `context: fork`, `agent`, `background` | ignored in Phase 1 (`context` and `agent` had zero uses in the survey; `background` was not counted); could later become a `run_agent` call with the body as the task |
| `paths`, `hooks`, `shell`, `when_to_use` | ignored, reported once in the import notes |
| `license`, `compatibility`, `metadata`, `version` | ignored |

- **`!`command`` preprocessing.** One real use in 1,029 files. Recommend not implementing it: it runs shell commands from a file at invocation time, and pi's shipped `inline-bash.ts` example shows the user can add it themselves. Report it in the import notes when a skill uses it.

### Phase 2: plugins (skills, commands, MCP)

- **Source of truth.** Reuse Claude Code's own installation rather than building a marketplace client: `~/.claude/plugins/installed_plugins.json` gives each plugin's `installPath` (cache copy or in-place source), and `enabledPlugins` in `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json` says which are on. Manifest fields `commands` and `agents` replace the default folders, `skills` and `mcpServers` add to them; the three plugins installed on this machine use only defaults.
- **Skills** go through the same `skillPaths` route. Pi lists them under their bare frontmatter name, not `plugin:name`; the `/plugin:name` command carries the namespace. Collisions produce pi's own duplicate-name diagnostic (`skills.js:333-337`).
- **Commands** (`commands/**/*.md`, legacy but still shipped by Anthropic's plugins and 43 of 43 local plugin commands) register as `/plugin:path:name` through the same handler as skills, with `${CLAUDE_PLUGIN_ROOT}` substituted. `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`, which the file rules in AGENTS.md forbid as a write target; the importer substitutes `<agentDir>/claude-import/data/<id>/` instead and says so in the import report. Pi's prompt templates are an alternative, but they take the name from the filename, so the namespace would be lost, and their `$N` is 1-based where Claude Code's is 0-based.
- **MCP servers** (`.mcp.json` or inline `mcpServers`): extend `/mcp-import`'s sources with enabled plugin manifests, substituting `${CLAUDE_PLUGIN_ROOT}`. Extensions never import each other, so either `mcp-import` grows a plugin source itself or the new extension owns a copy of the conversion; the former is smaller.
- **Output styles** (`output-styles/*.md`): the style extension's prompt files have the same shape. Deferred; the `/style` extension would need a second source directory.

### Phase 3: plugin agents

Plugin `agents/*.md` are close to this package's agent files: `name`, `description`, a body prompt, `tools`, `model`. The differences, each a translation:

| Claude Code | This package |
|---|---|
| `tools: Read, Grep, Glob, Bash` (Claude names) | `tools: [read, grep, find, bash]` via the Option A map; `Task` becomes `subagents: all`, `WebFetch` becomes `fetch`, `AskUserQuestion` has no agent-side tool |
| `model: sonnet / opus / haiku / inherit` | `inherit` as is; the aliases pass through unchanged, because subagents already resolves a model name or part of one against `pi --list-models` when the agent starts. Whether a bare family name resolves to one model or is rejected as ambiguous depends on the user's providers; a user-set `modelAliases` map in the extension's settings is the fallback, since this package names no models in code |
| `skills:` preloads bodies | lists them (this package's semantics); same field name |
| `limit` required here | a setting default |
| `disallowedTools`, `maxTurns`, `memory`, `background`, `isolation`, `color`, `effort`, `permissionMode`, `hooks`, `mcpServers` | ignored, reported |

The subagents extension loads agents from its shipped built-ins and two directories. A third source, agents handed over at session start, is subagents-internal work (the `agent-definitions` plugin), and a `Host.publish` channel is the sanctioned way for another extension to hand them over. The alternative, writing translated files into `~/.pi/agent/agents/`, is allowed by the file rules but leaves stale copies behind on update.

### Phase 4: hooks

Only if a wanted plugin needs them (none of the three installed here does; Anthropic's `security-guidance` and `ralph-loop` ship a `hooks/` folder). The pieces:

- `Host.onToolCall` and `Host.onToolResult` in the adapter over pi's `tool_call` (block, mutate `input` in place) and `tool_result` (replace content). Both are new adapter methods; the plan-mode research already specified `onToolCall` before it was dropped.
- A translator from pi tool names and arguments to Claude Code `tool_name` and `tool_input` (`path` to `file_path`, `edits[]` to `old_string`/`new_string`, bash `timeout` seconds to milliseconds) and back for `updatedInput`.
- The command handler protocol: JSON on stdin, exit 2 blocks with stderr as reason, stdout JSON `hookSpecificOutput.permissionDecision`, `updatedInput`, `additionalContext`; `${CLAUDE_PLUGIN_ROOT}` and friends in `command` and env, with `${CLAUDE_PLUGIN_DATA}` redirected under pi's agent dir as for commands.
- Event map: `PreToolUse` to `tool_call`, `PostToolUse` to `tool_result`, `SessionStart` to `session_start`, `Stop` to `agent_end` (a `block` decision means continue the loop, which pi has no hook for), `UserPromptSubmit` to `before_agent_start` (context only). The other 28 events have no pi equivalent. `prompt`, `agent`, `http` and `mcp_tool` handler types are out of scope.

## Decisions for the owner

1. **Extension name.** AGENTS.md forbids provider names in code and prompts. "Claude Code" is a harness, and `/mcp-import` already reads `~/.claude.json`, but an extension called `claude-import` with prompt text that says "Claude Code" stretches the rule. A neutral name (`skills-import`, `harness-import`) with the Claude Code paths as data, like `mcp-import`, keeps the rule intact.
2. **Reuse Claude Code's plugin install or build one.** The design reuses `installed_plugins.json`, which requires Claude Code on the machine. A pi-side marketplace client (git clone, `marketplace.json`, version pinning) is a separate project.
3. **Skill tool.** Claude Code's model invokes skills through a `Skill` tool; pi has the model read the file. The deferred Option B in skills-in-main-session (a `skill` tool) would also make the Option A row for `Skill` a real tool. Not required for compatibility.
4. **`!`command`` preprocessing.** Refuse (recommended) or implement behind a setting.
5. **Hooks.** Decide after Phases 1 to 3 whether any plugin worth having needs them.

## Delivery order

1. Phase 1 with the prompt section, the `/name` commands and `Host.discoverResources`. Docs and `npm run check` green.
2. Phase 2 skills and commands; MCP through `mcp-import`.
3. Phase 3 agents.
4. Phase 4 hooks, if at all.

## Not verified

- Whether `before_provider_request` can rewrite tool names generally; payload types are `unknown` in pi's types.
- Whether registering `read` and `Read` side by side breaks the Anthropic OAuth path in practice (inferred from pi-ai source, not run).
- Claude Code's current wire format for the `Skill` tool and listing; the only source is a third-party capture from October 2025.
- Whether Claude Code reads `.agents/skills` (pi does); no official statement found.
- Pi's handling of project-settings `skills` entries that point outside `.pi` (resolution rule read from docs, not run).
- The survey's verdicts come from grep plus reading headers and key sections, not from running the skills.
