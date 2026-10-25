# Research: Claude Code skills and plugins versus pi 1.4.0

Research date: 2026-10-22. Sources: Claude Code docs at code.claude.com (snapshot of that day; the plugin pages were restructured under `/docs/en/plugins/*`), agentskills.io, pi 1.4.0 docs and `dist/` source under `node_modules/@earendil-works/`, local `~/.claude` (read only), and shallow clones of anthropics/skills, anthropics/claude-code, obra/superpowers and ComposioHQ/awesome-claude-skills. `PCA` below is `node_modules/@earendil-works/pi-coding-agent`.

## 1. Claude Code skills

Source: https://code.claude.com/docs/en/skills unless noted. The `slash-commands` page serves the same content: commands merged into skills.

### Discovery and precedence

| Location | Path |
|---|---|
| Enterprise | `.claude/skills/` in the managed settings dir |
| Personal | `~/.claude/skills/<name>/SKILL.md` |
| Project | `.claude/skills/<name>/SKILL.md`, loaded from the start dir and each parent up to the repo root |
| Nested | `<subdir>/.claude/skills/`, loaded the first time Claude touches a file in that subdir |
| `--add-dir` | `.claude/skills/` inside the added dir |
| Plugin | `<plugin>/skills/<name>/SKILL.md`, as `plugin:name` |
| Legacy commands | `.claude/commands/<name>.md` creates `/name`; subfolders become `:` segments |

Enterprise beats personal beats project; a skill beats a command of the same name; plugin skills never clash because of the namespace. Edits take effect in the session; a new top-level `skills/` dir needs `/reload-skills`. `.agents/skills` is not documented as read by Claude Code.

### Frontmatter

