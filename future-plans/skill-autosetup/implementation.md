# Implementation: skill autosetup, release 1

What it takes to build `/agents autosetup` as specified in README.md (R1 to R6). Evals are out of scope (README, Out of scope). Read on 2026-10-25 against the working tree of branch `feat/style-concise-default`. Paths are under `extensions/subagents/` unless they start with `platform/`, `test/`, `biome.json` or `AGENTS.md`. Facts already in research.md are cited, not repeated.

## 1. Reused as-is

- **Routing** (`api/plugins/agent-view.ts`): the first word is checked with `isSubcommand` (`ui/agent-view/picker.ts:19-20`) and the rest joined as `args` (`agent-view.ts:218-225`); `runSubcommand` (175-176) sends every word but `view` to `runSetupWord` (161-173). `subcommands(prefix)` (136-150) completes the words and labels each non-`view` word with `service.usage[word]`; `setupCompletions` (201-205) completes agent names after `setup `. The description's usage is read once at enable (198-199). Reused, with the edits in section 2.
- **`agentSetup` service** (`api/plugins/agent-setup.ts:131-147`; type `core/model/agent-record.ts:164-169`): `{usage: {setup, create}, run, create, complete}`. Gains an `autosetup` method and usage key (section 2); `run`, `create`, `complete` unchanged.
- **`save(scope, changes)`** (`api/plugins/agent-setup.ts:34-59`): trust check, `writeChanges`, `definitions.reload()`, notice, shadow warning. Reused, with one change (its return value, section 2). Trap: it returns `void` today, so the tool cannot tell the model what was saved or why it failed.
- **`context(info)`** (`agent-setup.ts:61-79`): the `SetupContext` the form needs, agents ordered shipped first (`shippedFirst`, 17-19). Reused with an optional proposal argument (section 2).
- **`writeChanges`, `mergeChanges`, `overriddenFields`** (`core/agent-setup/write.ts:17-68`): per-agent field merge, keeps other keys, error string instead of throw. As-is.
- **`settingsPaths(info)`** (`core/model/settings.ts:131-134`): the two files. As-is.
- **`setupForm(context, paths)`** (`ui/agent-setup/setup-overlay.ts:8-33`): starts from `initialSetup(context)` (11), returns `{scope, changes}` or `undefined`. As-is once `initialSetup` reads the proposal.
- **`setupChanges`, `changedFields`, `fieldChanged`, `sameGrant`** (`ui/agent-setup/form.ts:66-95`): diff each draft against `agent.initial`; `setupChanges` falls back to `agent.initial` when a draft is missing (85). As-is: they already diff against `initial`, so keeping `initial` as the baseline is enough for proposed skills to show `(changed)` (`setup-render.ts:76`) and the tab as done (`setup-render.ts:235-238`).
- **`modelOptions`** (`form.ts:97-103`) reads `agent.initial.model`; the proposal never touches the model, so no effect.
- **`host.sendHiddenMessage`** (`platform/pi-adapter/runtime/host.ts:402-430`): follow-up with `triggerTurn` while a run is active; otherwise held and started as its own turn when idle (`deliverHeld` 155-167, `startHidden` 141). As-is; same use as `createAgentCommand` (`core/agent-setup/create.ts:142-154`).
- **Questionnaire as the UI-tool precedent** (`extensions/questionnaire/api/plugin.ts:9-49`, `core/questionnaire.ts:81-109`): definition object in core, `execute` in api, mode check before anything, `awaitingInput(host)(true)` around `host.ui.showForm(factory, {signal})`, `undefined` treated as cancel, result `{text, details}`. The adapter's `showForm` (`platform/pi-adapter/ui/form.ts:10-61`) waits for other overlays to clear, returns `undefined` on abort and wires the signal to close the form. A tool `execute` captures the live ctx first (`platform/pi-adapter/tools/tool-bridge.ts:125-132`, `onContext(ctx)`), so `host.ui.showForm` works from a tool in this extension exactly as in questionnaire; `host` is the same object for every plugin of the extension.
- **`host.registerTool` / `ToolSpec`** (`platform/pi-adapter/runtime/host.ts:347-350`; `types/tools.ts:21-38`): `modelOnly` maps to pi's `exposure: "model-only"` (`tool-bridge.ts:121`), which pi documents as "declared to the model while active, never callable" from codemode, activated at registration (PCA `dist/core/extensions/types.d.ts:383-395`). Precedent in this extension: `agentStatusPlugin` registers its tool at enable (`api/plugins/agent-status.ts:70-82`).
- **Child exclusion**: children get the parent's active tools minus anything registered from this extension's root (`api/extension.ts:20` `childExclude: [root]`; `platform/pi-adapter/child/child-runtime.ts:102-106`), so no agent, not even one with `tools: all`, sees `agent_skills_proposal`.
- **No agent kinds**: definitions carry no lead/chore marker (research.md §1, Agent definitions), and nothing here adds one. `context()`, the tool's checks and the form treat every agent alike; only a `skills: all` grant is refused, because there is nothing to pick. The chore policy lives in the brief alone (README R2, R6).
- **`cutChars`** (`core/components/receipt.ts:132`): shared core helper, not owned by a plugin (no `api/plugins/components.ts`), so `core/agent-setup/` may import it for cutting skill descriptions.
- **Test fakes**: harness `tests/support/subagents-harness.ts` (`createHarness`); fake host `test/framework/fake-host.ts`: `tools` map and `host.tool(name).execute(params, {update})` (403, 548-556), `hidden` (440, delivery `run` when idle), `published` (452-457), `forms`/`form()` (204-206, 296-303; `showForm` returns `undefined` outside tui), `notices`, `settle()` fires idle handlers (512-518), `info.mode`; fake runtime `skills` and `skillDescriptions` (`test/framework/fake-agent-runtime.ts:137-177`); form fixture `tests/support/setup-context.ts` (`context`, `PATHS`, `press`, `render`).

