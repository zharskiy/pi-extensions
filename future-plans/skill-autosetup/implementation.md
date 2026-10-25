Shipped on branch `feat/agent-skill-autosetup`; the text below is the plan as built, corrected where the build differed.

# Implementation: skill autosetup, release 1

What it takes to build release 1 as specified in README.md (R1 to R6): the bare `/agents setup` proposes each lead's skills. Read on 2026-10-25 against the working tree of branch `feat/style-concise-default`. Paths are under `extensions/subagents/` unless they start with `platform/`, `test/`, `node_modules/` (PCA = `node_modules/@earendil-works/pi-coding-agent/dist`), `biome.json` or `AGENTS.md`. Facts in research.md §1 are cited, not repeated. Evals are out of scope.

## 1. Reused as-is

- **Routing**: `/agents setup` → `runSetupWord` (`api/plugins/agent-view.ts:161-173`) → `service.run(args)` (`api/plugins/agent-setup.ts:134-141`): empty args → `runForm`, else `runLine`. The menu's `setup` entry goes the same way (`agent-view.ts:185-196`). No change to `agent-view.ts`, `ui/agent-view/picker.ts`, the service type or `core/agent-setup/line.ts`.
- **`runForm`** (`agent-setup.ts:81-105`): tui check (85-91), `showForm(setupForm(...))` (93), "nothing changed" (99-102), `save` (104). The new entry step goes between 91 and 93.
- **`save(scope, changes)`** (`agent-setup.ts:34-59`): trust check, `writeChanges`, `definitions.reload()` (50), notice (51), shadow warning (53-58). Reused with a return value and an optional `/new` suffix (section 2).
- **`context(info)`** (`agent-setup.ts:61-79`), **`settingsPaths`** (`core/model/settings.ts:131-134`), **`writeChanges`/`mergeChanges`** (`core/agent-setup/write.ts:17-46`), **`setupForm`** (`ui/agent-setup/setup-overlay.ts:8-33`), **`setupChanges`/`changedFields`/`fieldChanged`/`sameGrant`** (`ui/agent-setup/form.ts:66-95`): diff drafts against `agent.initial`, so a proposed draft with `initial` kept as baseline shows `(changed)` (`setup-render.ts:76`) and a done tab (`setup-render.ts:235-238`) with no render change.
- **Loaded overrides**: the plugin context carries the live `settings` (`api/plugins/fetch-tool.ts:58`, `agent-definitions.ts:14,51`); `settings.agents` is the user file merged with the project file, the project only when trusted (`settings.ts:141-147,154-156`), refreshed in place by every `reloadSettings` (`settings.ts:173-177`), i.e. session start and `definitions.reload()`.
- **`host.sendHiddenMessage`** (`platform/pi-adapter/runtime/host.ts:402-430`), as `createAgentCommand` uses it (`core/agent-setup/create.ts:142-154`).
- **Two forms in a row**: `showForm` waits for open overlays to clear (`platform/pi-adapter/ui/form.ts:19`); `menu` already chains a picker and the next form (`agent-view.ts:191-195`).
- **Tool that opens a form**: questionnaire (`extensions/questionnaire/api/plugin.ts:9-49`, `core/questionnaire.ts:81-109`): mode check, `AWAITING_INPUT_CHANNEL` published around `showForm(factory, {signal})`, `undefined` = cancel. A tool's `execute` captures the live ctx first (`platform/pi-adapter/tools/tool-bridge.ts:125-132`), so `host.ui.showForm` works from a tool here too.
- **`registerTool` / `ToolSpec`** (`platform/pi-adapter/types/tools.ts:21-38`; `modelOnly` → `exposure: "model-only"`, `tool-bridge.ts:121`); this extension already registers a main-session tool at enable (`api/plugins/agent-status.ts:70-82`). Children never get it: `childExclude: [root]` (`api/extension.ts:20`, `platform/pi-adapter/child/child-runtime.ts:102-106`).
- **Fresh instance per session**: pi builds a new extension instance on `/new`, `/resume`, `/fork`, `/reload` (`platform/pi-adapter/ARCHITECTURE.md:18`), so an in-memory mark is reset with the session; `onSessionStart` clearing is belt and braces (RPC fires it twice, same line).
- **Helpers**: `cutChars` (`core/components/receipt.ts:132`, shared core, no plugin owns `components`); `readText` (`platform/shared/index.ts`, as `write.ts:3` uses it); `grantText` (`core/model/agent-record.ts:87`, renders `[]` as `""`).
- **Fakes**: `createHarness` (`tests/support/subagents-harness.ts`); fake host `tools`/`tool(name)` (`test/framework/fake-host.ts:403,548-556`), `hidden` (440), `published` (452-457), `forms`/`form()` (204-206, 296-303), `notices`, `info.mode`, `settle()`; fake runtime `skills`, `skillDescriptions` (`test/framework/fake-agent-runtime.ts:171-174`); form fixture `tests/support/setup-context.ts`.

