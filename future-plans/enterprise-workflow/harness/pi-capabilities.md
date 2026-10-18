# Pi capabilities and this repo's building blocks

Abbreviations: `PI` = `node_modules/@earendil-works/pi-coding-agent`; `TYPES` = `PI/dist/core/extensions/types.d.ts` (line numbers as of the installed version); `ARCH` = `ARCHITECTURE.md`; `CONTRACT` = `core/adapter/contract.ts`.

Key framing: pi's extension API is much richer than what `core/adapter` exposes. `CONTRACT` `Host` (lines 267-296) has no model switch, no input interception beyond editor-submit rewriting, no classifier call, no compaction trigger, no active-tool control. Anything marked "pi yes / repo no" needs a new adapter method. Only `core/adapter` may import pi (`AGENTS.md`, Rules).

## 1. Events and hooks

All via `pi.on(event, handler)` (`TYPES` 1187-1227; `PI/docs/extensions.md`, "Events and concurrency"). Handlers run in load order.

| Event | Result type / power | Source |
|---|---|---|
| `project_trust`, `resources_discover` | trust decision, extra resources | TYPES 1187-1188 |
| `session_start`, `session_shutdown`, `session_info_changed` | notify | 1189-1196 |
| `session_before_switch`, `session_before_fork`, `session_before_tree` | `{cancel}`; tree can supply a summary | 1130-1154 |
| `session_before_compact` | `{cancel}` or `{compaction}` (custom summary); event has `reason: manual\|threshold\|overflow`, `customInstructions`, `signal` | 601-611, 1137 |
| `session_compact`, `session_compact_failed` | notify (`compactionEntry`, `fromExtension`) | 613-623 |
| `input` | `{action: continue}`, `{action: transform, text, images}`, `{action: handled}`: can rewrite or swallow the raw prompt; has `source`, `streamingBehavior` | 910-930; `PI/docs/prompt-templates.md` "Use a template" (extensions see raw input first) |
| `before_agent_start` | event has `prompt`, `images`, mutable `systemPromptOptions`, `messageType: user\|custom`; result `{message, systemPrompt}`: inject a hidden message or replace the whole system prompt for this run | 720-742, 1125-1129; extensions.md "Events and concurrency" |
| `agent_start`, `agent_end`, `agent_settled`, `agent_before_settle` | `agent_before_settle` can append entries and request one continuation; `agent_settled` is notification-only (the repo's "idle") | extensions.md "Respect the runtime lifecycle" |
| `turn_start`, `turn_end` | `turn_end` can chain `custom`, `custom_message`, `context_edit`, `compaction` entries and `continue: true` | extensions.md "Events and concurrency" |
| `message_start/update/end` | `message_end` can replace a finalized message | same |
| `tool_call` | mutate `event.input` or `{block, reason, terminate}` | 1089-1098 |
| `tool_result`, `tool_execution_start/update/end` | results compose; nested calls carry `parentToolCallId` | extensions.md "Tools" |
| `context`, `context_with_system` | transform messages sent to the model per request | extensions.md `context_with_system` |
| `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event` | inspect/alter provider traffic | 1203-1206 |
| `model_select`, `thinking_level_select` | notify | 1222-1223 |
| `user_bash` | handle `!cmd` | 1226 |
| `ui_prompt_start/end`, `mcp_servers_change`, `cache_warming_decision` | notify / `{action: warm\|stop}` | 1197-1212 |

Direct answers:
- **Cancel or rewrite the user prompt: yes.** `input` returns `transform` or `handled`. Not used by the repo; the adapter only rewrites at editor submit (`HostUi.onEditorSubmit`, CONTRACT 191, used by command-aliases).
- **Per-turn system-prompt addition: yes.** `before_agent_start` result `systemPrompt`, or mutate `systemPromptOptions` sections (preferred, keeps transcript deltas). The repo wraps this as `Host.setPromptSection(name, text)` and `setMainPrompt` (ARCH "Startup and the adapter"; `core/adapter/pi-sections.ts`), applied at every `before_agent_start`, so a per-turn change needs one call before the run.
- **Switch model for next turn and back: yes.** `pi.setModel(model)` (session-only, returns false without credentials) and `pi.setThinkingLevel` (TYPES 1298-1305). Switching loses the prompt cache (virtual-models.md "Route requests"). Not in `Host`. Alternative: `pi.registerVirtualModel({route(request, ctx)})` picks a physical model per request, with branch-persisted `state` (PI/docs/virtual-models.md "Keep routing state").
- **Cheap own LLM call with another model: yes.** `ctx.modelRegistry.streamSimple(model, context)` for chat models (extensions.md "Context and session changes"); `ctx.modelRegistry.classify(model, {state, questions})` for classifier-type models only, answers typed choice/score/bool (model-registry.d.ts line 47; codemode.md "Classify"). Usage must be reported in tool results to keep totals right. The repo has no wrapper.
- **Idle/timer hooks: no dedicated event.** `agent_settled` marks idle; `ctx.isIdle()` exists. A timer must be a `setTimeout` started in `session_start` and cleared in `session_shutdown` (extensions.md "Respect the runtime lifecycle": no timers in the factory). Repo precedent: `pi-overlay.ts` polls on an unref'd timer; session-limits waits 1 s after busy sources go idle (ARCH "Session-limits").
- Extensions run in `tui`, `rpc`, `json`, `print` modes; `ctx.hasUI` gates dialogs (extensions.md "UI and modes").

Events the repo adapter actually subscribes to: `session_start/shutdown`, `before_agent_start`, `agent_start/end/settled`, `turn_start/end`, `message_update/end`, `tool_execution_start/end`, `session_compact`, `ui_prompt_start/end` (`core/adapter/pi-adapter.ts` 187-345). It never uses `input`, `context`, `tool_call`, `session_before_*`.

## 2. Commands, tools, UI

| Capability | Pi API | Repo wrapper |
|---|---|---|
| Slash command | `pi.registerCommand(name, {description, handler, completion})` | `Host.registerCommand(name, CommandSpec{description, complete, run(args, SessionControl)})` (CONTRACT 226-228, 268) |
| Command-only session control | `ExtensionCommandContext`: `waitForIdle`, `newSession({parentSession, setup, withSession})`, `fork`, `navigateTree`, `switchSession`, `reload` (TYPES ~282-321) | `SessionControl.newSession` only (CONTRACT 222; used by session-limits) |
| Custom tool | `pi.registerTool` with TypeBox params, `outputSchema`, `exposure` (direct/model-only/codemode/deferred/hidden), `promptGuidelines`, renderers, `ctx.executeTool` | `Host.registerTool(ToolSpec)` (CONTRACT 53-73); `modelOnly`, `executionMode`, guidelines mapped |
| Shortcut, CLI flag | `registerShortcut`, `registerFlag`, `getFlag` | none |
| Messages | `sendUserMessage(text, {deliverAs})`, `sendMessage({customType,...},{triggerTurn, deliverAs: steer\|followUp\|nextTurn})`, `appendEntry` | `sendUserMessage`, `sendHiddenMessage`, `dispatchCommand`, `appendEntry`, `registerEntryRenderer` |
| Dialogs | `ctx.ui.select/confirm/input/notify/custom/setWidget/setFooter/setHeader/setStatus/setEditorComponent/setWorkingIndicator` (TYPES 74-195) | `HostUi`: `confirm`, `notify`, widgets, `openOverlay`, `showForm` (inline form over pi's Editor), footer, working indicator, editor frame/keys (CONTRACT 179-200) |
| Higher-level forms | none | `core/manager`: `select.ts`, `multi-select.ts`, `tabs.ts`, `list.ts`; questionnaire tool (batch multiple-choice, tabs, free text; extensions/questionnaire/README.md "What it does") |
| Shell | `pi.exec(cmd, args, opts)` (TYPES 1280) | none in Host; subagents' `worktree.ts` runs git itself |
| Cross-extension bus | `pi.events` | `Host.publish/subscribe` plus `core/manager/channels.ts` (`pi:busy`, `pi:awaiting-input`, `spending:usage`) |
| Active tools | `getActiveTools/getAllTools/setActiveTools` | `Host` has `activeTools` only inside `pi-child.ts` |
| Settings read | `pi.getSettings()` | `core/manager/settings.ts` per-extension `pi-<ext>.json` (user + trusted project) |

Prompt templates (`PI/docs/prompt-templates.md`) are not API: markdown files become `/name` commands with `$1`, `$@`, `${1:-default}`. Direct `.md` children only in `~/.pi/agent/prompts/` and `.pi/prompts/` (nested via settings or packages). They expand to text only; they cannot run code or call agents by themselves.

## 3. Sessions

- Storage: JSONL tree, default `~/.pi/agent/sessions/` grouped by cwd; `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` setting move it (`PI/docs/sessions.md` "Control session storage"). Entry types: `session` header (`cwd`, `parentSession`), `message`, `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `context_edit`, `custom`, `custom_message`, `label`, `session_info` (`PI/docs/session-format.md` lines 69-83 and entry list).
- Branch/fork/resume: `/tree` (same file), `/fork` (new file from earlier user message), `/clone` (copy active branch), `--continue`, `--resume`, `--session`, `--fork` (`sessions.md` "Choose how to branch"). Extensions: `ctx.fork`, `navigateTree`, `switchSession`, `newSession` (command context only).
- Metadata: session name (`pi.setSessionName`), per-entry labels (`pi.setLabel`), arbitrary `custom` entries via `appendEntry` (not sent to the model). **No tags**; use namespaced custom entries like the repo's `pi-spending:usage` (STRUCTURE.md "Conventions").
- Repo reading: `Host.readEntries(customType, file?)`, `sessionUsage(file?)`, `AgentRuntime.readSession(file)`; `core/adapter/session-file.ts` parses jsonl. `onSessionStart(info, parent)` gets the parent file for fork/clone/handoff (ARCH "Startup and the adapter").
- Child sessions today (`core/adapter/pi-child.ts` 160-260): `spawn(SpawnSpec)` builds an in-memory `SettingsManager`, a `DefaultResourceLoader({cwd, noSkills, additionalSkillPaths, appendSystemPromptOverride, extensionsOverride, extensionFactories})`, `SessionManager.create(spec.cwd, spec.sessionDir, {parentSession})`, then `createAgentSession({cwd, model, thinkingLevel, tools, customTools, ...})`, `bindExtensions({mode:"print"})`. Only a hidden child extension loads; other repo extensions skip themselves via `childScope` (`pi-scope.ts`). Child auto-compaction is cancelled (`session_before_compact` returns `{cancel:true}`, pi-child.ts line 64) and replaced by the handoff chain.
- Layout: `<main session file minus .jsonl>/agents/<id>/` holds `manifest.json`, the child `.jsonl`, `result.md` (ARCH "Persistence summary"). Handoffs in `<OS tmp>/pi-subagents/` and `pi-session-limits/`.

## 4. Compaction

- Auto: triggers when `contextTokens > contextWindow - reserveTokens`; settings `compaction.enabled`, `reserveTokens` (16384), `keepRecentTokens` (20000), `modelOverrides` per `provider/id` (`PI/docs/settings.md` "Compaction"; `compaction.md` "When It Triggers"). Also overflow recovery compaction + retry.
- Manual: `/compact [instructions]`. Programmatic: `ctx.compact({customInstructions, onComplete, onError})` (TYPES 204-208, 250), non-blocking; available on every `ExtensionContext`, so an idle timer can call it. Not in `Host`.
- Custom summary: `session_before_compact` returns `{compaction: CompactionResult}` or `{cancel}`; `turn_end`/`agent_before_settle` can also propose `compaction` and `context_edit` entries. `CompactionEntry.details` is free-form (`compaction.md` "CompactionEntry Structure").
- Branch summarization on `/tree` has its own settings and hook (`session_before_tree`).
- Repo today: session-limits does not compact. It avoids compaction by writing a handoff at `hardRatio` 0.75 and starting a new session seeded with it; soft footer warning at 0.6 (extensions/session-limits/README.md "What it does"; ARCH "Session-limits"). It only listens to `Host.onCompact` to drop its cached token count. Children cancel compaction (above).

## 5. Skills, context files, project overrides

- Skills: directories with `SKILL.md`, discovered recursively in `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, and project `.agents/skills/` from cwd up to the repo root; descriptions go into the system prompt, bodies load on demand; `/skill:name` forces; `disable-model-invocation` (`PI/docs/skills.md` "Understand how skills load", "Add it to Pi").
- Context files: `AGENTS.md`/`CLAUDE.md` (plus `AGENTS.override.md`) from the agent dir, cwd and parents, no trust needed; `SYSTEM.md` replaces and `APPEND_SYSTEM.md` appends, project beats user (`PI/docs/configuration.md` "Context files", "Project .pi directory").
- Prompts: see section 2.
- Repo passing skills to children: `AgentRuntime.skillNames()` and `parent.skillFiles()`; `spawn` sets `noSkills: true` and `additionalSkillPaths` = the chosen files, plus `skillsOverride` filter (pi-child.ts 190-205). Agent files declare `skills: [..]|all|[]`; overrides in `agents.<name>.skills`; per-call `skills` on `run_agent` (extensions/subagents/README.md "Skills in three layers", "Skills per task"). Child context files load through the normal loader for `spec.cwd`.
- Agent definitions: bundled `extensions/subagents/agents/**/*.md`, user `<agentDir>/agents/*.md`, project `.pi/agents/*.md`; frontmatter fields `name, description, model, limit, tools, skills, subagents, worktree, mcp` (`src/model/agent-schema.ts`, `AgentFrontmatter`). Settings overrides in `<agentDir>/pi-subagents.json` and `.pi/pi-subagents.json`: only `model`, `thinking`, `skills` per agent (`AgentOverride`, README "Settings"). **No override for tools, prompt body, cwd, limit, or per-project rules.** Project files load only in trusted projects.

## 6. Working directory and worktrees

- Pi: one cwd per session (`ctx.cwd`, session header `cwd`). SDK `createAgentSession({cwd})` and `AgentSessionRuntime.newSession/switchSession/fork` recreate services for the target cwd (`PI/docs/sdk.md` line 54 and "AgentSessionRuntime"). `/clone` and `--session-dir` do not change cwd. No native worktree, multi-root or `chdir` feature found in docs (grep of cli, extensions, settings, security found none; `--cwd` exists only on `pi mcp add`). `pi.exec` can run git in any directory.
- Repo worktrees: `worktree: true` in agent frontmatter. `createWorktree` runs `git worktree add -b pi-agents/<id>-<stamp> <cwd>/.pi/worktrees/<id>-<stamp> <HEAD sha>` from the session cwd, agent cwd is the same subdirectory inside; successors reuse it; teardown `git worktree remove` without force, branch deleted only if unmoved (ARCH "Worktrees"; `run-agent/placement.ts` 11-48, `worktree.ts`).
- Child in a different directory: technically yes, `SpawnSpec.cwd` is free (CONTRACT 332-333; pi-child.ts passes it to loader, session manager and `createAgentSession`). But `placement.ts` only returns the session cwd or a worktree of the **same** repo; `run_agent` parameters are `agent, task, label, files, model, skills` (tools.ts 144-172) with no `cwd`/`repo`. Also the child's session folder, project trust and `.pi` config are resolved against that cwd, and `ctx.isProjectTrusted()` is the parent's value (pi-child.ts settings manager).

## 7. MCP and codemode

- Config: `~/.pi/agent/mcp.json` and `.pi/mcp.json` (trusted projects), `mcpServers` map with `command/args/env/cwd` or `url/headers/oauth`, `exposure`, `toolExposure` patterns, `description`, `enabled`; `pi mcp add [-l]`, `/mcp`; `pi.registerMcpServer(name, config)` for per-session servers registered by an extension, with `pi.unregisterMcpServer` (`PI/docs/mcp.md` "Configure servers", "Control tool exposure"; extensions.md "MCP servers"). Tool names `mcp__<server>__<tool>`.
- Exposure: `codemode` (default; scripts call via `searchTools/describeTool/ALL_TOOLS`), `deferred` (loaded by `tool_search`), `direct`, `hidden`.
- Codemode: a script tool that calls other tools and `models.classify/generateImages` (`PI/docs/codemode.md` "Models").
- Repo: agent field `mcp: true|false` toggles pi's MCP built-in in the child; there is no per-server filter. Any tool grant brings `codemode` and `tool_search`; `mcp:false` keeps those but no servers (README "MCP tools"; `mcpExtensions` in pi-child.ts). `/mcp-import` converts Claude Code/Cursor servers into `mcp.json` (extensions/mcp-import). Nothing registers MCP servers programmatically via `registerMcpServer`.

## 8. Gaps

| Idea | Pi has | Repo has | Missing |
|---|---|---|---|
| (a) per-prompt classification with a cheap model | `input` hook (rewrite/handle), `modelRegistry.classify` / `streamSimple`, `setModel`, virtual-model router with `state` | `onEditorSubmit` rewrite only | Adapter methods for `input`, a model call and `setModel`; a classifier-capable model in the catalogue (`classify` needs a classifier-type model; chat models go through `streamSimple`); cost reporting on `spending:usage` |
| (b) compaction on idle timer | `ctx.compact()`, `ctx.isIdle()`, `agent_settled`, `session_before_compact` custom summary | `Host.onIdle`, `isIdle`, timer precedent in session-limits | `Host.compact()`; timer lifecycle; decision whether it replaces or complements the handoff switch (session-limits owns thresholds) |
| (c) workflow files `.pi/workflows/*.md` | prompt templates (text only), skills, `registerCommand`, `sendUserMessage` | agent `.md` loader with frontmatter (`yaml-lite.ts`), `run_agent` batches and wake-on-completion, result `Status:` contract | No workflow format, loader or runner; no pi resource type for it. Would be a new subagents plugin that parses steps and drives `run_agent` internals, not the model |
| (d) workspace knowing several repos | one cwd per session; context files up the tree; `sessionDir`; SDK `cwd` per session | settings in `pi-<ext>.json` (user + project) | No multi-root concept, no workspace file, no code-location registry; would be a new extension plus prompt section via `setPromptSection` |
| (e) children in another repo's worktree | `createAgentSession({cwd})` takes any dir; `pi.exec` for git | free `SpawnSpec.cwd`; same-repo worktrees | `run_agent` has no cwd/repo parameter; `placement.ts`/`createWorktree` assume the session cwd's repo; trust, skills and `.pi` config for the other repo; cleanup path under the other repo |
| (f) pluggable code search (MCP) | MCP servers, `registerMcpServer`, `deferred`/`toolExposure`, `tool_search` | child `mcp: true`; `/mcp-import`; leads have MCP, chores (scout) do not | Per-agent server filter (only all or none); scout has `mcp:false` so it cannot use a search server; no docs convention for naming the search tool in prompts |
| (g) per-project rules for implementer/validator | `.pi/APPEND_SYSTEM.md`, project `AGENTS.md`, `.agents/skills`, `.pi/agents/*.md` | project agent files and `agents.<name>` overrides (model, thinking, skills), `skills` per task | Overrides cannot add prompt text, tools, or limits to a shipped agent; project rules reach children only through AGENTS.md (loaded by child loader) or a skill; no validator role among shipped agents (leads: planner, implementer, reviewer, general) |

## Most important facts

1. Pi lets an extension rewrite or swallow input (`input`), replace or extend the system prompt per run (`before_agent_start`), switch model (`setModel`) and call other models (`modelRegistry`); the repo exposes none of these except prompt sections and the editor-submit rewrite.
2. `ctx.compact()` and `session_before_compact` give full control of compaction, but the repo avoids compaction (handoff switch at 75%; children cancel it).
3. Pi has no worktree, multi-root or idle-timer feature; one cwd per session. The only worktree logic is the repo's same-repo `git worktree add`.
4. Children can take any cwd technically (`SpawnSpec.cwd`), but `run_agent` cannot request one.
5. Project customisation of agents is narrow: overrides cover model, thinking, skills only; MCP is all-or-nothing per agent.
