# Research: skill autosetup

Facts behind README.md. First gathered 2026-10-22, re-verified 2026-10-25 after the modular-architecture refactor (PR #18). Sources: this package's code (paths relative to the repo root, line numbers as read on 10-25), pi 1.4.0 as installed under `node_modules/@earendil-works/pi-coding-agent` (PCA below; `package.json` says 1.4.0), and vendor docs (links given; most carry no publication date). Pi claims marked "10-22" were not re-read on 10-25.

The facts below predate release 1 and its follow-up (README.md, Follow-up shipped).

## 1. What this package has today

All paths below are under `extensions/subagents/` unless they start with `platform/`, `test/` or `AGENTS.md`.

### `/agents` routing

- Command registered in `api/plugins/agent-view.ts:207` (`host.registerCommand("agents", { run })`): first word checked with `isSubcommand` (`ui/agent-view/picker.ts:4-20`, `SUBCOMMANDS = ["view","create","setup"]`), rest joined as `args` (`agent-view.ts:218-225`); no subcommand and an argument opens the agent with that id (227-230); no argument opens the menu (`menu`, 185-196, a `selectForm` picker, tui only).
- `runSetupWord` (`agent-view.ts:161-173`): `create` goes to `service.create(args)`, `setup` goes to `service.run(args)` of the `agentSetup` service; the service is optional (`setup()`, 134: `services.has("agentSetup")`), a disabled `agent-setup` plugin gives an error notice naming the word.
- `agentSetup` service (`api/plugins/agent-setup.ts:131-147`, type `core/model/agent-record.ts:164-169`): `{usage: {setup, create}, create, run(args), complete(prefix)}`. `run` (134-141): non-empty `args` goes to `runLine(args)` (the one-line form), empty `args` to `runForm()`.
- Entry point for release 1: the bare `/agents setup` reaches `runForm` (`agent-setup.ts:81-105`): tui check 85-91, then `showForm(setupForm(...))` 93. The menu's `setup` entry takes the same path (`agent-view.ts:185-196`). No new word: `picker.ts`, `runSetupWord`, the service type and `line.ts` stay as they are.
- Completion: `subcommands(prefix)` (`agent-view.ts:136-150`) completes the first word, labelled with `service.usage[word]`; `setupCompletions` (201-205) forwards `setup <prefix>` to `agentSetup.complete`, which lists agent names only (`agent-setup.ts:142-146`).
- Usage strings: `SETUP_USAGE` (`line.ts:11-14`), `CREATE_USAGE` (`create.ts:11`); the description's usage is read once at enable (`agent-view.ts:198-199`).

### Lead predicate

- No lead/chore field on the definition; the only data is `path` (`AgentDefinition`, `core/model/agent-record.ts:98`), the file the agent was loaded from. `markdownFiles` (`core/agent-definitions/loader.ts:163-178`) walks every agents dir recursively and joins paths with `node:path` `join` (171), so subfolders count and the separator is the OS one.
- Shipped: `agents/chores/{editor,fetch,image,scout,shell,verifier}.md`, `agents/leads/{general,implementer,planner,reviewer}.md`; general has `skills: all` (`agents/leads/general.md:7`). A user or project agent under `<agents dir>/chores/` is found by the same walk, so a `chores` directory segment in the path relative to that agents dir marks it as a chore (each definition has `source`, `agent-record.ts:80`, and each source one dir: `agent-definitions.ts:16`, `core/model/paths.ts:15,17`); anything else with a list `skills` grant is a lead.

### Override detection

- The plugin context has the live `settings` (`api/plugins/fetch-tool.ts:58`; `agent-definitions.ts:14,51`). `settings.agents` is user overrides merged with project overrides per agent and field, project only when trusted (`core/model/settings.ts:141-147,101-107,154-156`), refreshed in place by `reloadSettings` (173-177) at session start and on `definitions.reload()`.
- File-level alternatives: `readObject` (`core/agent-setup/write.ts:6-15`) is not exported; `overriddenFields` (48-68) reads one file and answers which fields of given changes are set; `settingsPaths` (`core/model/settings.ts:131-134`).

### Inventory scope

- `SkillFile = {name, description, path}` (`platform/pi-adapter/child/skills.ts:11`); `discoverSkills` maps pi's skills to those three fields (72), dropping `sourceInfo`. Loaded skills come from `command.sourceInfo` (`runtime/extension.ts:14-22`), whose `scope` is available but not copied. `skillCatalog` strips to `{name, description}` (`child/child-runtime.ts:315-316`); `SkillInfo` (`types/messages.ts:16`), contract `skillCatalog(): SkillInfo[]` (`types/runtime.ts:58`); `tests/child-runtime.test.ts:279-285` asserts the two-field shape with `toEqual`.
- Pi's `SourceScope = "user" | "project" | "temporary"` (PCA `core/source-info.d.ts:2`). With `includeDefaults: false`, as `discoverSkills` calls it, `loadSkills` sets a skill's scope by location only: `user` under `<agentDir>/skills`, `project` under `<cwd>/.pi/skills`, otherwise `path` → `temporary` (PCA `core/skills.js:90-112,368-376`). So `.agents/skills`, `~/.agents/skills`, package and settings-path skills come out `temporary`. The resolved resource from `DefaultPackageManager.resolve` carries `metadata.scope` (`PathMetadata`, PCA `core/package-manager.d.ts:2-13`), the better source. Not yet confirmed by a test.

### Select preselection

- `selectForm` focuses `clampIndex(spec.selected ?? 0, …)` (`platform/ui-kit/select.ts:31`); Enter picks the focused option (`list.ts:64-66`, `select.ts:49-51`); digits pick directly (`list.ts:60-62`); Esc returns `undefined` (`select.ts:36-39`). `listLines` marks the row with `index === selected` (`list.ts:32`), and moves clamp to `[0, count-1]` (`list.ts:55,68-76`), so a focus of `-1` would draw no pointer and move to row 0 on the first ↑/↓. Callers: `ui/agent-view/picker.ts`, `extensions/style/ui/pick.ts`, `extensions/mcp-import/ui/pick.ts`.

### Two forms in a row

- `showForm` awaits `overlaysCleared` before opening (`platform/pi-adapter/ui/form.ts:19`); `menu` already opens the subcommand picker and then the chosen form (`agent-view.ts:191-195`).

### The setup form

- Files: state and keys `ui/agent-setup/form.ts`, lines `ui/agent-setup/setup-render.ts`, factory `ui/agent-setup/setup-overlay.ts:8-33` (`setupForm(context, paths): FormFactory<SetupResult | undefined>`; result `{scope, changes}`, undefined on cancel).
- Shows one agent per tab plus a Submit tab (`form.ts:64` `onSubmitTab`, `260` `tabStep(..., agents.length + 1)`); three fields per tab: model, thinking, skills (`FIELDS`, 34); skills picker is a multi-select over `context.skills` (`form.ts:119-128`, `193-215`).
- `SetupContext = {agents: SetupAgent[], models, skills: SkillInfo[], trusted}` (27-32); `SetupAgent = {name, description, tools, mcp, initial: {model, thinking?, skills}}` (23-25). Built in `agent-setup.ts:61-79` from `definitions.list()`, with `initial` taken from the effective definition (70-74: `skills: definition.skills`, after overrides).
- Prefill: `initial` is both the starting draft (`initialSetup`, `form.ts:57-62`: `drafts: context.agents.map((agent) => agent.initial)`) and the baseline of `changedFields`/`setupChanges` (71-95). The form cannot be opened with drafts that differ from the baseline without a code change. Passing the proposal as `initial` opens it prefilled but then diffs against the proposal, so only the user's further edits come back as patches and an unedited confirm reports "nothing changed" (`agent-setup.ts:99-102`). A small change is needed: an optional `proposed` per agent (or a `drafts` argument to `initialSetup`) with `initial` kept as the baseline; `setup-render.ts` marks changed fields through `fieldChanged` (76-81), so proposed values would show as changed with no render change. The skills picker opens with the draft's names ticked (`form.ts:123-127`); an `all` draft opens with no box ticked and stays `all` unless a box changes (212-214).
- `setupChanges` (`form.ts:83-95`): per agent, the changed fields among `model`, `thinking`, `skills` become an `AgentOverride` patch `{name, patch}`; unchanged agents are skipped. `skills` compares as a set (`sameGrant`, 66-69).
- Project scope in an untrusted project is refused on Submit (`form.ts:227-231`, `UNTRUSTED` 55) and at save (`agent-setup.ts:38-41`). The form scope defaults to project when trusted (`initialSetup` 61).
- `runForm` (`agent-setup.ts:81-105`): outside `tui` it notifies and returns (85-91); otherwise `host.ui.showForm(setupForm(context(info), paths))`, then `save(result.scope, result.changes)`.

### The write path

- `settingsPaths(info)` (`core/model/settings.ts:131-134`): `{project: <cwd>/.pi/pi-subagents.json, user: <agentDir>/pi-subagents.json}`.
- `core/agent-setup/write.ts`: `readObject` (6-15) treats a missing or blank file as `{}`, throws on a non-object; `mergeChanges` (17-33) does `merged[name] = {...existing, ...patch}` per agent and keeps other top-level keys; `writeChanges` (35-46) does `mkdirSync` of the dir, `writeFileSync(JSON.stringify(next, null, 2) + "\n")`, not atomic, no lock, returns an error string `cannot save <path>: ...` instead of throwing; `overriddenFields` (48-68) lists fields the project file also sets.
- `save` (`agent-setup.ts:34-59`): refuses project scope when `!info.projectTrusted` (38-41, error notice "not saved: this project is not trusted ..."), `writeChanges`, `definitions.reload()` (50), then notice `pi-subagents: saved <name (fields), ...> to <path>; agents started from now on use it` (51); when scope is user and the project file also sets a field it warns `<project path> also sets ... and wins` (53-58). `save` is a closure inside the plugin; a tool in the same plugin can call it.
- `definitions.reload()` (`api/plugins/agent-definitions.ts:70-77`) re-reads the settings files then `load(info)`; `list()` (80-81) is sorted by name.
- Shape written (`core/model/agent-schema.ts:9,23`, `Grant = string[] | "all"`): `{ "agents": { "<name>": { "model"?, "thinking"?, "skills"?: ["a","b"] | "all" } } }`; an empty array is a valid value (no skills).

### Agent definitions

- `AgentDefinition = AgentFrontmatter & {thinking?, prompt, source: "builtin"|"user"|"project", path}` (`core/model/agent-record.ts:88-101`); frontmatter carries `name`, `description`, `model?`, `limit`, `tools: Grant`, `skills: Grant`, `subagents: Grant`, `worktree?`, `mcp?` (`core/model/agent-schema.ts:11-21`). Service `{get, list, promptAppend, reload}` (`agent-record.ts:130-135`).
- `list()` returns `description`, `source` and the effective `skills`: overrides are applied by `overridden` (`core/agent-definitions/loader.ts:231-240`, `skills: override.skills ?? definition.skills`, the override replaces the file's list, no union). The raw file list is not kept on the definition; `loadDefinitions` holds it in `fromFiles` (loader.ts:338) for warnings only.
- Unknown-skill rule: `skillsNotice` (194-199) and `checkedOverride` (201-219) set the override's `skills` to undefined when any named skill is not in `runtime.skillNames()` (empty list and `all` are never checked), with warning `agents.<name>.skills names unknown skill(s) ... (available skills: ...); dropped`; the agent then keeps its file list. `loaded` is read once per load (`once`, 221-229; `loadDefinitions` 339-340); an agent file's own unknown skills only warn (`unknownFrontmatterSkills`, 280-296).
- There is no lead-versus-chore field on the definition; the folder is visible only in `path` (see Lead predicate above); the setup form shows read-only `tools` and `mcp` instead (`SetupAgent`). Nine shipped agents ship `skills: []`; only `general` ships `all`.
- `loadDefinitions` dirs (`api/plugins/agent-definitions.ts:42-49`): builtin, `<agentDir>/agents`, `<cwd>/.pi/agents` only when trusted.

### Skill inventory

- `platform/pi-adapter/child/skills.ts`: `SkillFile = {name, description, path}` (11); `discoverSkills` (56-73) resolves through `DefaultPackageManager` over a read-only `SettingsManager` with `!`/`-` entries stripped (17-33) and `loadSkills({includeDefaults: false, skillPaths})`; `mergeSkills` (75-79) puts the main session's loaded skills first, then discovered ones not already named; `createSkillInventory` (81-94) holds `files()` and `scan(scope)`.
- Loaded skills come from `pi.getCommands().filter(source === "skill")` (`platform/pi-adapter/runtime/extension.ts:14-22`), with `description: command.description ?? ""`, so a description can be an empty string from that source; discovered skills always have one because pi refuses to load a skill without it (10-22).
- Scan: only when `skillInventory: true` (`api/extension.ts:19` sets it), on pi's `session_start` (`runtime/extension.ts:45-48`, `scope = {cwd, agentDir, projectTrusted}`), so after a `/reload` and at startup; no other rescan. Skills added during the session do not appear until `/reload`.
- Runtime methods (`platform/pi-adapter/types/runtime.ts:58-60`, impl `child/child-runtime.ts:315-326`): `skillCatalog(): SkillInfo[]` where `SkillInfo = {name: string; description: string}` (`types/messages.ts:16`), mapped from the inventory with `path` dropped; `skillNames()` is its names; `sessionSkillNames()` is only the main session's loaded skills. No source, scope, path or `disableModelInvocation` is exposed, so a skill hidden from the model by `disable-model-invocation` still appears in the catalogue (10-22: it is in `loadSkills` output).
- Spawn picks files by name from the inventory (`child-runtime.ts:143-153`, `pickSkillFiles(parent.inventorySkillFiles(), spec.skills)`, child gets `skillsOverride` filter). `run_agent` caller rules in `ARCHITECTURE.md:52`: a caller may pass only skills of its own effective set.
- Main prompt: `prompts/main-session.md:29` says to pass own skills whose descriptions fit; it does not mention hidden messages, `/agents` or any brief (no `hidden`, `customType` or `create` in the file). Behaviour on a hidden brief rests entirely on the brief text.

### `/agents create` pattern

- `core/agent-setup/create.ts:115-159` (`createAgentCommand({host, template, definitions, runtime})`): parse and check (118-140), then `host.sendHiddenMessage({customType: CREATE_TYPE, text: createBrief(...)})` (142-154) with `CREATE_TYPE = "pi-subagents-create"` (9), then `host.ui.notify("pi-subagents: asked the main session to create the agent; answer its questions, then /reload", "info")` (155-158). Works in any mode, writes nothing.
- Template `prompts/create-agent.md`, read once at enable (`agent-setup.ts:29`, `readFileSync(join(root, "prompts", "create-agent.md"))`, `root` from the plugin context); placeholders `{{command}} {{known}} {{askName}} {{file}} {{taken}} {{skills}} {{lead}} {{chore}}` filled by `input.template.replace(/\{\{(\w+)\}\}/g, ...)` with unknown keys left as-is (`create.ts:100`); skills rendered as `- name: description` lines or `none` (79-80).
- `sendHiddenMessage` (`platform/pi-adapter/runtime/host.ts:402-430`): `HiddenMessage = {customType, text, details?}` (`types/messages.ts:10`); sent as a custom message with `display: false`; if a run is active it is delivered as a follow-up with `triggerTurn: true`, otherwise held and delivered when idle. No-op before a live session.

### Tools and model-only tools

- `registerTool<P, D>(spec: ToolSpec<P, D>)` (`platform/pi-adapter/types/host-capabilities.ts:11`); `ToolSpec = {name, label, description, promptSnippet?, promptGuidelines?, parameters (JSON schema object), executionMode?, modelOnly?, renderShell?, execute(params, {signal?, toolCallId?, update}) => Promise<{text, details?, isError?}>, pendingResult?, renderCall?, renderResult?}` (`types/tools.ts:21-38`). `modelOnly` becomes pi's `exposure: "model-only"` (`platform/pi-adapter/tools/tool-bridge.ts:121`).
- `extensions/questionnaire`: definition with `modelOnly: true`, `executionMode: "sequential"`, JSON-schema `PARAMETERS`, `promptSnippet`, `promptGuidelines` (`core/questionnaire.ts:81-90`, 28-67); tool built in `api/plugin.ts:9-49` as `{...questionnaireDefinition, execute}`. `execute` calls `checkCall(params, () => host.session().mode)` (`api/plugin.ts:15`): outside `tui` it returns the error result `Error: questionnaire needs the interactive terminal; pick a sensible default or ask in prose.` (`core/questionnaire.ts:25-26, 92-102`). It then runs `await host.ui.showForm(factory, {signal})` inside `execute` (`api/plugin.ts:28-37`), wrapped in `awaitingInput(host)(true/false)` which publishes `AWAITING_INPUT_CHANNEL` (`core/questionnaire.ts:104-109`) so other extensions know a dialog is open; returns `{text: resultText(details), details}`, with `cancelled: true` when the form returns undefined (39-41).
- So a tool can open a form from inside `execute`; questionnaire is the only precedent. No tool in `extensions/subagents` opens UI: `showForm`/`openOverlay` appear only in `api/plugins/agent-view.ts` and `api/plugins/agent-setup.ts` (commands). Tools there: `run_agent`, `message_agent`, `handoff`, `agent_status` (`api/plugins/agent-status.ts:74`), `fetch`.
- Session mode: `host.session().mode`, `RunMode = "tui" | "rpc" | "print" | "json"`, in `SessionInfo = {id, file?, cwd, agentDir, projectTrusted, subscription, mode}` (`types/session.ts:1-11`).
- A model-only tool registered at plugin enable is listed in every model request's tool list, not only after the command; a v1 tool should say in `description` that it answers a `/agents setup` skills brief only, and refuse (error result) when no brief is pending.

### Host surface

- `HostUi` (`types/host-ui.ts:51-57`) = `NoticeUi & OverlayUi & WidgetUi & EditorUi & KeysUi & {style}`: `notify(message, level?: "info"|"warning"|"error")`, `setStatus`, `setNotice`, `confirm(title, message): Promise<boolean>`, `terminalNotify`; `openOverlay(factory)`, `showForm<T>(factory, {signal?}): Promise<T | undefined>`; widgets, editor and key helpers.
- Hosts for commands and lifecycle: `registerCommand(name, {description, complete?, run(args, control)})` (`types/messages.ts:4-8`), `onSessionStart(handler(info, parent?))` (`host-capabilities.ts:22`), `session()` (48).
- Notice prefix used everywhere in the plugin: `${NAMESPACE}: ` (`agent-setup.ts:31-32`).

### Project signals

- No helper in the repo lists a directory tree or reads `package.json` dependencies. Nearest: `readText`, `isPlainObject` and `errorText` in `platform/shared/index.ts` (used by `write.ts:3`), `platform/shared/plugin/settings-files.ts` (JSON settings files), and `existsSync`/`statSync` loops in `platform/pi-adapter/child/skills.ts` and `test/architecture.test.ts` (test only, not shippable). A new core helper (cwd basename, `readdirSync` of the root, manifest dependency names) is needed; manifests other than `package.json` (`pyproject.toml`, `Cargo.toml`, `go.mod`) would need their own light parsing.

### Files rule (AGENTS.md)

- `AGENTS.md:18`: every file the extensions write lives under pi's agent dir or session dir, except handoff documents, `worktree: true` checkouts, "and two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` (`/agents setup`) and `.pi/mcp.json` (`/mcp-import ... project apply`, or the interactive `/mcp-import` picker)". A write that a model tool call performs after `/agents setup` and a form confirm is on the user's command in the sense that two explicit user acts precede it; the parenthesis already names `/agents setup`, and one clause should say the write may follow a model tool call (a docs change, `AGENTS.md` and root `ARCHITECTURE.md`). The save keeps the trust check (`agent-setup.ts:38-41`).
- `AGENTS.md:18` also says `/agents create` writes nothing and briefs the main session; `autosetup` differs in that the extension writes, not the main session's write tool.

### Docs and architecture rules

- `test/docs-sync.test.ts:63-77`: any changed or untracked file under `extensions/subagents/` other than its three docs requires changes to `extensions/subagents/README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md`, measured against the merge-base with `origin/main` (`DOCS_SYNC_BASE` overrides). `AGENTS.md` and `future-plans/` are not part of it.
- `test/architecture.test.ts`: extension folder holds only `index.ts`, `api`, `core`, `ui`, `tests`, `prompts`, `agents` and the three docs (127-134, so a new template belongs in `prompts/`); max depth 3 folders (144); `*.test.ts` inside `tests/` (154); a plugin may not import another plugin's `api`/`core`/`ui` (177-183, plugin = basename under `api/plugins/` and folder of the same name under `core/` and `ui/`); relative imports normalised (185); `index.ts` only re-exports `./api/` (210). New code for `autosetup` therefore goes in `core/agent-setup/` and `ui/agent-setup/` and the existing `api/plugins/agent-setup.ts` (no new plugin needed); basenames are unique inside `api/`, `core/`, `ui/` (`STRUCTURE.md` header). Biome's `noRestrictedImports` limits `core/` to `platform/pi-adapter/index.ts` and `platform/shared/index.ts`.

### Tests

- `tests/plugins/agent-setup/`: `agent-setup.test.ts` (plugin: form, one-line and completion suites), `agent-template`, `create`, `form`, `line`, `render`, `write` tests; fixture `tests/support/setup-context.ts` (`context()`, `PATHS`, `press`, `render`; includes a skill with `description: ""`).
- Harness: `tests/support/subagents-harness.ts:69-84` `createHarness([plugins...], {overrides, beforeStart})` returns `{host, runtime, services, root}` with cwd `<root>/project` and agentDir `<root>/agent`; `agent-setup.test.ts:19-49` shows the pattern (`host.info.projectTrusted`, `runtime.skills = [...]`, `host.runCommand("agents", "setup")`, `flushMicrotasks`, `host.form()`).
- Fake host `test/framework/fake-host.ts:130`: `tools` Map (402-403, `host.tool(name).execute(...)`), `hidden: {message, delivery}[]` (440), `notices: {message, level}[]` (264), `forms: FakeForm[]` (296-302), `confirmAnswer` (245, 276-278), `runCommand(name, args)`, `settle()`; `hiddenMessageTexts(host)` (668). Fake form `test/framework/fake-form.ts`: `render(width)`, `press(...keys)`, `type`, `closed`, `result`.
- Fake runtime `test/framework/fake-agent-runtime.ts:137-177`: `skills: string[]`, `skillDescriptions: Record<string, string>` (default `""`), `skillCatalog`, `skillNames`, `sessionSkills`.
- Live tests: `tests/live/*.live.test.ts` (run-agent, nesting, grants, handoff, worktree) using `describeLive` and `createLiveHarness("<name>", {agents})` from `tests/support/live-harness.ts`; `PI_LIVE_MODEL` required.
- Evals: `test/evals/subagents/<subject>/` with `*-cases.ts` and `*.eval.ts` (routing, planner, reviewer, implementer); `routing/main-session-routing.eval.ts` runs one real main session with `mainSessionPrompt` and `recordingTools` from `tests/support/routing-session.ts`, grades with `gradeRun`/`expectPassRate` from `test/framework/eval-runs/`, writes SKILL files to a temp dir (`writeSkill`, 41-60). A proposal eval follows that pattern: a `skill-proposal/` folder with cases (agents, skills, project signals, expected and forbidden assignments), a stub `agent_skills_proposal` tool that records its call, and rubric checks (names valid, chores empty, a plausible skill assigned). `test/evals/README.md` explains `PI_EVAL_RUNS`, results under `.results/`.

### What the v1 design assumes that the code does not give yet

- Prefilled form: not supported without a small change to `ui/agent-setup/form.ts` (`initialSetup`, `SetupAgent`).
- A tool opening a form: supported by the adapter (`showForm` inside `execute`, questionnaire precedent), but no tool in this extension does it and `agent-setup.ts` has no tool registration yet.
- Lead/chore marker: absent on `AgentDefinition`.
- Skill source and `disable-model-invocation`: not in `SkillInfo`; descriptions can be `""` for session-loaded skills.
- Main-session prompt: silent about hidden briefs; the brief must carry the whole instruction (the create brief does the same).
- Directory and manifest reading helper: none.
- `AGENTS.md:18` file rule: wording names `/agents setup` only.

## 2. Pi

### Skill discovery and frontmatter (10-22, from PCA `dist/core/` and `docs/`)

- Locations (`package-manager.js` `addAutoDiscoveredResources` ~L1986-2066; `docs/skills.md`): `<agentDir>/skills`, `~/.agents/skills`, `<cwd>/.pi/skills` (trusted, cwd only), `.agents/skills` in cwd and ancestors up to the git root (trusted), settings `skills` paths, package skills, `--skill`, extension `resources_discover`. No `.claude` path anywhere in `dist/`.
- `Skill` carries `name`, `description`, `filePath`, `baseDir`, `sourceInfo`, `disableModelInvocation`; `SkillFrontmatter` is `{name?, description?, "disable-model-invocation"?, [key]: unknown}`, other keys parsed and dropped (`dist/core/skills.js` `loadSkillFromFile`). `description` is required or the skill is not loaded; name collisions keep the first and warn. This package uses skills exactly as pi finds them and reads no extra keys.
- Precedence (`package-manager.js` L50-70): project settings entry 0, project auto 1, user settings entry 2, user auto 3, package 4; first wins per name.
- Prompt rendering (`skills.js` `formatSkillsForPrompt`, `system-prompt.js` L100-110): `<skills>` with `<available_skills>` and one `<skill><name/><description/><location/></skill>` per skill; emitted only when `read` or `bash` is active; bodies not injected. `/skill:name args` expands to `<skill name location>` plus body (`agent-session.js` L1723-1740). A child agent gets this block from pi for the skills it was given (this package, `ARCHITECTURE.md:42`).

### Extension API points used (10-22 unless stated)

- Hidden messages: `pi.sendMessage(custom, {deliverAs: "followUp", triggerTurn})`, used by the adapter (re-read 10-25, `runtime/host.ts:402-430`).
- Tools: `pi.registerTool` with `exposure: "model-only"` (re-read 10-25, `tool-bridge.ts:121`); tool `execute` receives a context with UI; guard with `ctx.mode === "tui"` / `ctx.hasUI`.
- UI (`ExtensionUIContext`): `notify`, `setStatus`, `setWidget`, `custom`, `select`, `confirm`, `input`, `editor`.
- Events accepted by `pi.on()` (`dist/core/extensions/types.d.ts` L1186-1227) include `project_trust`, `resources_discover`, `session_start` (`reason: "startup"|"reload"|"new"|"resume"|"fork"`), `session_shutdown`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start/end`, `tool_call`, `tool_result`. For completeness only: v1 uses none of them for `autosetup`; the adapter's `session_start` handler (`runtime/host.ts:170`) already rescans skills.
- No `getSkills` API; routes are `pi.getCommands()` (skills as `skill:<name>`), `ctx.getSystemPromptOptions().skills`, and `loadSkills` and `DefaultPackageManager` as exported (this package uses the first and the last two, `skills.ts:56-73`, `extension.ts:14-22`).

### Project identity and trust (10-22)

- Identity is the cwd; `.pi/` is read at `<cwd>/.pi` only (`projectBaseDir = join(cwd, ".pi")`); the git root only bounds the `.agents/skills` walk.
- Trust (`docs/security.md`, `dist/core/project-trust.js`, `trust-manager.js` L151-170): needed when `.pi/{settings.json, mcp.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md}` or any ancestor `.agents/skills` exists; decided by CLI flag, a `project_trust` extension, `~/.pi/agent/trust.json`, `defaultProjectTrust`, or a prompt (tui only). Context files load regardless of trust. This package reads `<cwd>/.pi/pi-subagents.json` only when `info.projectTrusted` (`core/model/settings.ts:141-146`).

## 3. Other tools

- **OpenCode**: `skill({name})` tool whose description lists every skill; per-agent `permission.skill` with `allow`/`ask`/`deny` globs (deny hides from the catalogue), `tools: {skill: false}` removes it. The one surveyed tool with a per-agent skill allowlist, the same shape as this package's `agents.<name>.skills`. https://opencode.ai/docs/skills/
- **Suggest then confirm**: Devin Knowledge suggestions (proposals the user accepts or edits) and JetBrains Junie writing `.junie/AGENTS.md` for review; VS Code `.vscode/extensions.json` `recommendations`, shown as a one-time prompt with a per-item ignore, never installed silently. All keep the user as the one who confirms the write.
- **agentskills.io** client guide: 50 to 100 tokens per skill in the catalogue, hide filtered skills entirely, scan `.agents/skills`, gate project skills on trust. Required `name` (at most 64) and `description` (at most 1,024). https://agentskills.io/specification

## 4. Dropped from scope

- Catalogue metadata keys (`pi-agents`, `pi-match`, signals and globs in SKILL.md frontmatter): v1 uses skills exactly as pi finds them and lets the model judge from name and description.
- Session-start reconcile with a record file, hashes and three-way merge: v1 runs only when the user invokes `/agents setup`; automatic re-runs are "v2, if ever".
- Claude Code seeds (`.claude/skills`, `enabledPlugins`, `relevance` signals, plugin install records, auto-update): no Claude Code files are read.
- Company catalogue and marketplace entries (Codex `policy.installation`, Cursor plugin groups, admin sync): no shared catalogue, only the user's own machine.
- Pi packages and update detection (`pi update`, `checkForAvailableUpdates`, package filters, install dirs): the inventory already includes package skills through `discoverSkills`; nothing here needs to notice a change.
- Pi `skills` settings patterns (`!`, `+`, `-`, `pi config`): the inventory strips exclusions on purpose (`skills.ts:17-33`) and `autosetup` writes only `pi-subagents.json`.
- Glob-based rules and lockfile or reconcile patterns (Windsurf, Continue, Amp globs; mise, Homebrew Bundle, Nix, vercel-labs `skills-lock.json`): no stored state to reconcile.
- Claude Code's per-project state section and survey statistics: nothing persists between runs, so there is no state to compare.
