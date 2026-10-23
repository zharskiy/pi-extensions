# Research: skill autosetup

Facts behind README.md, gathered 2026-10-22. Four sources: this package's code (paths relative to the repo, line numbers as read that day), pi 1.4.0 as installed under `node_modules/@earendil-works/pi-coding-agent` (PCA below), the claude-code-compat research in this folder's sibling, and vendor docs read that day (links given; most carry no publication date).

## 1. What this package has today

### `/agents setup` and the override file

- Plugin: `extensions/subagents/src/plugins/agent-setup/` (index.ts, form.ts, render.ts, line.ts, write.ts; create.ts and agent-template.ts for `/agents create`). Requires `agent-definitions` (index.ts:62). `/agents` routing with `view|create|setup` in `agent-view/index.ts:18`.
- Form context (`agent-setup/index.ts:97-115`): agents from `definitions.list()` with `initial: {model, thinking, skills}`, models from `runtime.availableModels()`, skills from `runtime.skillCatalog()`, `trusted` from `info.projectTrusted`. `setupChanges` (form.ts:83-95) emits only changed fields as `AgentOverride` patches; project scope is refused in an untrusted project (form.ts:229-231, index.ts:74-77).
- One-line form (line.ts:11-14): `/agents setup [<agent> model=… thinking=… skills=<a,b|all|none> scope=<project|user>]`; `skills=` validated by `overrideSkills` and `unknownSkillsProblem(skills, runtime.skillNames())` (line.ts:57-63).
- Save (index.ts:70-95): `settingsPaths(info)` gives `{project: <cwd>/.pi/pi-subagents.json, user: <agentDir>/pi-subagents.json}` (model/settings.ts:131-134); `writeChanges` then `definitions.reload()` then a notice.
- `write.ts`: `readObject` (7-16) treats a missing file as `{}`; `mergeChanges` (18-34) does `merged[name] = {...existing, ...patch}` and returns `{...current, agents: merged}`, so other top-level keys survive; `writeFileSync(JSON.stringify(next, null, 2))`, not atomic, no lock (36-47).
- Shape written (`model/agent-schema.ts:23`, `Grant = string[] | "all"` at line 9):

```json
{ "agents": { "reviewer": { "model": "provider/id", "thinking": "high", "skills": ["docs", "testing"] }, "general": { "skills": "all" } } }
```

### Settings and validation

- `core/manager/settings.ts`: `parseSettings` (74-108) iterates schema keys only, so unknown top-level keys are ignored silently; `readSettingsFiles` (128-136) reads the project file only when `projectTrusted`; `watchSettings` (161-179) re-reads at `onSessionStart`, not a file watcher. ARCHITECTURE.md:58: "Nothing is reloaded live".
- `extensions/subagents/src/model/settings.ts`: `agents` schema entry (126), `parseOverride` (71-90) accepts only `model`, `thinking`, `skills`; `mergeOverrides` (101-107) per agent and per field, project over user; `reloadSettings` (167-191).
- Loader checks (`agent-definitions/loader.ts`): one unknown skill name voids the whole `skills` override for that agent (`checkedOverride` sets `skills: undefined`, 200-218), with `agents.<name>.skills names unknown skill(s) … dropped` (194-199, 201-219); the override replaces the agent file's list, no union (231-240); unknown agent is a warning (269); `runtime.skillNames()` is called once per load (339).
- Session-start order: `extensions/subagents/src/index.ts:16-22` registers settings reload before the extension manager, so settings precede the definitions' own `onSessionStart(load)` (`agent-definitions/index.ts:89`).

### Skill inventory

- `core/adapter/pi-skills.ts:11`: `SkillFile = {name, description, path}`. No source field; pi's `Skill` has `sourceInfo: {path, source, scope: "user"|"project"|"temporary", origin: "package"|"top-level", baseDir?}`, `filePath`, `baseDir`, `disableModelInvocation` (PCA `dist/core/skills.d.ts`, `source-info.d.ts`); `pi-skills.ts:72` maps to `{name, description, path: skill.filePath}` and drops the rest.
- Two sources merged, loaded wins (`mergeSkills`, 75-79): the main session's loaded skills via `pi.getCommands().filter(c => c.source === "skill")` (`pi-adapter.ts:41-49`), and `discoverSkills` (56-73) over a read-only `SettingsManager.fromStorage` with `!`/`-` entries stripped (17-33), packages resolved with missing ones skipped, `loadSkills({includeDefaults: false, skillPaths})`.
- Scan timing: `pi-adapter.ts:495-501` runs `inventory.scan` on pi's `session_start` before the host's own handler (199); every session start including `/reload`; nothing else rescans.
- Consumers: `AgentRuntime.skillCatalog() / skillNames() / sessionSkillNames()` (`core/adapter/contract.ts:424-426`, `pi-child.ts:370-381`); spawn picks SKILL.md paths with `pickSkillFiles(parent.inventorySkillFiles(), spec.skills)` (`pi-child.ts:146-147, 205`).

