# The harness side: what pi-extensions must build for a company package

> Status edit, 2026-10-18: the owner dropped section 2.1 (agent files from pi packages) as excessive. Company agents are installed into the user agent dir or `.pi/agents`, for example by the example's `install-agents.sh`, which therefore stays. The workflow engine stays dropped too (item 5). Sections 2.2 to 2.4 remain planned; 2.2 is detailed in ../../cwd/spec.md.

Scope: verify section C of `../company/company-side.md`, design the harness changes that survive, and say what happens to `future-plans/`. Read on branch `feat/verifier-chore` (5a3846f). "pi dist" means `node_modules/@earendil-works/pi-coding-agent/dist/` (pi 1.3.0). Paths without a prefix are under `extensions/subagents/`.

## 1. Verification of section C

| # | Item | Company status | Verified status |
|---|---|---|---|
| 1 | Package skills reach the main session and agents | exists | **exists**, with three caveats |
| 2 | Agent files from a company package | missing | **missing**; the recommended fix differs. Dropped by the owner: install agents into the user agent dir or `.pi/agents` instead |
| 3 | `cwd` per `run_agent` item | missing | **missing**; "with the session's trust" is unsafe as written |
| 4 | Verifier chore | exists | **exists** |
| 5 | Workflow engine | not needed | **not needed** |
| 6 | Gates that ask the user | exists | **exists** |
| 7 | Extending the main prompt | not needed | **not needed as a mechanism; one wording change recommended**. The conflict is real and larger than stated |
| 8 | Progress across handoffs | not needed | **not needed** |
| 9 | MCP for a company agent | exists, filter missing | **exists**; the description of "every server" is incomplete; a filter is cheap and feasible |
| 10 | `agents.<name>.mcp` override | not needed | **not needed** |
| 11 | Artefact root | not needed | **not needed** |
| 12 | Workspace extension | not needed beyond 3 | **not needed beyond 3** |
| 13 | Result contract, per-task skills | exists | **exists** |
| 14 | `examples/company/` | not a feature | agreed |

### Item 1: package skills

Confirmed. The chain:

- A pi package declares skills with a `skills/` folder or `"pi": { "skills": [...] }` in `package.json` (pi docs `packages.md:5`, `:44`, `:65`). The manifest reader keeps only `extensions`, `skills`, `prompts`, `themes` (pi dist `core/pi-manifest.js:3`).
- pi resolves user and project packages into the main session's resource loader (pi dist `core/package-manager.js:704-736`).
- `pi.getCommands()` lists every loaded skill as `skill:<name>` with its `sourceInfo`, straight from `resourceLoader.getSkills()` (pi dist `core/agent-session.js:2727-2732`). `disable-model-invocation` only hides a skill from the prompt (pi dist `core/skills.js:262`, `:279`), so user-invoked skills are in the list too.
- The adapter turns that list into `skillFiles` (`core/adapter/pi-adapter.ts:490-495`).
- The child loader runs with `noSkills: true` and `additionalSkillPaths` picked from those files (`core/adapter/pi-child.ts:197-209`); with `noSkills` pi loads exactly those paths (pi dist `core/resource-loader.js:424-426`).

Caveats the company document should state:

1. An agent gets only the skills its grant names: the file's `skills`, an `agents.<name>.skills` override, or the per-task `skills` list (`src/plugins/run-agent/runner.ts:700-704`, `:611`). `tech-lead`'s `skills: [tracker]` works.
2. Skills are always the main session's. A child never discovers skills of its own cwd (`noSkills: true`, `pi-child.ts:201`). With item 3 this matters: a repo's own `.pi/skills` or `.agents/skills` below the workbench reach an agent only if the main session already loaded them.
3. A project-scope package loads only after project trust (`packages.md:21`). The company package should be installed user-scope, as the example README does.

### Item 2: agent files from a package