All fields optional; unknown fields are silently ignored; a malformed YAML block still loads the body. Outside Claude Code (claude.ai, the Skills API) only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools` are allowed.

| Field | Meaning | Origin |
|---|---|---|
| `name` | command name, defaults to the directory name | standard (1-64 chars, `[a-z0-9-]`, must match the directory) |
| `description` | listing text, combined with `when_to_use`, cut at 1,536 chars | standard (max 1024) |
| `when_to_use` | extra trigger text | Claude Code |
| `argument-hint` | autocomplete hint | Claude Code |
| `arguments` | named positional args for `$name` | Claude Code |
| `disable-model-invocation` | user only; description not in context; blocks preloading | Claude Code |
| `user-invocable` | `false` hides from the `/` menu | Claude Code |
| `allowed-tools` | tools pre-approved for the turn; it grants permission, it does not restrict; space or comma separated, or a list; `Bash(git *)` patterns | standard as experimental; Claude Code semantics are pre-approval |
| `disallowed-tools` | tools removed while the skill is active | Claude Code |
| `model`, `effort` | per-turn overrides | Claude Code |
| `context: fork`, `agent`, `background` | run the body as a subagent's prompt (default agent `general-purpose`, background by default) | Claude Code |
| `hooks` | hooks registered on invocation for the rest of the session | Claude Code |
| `paths` | globs; the skill auto-loads only when Claude works on matching files | Claude Code |
| `shell` | `bash` or `powershell` for `!` commands | Claude Code |
| `license`, `compatibility`, `metadata` | informational | standard |

### Body substitutions

`$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` (0-based, shell-style quoting), `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.KEY}`. If no placeholder consumes the arguments, `ARGUMENTS: <value>` is appended. `\$` escapes. Substituted values are not re-expanded.

`!`command`` (inline, at line start or after whitespace) and a fenced block opened with three backticks and `!` run before Claude sees the skill, in the session cwd, stderr merged, 2-minute timeout, non-zero exit aborts the invocation. Permission-checked without prompting; `disableSkillShellExecution` replaces each with a notice. Not available in claude.ai or the API.

Bundled files (`scripts/`, `references/`, `assets/`) are read on demand with the normal tools; the docs say to reference them from `SKILL.md` and to use `${CLAUDE_SKILL_DIR}` for scripts. The standard says relative paths from the skill root; the client guide (https://agentskills.io/client-implementation/adding-skills-support) says to resolve them against the skill directory.

### Tool names and invocation

The tools reference (https://code.claude.com/docs/en/tools-reference) says tool names "are the exact strings you use in permission rules, subagent tool lists, and hook matchers". Current names include Agent, AskUserQuestion, Bash, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, NotebookEdit, Read, Skill, TaskCreate/Get/List/Update, TaskStop, TodoWrite, ToolSearch, WebFetch, WebSearch, Write. Glob and Grep are absent by default on macOS and Linux (Claude uses `find` and `grep` through Bash). TodoWrite is off by default in favour of the Task tools. MultiEdit, LS, SlashCommand, BashOutput and KillShell are no longer in the table. No doc tells authors to name tools in a body; the docs' own examples do ("Find relevant files using Glob and Grep").

The model invokes a skill through the `Skill` tool; the rendered body enters the conversation once and is re-attached after compaction (5,000 tokens each, 25,000 combined). The listing budget is 1% of the context window, every name always listed, descriptions dropped least-recently-invoked first. A subagent's `skills:` field preloads full bodies (first 32 names); subagents may still call `Skill`. A third-party capture (https://mikhail.io/2025/10/claude-code-skills/, possibly stale) shows the listing as `<available_skills><skill><name/><description/><location/>` inside the Skill tool description, and the result as "Base Path:" plus the body.

### Other agents

| Agent | Reads `.claude/skills` | Notes |
|---|---|---|
| OpenCode (https://opencode.ai/docs/skills/) | yes, plus `.opencode/skills`, `.agents/skills` and the home equivalents | `skill` tool; strict name regex; tool-specific fields under `metadata` |
| Amp (https://ampcode.com/docs/customize/skills) | yes, switchable off | only `name` and `description` shown; no tool-name translation documented |
| Copilot CLI (https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | yes, plus `.github/skills`, `.agents/skills` | `allowed-tools` means "without asking" |
| Codex CLI (https://learn.chatgpt.com/docs/build-skills) | no, `.agents/skills` only | `agents/openai.yaml` sidecar |
| Gemini CLI (https://geminicli.com/docs/cli/skills/) | no | `activate_skill` tool with confirmation |

None documents a tool-name translation. The agentskills.io client guide says some clients scan `.claude/skills/` "for pragmatic compatibility" and recommends lenient validation.

## 2. Pi 1.4.0 surface

### Skills

- Discovery: `~/.pi/agent/skills`, `.pi/skills` (trusted project), `~/.agents/skills`, `.agents/skills` up to the git root (`PCA/dist/core/package-manager.js:2011-2064`). No `.claude` path anywhere in `dist/`. Settings `skills: string[]` takes files or dirs with `~` and absolute paths; project entries resolve against `<cwd>/.pi` (`docs/settings.md:150-161`); a missing settings path is skipped silently (`dist/core/package-manager.js:2071`, `collectFilesFromPaths`); only a missing `--skill` path is an `error` diagnostic (`dist/core/resource-loader.js:429-434`, which loops over `additionalSkillPaths`). `--skill <path>` is repeatable; `--no-skills` keeps explicit `--skill` paths. Packages contribute `skills/` or `pi.skills` globs, lowest precedence.
- Frontmatter read: `name` (default: directory name), `description` (required, else dropped), `disable-model-invocation` only as boolean `true` (`dist/core/skills.js:231-263`). Everything else is ignored without a warning. A YAML syntax error drops the skill with a warning. Name rule `/^[a-z0-9-]+$/`, max 64, is a warning only; the skill still loads. Name differing from the folder: no check.
- Listing: `formatSkillsForPrompt` (`skills.js:278-303`) emits "Use the read tool to load a skill's file when the task matches its description. When a skill file references a relative path, resolve it against the skill directory..." followed by `<available_skills><skill><name/><description/><location/>`. The `skills` section is emitted only when `read` or `bash` is declared, or selected but hidden (`system-prompt.js:102-109`). Two skills with one name produce a duplicate diagnostic (`skills.js:333-337`). A `SYSTEM.md` custom prompt keeps the section.
- Body loading: no skill tool; the model calls `read` on `<location>` and sees the raw file including frontmatter.
- `/skill:name args` (`dist/core/agent-session.js:1727-1751`): strips the frontmatter, wraps the body in `<skill name="N" location="PATH">\nReferences are relative to BASEDIR.\n\nBODY\n</skill>` and appends the args after the block. No `$ARGUMENTS`, `$N` or `$@` substitution in skills. Order on input: extension command, `input` event handlers, skill expansion, prompt-template expansion (`agent-session.js:1638-1663`).
- Prompt templates (`~/.pi/agent/prompts/*.md`, `.pi/prompts/*.md`, name from the filename) substitute `$1..$N` (1-based; Claude Code's `$N` is 0-based), `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`, and read `description` and `argument-hint` (`dist/core/prompt-templates.js`). No `!`shell`` and no `@file` anywhere; `examples/extensions/inline-bash.ts` adds `!{cmd}` through the `input` event.
- Runtime additions: `resources_discover` (startup and `/reload`) returns `{skillPaths, promptPaths, themePaths}`, merged into the loader with a prompt rebuild (`dist/core/extensions/types.d.ts:551-562`, `agent-session.js:2680-2698`). By code reading it bypasses `--no-skills` (`resource-loader.js:342-345, 626-636`).

### Tools

- Built-ins `read, bash, powershell, edit, write, grep, find, ls`; default active `read, bash, edit, write` (`dist/core/tools/index.js:19-28`, `agent-session.js:2993-2995`). `codemode` and `tool_search` come from built-in extensions, inactive by default. MCP tools are `mcp__<server>__<tool>`.
- Schemas: `read {path, offset?, limit?}`; `bash {command, timeout? (seconds)}`; `edit {path, edits[{oldText,newText}]}` with `prepareArguments` accepting legacy `oldText`/`newText`; `write {path, content}`; `grep {pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`; `find {pattern, path?, limit?}`; `ls {path?, limit?}`. Claude Code uses `file_path`, `old_string`/`new_string`/`replace_all`, millisecond timeouts and `output_mode` on Grep.
- Prompt: `- <name>: <promptSnippet>` lines for declared tools that have a snippet; custom tools without one are not listed (`system-prompt.js:84-86`).
- `pi.registerTool`: no name regex or reserved-name check (`dist/core/extensions/loader.js:234-244`). A tool registered under a built-in's name replaces it (`agent-session.js:2884-2898`; `examples/extensions/tool-override.ts`). Same name in two extensions: first in load order wins, with a conflict error. Tools cannot be unregistered; re-register with `exposure: "hidden"`. `pi.setActiveTools`, `getActiveTools`, `getAllTools` exist; this package's `Host` wraps none of them.
- Every built-in is exported as `createXToolDefinition(cwd, options?)` with snippets, guidelines and renderers, so `pi.registerTool({ ...createReadToolDefinition(cwd), name: "Read" })` is valid (`PCA/dist/index.js:20-30`; `examples/extensions/ssh.ts:128-171` spreads the `createXTool(...)` results the same way).
- `tool_call`: payload `{toolName, toolCallId, parentToolCallId?, input}`, result `{block?, reason?, terminate?}`; `input` is mutable in place without re-validation; `toolName` is not read back. Lookup by exact name happens first, so an unknown name returns "Tool X not found" and no handler runs (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:494-501`). Codemode calls pass through the same hooks with `parentToolCallId`.
- `tool_result`: handlers may return `{content?, details?, structuredContent?, isError?, usage?}`; the name is fixed.
- `before_agent_start`: mutable `systemPromptOptions` with `customPrompt`, `selectedTools`, `hiddenTools`, `toolSnippets`, `toolGuidelines`, `promptGuidelines`, `appendSystemPrompt`, `sections`, `skills` (a copy per run; editing changes the listing only, `/skill:name` resolves from the loader). Returning `systemPrompt` forces a full replacement.
- Wire renaming: on Anthropic OAuth requests pi-ai renames tools case-insensitively to Claude Code casing (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `KillShell`, `NotebookEdit`, `Skill`, `Task`, `TaskOutput`, `TodoWrite`, `WebFetch`, `WebSearch`) and maps responses back by case-insensitive match against the registered tools (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:42-77, 538-550`). Registering `read` and `Read` side by side would collide there (inferred, not run).
- Codemode: `tools.<name>(args)` with non-identifier characters replaced by `_`; built-in names are unchanged. Under `codemode.mode: "only"` the declared tool list shrinks to `codemode`.
- Not built into pi: subagents, todo list, ask-the-user tool, web fetch, web search, a skill tool, plan mode, notebook editing, background shells. Pi's README says it "skips features like sub-agents and plan mode". Examples exist for subagent, todo, question and plan mode.

### This package

- `Host` (`core/adapter/contract.ts:268-300`): `registerTool`, `registerCommand`, `setMainPrompt`, `setPromptSection`, `onSessionStart`, `onSessionShutdown`, `onIdle`, `onTurnEnd`, `onCompact`, `sendUserMessage`, `sendHiddenMessage`, `dispatchCommand`, `publish`, `subscribe`, `appendEntry`, `registerEntryRenderer`, `onAgentStart`, `onPhase`, `onDialog`, plus session, model and usage accessors. `publish`/`subscribe` is the channel the README's agent handover uses. No `onToolCall`, `onToolResult`, `discoverResources`, `onInput`, `setActiveTools`. The adapter subscribes to no `tool_call` or `tool_result` event anywhere.
- `setPromptSection` stores sections in a process-wide map and applies them in the main session's and every child's `before_agent_start`, so one section reaches every agent at any depth (`core/adapter/pi-sections.ts`). Only `/style` uses it (`output_style`).
  - Note: this is no longer the case. Prompt sections now reach the main session only; children get nothing from extensions except what the subagents extension passes on purpose (`promptAppend`).
- Tools: `questionnaire` (AskUserQuestion's analogue, `modelOnly`), `run_agent` (Task/Agent's analogue; `agent`, `task`, `files`, `model`, `skills`), `message_agent`, `agent_status`; `fetch` and `handoff` for children only. `toPiTool` passes names through unchanged and forwards neither `prepareArguments` nor `namespace`.
- Skills for agents: `skills:` allowlists are validated against the inventory (`createSkillInventory`: the main session's loaded skills plus pi's default discovery with settings exclusions stripped) and handed to the child through `DefaultResourceLoader.additionalSkillPaths` with `noSkills: true`. Bodies are listed, not preloaded. A skill grant requires `read` in the agent's tools.
- Context files: pi loads the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` per directory (`resource-loader.js:116`); the global file comes from `~/.pi/agent`, so `~/.claude/CLAUDE.md` is never read.
- `/mcp-import` reads `~/.claude.json` and `.mcp.json`, converts with notes, and writes only `.pi/mcp.json` on the user's command: the precedent for "import, report, never overwrite".
- `future-plans/skills-in-main-session/` already holds the deferred `skill` tool (Option B there) and the survey of where other agents read skills. `future-plans/plan-mode-and-guards/` specified `Host.onToolCall` before it was dropped. `future-plans/enterprise-workflow/harness/pi-capabilities.md` lists the pi events the adapter does not wrap.

## 3. Survey of 1,029 real skill and command files

Clones and scripts live in the session scratchpad; nothing from the clones was executed. Sources: anthropics/skills (20 skills), anthropics/claude-code plugins (10 skills, 18 commands), obra/superpowers (15), ComposioHQ/awesome-claude-skills (32 curated, 832 generated from one template, 1 command), local `~/.claude/skills` (17), local plugins deduplicated (41 skills, 43 commands). The 832 generated skills are reported separately because they would swamp every statistic.

### Frontmatter in use

`name` and `description` everywhere (commands have no `name`). `license` in 17 of 20 anthropics/skills. `allowed-tools` in 14 of 18 Anthropic plugin commands, 10 of 41 local plugin skills and 14 of 43 local plugin commands, nowhere else. `argument-hint` in 28 of 43 local plugin commands. `user-invocable` 7, `disable-model-invocation` 4, `arguments` 13, all in plugins. `context`, `agent`, `model`, `hooks`, `paths` and `metadata`: zero real uses in 1,029 files (they appear only inside example blocks of the plugin-authoring docs). The generated composio skills all carry `requires: mcp: [rube]`.

### Tool names in bodies

Raw word matches for `Read`, `Write`, `Edit` are mostly English: a hand check of 15 samples each found 3 of 15 `Read`, 5 of 15 `Write` and 12 of 15 `Edit` to be tool references, and 9 of the 12 `Edit` hits come from plugin-authoring docs that describe Claude Code itself. With a strict pattern (`X tool`, backticked `X`, `X(`, "use X"), files with a tool reference in the body:

| Source | Strict body reference | `allowed-tools` frontmatter |
|---|---|---|
| anthropics/skills | 1 of 20 | 0 |
| claude-code plugin skills | 3 of 10 | 0 |
| claude-code plugin commands | 5 of 18 | 14 of 18 |
| superpowers | 0 of 15 | 0 |
| composio curated | 1 of 32 | 0 |
| composio generated | 0 of 832 | 0 |
| local user skills | 2 of 17 | 0 |
| local plugin skills | 10 of 41 | 12 of 41 |
| local plugin commands | 10 of 43 | 14 of 43 |

### Runtime features in bodies

| Feature | Where it appears |
|---|---|
| `$ARGUMENTS` | 19 of 43 local plugin commands, 12 of 41 local plugin skills, 7 of 18 Anthropic commands; none in general skill libraries |
| `${CLAUDE_PLUGIN_ROOT}` | 16 of 43 local plugin commands, 7 of 41 local plugin skills, 5 of 10 Anthropic plugin skills |
| `${CLAUDE_SKILL_DIR}` | 2 files |
| `$ARGUMENTS[N]`, `${CLAUDE_SESSION_ID}`, real positional `$N` | none |
| `!`command`` | 1 real use (plus the syntax documentation) |
| subagent dispatch prose | 9 of 15 superpowers (4 describe dispatch), 11 of 43 local plugin commands |
| TodoWrite or "todo list" | 5 of 18 Anthropic commands, 4 of 43 local commands |
| AskUserQuestion | 8 of 43 local commands |
| MCP dependency | all 832 generated composio skills, 16 of 43 local commands |

Files with a "hard" marker (subagent dispatch, TodoWrite, AskUserQuestion, a Skill tool call, `$ARGUMENTS`, `${CLAUDE_*}`): 2 of 20 anthropics/skills, 0 of 32 composio curated, 4 of 15 superpowers, 5 of 10 Anthropic plugin skills, 10 of 18 Anthropic commands, 21 of 41 local plugin skills, 30 of 43 local plugin commands.

### Bundled resources

About 40 to 55 percent of curated skills ship `scripts/`, `references/` or `assets/`; commands and generated skills ship none. Every reference is a path relative to the skill directory (`python scripts/merge_runs.py unpacked/`, "See `references/schemas.md`", `./reference/evaluation.md`) or `${CLAUDE_PLUGIN_ROOT}` for plugins.

### Verdicts on twelve representative files

| File | Verdict in an agent with `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
|---|---|
| anthropics/skills `frontend-design` | works unchanged |
| anthropics/skills `docx`, `webapp-testing` | work unchanged given python and skill-relative path resolution |
| anthropics/skills `skill-creator` | wants parallel subagents, with inline fallbacks |
| superpowers `test-driven-development` | works unchanged |
| superpowers `subagent-driven-development` | needs a subagent tool; has a no-subagent branch |
| superpowers `using-superpowers` | works with translation; ships `references/pi-tools.md` |
| claude-code `feature-dev` command | needs TodoWrite, plugin agents, `$ARGUMENTS` |
| local telegram `access` skill | works with translation plus `$ARGUMENTS` |
| claude-code `hook-development` skill | about Claude Code itself; meaningless elsewhere |
| composio `changelog-generator` | works unchanged |
| composio generated skill | needs an MCP server |

### The superpowers precedent

`skills/using-superpowers/SKILL.md` lists one reference file per harness (Claude Code, Codex, pi, Antigravity, Hermes, Muse). `references/pi-tools.md` says: skills speak in actions; on pi a subagent dispatch means an installed subagent tool if any, else "do not fabricate `Task` calls; execute sequentially"; task tracking means an installed todo tool, else a plan file or `TODO.md`; older docs saying `TodoWrite` mean the action. That is Option A of the README, written by a skill author instead of the harness.

## 4. Claude Code plugins

Sources: https://code.claude.com/docs/en/plugins/manifest-reference, `/plugins/components`, `/plugins/marketplace-reference`, `/plugins/loading`, `/plugins/install`, `/docs/en/hooks`, `/docs/en/sub-agents`, `/docs/en/mcp`, and the local `~/.claude/plugins`.

### Manifest and layout

`.claude-plugin/plugin.json` is optional; only `name` is required. Fields: `name`, `displayName`, `description`, `version` (not checked as semver; pinning), `author`, `homepage`, `repository`, `license`, `keywords`, `defaultEnabled`, `dependencies`, `settings` (only `agent` and `subagentStatusLine` take effect), `userConfig` (prompted values, `${user_config.KEY}`), `channels`, `skills` (adds to `skills/`), `commands` (replaces `commands/`, may inline content), `agents` (replaces, `.md` files only), `hooks` (merged with `hooks/hooks.json`), `mcpServers` (merged with `.mcp.json`, also `.mcpb` bundles), `lspServers`, `outputStyles`, `workflows`, `experimental.*`. Paths must start with `./` and stay inside the root. Unknown top-level keys are stripped with a warning.

Default layout: `skills/<n>/SKILL.md`, `commands/*.md` (legacy, subfolders become name segments), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json`, `bin/` (added to the Bash PATH), `settings.json`. A root `SKILL.md` with no `skills/` loads as a single skill. A root `CLAUDE.md` is not loaded. Anthropic's `security-guidance`, `ralph-wiggum` and `code-review` plugins and the three plugins installed locally all use defaults with minimal manifests.

### Namespacing and variables

Commands and skills are `/plugin:name` (`commands/db/migrate.md` is `/plugin:db:migrate`); agents are `plugin:name`, invoked as `@agent-plugin:name`; MCP tools are `mcp__plugin_<plugin>_<server>__<tool>`; output styles are `plugin:name`. `${CLAUDE_PLUGIN_ROOT}` is the installed version directory (changes on update); `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`. Both substitute in hook commands, MCP and LSP fields and the Markdown bodies of skills, commands and agents, and are exported to hook, MCP and LSP processes, but not to commands run through the Bash tool.

### Agents

Required `name` and `description`; body is the system prompt. Plugin agents honour `model` (`sonnet`, `opus`, `haiku`, a full id, `inherit`), `effort`, `maxTurns`, `tools` (comma string or list of Claude names), `disallowedTools`, `skills` (preloaded bodies), `memory`, `background`, `omitClaudeMd`, `isolation: worktree`, `color`; they ignore `permissionMode`, `hooks`, `mcpServers`, `initialPrompt`. Unknown fields are ignored. Local example: `tools: Read, Write, Edit, Grep, Glob, Bash`, `model: sonnet`, `color: green`.

### Hooks

`hooks/hooks.json` is `{"hooks": {"<Event>": [{"matcher", "hooks": [handler...]}]}}`. 33 events, among them SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, PreCompact, PostCompact, SessionEnd. Handler types `command`, `http`, `mcp_tool`, `prompt` (one model turn answering `{ok, reason}`), `agent` (a read-only subagent, up to 50 turns). Matchers on tool events are tested against Claude Code tool names (`Bash`, `Edit|Write`, `^Notebook` as regex, `mcp__...`).

Command hooks get JSON on stdin: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input` (Claude Code's argument schema; file tools always get an absolute `file_path`), `tool_use_id`; PostToolUse adds `tool_response` and `duration_ms`; Stop adds `stop_hook_active` and `last_assistant_message`. Exit 0 applies stdout JSON; exit 2 blocks with stderr as the reason on blockable events; other codes are ignored. PreToolUse returns `hookSpecificOutput.{permissionDecision: allow|deny|ask|defer, permissionDecisionReason, updatedInput, additionalContext}`; PostToolUse accepts `additionalContext` and `updatedToolOutput`; Stop and others use `decision: "block"` plus `reason`; SessionStart returns `additionalContext`. Context strings are capped at 10,000 characters. Env: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`.

### MCP, LSP, output styles

`.mcp.json` is `{"mcpServers": {name: {command, args, env} | {type: http|sse|ws, url, headers}}}` with `${CLAUDE_PLUGIN_ROOT}` substitution: the same family as `/mcp-import`'s input. `.lsp.json` maps a server to `command` and `extensionToLanguage`. Output styles are Markdown with `name`, `description`, `keep-coding-instructions`.

### Marketplaces and install state

`.claude-plugin/marketplace.json` has `name`, `owner`, `plugins[{name, source, ...}]`; sources are a relative path, `github`, `url`, `git-subdir`, `npm`, `archive` or `command`. The official marketplace has 315 entries (164 `url`, 98 `git-subdir`, 53 relative, 0 `npm`). On disk under `~/.claude/plugins`: `cache/<marketplace>/<plugin>/<version>/`, `data/<id>/`, `marketplaces/<name>/`, `installed_plugins.json` (`{"version":2,"plugins":{"<name>@<marketplace>":[{scope, installPath, version, installedAt, lastUpdated, gitCommitSha?}]}}`), `known_marketplaces.json`. Plugins from a local directory marketplace load in place from their source, everything else from the cache. Enabling is `enabledPlugins: {"<name>@<marketplace>": bool}` across the settings scopes, managed highest.

Anthropic's `security-guidance` and `ralph-loop` in the official marketplace ship a `hooks/` folder. Installed here: `telegram@claude-plugins-official` (2 skills, 1 stdio MCP server run from `${CLAUDE_PLUGIN_ROOT}`), `notion@claude-plugins-official` (10 commands, 4 skills, 1 http MCP server; manifest name `Notion` while the registry says `notion`), `mz-product-development@mz-plugins` (11 skills and 6 agents in the live source, loaded in place; the cache copy is stale). None ships hooks, LSP, output styles or settings.

### Component map

| Component | Pi analogue | Translation needed |
|---|---|---|
| skills | pi skills (agentskills.io) | discovery paths; Claude-only fields ignored or handled; `${CLAUDE_*}` and `$ARGUMENTS` |
| commands | extension commands or prompt templates | `$N`, `$name`, `!` injection; `plugin:` namespace; `allowed-tools`, `model`, `hooks` dropped |
| agents | subagents agent files | tool names, model aliases, `skills` preload semantics, `limit`; many fields dropped |
| hooks | `tool_call`, `tool_result`, `session_start`, `agent_end` through new adapter methods | tool-name matchers, `tool_input` schemas, stdin and exit-code protocol, `updatedInput`; `prompt`, `agent`, `http`, `mcp_tool` handlers and 28 events have no equivalent |
| MCP | `.pi/mcp.json` via `/mcp-import` | `${CLAUDE_PLUGIN_ROOT}`; tool names differ (`mcp__server__tool`) |
| output styles | `/style` prompt files | a second source directory |
| `settings.json` `agent` | none | |
| LSP, `bin/`, `userConfig`, monitors, themes, workflows, mods, channels | none | |
| marketplace and install | reuse `installed_plugins.json`, or a pi-side client | the latter is a project of its own |

## Not verified

- Claude Code's current Skill tool wire format and listing: only a third-party capture from October 2025.
- `@file` references in skills: nothing found in the docs.
- Whether Claude Code reads `.agents/skills`: no official statement.
- The tail of the skills page (about 11k characters) and the per-event input schemas of roughly 25 hook events were not read.
- The survey's verdicts come from grep plus reading headers and key sections, not from running the skills.
- Pi: `before_provider_request` payload shape; behaviour of `read` and `Read` side by side on the Anthropic OAuth path; project-settings `skills` path resolution outside `.pi`; `--no-skills` versus `resources_discover` (read from source, not run).