### How skills reach an agent

- Frontmatter `skills` is required: list, `[]` or `all` (`agent-definitions/fields.ts:44-49`). Shipped: nine agents `[]`, `general` `all` (`agents/*/*.md:7`).
- `run-agent/runner.ts:724-752`: `own` is the caller's skills when the definition says `all`, else the definition's list; the task's `skills` parameter is unioned; a name the caller lacks fails the batch; `read` must be among the agent's tools.
- The child gets `DefaultResourceLoader` with `noSkills: true`, `additionalSkillPaths` and a `skillsOverride` filter (`core/adapter/pi-child.ts:200-216`); pi renders the `<skills>` listing, bodies are read on demand. The agent prompt text itself carries no skills (`agent-definitions/prompt.ts:3-9`).
- Main session: `prompts/main-session.md:29` says to pass own skills whose descriptions fit, chores take none; the main prompt does not enumerate skills, pi's `<skills>` block does. `replaceMainPrompt` keeps `options.sections` and does not touch `options.skills` (`core/adapter/main-prompt.ts:64-74`).

### Agent discovery

- `loadDefinitions(dirs)` (`agent-definitions/loader.ts:298-345`); dirs are builtin `agents/`, `<agentDir>/agents`, `<cwd>/.pi/agents` when trusted (`agent-definitions/index.ts:42-68`, `model/paths.ts:15-17`); later dirs win by name. `AgentDefinition = AgentFrontmatter & {thinking?, prompt, source: "builtin"|"user"|"project", path}` (`model/types.ts:91-98`). Service `{get, list, promptAppend, reload}` (types.ts:126-130).

### Host surface

- `core/adapter/contract.ts:268-300`: `onSessionStart(handler(info, parent?))`, `onSessionShutdown(reason)`, `onIdle`, `onTurnEnd`, `onCompact`, `onAgentStart`, `sendUserMessage`, `sendHiddenMessage({customType, text})`, `dispatchCommand`, `setMainPrompt`, `setPromptSection`, `publish/subscribe`, `appendEntry/readEntries`, `session()`, `registerTool`, `registerCommand(name, {description, complete?, run})`. `SessionInfo = {id, file?, cwd, agentDir, projectTrusted, subscription, mode}` (208-216). The adapter does not expose whether a `session_start` was startup or reload.
- `HostUi` (179-202): `notify(message, level?)`, `setStatus`, `confirm(title, message): Promise<boolean>`, `setWidget`, `openOverlay`, `showForm(factory)`. Multi-select is built over `showForm` with `core/manager/multi-select.ts`; `select.ts` for single choice. `notify` is a no-op without a context; agents have no UI.
- No scheduler; timers exist only in the working indicator, session-limits idle polling, notifications debounce and UI throttles.

### `/agents create` pattern

- `create.ts:115-159`: validate locally, fill `prompts/create-agent.md` (`{{skills}}` as `- name: description` lines), `host.sendHiddenMessage({customType: "pi-subagents-create", text})`, notify "asked the main session to create the agent". The extension writes nothing; the main session's write tool creates the file.

### `questionnaire`

- `extensions/questionnaire/src/questionnaire.ts:73-85`: tool `questionnaire`, `modelOnly: true`, single-choice per question with optional typed answer, tui only (`NOT_INTERACTIVE` otherwise), no multi-select type.

### File rules

- AGENTS.md:16: every file the extensions write lives under pi's agent dir or session dir, except handoff documents, worktree checkouts, and two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` and `.pi/mcp.json`. `test/architecture.test.ts` enforces import and layout rules. User-level settings files follow `<agentDir>/pi-<extension>.json`.

### Tests