Missing, confirmed. Load dirs are builtin, `<agentDir>/agents`, and `.pi/agents` when trusted (`src/plugins/agent-definitions/index.ts:42-48`, `src/model/paths.ts:15-17`). The walk keeps only `isDirectory()` and `isFile()` entries (`src/plugins/agent-definitions/loader.ts:168-177`), so symlinks are skipped.

Correction to D.1 of the company document: option (b) does not need pi internals. pi exports `DefaultPackageManager` (pi dist `index.d.ts:17`), whose `listConfiguredPackages()` returns each configured package with its scope and `installedPath` (pi dist `core/package-manager.js:759-781`, path logic `:672-688` for npm, git and local sources). A call from `core/adapter` is a supported API, not a guess at install folders. Section 2.1 recommends (b).

### Item 3: `cwd`

Missing, confirmed: the item schema has no `cwd` and `additionalProperties: false` (`src/plugins/run-agent/tools.ts:142-174`); `SpawnSpec.cwd` exists (`core/adapter/contract.ts:333`); the child loader and session use it (`pi-child.ts:198`, `:230`, `:236`); placement returns the session cwd unless the agent is a worktree agent (`src/plugins/run-agent/placement.ts:27-33`).

Correction: "inside the session cwd, with the session's trust" is unsafe if taken literally. The child copies the parent's trust flag (`pi-child.ts:190-192`). With that flag, pi loads the child cwd's `.pi/extensions`, `.pi/skills` dirs into the package resolver and runs project extensions (pi dist `core/package-manager.js:2024-2038`) and reads `<child cwd>/.pi/mcp.json` (pi dist `extensions/mcp/config.js:105-110`). pi's own trust is per directory, nearest entry wins (pi dist `core/trust-manager.js:20-33`), and a folder with no `.pi` resources counts as trusted without asking (pi dist `core/project-trust.js:22-24`). So a session started in a bare workbench is "trusted", and a cloned repo below it with its own `.pi/extensions` would run that code in an agent although pi would have asked before running it in a session. Section 2.2 fixes this in the adapter.

Two more facts the company design depends on:

- Context files load from the child cwd and its parents (pi dist `core/resource-loader.js:465-470` calling `loadProjectContextFiles`). The workbench and department `AGENTS.md` reach an agent in `be/order-service`, as A.4 assumes.
- Project MCP config is read from the child cwd only, without walking up (pi dist `extensions/mcp/config.js:108`). A tracker server in the workbench's `.pi/mcp.json` would not reach an agent whose cwd is a repo. The example README puts it in `~/.pi/agent/mcp.json`, which is right; the docs should say why.

### Item 4: verifier

Exists: `agents/chores/verifier.md:1-21`, routing line `prompts/main-session.md:9`.

### Item 7: the main-session prompt

What is replaced, confirmed: subagents sets `customPrompt` and fills the `tools`, `rules` and `docs` sections (`core/adapter/main-prompt.ts:64-74`, applied at `core/adapter/pi-adapter.ts:229-237`). pi renders `customPrompt` as the preamble (pi dist `core/system-prompt.js:77-79`), then keeps `addendum` (APPEND_SYSTEM.md), `project_context` (context files) and `skills` (pi dist `core/system-prompt.js:97-108`). One addition: pi feeds a user's `SYSTEM.md` into `customPrompt` (pi dist `core/agent-session.js:1290`), so subagents silently replaces it. That is acceptable but belongs in the README.

Is there a conflict with a company `feature` skill? Yes, and the planner line is the smaller part:

- `main-session.md:1` limits the main session to "one short file, one orienting command or a trivial edit yourself; anything more ... goes to an agent".
- The example `feature` skill makes the main session read `WORKBENCH.md`, the ticket over MCP and `docs/contract.md`, write `spec.md` and the briefs, and edit the stage log (`../company/example/skills/feature/SKILL.md`, "Before the first stage", stages 3 and 4).
- `main-session.md:1` and `:7` also push splitting work to `planner`, while stage 4 says the main session splits (with `tech-lead` for multi-repo).