## 2. Changed

### `api/plugins/agent-setup.ts`

The tool must live in this file. `test/architecture.test.ts:86-96` treats every file under `api/plugins/` as a plugin of its own name, so a separate `api/plugins/agent-skills-proposal.ts` importing `core/agent-setup/` would fail the cross-plugin rule (177-183).

1. **`save` returns an outcome.** `type SaveOutcome = {path: string; text: string} | {error: string}`; same notices as now. `runForm` and `runLine` ignore it. About 6 lines.
2. **`context(info, proposal?)`.** With a validated proposal, each agent named in it gets `proposed: {...initial, skills}` and `note` (the reasons line); the others are unchanged. About 8 lines.
3. **`autosetup` on the service.** `services.provide("agentSetup", {…, autosetup: runAutosetup})`. `runAutosetup(args)`: non-empty `args` → error notice `usage: /agents autosetup`; outside tui → error notice naming `/agents setup` and both files (the `runForm` advice, 86-89) and stop; else build the brief (`autosetupBrief`, section 3), `host.sendHiddenMessage({customType: AUTOSETUP_TYPE, text})`, set `pending = true`, notify `asked the main session to propose agent skills`. About 20 lines. `run`, `runLine` and `parseSetupLine` are untouched.
4. **Usage.** `usage: {setup: SETUP_USAGE, create: CREATE_USAGE, autosetup: AUTOSETUP_USAGE}` with `AUTOSETUP_USAGE = "/agents autosetup"`. The `AgentSetupService` type (`agent-record.ts:164-169`) gains `autosetup(args): Promise<void>` and the `usage.autosetup` key. 4 lines.
5. **Completion.** Nothing here: the word is completed by `subcommands` in agent-view (below); `complete(prefix)` still lists agent names after `setup `.
6. **Pending mark.** `let pending = false` in the `enable` closure, in memory only, never written anywhere. Set by `runAutosetup`; cleared when the tool finishes (confirm, cancel, nothing to change, save failure) and on `host.onSessionStart`; not cleared on a validation refusal, so the model can correct and call again. Settled 2026-10-25 (option A below): no other clearing. About 6 lines.
7. **The tool.** `host.registerTool({...proposalDefinition, execute})`, following questionnaire:
   - `!pending` → error result `Error: no proposal is pending; the user must run /agents autosetup first.`
   - `host.session().mode !== "tui"` → error result (cannot happen while pending, since `runAutosetup` refuses outside tui, but the spec asks for the check).
   - `checkProposal(params, definitions.list(), runtime.skillCatalog())` (any agent with a list grant is accepted; no lead/chore check) → error list → error result with every problem on its own line, plus the valid names.
   - No difference from the current lists → `nothing to change: the proposal matches the current lists`, pending cleared, no form.
   - Publish `AWAITING_INPUT_CHANNEL` (`platform/shared/index.ts`; api may import it, as `api/extension.ts:3` does) with `source: "pi-subagents"`, `title: "agent skills"`, around `await host.ui.showForm(setupForm(context(info, proposal), settingsPaths(info)), {signal})`.
   - `undefined` → `Cancelled by the user; nothing was saved.` (not `isError`, as questionnaire). Empty `changes` → `The user confirmed without changes; nothing was saved.` Otherwise `save(scope, changes)` → its `text` or `error` (error as `isError`).
   - `executionMode: "sequential"`, so two calls in one turn never open two forms.
   About 45 lines with the result texts.