- `extensions/subagents/test/plugins/agent-setup/`: agent-setup.test.ts (form, one-line, completion suites; `createHarness([...], )` with `host.info.projectTrusted`, `runtime.skills`), form/line/render/write/create tests, `setup-context.ts` fixture. Fakes: `core/test/helpers/fakes.ts` (`createFakeHost`: `notices`, `hidden`, `forms`, `confirmAnswer`, `runCommand`, `settle`; `createFakeRuntime`: `skills`, `skillDescriptions`, `sessionSkills`), `fake-form.ts`. Harness writes real JSON under temp `cwd/.pi` and `agentDir`.

## 2. Pi 1.4.0

### Skill discovery and frontmatter

- Locations (`PCA/dist/core/package-manager.js` `addAutoDiscoveredResources` ~L1986-2066; `docs/skills.md`): `<agentDir>/skills`, `~/.agents/skills`, `<cwd>/.pi/skills` (trusted, cwd only), `.agents/skills` in cwd and ancestors up to the git root (trusted), settings `skills` paths, package skills, `--skill`, extension `resources_discover`. No `.claude` path anywhere in `dist/`.
- `Skill` carries only `name`, `description`, `filePath`, `baseDir`, `sourceInfo`, `disableModelInvocation`; `SkillFrontmatter` is `{name?, description?, "disable-model-invocation"?, [key]: unknown}`, other keys parsed and dropped (`dist/core/skills.js` `loadSkillFromFile`). `description` required or the skill is not loaded; name collisions keep the first and warn. Docs list the portable fields `license`, `compatibility`, `metadata`, `allowed-tools`.
- Precedence (`package-manager.js` L50-70): project settings entry 0, project auto 1, user settings entry 2, user auto 3, package 4; first wins per name.
- `skills` setting: `string[]`; `!glob` excludes, `+path` force-includes, `-path` force-excludes (`docs/settings.md` "Resources"; `isEnabledByOverrides` L523, `applyPatterns` L548). Read from code: user auto skills are filtered by user settings only, project auto skills by project settings only; a pattern-only project list adds nothing. `pi config [--local]` is a TUI that writes these per scope. No `disabledSkills` key. `--no-skills` disables discovered and configured skills for one run.
- Prompt rendering (`skills.js` `formatSkillsForPrompt`, `system-prompt.js` L100-110): header, then `<available_skills>` with `<skill><name/><description/><location/></skill>` per skill, wrapped in `<skills>`; emitted only when `read` or `bash` is active; bodies not injected. `/skill:name args` expands to `<skill name location>` plus body (`agent-session.js` L1723-1740).

### Packages

- Commands: `pi install <source> [-l]`, `pi remove`, `pi update [target] [--self|--extensions|--models|--all|--extension <source>] [--force]`, `pi list`, `pi config [--local]`, `pi -e <source>` (`docs/cli.md`, `dist/package-manager-cli.js`). Sources `npm:`, `git:host/path@ref`, URL, local path. Git identity is the repo URL without ref.
- Install dirs (`package-manager.js` L1730-1815): user git `<agentDir>/git/<host>/<path>`, project git `<cwd>/.pi/git/<host>/<path>`, npm under `npm/node_modules`.
- Settings shape (`docs/packages.md`, `dist/core/settings-schema.js` L118-130): `packages: [ "npm:…", { source, extensions?, skills?, prompts?, themes?, autoload? } ]`; filters narrow the manifest with `[]`, `!`, `+`, `-`; `autoload: false` on a project entry acts as a filtering delta over the personal package. Manifest is `package.json` `pi: {extensions, skills, prompts, themes}`; four resource types, no agents. Project packages need trust; missing project packages install on load unless `PI_OFFLINE`.
- Updates: `pi update --extensions` reconciles git checkouts and installs newer unpinned npm versions (`package-manager.js` L833-912). No auto-update. Interactive startup runs `checkForAvailableUpdates()` asynchronously (`interactive-mode.js` ~L836-851, L926, L3790): git compares local HEAD to remote upstream, skips local and pinned, shows a "Package Updates Available … Run `pi update --extensions`" box. `PI_OFFLINE` disables it.

### Extension API