A `/skill:feature` call puts the skill body into the user message (pi dist `core/agent-session.js:1698-1710`), so in practice the model usually follows the skill. "Usually" is the problem: the likely failure is the model delegating the spec or briefs to `general`, which breaks the phase-boundary rule the workflow relies on.

Smallest fix: one generic sentence in `main-session.md`, no company words. Options compared:

- Settings-level prompt override (`mainPrompt: <path>` in `pi-subagents.json`): rejected. The company would fork the whole prompt and drift from every routing change; it also adds a file the harness must validate.
- Appended company section: already possible without harness code, through `APPEND_SYSTEM.md` or the workbench `AGENTS.md`. But it fights the preamble instead of being invited by it, and every company would have to discover the need.
- Softer wording with a precedence rule: chosen. Add to the end of `main-session.md:1`: "When a skill or the user says who does a step (you or a named agent), follow that over this guide." About one line. The routing live test (`test/live/routing.live.test.ts`) guards that routing without a skill does not change.

### Item 9: what `mcp: true` grants

Exists, all or nothing. Precisely, an agent with any tool and `mcp: true` loads pi's MCP built-in in its own session (`pi-child.ts:121-138`, `:222`) and gets `mcp__*` plus the three resource tools in its allowlist (`pi-child.ts:97-119`). That built-in connects:

- every enabled server in `<agentDir>/mcp.json`;
- every enabled server in `<agent cwd>/.pi/mcp.json` when the child counts as trusted (pi dist `extensions/mcp/config.js:105-110`, default loader `extensions/mcp/index.js:1201-1202`);
- servers registered by extensions loaded in the child with `pi.registerMcpServer()` (pi dist `extensions/mcp/index.js:247-260`).

If the main session has the MCP built-in disabled, no agent gets it (`pi-child.ts:135`, `pi-adapter.ts:496`).

A per-server allow list is feasible without touching pi's config loading. When any allowlist entry starts with `mcp__`, pi unregisters every MCP tool that does not match (pi dist `core/agent-session.js:193-197`, `:1123-1131`), so codemode and `tool_search` cannot reach it either. Entries may be `*` patterns (pi dist `core/mcp-servers.js:19-23`). Tool names are `mcp__<server>__<tool>` with every non-alphanumeric character turned into `_` (pi dist `extensions/mcp/tools.js:46`). So the adapter only needs to replace `mcp__*` in `childToolNames` with one pattern per allowed server or tool. Filtering in `loadConfig` instead (an option of `createMcpExtension`, pi dist `extensions/mcp/index.d.ts`, `McpExtensionOptions.loadConfig`) would also stop the other servers from connecting, but `loadMcpConfig` is not exported (pi dist `index.d.ts:32` exports only its types), so the adapter would have to re-implement pi's config parsing. Rejected.

## 2. Harness changes to build

Three changes and one sentence; 2.1 is dropped, so two changes and one sentence remain. All agent-facing names stay abstract: no company, provider or model words.

### 2.1 Agent files from pi packages (dropped)

**Dropped by the owner on 2026-10-18: excessive.** Company agents are installed into the user agent dir or a project's `.pi/agents`, for example by the example's `install-agents.sh`. The design below is kept for reference only.

**Contract.** A pi package lists agent folders in its own `package.json`:

```json
{ "pi": { "skills": ["./skills"] }, "pi-subagents": { "agents": ["./agents"] } }
```

- `pi-subagents.agents` is a list of paths relative to the package root. Each folder is walked like `<agentDir>/agents` (subfolders included).
- No setting is needed. Installing the package with `pi install` is enough; `/reload` picks up changes.
- Order of sources, later wins: builtin, user-scope packages, `<agentDir>/agents`, project-scope packages (trusted project only), `.pi/agents` (trusted only). A user can still override a package agent with a same-named file or with `agents.<name>` in `pi-subagents.json`.
- New `AgentSource` value `"package"` (`src/model/types.ts:80`); `/agents setup` sorts package agents with "your own agents" (`src/plugins/agent-setup/index.ts:25`).
- Warnings, through the existing `notifyOnce` (`src/plugins/agent-definitions/index.ts:21-26`):
  - `pi-subagents: package <source>: pi-subagents.agents must be a list of relative paths; ignored`
  - `pi-subagents: package <source>: agents path "<p>" leaves the package; ignored`
  - `pi-subagents: package <source>: agents folder <path> not found`
  - invalid agent files report as today (`index.ts:57-63`).