The plugin goes from 149 to about 240 lines. If that is too long, the result texts and the `SaveOutcome` text can move to `core/agent-setup/proposal.ts`; the `execute` body must stay here because it closes over `save`, `context` and `pending`.

### `ui/agent-setup/form.ts`

Smallest change: optional fields on the agent, not a second argument, so `setupForm`, `initialSetup` and every caller keep their signature.

```ts
type SetupAgent = {
  name: string; description: string; tools: Grant; mcp: boolean;
  initial: Draft;      // baseline for changedFields/setupChanges, as today
  proposed?: Draft;    // opening draft when set
  note?: string;       // one line shown on the agent tab
};

export const initialSetup = (context: SetupContext): SetupState => ({
  drafts: context.agents.map((agent) => agent.proposed ?? agent.initial),
  ...
});
```

`Draft` stays file-private; the plugin builds `proposed` as `{...initial, skills}`. `openPicker` ticks the draft's names (119-128); `chooseSkills` keeps `all` only when the draft is `all` (212), which cannot happen for a proposed agent (refused upstream). Call sites of `initialSetup`: `setup-overlay.ts:11`, `form.test.ts` (10 uses), `render.test.ts` (3 uses); none needs editing for this part since the fields are optional.

**Picker order (all uses of the form, README R3).** Today the skills picker is a `MultiState` whose positions are `context.skills` indexes: `openPicker` builds `checked` by mapping `context.skills` (125-127), `chooseSkills` maps `checkedIndexes(picker.multi)` straight to `context.skills[index]` (210), and the render lists `context.skills` and reads the detail line from `context.skills[cursor]` (`setup-render.ts:95-96,124`). Smallest change: an order held in the picker.

```ts
type SkillsPicker = { field: "skills"; multi: MultiState; order: number[]; touched?: boolean };

// openPicker: checked first, then the rest, each in inventory order; fixed until the picker closes
const ticked = context.skills.map((skill) => named.includes(skill.name));
const order = [...ticked.keys()].sort((a, b) => Number(ticked[b]) - Number(ticked[a]) || a - b);
// multi positions are positions in `order`
initialMulti(order.length, order.map((index) => ticked[index]));

// chooseSkills: position → inventory index → name
checkedIndexes(picker.multi).flatMap((position) => context.skills[picker.order[position] ?? -1]?.name ?? []);

export const pickerSkills = (context: SetupContext, picker: SkillsPicker) =>
  picker.order.flatMap((index) => context.skills[index] ?? []);
```

`multiKey` only moves the cursor and flips `checked[position]` (`platform/ui-kit/multi-select.ts`), so toggling never reorders. The saved list comes out in display order (checked first); `sameGrant` compares as a set, so the change marks are unaffected. `setup-render.ts` uses `pickerSkills` for the rows (124) and for the detail line (`skillDetail` takes the picker instead of a cursor into `context.skills`). An `all` draft opens with nothing ticked, so in inventory order. About 12 lines in `form.ts`, 4 in `setup-render.ts`.