## 2. Changed

### Adapter: `scope` and `path` on the inventory

- `SkillInfo` (`platform/pi-adapter/types/messages.ts:16`) becomes `{name, description, scope: "project" | "user" | "temporary", path}`; `SkillFile` (`child/skills.ts:11`) gains `scope`. The runtime contract stays one method: `skillCatalog(): SkillInfo[]` (`types/runtime.ts:58`) now carries `path` instead of stripping it (`child/child-runtime.ts:315-316`); no new method needed.
- Loaded skills: `sessionSkillFiles` (`runtime/extension.ts:14-22`) adds `scope: command.sourceInfo.scope`.
- Discovered skills: do not use `skill.sourceInfo.scope` from `loadSkills`. With `includeDefaults: false` pi marks a skill `user` only under `<agentDir>/skills`, `project` only under `<cwd>/.pi/skills`, and everything else (`.agents/skills`, `~/.agents/skills`, packages, settings paths) `temporary` (PCA `core/skills.js:90-112,368-376`). The resolved resource carries the real scope (`PathMetadata.scope`, PCA `core/package-manager.d.ts:2-13`). `discoverSkills` (`child/skills.ts:56-73`) keeps `skillFilePath(resource) → resource.metadata.scope` and gives each loaded skill the scope of the resource whose path equals or contains `skill.filePath`; none found → `project` when the path is under the cwd, else `user`.
- Verification step (before relying on `[project]`): an adapter test with a temp project holding `.agents/skills/x/SKILL.md` and `.pi/skills/y/SKILL.md`, a temp agent dir with `skills/z`, asserting `project, project, user`; plus one manual `/agents setup` in a real project with a package skill.
- Breaks: `tests/child-runtime.test.ts:279-285` (`toEqual` on the catalogue), `tests/skills.test.ts` fixtures, `test/framework/fake-agent-runtime.ts:173` (add `skillScopes`/`skillPaths` maps, default `user` and `/skills/<name>/SKILL.md`), `test/framework/pi/live/live-runtime.ts` and `live-extension.ts` (use `SkillInfo` directly). The create brief and the form ignore the new fields.

About 25 lines, 4 tests.

### ui-kit: `selectForm` without preselection

Today `selected = clampIndex(spec.selected ?? 0, …)` (`platform/ui-kit/select.ts:31`) and Enter picks `selected` (`list.ts:64-66` via `select.ts:49-51`). Smallest mode: `SelectSpec.unfocused?: boolean`.

- `let selected = spec.unfocused ? -1 : clampIndex(spec.selected ?? 0, spec.options.length);`
- In `handleKey`, ignore a pick at `-1`: `if (step.pick && step.index < 0) return;`.
- Nothing else: `listLines` marks a row by `index === selected` (`list.ts:32`), so `-1` draws no pointer; `listKey` moves `-1` to `0` on ↓/↑/Home (`clampIndex`, `list.ts:55,68-76`) and digits pick directly (60-62); Esc stays `undefined` (`select.ts:36-39`).

About 4 lines, 4 tests in `platform/ui-kit/tests/select.test.ts`.

### `api/plugins/agent-setup.ts`

The tool must live in this file: every file under `api/plugins/` is a plugin to `test/architecture.test.ts:86-96`, so another file importing `core/agent-setup/` would fail the cross-plugin rule (177-183).