**Where it plugs in.**

- `core/adapter/contract.ts:265-297`: new `Host.packages(): { source: string; scope: "user" | "project"; path: string }[]`, only installed packages.
- `core/adapter/pi-adapter.ts`: implement it with `new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }) }).listConfiguredPackages()`, dropping entries without `installedPath`. This is the only pi import, and it stays in the adapter.
- `extensions/subagents/src/model/paths.ts`: a pi-free `packageAgentDirs(packages)` that reads each `package.json`, validates the key and resolves paths inside the root.
- `src/plugins/agent-definitions/index.ts:42-48`: insert the package dirs into `dirs` in the order above; project-scope ones only when `info.projectTrusted`.

Rules respected: only `core/adapter` imports pi; subagents reads plain JSON files; no extension imports another; the key names no provider. Nothing is written, so the file rule in AGENTS.md is untouched.

**Alternatives.**

- (a) `agentDirs` list in the user `pi-subagents.json`. Simple and pi-free. Rejected as the main path: the user must type the install folder, which differs for npm, git and local installs and is pi's business; a fresh machine needs a manual step; two places describe one package. Worth keeping in reserve for agent folders that are not packages, but nobody asked for that.
- (b) Package discovery, chosen. Zero setup, follows pi's own model (packages carry resources, trust gates project packages), and the API exists. Cost: one adapter method. Why an explicit key and not a conventional `agents/` folder: other ecosystems ship `agents/*.md` with a different frontmatter (for example Claude Code plugins); a convention would turn every such package into a stream of "invalid agent file" warnings.
- (c) Follow symlinks in the loader walk. About ten lines (`statSync` on symlink entries plus a realpath set against loops), and pi's own resource walk follows file symlinks (pi dist `core/package-manager.js:180, :222, :244`). Rejected as the main path because it needs a manual link per machine. Worth doing anyway as a small consistency fix; see decision 6.

**Tests** (`extensions/subagents/test/`, plus `core/test/adapter/`):

- `model/paths.test.ts`: "reads pi-subagents.agents from a package.json", "ignores a path that leaves the package root", "ignores a package without the key", "reports a non-list value".
- `plugins/agent-definitions/agent-definitions.test.ts`: "loads agents from a user-scope package between builtin and the user dir", "a user agent file overrides a package agent of the same name", "skips project-scope package agents in an untrusted project", "applies agents.<name> overrides to a package agent", "tags package agents with source package".
- `plugins/agent-setup/agent-setup.test.ts`: "lists package agents with the user's own agents".
- `core/test/adapter/pi-adapter.test.ts`: "packages() returns installed user and project packages with their paths" (temp agent dir with a local-path package in `settings.json`), "packages() leaves out project packages when the project is not trusted".
- The fake host in `test/helpers/harness.ts` gets a `packages` stub.

**Size.** About 8 files touched, 80 lines of code, 150 lines of tests, 20 lines of docs (README sources list, ARCHITECTURE adapter section, STRUCTURE).

### 2.2 `cwd` on `run_agent`

**Contract.**

- New optional item field: `cwd: string`. Description: "Directory to run this agent in: a path relative to your working directory, or an absolute path inside the session's working directory. Omit to run where you run."
- Resolution: relative to the caller's cwd (the session cwd for the main session, the agent's cwd for an agent). Then `realpath`. It must exist, be a directory, and be the session cwd or inside it after symlinks are resolved.
- Default: the caller's cwd. An agent started in `be/order-service` that starts a scout without `cwd` keeps the scout there.
- Successors from a handoff keep the cwd (they reuse the slot, `runner.ts:357-371`, `:373`).
- `worktree: true` with `cwd`: the worktree is made from the repo at `cwd` (`placement.ts:35` gets the target instead of the session cwd), checkout under `<cwd>/.pi/worktrees/`. AGENTS.md's file rule already says `<cwd>/.pi/worktrees/`; it should say "the agent's cwd".
- Errors, checked in `startBatch` with the skill errors so nothing in the batch starts (`runner.ts:783-791`):
  - `<agent>: cwd "<value>" is outside the session directory <session cwd>. Nothing was started.`
  - `<agent>: cwd "<value>" does not exist or is not a directory. Nothing was started.`