**Scope per project (README R3).** Today `SetupState.scope` indexes `SCOPES = ["project", "user"]` (`core/agent-setup/scope.ts:5`); `initialSetup` starts at 1 when untrusted (61); `submitKey` refuses project with `UNTRUSTED` when untrusted and something changed (227-231, text at 55); the Submit tab lists both files, the project one suffixed `(project not trusted)` (`setup-render.ts:192-196`); `setupForm` returns `SCOPES[state.scope]` (`setup-overlay.ts:26`). Change:

- `export const scopeOptions = (context: SetupContext): readonly Scope[] => context.trusted ? SCOPES : ["user"];` in `form.ts`; `initialSetup` scope `0` always (project in a trusted project, user otherwise, as today); `submitKey` steps over `scopeOptions(context).length`; `setup-overlay.ts:26` returns `scopeOptions(context)[state.scope] ?? "user"`.
- The `UNTRUSTED` refusal and `refused` become unreachable: remove them (knip would flag the unused export). `save` keeps its own trust check (`agent-setup.ts:38-41`) as the backstop.
- `submitLines` lists `scopeOptions(context)` and, when untrusted, adds a warning line under `Save to:`: `This project is not trusted, so pi does not read its .pi/pi-subagents.json; the user file applies to every project.`

About 10 lines over `form.ts`, `setup-render.ts`, `setup-overlay.ts`. It changes the plain `/agents setup` form too, which the spec intends.

### `ui/agent-setup/setup-render.ts`

`infoLines` (141-156) adds `...line("Proposed", agent.note)` when `agent.note` is set, under Tools and MCP; dim like them, wrapped by `padded`. About 3 lines. The note text (e.g. `docs: the repo has a docs/ site; tdd: build checks run the tests`) is built in core, so the ui stays generic.

### `ui/agent-view/picker.ts`

- `SUBCOMMANDS = ["view", "create", "setup", "autosetup"]` (4); `SUBCOMMAND_TEXT.autosetup = "the main session proposes skills per agent"` (8-12); `MENU_TEXT` gets it through the spread (14-17). Both are `Record<Subcommand, string>`, so the compiler forces the entries.
- `subcommandPicker` (22-30) lists its options explicitly: add `{value: "autosetup", label: "autosetup", description: MENU_TEXT.autosetup}` after `setup`. The menu then runs `runSubcommand("autosetup", "")`. Leaving it out of the menu is possible, but the records already require the text.

### `api/plugins/agent-view.ts`

- `runSetupWord` (161-173): three-way dispatch, `create` → `service.create(args)`, `setup` → `service.run(args)`, `autosetup` → `service.autosetup(args)`. `SetupWord = Exclude<Subcommand, "view">` (29) picks up the new word with no edit; the disabled-plugin error already names the word.
- `subcommands` (136-150) labels each word with `service.usage[word]`, so `usage.autosetup` is all it needs; `/agents a` completes `autosetup`.
- Description (198-199, 208): `usageText` adds `| ${usage.autosetup}`, and `Agents: list, setup or create.` becomes `Agents: list, setup, autosetup or create.`. Pinned by `tests/plugins/agent-setup/create.test.ts:180-182`; the menu test `tests/plugins/agent-view/menu.test.ts:41-49` gains the `autosetup` row.

`core/agent-setup/line.ts` is not touched.

## 3. New

### `prompts/autosetup-skills.md`

Read once at enable next to `create-agent.md` (`agent-setup.ts:29`). Placeholders in create-agent.md style, filled with the same `replace(/\{\{(\w+)\}\}/g, …)`: `{{project}}` (cwd basename and path), `{{listing}}`, `{{trusted}}` (which files the form will offer: project and user, or user only, applying to every project), `{{agents}}`, `{{skills}}`. The tool name is written literally, as `create-agent.md` names `run_agent`; a test asserts the template contains `PROPOSAL_TOOL`. Outline:

1. One line: the user ran `/agents autosetup`; do this yourself in this conversation, do not delegate to an agent.
2. Project: `{{project}}`, top-level entries `{{listing}}`; read a manifest or two (package.json, build files, README) with your own tools when the listing does not show the stack.
3. Rules (README R2): a skill fits an agent when its description names that agent's job or stack; prefer fewer; keep what is already there unless it clearly does not belong here; agents marked `all` are not listed and get nothing; propose full lists, not deltas; a skill listed without a description is judged by its name alone, and only when the name is unambiguous.
4. Chore policy, one sentence, the only place chores are treated differently (R2, R6): agents that do one mechanical job on instruction (run commands, fetch a page, describe an image, apply exact edits, find things in the code) get no skills in this release; propose only for agents that take a task needing judgement.
5. Answer: call `agent_skills_proposal` once with `{assignments: {<agent>: [<skill>, …]}, reasons: {<skill>: "<why, one line>"}}`, only agents whose list should change; an empty list means no skills; do not write any file; do not run `/agents setup` or `/agents autosetup`; the user confirms in a form; afterwards tell the user what was saved, from the tool's result. If the tool returns an error, fix the names and call it again.
6. `Agents:` `{{agents}}`, one line each: `- <name>: <description> | tools: <grant> | skills: <list or none>`.
7. `Agents granted all skills (not proposed): <names or none>` (part of `{{agents}}`).
8. `Skills:` `{{skills}}`, one line each `- <name>: <description cut to 200 characters>`, or `- <name> (no description)`.

200 characters keeps a hundred skills near 6,000 tokens once per command; agentskills.io allows 1,024 (research.md §3), most real descriptions are under 200.

### `core/agent-setup/autosetup.ts` (brief and project listing; mirrors `create.ts`)

- `AUTOSETUP_TYPE = "pi-subagents-autosetup"`, `AUTOSETUP_USAGE = "/agents autosetup"`.
- `projectListing(cwd, limit = 60): string[]`: `readdirSync(cwd, {withFileTypes: true})`, sorted, directories suffixed `/`, `.git` and `node_modules` skipped, cut at `limit` with `… and N more`; a read error gives `(cannot list: <errorText>)`. Lives here, not in `platform/shared/`: one caller, and `core/` may use node built-ins (`create.ts:1`, `write.ts`). `platform/shared/` would admit it (`platform/shared/STRUCTURE.md:3`) but nothing else needs it.
- `agentLines(definitions)`, `skillLines(catalog)`: pure, using `grantText` from `core/model/agent-record.ts:87` (it renders `[]` as an empty string, so the lines write `none` themselves) and `cutChars`.
- `autosetupBrief({template, cwd, trusted, listing, definitions, skills}): string`.

About 60 lines. Deps are plain data, so tests need no host.

### `core/agent-setup/proposal.ts` (tool definition, validation, drafts)