1. **Entry in `runForm`**, after the tui check (91), before `showForm` (93):
   ```ts
   if (!hasSkillsOverride(settings.agents)) return startAutosetup();
   const choice = await host.ui.showForm(selectForm({ title: PROPOSE_TITLE, options: YES_NO, unfocused: true }));
   if (choice === undefined) return;          // Esc: nothing
   if (choice === "yes") return startAutosetup();
   // "no": the plain form, as today
   ```
   `hasSkillsOverride(agents) = Object.values(agents).some((o) => o.skills !== undefined)` (core, section 3). It reads the loaded `settings.agents` instead of the files: same files, same trust rule, no new read. A hand edit since the last session start or save is seen after `/reload`. `api` may import `selectForm` from ui-kit (as `ui/agent-view/picker.ts:2` does; api is not restricted from ui-kit).
2. **`startAutosetup()`**: `candidates = candidateSkills(runtime.skillCatalog())` (interactive filter, section 3); `leads = definitions.list().filter(isLead)`; no leads → notice `no lead agents to set up` and stop; brief `autosetupBrief(...)`; `host.sendHiddenMessage({customType: AUTOSETUP_TYPE, text})`; `pending = {candidates}` (the candidate names validated later); notice `asked the main session to propose agent skills; the form opens when it answers` plus `; left out, interactive: a, b` when any. About 25 lines.
3. **`save` returns an outcome and takes a suffix**: `save(scope, changes, {fresh = false} = {}): {path, text} | {error}`. Notice 51 becomes `saved … to <path>; agents started from now on use it` + (`fresh` ? `; start a new session with /new to release the tokens spent on the setup` : ``). Only the tool passes `fresh: true`; the plain form and the line form keep today's text (R3 ties the line to the autosetup save). About 8 lines.
4. **`context(info, proposal?)`**: each proposed lead gets `proposed: {...initial, skills: list}` and `note` (reasons line); `SetupContext.project = proposal.project`. About 8 lines.
5. **Pending mark**: `let pending: {candidates: string[]} | undefined`; set in `startAutosetup`, cleared when the tool finishes (confirm, cancel, nothing to change, save failure) and in `host.onSessionStart`; kept across a validation refusal (R6). 4 lines.
6. **The tool**: `host.registerTool({...proposalDefinition, execute})`:
   - not pending → `Error: no proposal is pending; the user must run /agents setup first.`
   - mode not tui → error (defensive; `runForm` already refuses outside tui).
   - `checkProposal(params, definitions.list(), pending.candidates)` errors → error result, mark kept.
   - no difference from current lists → `Nothing to change: the proposal matches the current lists.`, mark cleared, no form.
   - publish `AWAITING_INPUT_CHANNEL` (`source: "pi-subagents"`, `title: "agent skills"`) around `showForm(setupForm(context(info, proposal), settingsPaths(info)), {signal})`.
   - `undefined` → `Cancelled by the user; nothing was saved.`; empty changes → `The user confirmed without changes; nothing was saved.`; else `save(scope, changes, {fresh: true})` → success text (below) or `isError` with the error.
   - `executionMode: "sequential"`.
   About 45 lines.

Plugin grows from 149 to about 250 lines; the result texts live in `core/agent-setup/proposal.ts`, `execute` stays here (it closes over `save`, `context`, `pending`).

### `ui/agent-setup/form.ts`

- **Proposal draft**: `SetupAgent` gains `proposed?: Draft` and `note?: string`; `SetupContext` gains `project?: string`; `initialSetup` drafts `agent.proposed ?? agent.initial` (57-58). `initial` stays the baseline. Optional fields, so `setup-overlay.ts:11`, `form.test.ts` and `render.test.ts` callers compile unchanged.
- **Picker order** (all uses of the form): today positions are `context.skills` indexes (`openPicker` 123-127, `chooseSkills` 210). Hold the order in the picker:
  ```ts
  type SkillsPicker = { field: "skills"; multi: MultiState; order: number[]; touched?: boolean };
  // openPicker: the draft's names in list order, then the rest in inventory order
  const listed = named.flatMap((name) => { const i = context.skills.findIndex((s) => s.name === name); return i < 0 ? [] : [i]; });
  const order = [...listed, ...context.skills.keys()].filter((i, at, all) => all.indexOf(i) === at);
  initialMulti(order.length, order.map((_, position) => position < listed.length));
  // chooseSkills: position → inventory index → name; written in display order
  checkedIndexes(picker.multi).flatMap((position) => context.skills[picker.order[position] ?? -1]?.name ?? []);
  export const pickerSkills = (context, picker) => picker.order.flatMap((i) => context.skills[i] ?? []);
  ```
  `multiKey` only moves the cursor and flips `checked[position]`, so rows never move while open. The confirmed list is written in display order, i.e. the proposal's order (R3). An `all` draft opens with nothing ticked, in inventory order. About 12 lines.