- The run_agent start block and `/agents` view show the cwd when it differs from the session cwd (manifest field `cwd`, `src/plugins/agent-registry/registry.ts:41`).
- Prompt: one line in the Brief section of `main-session.md:18-27`: "Set `cwd` when the work belongs to one directory below yours, such as one repository; its AGENTS.md then reaches the agent."

**What the target directory brings, and what it does not.**

- Brings: context files of the target and its parents (pi loads them from the child cwd); tools run there; `<target>/.pi/mcp.json`, `.pi/settings.json`-driven resources and `.pi/extensions` only when the target is trusted (below).
- Does not bring: the target's `.pi/agents` and `.pi/pi-subagents.json`. Agent definitions and settings belong to the session (`src/plugins/agent-definitions/index.ts:42-55`, `src/model/settings.ts:140-156`), and nested agents use the session's runner through custom tools (`src/plugins/run-agent/index.ts:52`, `:99`). One registry and one settings set per session keeps routing, overrides and limits predictable. Say this in the README.
- Does not bring: the target's own skills (item 1, caveat 2).

**Trust.** In `core/adapter/pi-child.ts`, replace `projectTrusted: ctx.isProjectTrusted()` (`:190-192`) with a `childTrust(ctx, spec.cwd)`:

- same directory as the session: the session's flag, as today;
- session untrusted: untrusted;
- otherwise: trusted when the target has no trust-requiring resources of its own, or when pi's trust store trusts the target (nearest entry). pi exports both helpers, `hasTrustRequiringProjectResources` and `ProjectTrustStore` (pi dist `index.js:32`). Else untrusted: the agent still runs and still gets AGENTS.md, but no `.pi` settings, extensions or mcp.json of the target.

No prompt and no refusal: an agent cannot ask the user (README:44). The run's result can carry a one-line note "(cwd <path> is not trusted; its .pi resources were not loaded)" so the main session can tell the user to trust it. Session-only trust decisions are not in the store; that case falls back to untrusted, which is the safe side.

What is not refused: a dirty tree (the harness does not judge git state; `main-session.md:16` already forbids two editing agents on the same files), an untrusted session (the agent simply runs untrusted), a non-git directory (only `worktree: true` needs git, and it reports its own error, `placement.ts:35-39`).

**Where it plugs in.** `src/plugins/run-agent/tools.ts:142-174` (schema), the `BatchItem` type, `runner.ts:748-791` (validation), `runner.ts:583-604` and `placement.ts:22-48` (placement takes the resolved cwd), `src/model/types.ts:73`, `:100-113` (`cwd` on `AgentRecord` and `NewAgent`), `registry.ts:41` (manifest), `core/adapter/pi-child.ts:190-192` (trust). No new pi import outside the adapter; no provider knowledge; the file rule changes only in wording.

**Alternatives.**

- Any absolute path with a per-directory trust check: rejected for now. It lets one session drive repos it was not started in, and the session's agent registry and settings would apply to a project that has its own. A second pi session in that directory is the honest answer.
- Repo names resolved through a workspace file (spec 04): rejected; the owner dropped the workspace extension, and a path is enough.
- Inherit the session's trust flag unchanged: rejected, see item 3.
- Default to the session cwd for nested agents: rejected; a lead started in a repo would scatter its scouts back to the workbench root, which is never what the brief means.

**Tests.**