- `PROPOSAL_TOOL = "agent_skills_proposal"`; `type ProposalParams = {assignments: Record<string, string[]>; reasons?: Record<string, string>}`.
- `proposalDefinition` (a `Pick<ToolSpec, …>` like `extensions/questionnaire/core/questionnaire.ts:69-90`): `name`, `label: "Agent skills proposal"`, `description: "Answer a /agents autosetup brief: propose each agent's full skills list for this project. Only valid after the user ran /agents autosetup; opens a form the user confirms; never call it otherwise."`, no `promptSnippet` or `promptGuidelines` (keeps it out of the system prompt's tool list; the brief carries the instructions), `executionMode: "sequential"`, `modelOnly: true`, parameters in the repo's plain JSON-schema style (`api/plugins/fetch-tool.ts:33-38`):

```ts
parameters: {
  type: "object",
  properties: {
    assignments: {
      type: "object",
      description: "Agent name to its full proposed skills list. Only agents whose list should change; [] for none.",
      additionalProperties: { type: "array", items: { type: "string" } },
    },
    reasons: {
      type: "object",
      description: "Skill name to one line saying why it fits this project.",
      additionalProperties: { type: "string" },
    },
  },
  required: ["assignments"],
  additionalProperties: false,
}
```

- `checkProposal(params, definitions, catalog): {proposal: Record<string, string[]>; notes: Record<string, string>} | {errors: string[]}`: unknown agent (`no agent named "x"`), agent with `skills: "all"` (`x has all skills; it is not proposed for`), unknown skill (`no skill named "y" (for x)`), empty `assignments`; duplicates dropped; reasons for skills not proposed are ignored. Errors list every problem, then the valid agent and skill names once.
- `proposalChanges(proposal, definitions)`: the agents whose set differs (`sameGrant` semantics: order-free), for the nothing-to-change case.
- `noteFor(skills, reasons)`: `docs: …; tdd: …`, cut to 200 characters.

About 90 lines. The definition stays in core, as questionnaire's does; `execute` is assembled in api. No lead/chore check, no list of chore names. If the brief alone proves unreliable for chores, the next cheapest place is an opt-out in the agent file (a frontmatter key its author sets), read by `checkProposal` and the brief; still not a chore flag in the platform (README R6).

### Tool result shapes

- Success: `Saved to <path>: implementer skills [a, b]; reviewer skills [c]. Agents started from now on use them.` plus the shadow warning when user scope is shadowed. `details: {scope, path, changes}`.
- Cancel: `Cancelled by the user; nothing was saved.` `details: {cancelled: true}`.
- Confirmed without changes / proposal equals current lists: `Nothing was saved: …`.
- Refusal: `isError: true`, text starting `Error:`; `details` omitted.

### Tests

- `tests/plugins/agent-setup/autosetup.test.ts` (new, pure): brief lists agents with tools and current skills; `all` agents only in the not-proposed line; a skill with `description: ""` renders as `(no description)`; descriptions cut at 200; no skills gives `none`; template placeholders all filled (no `{{` left) for the shipped template; template mentions `agent_skills_proposal`. `projectListing` on a `tempDir`: sorted, `/` on dirs, `.git`/`node_modules` skipped, the limit line, missing dir.
- `tests/plugins/agent-setup/proposal.test.ts` (new, pure): unknown agent, `all` agent, unknown skill, empty assignments each give their error and all at once; duplicates dropped; reasons for unproposed skills ignored; `proposalChanges` ignores order; `noteFor` cut.
- `tests/plugins/agent-setup/form.test.ts` (extend): with `proposed` on `chore` (fixture helper `proposedContext()` in `setup-context.ts`), `initialSetup` drafts the proposal, `fieldChanged(…, "skills")` is true, `setupChanges` returns `[{name: "chore", patch: {skills: ["docs"]}}]`; unticking back to the baseline gives no change. Picker order (fixture with three skills and `skills: ["search"]`): opens with `search` first, then the rest in inventory order; ticking and unticking keeps the order; Enter maps positions back to the right names; an `all` agent opens in inventory order with nothing ticked. Scope: untrusted `initialSetup` scope is 0 and `scopeOptions` is `["user"]`, Enter on Submit saves `user`; trusted unchanged. Replaces the test at 125-134 (the `UNTRUSTED` refusal) and adjusts 13-16.
- `tests/plugins/agent-setup/render.test.ts` (extend): `(changed)` on Skills for the proposed agent, tab marked done, the `Proposed:` line when `note` is set and absent otherwise; picker rows in checked-first order and the detail line of the skill under the cursor through the order; untrusted Submit tab shows only `User` and the every-project line (replaces 19-26).
- `tests/plugins/agent-setup/agent-setup.test.ts` (extend; harness with `agentRegistryPlugin`, `agentDefinitionsPlugin`, `agentSetupPlugin`, `agentViewPlugin`; fake host, runtime, form): `/agents autosetup` in tui sends one hidden message with `customType` `pi-subagents-autosetup` containing agent and skill lines, notifies, opens no form; with arguments → usage error; in `rpc` → error notice, no hidden message; tool before the command → error, no form; unknown agent or skill, or an `all` agent → error, pending kept, a corrected call opens the form; a chore-named agent with a list grant is accepted like any other; valid call in a trusted project → form opens with the proposal marked, Submit writes only the proposed agents' `skills` to the project file, `definitions.get(name).skills` is the new list, the tool text names the path and the agent, `published` has awaiting `true` then `false`; Escape → nothing written, `Cancelled…`, a later call refused; untrusted project → only the user file offered, written there; the test at 151-169 (untrusted refusal) rewritten for the single-scope form; pending clearing per the option chosen in section 6.
- `tests/plugins/agent-setup/create.test.ts` (adjust): description string at 180-182.
- `tests/plugins/agent-view/menu.test.ts` (adjust): the menu lists `autosetup`; completion `/agents a` offers `autosetup` with its usage label; the disabled-plugin error names `/agents autosetup`.

About 30 new or changed tests, 400 test lines.

## 4. Docs and rules

- `test/docs-sync.test.ts:46-66`: any changed or untracked file under `extensions/subagents/` other than its three docs requires changes to `extensions/subagents/README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md`, against the merge-base with `origin/main` (30-31). So every step that touches extension code must touch all five, or the steps share one branch and the docs land before `npm run check` is expected green.
- `test/architecture.test.ts`: template in `prompts/` (127-134 allow it); new files at depth 2 (`core/agent-setup/`, 144); tests in `tests/` (154); no cross-plugin import (177-183, with `pluginOwner` 86-96: the tool must stay in `api/plugins/agent-setup.ts`); normalised imports (185). `biome.json:621` (`extensions/*/core/*/*.ts`) forbids `core/` importing `ui/`, `api/`, ui-kit or extension-manager: `proposal.ts` returns plain data, the `SetupContext` is built in api.
- `AGENTS.md:18`, proposed wording of the parenthesis: "`.pi/pi-subagents.json` (`/agents setup`, or `/agents autosetup` once the user confirms its form)". Optionally after the `/agents create` sentence: "`/agents autosetup` also briefs the main session, but the extension writes, through the setup form's save, after the user confirms." Root `ARCHITECTURE.md:48` carries the same parenthesis and needs the same edit; `ARCHITECTURE.md:50` the optional sentence.
- `extensions/subagents/README.md:36-41`: a table row `/agents autosetup` | "The main session proposes skills per agent for this project; you confirm or edit them in the setup form." The `/agents` row can mention the new menu entry; the `/agents setup` row that checked skills come first and that an untrusted project saves to the user file only.
- `extensions/subagents/ARCHITECTURE.md`: line 9 (agent-setup plugin also registers the model-only `agent_skills_proposal` tool); line 79 (menu: `autosetup` entry); line 80 (`autosetup` is a fourth first word); a new bullet after 84 for `autosetup`: brief from `prompts/autosetup-skills.md` filled by `autosetupBrief`, hidden message type `pi-subagents-autosetup`, the pending mark and when it clears, the tool's checks, the form opened with `proposed` drafts against `initial`, save through the same path, the result text, tui only; line 81 (the form can open with proposed drafts and a Proposed line; checked skills first in the picker; an untrusted project offers the user file only, replacing "refused in an untrusted one").
- `extensions/subagents/STRUCTURE.md`: line 21 (`autosetup-skills.md`), line 34 (agent-setup also the `agent_skills_proposal` tool), lines 78-80 (`autosetup.ts`, `proposal.ts`), line 107 (form: proposed drafts, picker order, `scopeOptions`), the `ui/agent-view/picker.ts` line (fourth word), line 133 (test list), line 152 (fixture helper).
- Root `STRUCTURE.md`: nothing in it describes this change; docs-sync still requires a diff. Natural spot: line 30, after the `style` prompts sentence, "The subagents briefs (`create-agent.md`, `autosetup-skills.md`) live in `extensions/subagents/prompts/`."

## 5. Sequence and size

1. **Setup form** (`form.ts`, `setup-render.ts`, `setup-overlay.ts`, `setup-context.ts`, `form.test.ts`, `render.test.ts`, the untrusted test in `agent-setup.test.ts`, docs): proposal draft and note, checked-first picker order, user scope only in an untrusted project. About 40 code lines, 12 tests. Independent, and useful on its own for `/agents setup`.
2. **Core: brief, listing, validation, definition, template** (`autosetup.ts`, `proposal.ts`, `prompts/autosetup-skills.md`, two new test files, docs). About 150 code lines, 45 template lines, 15 tests. Independent of step 1. Knip counts the vitest test files as entries (`knip.json`: `vitest` plugin), so exports used only by the new tests until step 3 are not flagged.
3. **Wiring** (`agent-setup.ts`: `SaveOutcome`, `autosetup` method and usage, pending mark, tool; `agent-record.ts` service type; `picker.ts` word and menu entry; `agent-view.ts` dispatch and description; `agent-setup.test.ts`, `create.test.ts`, `menu.test.ts`; AGENTS.md, root ARCHITECTURE.md, all docs). About 100 code lines, 12 tests. Needs 1 and 2.

Total about 290 shipped lines plus the template, about 400 test lines. Steps 1 and 2 can run in parallel; 3 after both.

## 6. Risks and open points

- **The tool is declared in every main-session request**, pending or not (`modelOnly` tools are activated at registration, PCA `types.d.ts:392`). Cost: the description and schema, about 150 tokens per request. The adapter's `ToolSpec` has no `defaultActive` and the `Host` has no `setActiveTools`, though pi has both (`types.d.ts:491-497`, 1291). Release 1: keep it declared, no `promptSnippet`, description says to call it only after the command, refuse when not pending. Later, if the token cost matters: add `defaultActive: false` to `ToolSpec` and a `setToolActive(name, on)` to `Host` in the adapter, and activate it only while pending.
- **When the pending mark clears (settled 2026-10-25: option A, clear when the tool finishes or the session ends; kept here for the record).** Every option also clears it when the tool finishes and on `onSessionStart`. Facts: a held brief starts its own run, an active run takes it as a follow-up (`host.ts:229-233`, 416-419); `onIdle` fires only on `agent_settled` (`host.ts:319-328`), after the tool returned; the `Host` has no user-input hook (`platform/pi-adapter/types/host-capabilities.ts:22-29`), though pi has an `input` event (PCA `types.d.ts:1227`).
  - A. On the tool call or session end only. Cost: a brief the model ignored leaves the gate open for the session, so a later unprompted call opens the form (still behind the user's confirm). No new code.
  - B. When the turn that received the brief ends (`host.onIdle`). Cost: if the model asks the user something before calling, the answer starts a new run and the call is refused; the user runs the command again. One line.
  - C. On the next user prompt. Cost: needs an `onUserInput` hook in the adapter (pi's `input` event, about 10 lines, a test, the adapter docs), and a steering message during the brief's turn clears it too.
  Recommendation was B; the owner chose A on 2026-10-25: a stale mark can at worst open a form the user cancels, and nothing is written without a confirm. C would need a new adapter hook on pi's `input` event and is not planned.
- **Form opened mid-turn.** Works as in questionnaire: `execute` awaits the form while the turn waits on the tool result; the form takes keys while focused; Escape inside it means cancel (`form.ts:256-258`), not abort. If the run is aborted from outside, the signal closes the form with `undefined` (`ui/form.ts:31-33`), reported as cancel. pi does not emit `ui_prompt_start` for `ctx.ui.custom`, which is why questionnaire publishes `AWAITING_INPUT_CHANNEL` itself (`core/questionnaire.ts:104-109`) for the notifications extension (`extensions/notifications/api/plugin.ts:28`); the tool must do the same or the user is not pinged while the turn sits on the form.
- **Map-shaped parameters.** `assignments` and `reasons` are objects with free keys (`additionalProperties` schemas). Most providers accept them; some strict tool-schema modes reject open maps, and the repo has no other open-map tool. If calls come back malformed in use, switch to arrays (`assignments: [{agent, skills}]`, `reasons: [{skill, why}]`); the README's shape would change with it.
- **Untrusted project.** Handled by the single-scope Submit tab and its every-project line (section 2); the brief's `{{trusted}}` tells the model the same, and the tool result names the file.
- **Saved order.** With the checked-first picker the saved list follows display order, not inventory order; harmless (`sameGrant` compares sets), but an agent's list in the file may reorder on its next save.
- **After reload.** `save` calls `definitions.reload()` synchronously (`agent-setup.ts:50`; `agent-definitions.ts:70-77`), which re-reads the settings and replaces the loaded definitions; `list()` builds a fresh sorted array each call (80-81), so the next tool call, form or `run_agent` sees the new lists. The override check uses `runtime.skillNames()`, the same inventory `checkProposal` validated against, so a saved name is never dropped as unknown at load (`loader.ts:194-219`), unless the inventory changed through a `/reload` between brief and call, which also restarts the extension and clears pending.
- **Model or thinking edits in the same form.** The user can change any field before confirming; `save` writes them all and the result text must report every field, not only skills (use `changeSummary`, `agent-setup.ts:21-22`).
- **Main prompt is silent about briefs** (`prompts/main-session.md:29` tells it to delegate and to pass its own skills). The brief must say to answer itself and not to start agents, as `create-agent.md:1` does.