- **Scope**: `scopeOptions(context) = context.trusted ? SCOPES : ["user"]`; `initialSetup` scope `0` always (61); `submitKey` (227-238) steps over `scopeOptions(context).length` and loses the `UNTRUSTED` refusal (227-231, constant 55), now unreachable (remove it; `save` keeps its trust check, `agent-setup.ts:38-41`); `setup-overlay.ts:26` returns `scopeOptions(context)[state.scope] ?? "user"`. About 8 lines.

### `ui/agent-setup/setup-render.ts`

- Picker rows and detail line through `pickerSkills` (124, `skillDetail` 95-112 takes the picker).
- `infoLines` (141-156): `Proposed:` line when `agent.note` is set.
- `submitLines` (178-206): a `Project:` line when `context.project` is set; scopes from `scopeOptions`; when untrusted, a line under `Save to:`: `This project is not trusted, so pi does not read its .pi/pi-subagents.json; the user file applies to every project.` (replaces the `(project not trusted)` suffix, 194).
About 12 lines.

## 3. New

### `core/agent-setup/autosetup.ts` (entry facts, filters, brief; mirrors `create.ts`)

- `AUTOSETUP_TYPE = "pi-subagents-autosetup"`.
- `isChore(relativePath)`: a directory segment of the path relative to the agents dir the file was loaded from is `chores`: `relativePath.split(/[\\/]/).slice(0, -1).includes("chores")` (both separators, so a Windows path works). `isLead(definition)`.
- The relative path is stored, not recomputed: `parseDefinition` records `relativePath` from the agents dir it loads from, and `isLead(definition)` is a pure check on the definition (`definition.skills !== "all"` and not `isChore(definition.relativePath)`). The loader walks subfolders (`markdownFiles`, `loader.ts:163-178`), so a user or project agent under `<agents dir>/chores/` is a chore. Shipped: implementer, planner, reviewer are leads; general is out by `skills: all`; the six files in `agents/chores/` are chores.
- `hasSkillsOverride(agents: AgentOverrides)`.
- `INTERACTIVE_TERMS = ["AskUserQuestion", "questionnaire", "ask the user", "ask_user", "confirm with the user"]`; `isInteractive(text)` case-insensitive substring; `candidateSkills(catalog): {candidates: SkillInfo[], interactive: string[]}` reads each `path` and matches the body only (the text after the closing `---` of the frontmatter). Unreadable file → kept (pi listed it); each SKILL.md is read with the shared `readText`. The read lives in core: core may use `node:fs` and `platform/shared` (`create.ts:1`, `write.ts:1-3`; `biome.json:621` limits core to the adapter and shared indexes, not fs).
- `projectListing(cwd, limit = 60)`: `readdirSync` withFileTypes, sorted, dirs suffixed `/`, `.git` and `node_modules` skipped, `… and N more`, read error → `(cannot list: …)`. Stays in the plugin's core: one caller (`platform/shared/STRUCTURE.md:3` would admit it).
- `leadLines(leads)`: `- name: description | tools: … | skills: … or none`. `skillLines(candidates)`: `- name [project]: description` (`[project]` only for `scope === "project"`), description cut at 200 with `cutChars`, empty → `- name (no description)`.
- `autosetupBrief({template, cwd, trusted, listing, leads, candidates})`: fills placeholders; nothing about chores or `all` agents.

About 90 lines.

### `core/agent-setup/proposal.ts` (tool definition, validation)