- `plugins/run-agent/cwd.test.ts` (new): "spawns the child in the given subdirectory", "resolves a relative cwd against the session cwd", "refuses a cwd outside the session cwd and starts no agent of the batch", "refuses a symlink inside the session that resolves outside", "refuses a missing path or a file", "an agent's nested agent without cwd runs in the caller's cwd", "a nested relative cwd resolves against the caller's cwd", "a successor keeps its predecessor's cwd", "records cwd in the manifest when it differs from the session cwd".
- `plugins/run-agent/worktree.test.ts`: "a worktree agent with cwd creates its worktree from the repo at cwd".
- `plugins/run-agent/describe-run-agent.test.ts`: the schema lists `cwd` and stays `additionalProperties: false`.
- `core/test/adapter/pi-child.test.ts`: "a child in the session cwd keeps the session's trust", "a child in a subdirectory with its own .pi/extensions and no trust entry runs untrusted", "a child in a subdirectory without .pi resources keeps the session's trust", "a child in a subdirectory trusted by the trust store is trusted".
- `test/live/run-agent.live.test.ts`: one case where an agent with `cwd` reports a word that only the subdirectory's AGENTS.md holds.

**Size.** About 10 files, 120 lines of code, 220 lines of tests, 25 lines of docs.

### 2.3 MCP server and tool filter

**Contract.** Frontmatter `mcp` accepts `true`, `false` or a list:

```yaml
mcp: [tracker, "wiki:get_*"]
```

- A plain entry is a server name as written in `mcp.json` or as registered; it allows `mcp__<server>__*`.
- `server:pattern` allows only matching tools of that server; `*` matches any characters.
- The adapter maps names the way pi does (non-alphanumeric to `_`, pi dist `extensions/mcp/tools.js:46`), so `acme-tracker` becomes `mcp__acme_tracker__*`.
- With a list, the resource tools are left out, since they reach every server with resources (pi dist `core/mcp-servers.js:24`); `codemode` and `tool_search` stay.
- `[]` is an error: "mcp: use false for no MCP, or list server names". A name that does not match any server is not an error at load time (servers can be per project); the agent simply has no such tools.
- Not part of `agents.<name>` overrides (item 10 stays not needed).

Limits to document: servers outside the list still connect in the agent's session, and their names can appear in the `mcp_servers` prompt section, but their tools are not registered, so they cannot be called. This is a guard against accidental writes, not a sandbox. The prose rule in `tech-lead` stays.

**Where it plugs in.** `src/plugins/agent-definitions/fields.ts:57` (new field kind "switch or list"), `src/model/agent-schema.ts:20` (`mcp?: boolean | string[]`), `runner.ts:612` (pass through), `core/adapter/contract.ts:340` (`SpawnSpec.mcp?: boolean | string[]`), `core/adapter/pi-child.ts:103-119` and `:135` (patterns instead of `mcp__*`, load the built-in for a non-empty list). The name mapping lives in the adapter, which is where MCP tool naming is already known. README rows `:65`, `:69`, `:95`; agent template comment in `src/plugins/agent-setup/agent-template.ts`.

**Alternatives.** A `loadConfig` filter (rejected above: duplicates pi's unexported config parser). `tools` entries with raw `mcp__…` patterns (rejected: today `childToolNames` adds `mcp__*` whenever MCP is on, so the meaning of `tools` would change for every agent, and authors would need to know pi's naming). Server-only filter without tool patterns (rejected as the only form: the use case is "read the tracker, never write it", and one server holds both).

**Tests.**

- `plugins/agent-definitions/fields.test.ts`: "mcp accepts true, false and a list of server names", "mcp rejects [] and non-string entries", "mcp accepts server:pattern".
- `plugins/run-agent/mcp.test.ts`: "passes an mcp list to the spawn unchanged".
- `core/test/adapter/conformance.test.ts`, "tool list filtering": "an mcp list keeps only the listed server's tools, also tools registered after the start", "a server:pattern entry keeps only matching tools", "an mcp list drops the resource tools", with the existing late-registered MCP fixture (`conformance.test.ts:441-530`).
- `test/live/grants.live.test.ts`: one fixture agent with `mcp: [fixture]` and one with `mcp: ["fixture:none_*"]`, read from the session file.