- Events accepted by `pi.on()` (`dist/core/extensions/types.d.ts` L1186-1227) include `project_trust`, `resources_discover`, `session_start` (`reason: "startup"|"reload"|"new"|"resume"|"fork"`), `session_shutdown`, `before_agent_start` (mutable `systemPromptOptions.skills`), `agent_start`, `agent_end`, `agent_settled`, `turn_start/end`, `tool_call`, `tool_result`. Startup order: `project_trust`, `session_start`, `resources_discover`. Docs: start long-lived resources from `session_start`, not the factory.
- `resources_discover` returns `{skillPaths?, promptPaths?, themePaths?}`; entries get `{source: <extension label>, scope: "temporary", origin: "top-level"}`; settings filters and `--no-skills` do not apply; re-fires on `/reload`.
- UI (`ExtensionUIContext`): `notify`, `setStatus`, `setWidget`, `custom`, `select`, `confirm`, `input`, `editor`; guard with `ctx.mode === "tui"` / `ctx.hasUI`.
- No `getSkills` API; routes are `pi.getCommands()` (skills as `skill:<name>`), `ctx.getSystemPromptOptions().skills` in command handlers, `event.systemPromptOptions.skills` in `before_agent_start`. `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`, `DefaultResourceLoader`, `DefaultPackageManager`, `SettingsManager`, `getAgentDir` are exported.
- State: `pi.appendEntry(customType, data)` for durable data outside model context; docs say "data outside one session" is external storage; no per-extension state-dir helper.

### Project identity and trust

- Identity is the cwd; `.pi/` is read at `<cwd>/.pi` only (`projectBaseDir = join(cwd, ".pi")`); the git root only bounds the `.agents/skills` walk. Sessions live under `~/.pi/agent/sessions/--<cwd with / replaced by ->--/` (`session-manager.js` L290-295, `docs/session-format.md`).
- Trust (`docs/security.md`, `dist/core/project-trust.js`, `trust-manager.js` L151-170): needed when `.pi/{settings.json, mcp.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md}` or any ancestor `.agents/skills` exists; decided by CLI flag, a `project_trust` extension, `~/.pi/agent/trust.json`, `defaultProjectTrust`, or the prompt (tui only). Context files load regardless of trust.

### Agents and skill tools in pi core