- `PROPOSAL_TOOL = "agent_skills_proposal"`; `ProposalParams = {project: string; assignments: Record<string, string[]>; reasons?: Record<string, string>}`.
- `proposalDefinition` (`Pick<ToolSpec, …>` as `extensions/questionnaire/core/questionnaire.ts:69-90`): label `Agent skills proposal`; description `Answer a skills brief from /agents setup: the project kind and up to five skills per lead agent, most useful first. Only valid right after that brief; opens a form the user confirms.`; no `promptSnippet`/`promptGuidelines`; `executionMode: "sequential"`; `modelOnly: true`; parameters (plain JSON schema as `api/plugins/fetch-tool.ts:33-38`):
  ```ts
  { type: "object",
    properties: {
      project: { type: "string", description: "One line: what kind of project this is." },
      assignments: { type: "object", description: "Lead name to its full list, most useful first, at most five; [] for none.",
        additionalProperties: { type: "array", items: { type: "string" }, maxItems: 3 } },
      reasons: { type: "object", description: "Skill name to one line saying why it fits.", additionalProperties: { type: "string" } } },
    required: ["project", "assignments"], additionalProperties: false }
  ```
- `checkProposal(params, definitions, candidates)` → `{proposal: {project, lists, notes}} | {errors}`: empty `project`; empty `assignments`; unknown agent `no agent named "x"`; not a lead (`isChore` path or `skills: all`) `x is not set up here`; skill not a candidate (unknown or filtered) `no skill named "y" here`; more than five `x: at most five skills`. Duplicates dropped, order kept; reasons for skills not proposed ignored. Errors list every problem, then the lead names and candidate names once.
- `proposalChanges(lists, definitions)` (order-free, as `sameGrant`) for "nothing to change"; `noteFor(list, reasons)` cut at 200.
- Result texts: success `Saved to <path>: implementer skills [a, b]; reviewer skills [c]. Agents started from now on use them. Tell the user, and suggest they start a new session with /new to release the tokens spent on the setup.` (plus the shadow warning); cancel and nothing-to-change carry no `/new` line.

About 90 lines. No chore list, no lead/chore data in any text; the only distinction is `isLead`.

### `prompts/autosetup-skills.md`

Read once at enable next to `create-agent.md` (`agent-setup.ts:29`); placeholders filled as in `create.ts:100`: `{{project}}` (basename and path), `{{listing}}`, `{{scope}}` (project and user, or user only and that it applies to every project), `{{leads}}`, `{{skills}}`. Outline (README R2):

1. The user ran `/agents setup`; do this yourself, do not start agents.
2. Project `{{project}}`, entries `{{listing}}`; read a manifest or the tree with your own tools if needed.
3. Rules in order: (1) say in one line what kind of project this is (frontend, backend, QA automation, devops, library, mixed…); (2) per lead pick the skills that fit its job here, at most five, most useful first; (3) prefer `[project]` skills; prefer fewer; a skill fits when its description names the lead's job or this stack; keep a current skill only if it still fits; (4) full lists, not deltas; (5) never a skill whose description implies asking the user.
4. Answer: call `agent_skills_proposal` once with `{project, assignments, reasons}`, only leads whose list changes; no file writes; do not run `/agents setup`; on an error result fix the names and call again; afterwards tell the user what was saved, from the result.
5. `Leads:` `{{leads}}`. 6. `Skills:` `{{skills}}`.

About 30 lines. A test asserts it names `PROPOSAL_TOOL` and leaves no `{{`.

### Tests