**Size.** About 8 files, 60 lines of code, 120 lines of tests, 15 lines of docs.

### 2.4 Main prompt precedence sentence

One sentence at the end of `prompts/main-session.md:1`, quoted in item 7. Update `core/test/adapter/main-prompt.test.ts` only if it pins the text; run `npm run test:live` routing locally once. Size: two lines.

## 3. What happens to future-plans

| File | Verdict | Reason |
|---|---|---|
| `00-overview.md` | rewrite | Its eight decisions, delivery order and `company-conventions/` layout assume harness-side workflows, workspace and guards; replace with one page: harness primitives, company side elsewhere, the list below. |
| `01-workflows.md` | drop | Engine, workflow files and `start_workflow`/`finish_stage` are company territory as skills (company-side B.1). The verifier part shipped in 5a3846f. The `(shape: no verification)` note was never built and is not needed. |
| `02-plan-mode.md` | drop | Owner decision. |
| `03-idle-handoff.md` | drop | Owner decision. |
| `04-workspace-and-epic.md` | drop | Owner decision; its only surviving piece, `cwd`, is now 2.2 and much smaller (no repo names, no worktree on first use, no `pi-workspace.json`). |
| `05-code-exploration.md` | drop | Owner decision; a code map is a company skill if anyone wants one. |
| `06-project-rules.md` | drop | Owner decision on guards; `tools`/`mcp` overrides are not needed (item 10); the MCP filter is 2.3. |
| `README.md` | rewrite | Index of the new short list. |
| `workflows.html` | drop | Rendering of the old plan. |
| `research/` | keep as archive | Evidence still cited (pi capabilities, process catalogue); mark it as background for the dropped specs. `spec-review.md` reviews the dropped draft and can go. |

Proposed deliverables, in order:

0. Verifier chore and complexity-based routing. Done (5a3846f).
1. `cwd` on `run_agent` with per-target trust (2.2). Should.
2. Main prompt precedence sentence (2.4). Tiny, independent, removes the routing conflict for any skill-driven workflow.
3. MCP server and tool filter (2.3). Could; ship when a company agent with tracker access exists.
4. `examples/company/` from `../company/example/`, with `install-agents.sh`, plus README notes: user-scope install, global `mcp.json`, SYSTEM.md is replaced. Depends on 1.

Agent files from pi packages (2.1) was here as a Must; the owner dropped it as excessive, so companies install agent files with a script such as `install-agents.sh`.

Each ships alone with docs and `npm run check` green.

## 4. Open decisions for the owner

1. **Agent loading.** Decided 2026-10-18: dropped, agents are installed by script into the user agent dir or `.pi/agents`. The original recommendation follows. Recommend package discovery with an explicit `pi-subagents.agents` key in the package's `package.json`. Alternative: an `agentDirs` setting (no adapter change, but the user types pi's install path). Changes the adapter contract (new `Host.packages()`).
2. **Target trust for `cwd`.** Recommend per-target trust from pi's trust store, falling back to untrusted, with a note in the result. Alternative: inherit the session flag (simpler, but runs project extensions pi would have asked about).
3. **Bounds of `cwd`.** Recommend inside the session cwd only. Alternative: any path, which needs per-directory settings and agent sources and pulls back part of spec 04.
4. **Nested default.** Recommend that agents without `cwd` run in their caller's cwd. Alternative: always the session cwd.
5. **`worktree: true` with `cwd`.** Recommend allowed, worktree made from the target repo, with the AGENTS.md wording "the agent's cwd". Alternative: refuse the combination in v1.
6. **Symlinks in agent folders.** Recommend following them as well (small, matches pi's own walk), independent of 1. Alternative: leave as is and document.
7. **MCP filter form.** Recommend server names plus `server:pattern`. Alternative: server names only, which does not stop writes on a tracker server that also reads.