- No native subagent or agent-file concept; the only one is `examples/extensions/subagent/`. No `skill` tool; `tool_search` covers deferred tools, not skills. Built-in tools: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`.
- Version 1.4.0 (2026-10-21). Changelog entries touching skills or packages since 1.0: 1.2.0 `~` expansion in `!`/`+`/`-` entries; 1.0.4 skills hint no longer names hidden tools; 1.0.0 `quietStartup: "header"`. Nothing adds `.claude/skills` or a disabled-skills key.

## 3. Claude Code's per-project state (from claude-code-compat/research.md and vendor docs)

- Skills: enterprise, `~/.claude/skills`, `.claude/skills` walked up to the repo root, nested dirs loaded on first touch, plugin skills namespaced `/plugin:skill`. Description plus `when_to_use` always in context, listing cut at 1,536 chars; `paths:` globs limit auto-loading (zero real uses in the 1,029-file survey); `disable-model-invocation` and `user-invocable`; unknown fields ignored. https://code.claude.com/docs/en/skills
- Plugin enabling: `enabledPlugins: {"name@marketplace": true}` in `.claude/settings.json` (project), `.claude/settings.local.json` (local, wins), `~/.claude/settings.json` (user), managed highest. A project entry with an external source is not fetched automatically; the user runs `claude plugin install … --scope project`. `extraKnownMarketplaces` applies only after workspace trust. https://code.claude.com/docs/en/plugins/install, …/plugins/loading, …/plugins/org
- Install record: `~/.claude/plugins/installed_plugins.json` `{"version":2,"plugins":{"name@mkt":[{scope, installPath, version, installedAt, lastUpdated, gitCommitSha?}]}}`; `cache/<mkt>/<plugin>/<version>/`, `marketplaces/<name>/`, `known_marketplaces.json`. A local-directory marketplace loads in place and the cache copy can be stale (compat research L201, L203).
- Auto-update: off by default for third-party marketplaces, per-marketplace opt-in, random delay up to 10 min after the first message, running session keeps what it loaded, notice `Plugin updated: <name> · Run /reload-plugins`; change detected by `plugin.json` version, then entry version, then commit SHA. https://code.claude.com/docs/en/plugins/host-marketplace
- Reconciliation: top-level `renames` map in `marketplace.json` (`"old": "new"`, `"old": null`) rewrites `enabledPlugins` keys in all scopes with a one-time notice; `forceRemoveDeletedPlugins: true` uninstalls removed plugins and lists them under "Flagged". No deprecation state.
- Relevance: a plugin entry may carry `relevance: {topic, signals: {cli, filesRead, cwd, manifestDeps: [{file, pattern}]}}`; matching is local, never auto-installs, surfaces as a tip, a session-start line and a Discover entry; throttled to once per 3 sessions, 2 notices total, stops once installed; gated by a managed `pluginSuggestionMarketplaces` list. https://code.claude.com/docs/en/plugins/relevance
- Subagent files: `.claude/agents/*.md` and plugin `agents/*.md` with `skills:` preloading full bodies (first 32), `tools`, `model`, and fields this package ignores (compat research L57, L187).
- Survey (compat research L107-L113): `metadata`, `paths`, `context`, `agent`, `model`, `hooks` have zero real uses in 1,029 files; `allowed-tools` common in plugin commands; no per-stack classification exists in the corpus.

## 4. Other tools

- **Codex CLI**: `.agents/skills` up to the repo root, `~/.agents/skills`, `/etc/codex/skills`; implicit invocation by description, disabled per skill via `agents/openai.yaml` `policy.allow_implicit_invocation: false`, per machine via `[[skills.config]] path enabled=false` in `~/.codex/config.toml`; plugins enabled with `[plugins."name@marketplace"] enabled = true`, repo `.codex/config.toml` for trusted projects; marketplace entries carry `policy.installation` (`AVAILABLE`, `INSTALLED_BY_DEFAULT`, `NOT_AVAILABLE`); admin sync daily, removed entries marked "No longer in source" but kept. https://learn.chatgpt.com/docs/build-skills, https://developers.openai.com/codex/plugins/build
- **agentskills.io**: required `name` (≤64) and `description` (≤1,024); optional `license`, `compatibility` (≤500), `metadata` (string to string, "reasonably unique keys"), `allowed-tools`. No registry, version or update spec. Client guide: 50 to 100 tokens per skill in the catalogue, hide filtered skills entirely, scan `.agents/skills`, gate project skills on trust. https://agentskills.io/specification
- **Cursor**: rules `.cursor/rules/*.mdc` with `description`, `globs`, `alwaysApply` (Always, Apply Intelligently, Specific Files, Manual); skills from `.agents/skills`, `.cursor/skills`, `.claude/skills`, `.codex/skills` with `paths` and `disable-model-invocation`; plugins with per-plugin Default Off / Default On / Required by group, auto refresh at most every 10 min. https://cursor.com/docs/context/rules, …/skills, …/plugins
- **GitHub Copilot**: `.github/instructions/*.instructions.md` with `applyTo` globs and `excludeAgent`; skills from `.github/skills`, `.claude/skills`, `.agents/skills`, `~/.copilot/skills`. `gh skill install --scope project|user --pin` writes source-tracking metadata into SKILL.md frontmatter; `gh skill update [--dry-run --force --unpin]` compares local tree SHA with remote, skips pinned and locally modified skills. https://cli.github.com/manual/gh_skill_update
- **OpenCode**: `skill({name})` tool whose description lists every skill; per-agent `permission.skill` with `allow`/`ask`/`deny` globs (deny hides from the catalogue), `tools: {skill: false}` removes it; `metadata: {"opencode/autoinvoke": "false"}` hides from the list. The one surveyed tool with a per-agent skill allowlist. https://opencode.ai/docs/skills/
- **Glob-based rules elsewhere**: Windsurf `trigger: glob|always_on|model_decision|manual`; Continue `globs` plus `regex`; Amp `globs` on files referenced from AGENTS.md. **Suggest then confirm**: Devin Knowledge suggestions, JetBrains Junie writing `.junie/AGENTS.md` for review.
- **Reconcile patterns**: VS Code `.vscode/extensions.json` `recommendations` with a one-time prompt and per-item ignore; mise `mise.toml` over `mise.local.toml` with `mise.lock` and `mise lock --bump --dry-run`; Homebrew Bundle `check` / `install` / `cleanup --force` / `dump`, no lockfile; Nix `flake.lock` moves pins only on explicit update; vercel-labs `skills` CLI `skills-lock.json` with `computedHash` per skill folder and a global `dismissed.findSkillsPrompt`.