- `platform/pi-adapter/tests/skills.test.ts`: discovered scope from the resource (`.agents/skills` → project, agent dir → user), fallback by path, loaded skills' scope from `sourceInfo`. `child-runtime.test.ts:279`: catalogue with `scope` and `path`.
- `platform/ui-kit/tests/select.test.ts`: `unfocused`: no pointer drawn, Enter does nothing, ↓ then Enter picks the first, digit picks, Esc → `undefined`.
- `tests/plugins/agent-setup/autosetup.test.ts` (new): `isChore`/`isLead` on relative paths: `chores/scout.md` (chore), `leads/reviewer.md` (lead), `mine.md` at the top of the user dir (lead), `chores/mine.md` in the user dir (chore), `chores\\mine.md` (chore), `chores.md` (not a chore), `skills: all` (not a lead); `agentsDirOf` + `relative` for each source, including an agents dir that itself sits under a folder named `chores` (its agents are leads); `hasSkillsOverride`; interactive filter (each term, case-insensitive, body only so a term in the frontmatter alone does not count, unreadable kept, report); brief: leads only, no chore or `general` name in the text, `[project]` mark, empty description, cut at 200, no `{{`; `projectListing` on a temp dir.
- `tests/plugins/agent-setup/proposal.test.ts` (new): each refusal and all at once; four skills refused; a chore-path agent and `general` → "not set up here", with no word about chores; filtered skill refused; order kept, duplicates dropped; `proposalChanges`; `noteFor`.
- `form.test.ts` / `render.test.ts` (extend; `proposedContext()` in `setup-context.ts`): proposed draft marked changed, `setupChanges` patch; picker opens with the list's order first (`["search","docs"]` stays in that order), fixed while toggling, Enter maps back to names in display order, `all` in inventory order; untrusted: one scope `user`, Enter saves `user`, the every-project line, no `This project` row (replaces `form.test.ts:125-134`, adjusts 13-16, `render.test.ts:19-26`); `Proposed:` and `Project:` lines.
- `tests/plugins/agent-setup/agent-setup.test.ts` (extend; harness with registry, definitions, setup, view plugins):
  - no override → `/agents setup` sends one hidden message (`pi-subagents-autosetup`), opens no form, notice names left-out interactive skills (fake runtime with paths to temp SKILL.md files);
  - override in the user file → the Yes/No form opens with no pointer; Enter does nothing; No → the plain setup form; Esc → no hidden message, no form; Yes → the brief;
  - project override in an untrusted project is not counted (only the user file is);
  - `rpc` → error notice, nothing sent;
  - tool: not pending → error; non-lead, unknown or filtered skill, four skills → error, mark kept, corrected call opens the form; valid call → form with the proposal marked, Submit writes only the leads' `skills` in proposal order, `definitions.get(...)` updated, `published` awaiting true/false;
  - `/new`: after a save both the notice and the tool text end with the `/new` suggestion; after cancel and after nothing-to-change neither does; a plain-form save notice has no `/new` line;
  - existing form tests (`openForm`, 37-44, and every suite using it) now need an override fixture or a No answer, since the bare command with no override starts autosetup; the one-line tests are unchanged.
- `create.test.ts`, `menu.test.ts`: unchanged (no new word).

About 40 new or changed tests, 500 test lines.

## 4. Docs and rules

- `test/docs-sync.test.ts:8,46-66`: only `extensions/<name>/` code triggers it; a subagents change needs `extensions/subagents/{README,ARCHITECTURE,STRUCTURE}.md` and root `ARCHITECTURE.md`, `STRUCTURE.md`. Platform changes are not checked, but the convention (`STRUCTURE.md` header: every code folder documents its files) asks for `platform/pi-adapter/ARCHITECTURE.md:24` (catalogue now `{name, description, scope, path}`, scope from the resolved resource) and `platform/ui-kit/STRUCTURE.md:8` (`selectForm` `unfocused`), plus `platform/ui-kit/ARCHITECTURE.md` if it describes the select.
- `test/architecture.test.ts`: template in `prompts/` (127-134); files at depth 2 (144); tests in `tests/` (154); tool in `agent-setup.ts` (86-96, 177-183). `biome.json:621`: `core/` cannot import `ui/`, `api/` or ui-kit, so `proposal.ts` returns data and api builds the `SetupContext` and the select.
- `AGENTS.md:18` and root `ARCHITECTURE.md:48`: "`.pi/pi-subagents.json` (`/agents setup`, whose write may follow a model tool call once the user confirms the form)".
- `extensions/subagents/README.md:40`: the `/agents setup` row: proposes skills for the lead agents when none is set, otherwise asks first; you confirm in the form; then `/new`.
- `extensions/subagents/ARCHITECTURE.md`: line 9 (agent-setup registers `agent_skills_proposal`); line 81 (entry step, proposed drafts, checked-first picker, untrusted user-only scope, Proposed and Project lines); a bullet after 84 for autosetup (override check, Yes/No, `isLead`, interactive filter, brief, mark, tool checks, save with the `/new` suffix); line 83 (save outcome).
- `extensions/subagents/STRUCTURE.md`: 21 (`autosetup-skills.md`), 34, 78-80 (`autosetup.ts`, `proposal.ts`), 107-109, 133, 152.
- Root `STRUCTURE.md:30`: "The subagents briefs (`create-agent.md`, `autosetup-skills.md`) live in `extensions/subagents/prompts/`." (docs-sync needs a diff; nothing else there describes this).

## 5. Sequence and size

1. **Adapter `scope`/`path`** (types, `skills.ts`, `extension.ts`, `child-runtime.ts`, fake runtime, adapter tests and docs). About 25 lines, 4 tests. Independent; verification of the scope source is part of it.
2. **ui-kit unfocused select** (`select.ts`, `select.test.ts`, ui-kit docs). About 4 lines, 4 tests. Independent.
3. **Setup form** (proposal draft, note, project line, picker order, untrusted scope; form, render and the untrusted plugin test; subagents and root docs). About 45 lines, 14 tests. Independent; ships value for the plain form alone.
4. **Core autosetup** (`autosetup.ts`, `proposal.ts`, template, two test files, docs). About 190 lines plus 30 template lines, 25 tests. Needs 1 for the `SkillInfo` fields.
5. **Wiring** (`agent-setup.ts`: entry step, `startAutosetup`, `save` outcome and `/new` suffix, mark, tool; `agent-setup.test.ts` incl. the fixture change for existing form tests; AGENTS.md, root ARCHITECTURE.md, docs). About 110 lines, 15 tests. Needs 1 to 4.

Total about 375 shipped lines plus the template, about 500 test lines. Steps 1, 2 and 3 run in parallel; 4 after 1; 5 last.

## 6. Risks and open points

- **Scope source** (README Not verified): `loadSkills` with explicit paths marks most discovered skills `temporary` (PCA `core/skills.js:368-376`); the design takes the scope from `ResolvedResource.metadata` instead, with the path-under-cwd fallback. The step-1 test settles it.
- **Override detection reads loaded settings**, not the files: a hand edit not yet reloaded is missed; an override pi rejected at parse (invalid value) is not counted.
- **Existing tests change meaning**: with no override, bare `/agents setup` no longer opens the form; every current form test must seed an override or answer No.
- **The tool is declared in every main-session request** (~150 tokens; `modelOnly` tools activate at registration, PCA `core/extensions/types.d.ts:392`; the adapter has no `defaultActive`/`setActiveTools`, though pi has both, 491-497, 1291). Gate plus no `promptSnippet` for release 1.
- **Form opened mid-turn**: as questionnaire; Escape in the form is cancel (`form.ts:256-258`); an outside abort closes it via the signal (`platform/pi-adapter/ui/form.ts:31-33`); pi emits no `ui_prompt_start` for custom forms, hence the explicit `AWAITING_INPUT_CHANNEL` publish (`extensions/notifications/api/plugin.ts:28`).
- **Pending mark**: settled: in memory, set by `startAutosetup`, cleared when the tool finishes or on session start (R6).
- **`/new` is suggested, never run.** pi has a built-in `/new` (PCA `core/slash-commands.js:22`). The adapter's `dispatchCommand` sends `/<name>` as a user message (`platform/pi-adapter/runtime/host.ts:118-131,432-434`; extension commands run at once, `platform/pi-adapter/ARCHITECTURE.md:23`); whether pi runs a built-in like `/new` that way was not verified. We deliberately do not call it: closing the session is the user's call (R3), and it would cut off the model's closing message.
- **Map-shaped parameters** (`additionalProperties` objects): some strict tool-schema modes reject open maps; fallback is arrays (`[{lead, skills}]`, `[{skill, why}]`), which changes the README shape.
- **Interactive filter false positives**: a skill that merely mentions "questionnaire" is dropped; reported by name in the notice; the term list is one constant (`INTERACTIVE_TERMS`).
- **After reload**: `save` → `definitions.reload()` re-reads settings and definitions synchronously (`agent-definitions.ts:70-77`); `list()` is a fresh array (80-81); a saved candidate name is in `runtime.skillNames()` so the load does not drop it (`core/agent-definitions/loader.ts:194-219`).
- **Main prompt is silent about briefs** (`prompts/main-session.md:29` says to delegate); the brief must say to answer itself, as `create-agent.md:1` does.
