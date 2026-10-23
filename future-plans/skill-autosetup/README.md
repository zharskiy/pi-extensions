# Skill autosetup: the right skills per agent per project

Research date: 2026-10-22. Question: how to build, on top of `/agents setup`, a mechanism that picks the skills each agent should carry in a given project, keeps that choice current as the company's skill catalogue changes, respects what the developer changed by hand, and tells the developer what it did.

- README.md (this file): the problem, the design, the two shapes for the Claude Code transition, the decisions left to the owner, delivery order.
- research.md: the facts behind it: what this package has today, pi 1.4.0's surface, Claude Code's per-project state, and how other tools solve each piece.

## Summary

1. **The mechanism exists; the policy does not.** `/agents setup` already writes the per-project, per-agent skill list the feature needs (`agents.<name>.skills` in `.pi/pi-subagents.json`), the loader already validates it, and the inventory already lists every skill pi can find. What is missing is who decides the list, when it is recomputed, and how a recomputation and a hand edit coexist. This folder adds a policy layer, not a new storage.
2. **Relevance comes from the catalogue first, from a model second.** The company controls its catalogue, so each skill can say which agents want it and which projects it fits, in the portable `metadata` field of SKILL.md, which agentskills.io leaves to such keys and Claude Code ignores when it does not understand them. Matching is local, deterministic and free. Skills without that declaration (every Claude Code skill in the 1,029-file survey) go through a model-judged proposal that the user confirms, the way `/agents create` already briefs the main session.
3. **Reconciliation is a three-way merge with a record of the last automatic choice.** Catalogue, last applied, current file. A skill the user removed is never re-added; a skill the user added is never touched while it is installed; a skill the catalogue dropped is removed and said so; a new match is added (or proposed, by setting). This is the mise lockfile and Claude Code `renames` pattern, applied to one JSON key.
4. **"Once in a while" is every session start.** The catalogue changes mostly through `pi update`; any change, however made, shows up as a new fingerprint at the next session start. pi already tells the user at startup that an update exists, and the next session start after it reconciles. No timers, no watchers, nothing outside pi's own lifecycle.
5. **Claude Code is a source of signals, not a dependency.** With the import extension from claude-code-compat in place, imported skills are ordinary inventory entries and autosetup assigns them like any other. Claude Code's per-project files (`.claude/settings.json` plugin enablement, `.claude/skills`, `.claude/agents` with their `skills:` lines) are extra relevance signals for the transition. Once a catalogue carries its own `metadata`, those signals add nothing and the import extension keeps working on its own.

The main session is left as pi loads it in the first delivery. The two ways to trim it are listed under Phase 4 and carry an unverified limit of pi's own settings.

## The problem, restated

- One company catalogue (a pi package from a git remote, or Claude Code skills and plugins on disk), tens of skills, changing over time: added, removed, renamed, re-described.
- One developer, several unrelated projects: backend, frontend, QA automation. A session in `order-service` should not carry the Playwright skills.
- Each agent has a job. `reviewer` wants the review axes and the stack conventions; `implementer` wants the conventions and the build checks; `planner` wants the ticket and brief skills; chores want nothing.
- The developer may override anything. An automatic choice that fights a hand edit is worse than no automation.
- Everything that happens must be visible: a line in the session, a status command, and the file itself readable.

Today the shipped leads have `skills: []` and rely on the main session passing skills per task; `general` has `all`. Per project the only tool is `/agents setup`, by hand, per agent, per project, with no memory of why a skill was picked.

## Design

### D1. Storage: the existing override, plus a record of the automatic choice

The effective list stays where it is: `agents.<name>.skills` in the project's `.pi/pi-subagents.json`, written through the existing `writeChanges` merge (which keeps other top-level keys) and read by the existing loader (which replaces the agent file's list; an unknown name voids the whole skills override for that agent, with a warning, so the reconcile never writes a name that is not in the current inventory). Nothing downstream changes: `run_agent` still unions the fixed list with the per-task `skills` parameter.

The automatic choice needs a record, so that the next run can tell "the user removed this" from "we never added this". Recommended location: under pi's agent dir, keyed by the project the way pi keys sessions, so that the project file holds only the result and a committed `.pi/pi-subagents.json` does not churn with fingerprints:

```
~/.pi/agent/pi-subagents/auto/--Users-maxim-work-order-service--.json
```

```json
{
  "cwd": "/Users/maxim/work/order-service",
  "mode": "apply",
  "catalogue": "sha256:…",
  "project": "sha256:…",
  "checked": "2026-10-22T09:12:00Z",
  "applied": { "implementer": ["kotlin-conventions", "gradle-checks"], "reviewer": ["kotlin-conventions", "review-axes"] },
  "declined": { "implementer": ["docx"] },
  "seeds": { "claude": ["frontend-design"] }
}
```

- `mode`: `apply` (write and notify), `propose` (notify only, apply on command), `off` (never run again here). Set by the user's first answer and by `/agents setup auto mode <apply|propose|off>`.
- `catalogue`: hash of the sorted inventory entries (name, description, the `metadata` keys below). `project`: hash of the project signals (D3). Either changing triggers a reconcile.
- `applied`: per agent, the skills autosetup put there last time (the merge base). `declined`: per agent, skills autosetup once added and the user removed; never re-added, listed by `status`.
- `seeds`: Claude Code signals used, so the status output can say where a choice came from.

The alternative, an `auto` key inside `.pi/pi-subagents.json` itself, is simpler (one file, unknown top-level keys are already ignored by the settings parser) but puts machine state next to a file a team may commit. Decision 1.

### D2. Who is assigned: the catalogue says so

A skill declares its wishes in the portable `metadata` map of its frontmatter (agentskills.io: string to string, "use reasonably unique keys"; pi parses and ignores unknown keys; Claude Code documents that it ignores unknown fields; OpenCode uses the same map for its own keys, such as `opencode/autoinvoke`; the other harnesses are not verified):

```yaml
---
name: kotlin-conventions
description: Kotlin style and structure rules for Acme backend services. Use when writing or reviewing Kotlin.
metadata:
  pi-agents: implementer, reviewer
  pi-match: "**/*.kt, build.gradle.kts, dep:org.jetbrains.kotlin"
---
```

- `pi-agents`: comma-separated agent names. Names are checked against the loaded definitions; unknown names are ignored with one notice per name, so a catalogue can name company agents that only some developers have. `none` means never assign automatically (a skill meant for the main session or per-task passing only). Absent: no automatic assignment in Phase 1; a candidate for the model-judged proposal in Phase 2.
- `pi-match`: comma-separated conditions, any one is enough. A plain pattern is a glob over the project's relative file paths (`path.matchesGlob`, Node 22.5+). `dep:<glob>` matches a dependency name from a manifest. `remote:<glob>` matches the git remote URL. `dir:<glob>` matches the cwd's basename. `*` or absent means every project. A skill that matches nothing is not assigned; where it is already in a list it stays in `applied` until it is actually removed (D4) or the user acts, so the next run does not mistake it for a user addition.
- `pi-replaces`: a former name. A rename then moves the old name out of every list it was in and puts the new one in, with a notice, instead of looking like a removal plus a new match. Optional; a catalogue that does not use it gets remove-plus-add.

Why frontmatter and not a catalogue file: the inventory hands autosetup a SKILL.md path per skill, so reading the file is one `readFileSync` and the existing `yaml-lite` parser; a separate manifest would need a package root to locate, which the inventory does not know. Why not Claude Code's richer `relevance.signals` (CLI commands run, files read): those are usage signals that need a running session; `pi-match` is answerable at session start from the tree alone, which is what per-project setup needs.

### D3. What a project is: cwd plus cheap signals

Identity is pi's: the cwd, not the git root (`.pi/` is read at `<cwd>/.pi` only). Signals, all computed once per session start, bounded and gitignore-aware (see Not verified):

- relative file paths to depth 4, skipping `node_modules`, `.git` and gitignored entries, capped (say 5,000 entries; the glob only needs to find one match);
- dependency names from whichever manifests exist at the root: `package.json` (dependencies and devDependencies), `build.gradle(.kts)` and `pom.xml` (group:artifact strings), `pyproject.toml` and `requirements*.txt`, `go.mod`, `Cargo.toml`, `*.csproj`, `Gemfile`, `composer.json`;
- the `origin` remote URL from `.git/config` (no git process);
- the cwd basename;
- Phase 3 only: Claude Code's project files (D6).

The `project` hash covers the signal set, so adding a Playwright config to a backend repo re-evaluates at the next start. The hash, not the signal list, is stored.

### D4. Reconcile: three-way merge per agent

Inputs per agent: `base` = `applied[agent]` from the record (empty on first run), `ours` = the effective list after `mergeOverrides` layers the project file's `agents[agent].skills` over the user-scope `<agentDir>/pi-subagents.json` (or the agent file's list when neither overrides it; `all` is left alone entirely), `theirs` = the new match set from D2 (or the confirmed proposal from Phase 2), `declined[agent]`.

| Skill is in | Action |
|---|---|
| theirs, not base, not ours, not declined | add; notice `+name` |
| theirs, not base, in declined | skip; counted in `status` as declined |
| theirs, in ours | keep; tracked in `applied` only if autosetup added it or it was in the list on first run; a skill the user added by hand stays untracked even though it matches |
| base and ours, not theirs, gone from the inventory | remove; notice `−name (removed from catalogue)` |
| base and ours, not theirs, still in the inventory | notice only in every mode (`−name (no longer matches)`, as "would remove"); stays in `applied`; `auto apply` removes |
| base, not ours | user removed it: add to `declined` and drop from `applied`, never re-add |
| ours, not base, not theirs | user added it: keep, do not track |
| ours, not base, gone from the inventory | remove in every mode, even if the user added it; notice `−name (no longer installed)`; leaving it would void every other skill for that agent (D1) |

`theirs` for `pi-replaces` renames is computed after rewriting the old name in `base`, `ours` and `declined`. The merge writes only agents whose list changed, to project scope only (never the user file), through the same `SetupChange` patches and `writeChanges` call the form uses, then `definitions.reload()`, exactly like a form save. Agents already running keep their lists.

The record is written after the file; a crash between the two leaves a file ahead of its record, which the next run treats as user additions (kept) and never as data loss.

### D5. When it runs, how it asks, how it tells

- **First contact, per project.** At session start in a trusted project with no record, when at least one skill declares `pi-agents` (or, in Phase 3, when Claude Code seeds exist): a single-choice prompt in tui mode, built over `showForm` with core/manager/select.ts (`HostUi.confirm` returns only a boolean), once: "N skills match this project for M agents. Set them up? Yes / Review (`/agents setup`) / Never for this project". Yes writes with `mode: apply`; Review opens the form prefilled with the proposal and records `propose`, and its save goes through the D4 path with the confirmed set as `theirs`, so the record is written with the file (a plain form save calls only `writeChanges`); Never records `off`. Outside tui nothing is asked and nothing is written; the notice says `/agents setup auto` is available. (VS Code recommendations pattern, with a throttle in the spirit of Claude Code's relevance tips.)
- **Every later session start**, in a trusted project only (the project file is not even read otherwise), including `/reload`, which is a session start to the extension: after the inventory scan, recompute both hashes; if either differs, reconcile per `mode`. `apply` writes and notifies; `propose` notifies and waits for `/agents setup auto apply`; removals that only lost their match wait in both modes. Cost when nothing changed: one frontmatter read per skill plus the bounded tree walk, no model call.
- **Commands.** `/agents setup auto` prints per agent: auto-set skills, user-added, declined, pending changes, and the mode; `auto mode <apply|propose|off>` sets the mode; `auto apply` applies the pending changes; `auto suggest` sends the model-judged brief (D7); `auto reset` clears `declined` and the record so the next run starts over. The one-line and form flows stay as they are; a form edit is simply "ours" at the next reconcile.
- **Notice shape**, one line per run, through `host.ui.notify`: `agent skills: implementer +kotlin-conventions +gradle-checks, reviewer +review-axes −docx (removed from catalogue); saved to .pi/pi-subagents.json; /agents setup auto`. In `propose` mode the verb is "would add" and the line ends with `/agents setup auto apply`.
- **The form** shows an `auto` marker next to skills that came from autosetup, so the user can see what is theirs and what is not before unticking. Small, optional.

Ordering at session start: the adapter's `session_start` runs the inventory scan before the host handlers; subagents loads settings, then definitions. Autosetup hooks `onSessionStart` after the definitions plugin (it needs the agent names and the catalog), writes, then calls `definitions.reload()`, the same path the form uses. Nothing in pi needs to change.

### D6. The Claude Code transition: two shapes

Both assume the import extension recommended in claude-code-compat (Phase 1: `.claude/skills` and `~/.claude/skills` through `Host.discoverResources`; Phase 2: enabled plugins' skills). Through pi's loader those skills enter the inventory like any other, with `sourceInfo.source` set to the importing extension's label. One adapter change is needed for either shape: `SkillFile` gains a `source` field from pi's `sourceInfo` (today the inventory keeps only name, description and path), so autosetup and `status` can say where a skill came from.

**Shape A: autosetup as the transition layer.** Autosetup reads Claude Code's per-project state as seed signals, in a trusted project only:

| Claude Code file | Signal |
|---|---|
| `.claude/settings.json` and `settings.local.json` `enabledPlugins` (`"name@marketplace": true`, managed over local over project over user) | the skills of an enabled plugin are relevant to this project; without a `pi-agents` key they go to the leads (`planner`, `implementer`, `reviewer`) |
| `.claude/skills/<name>` | a project skill is relevant here by construction; same lead default |
| `.claude/agents/<name>.md` `skills:` | an explicit agent-to-skill mapping; honoured when the agent name exists here (after claude-code-compat Phase 3 translates plugin agents, their `skills:` lines count too) |
| `CLAUDE.md` | read by pi already as a context file; not a signal |

The seeds feed `theirs` for D4 and are listed under `seeds` in the record, so the user can see which choices rest on Claude Code state. The Phase 2 model-judged proposal uses the same seeds as evidence in its brief. A developer who moves from Claude Code to pi gets, on first contact, "N skills from your Claude Code setup match this project", confirms, and has the same per-agent setup they had, now per agent rather than everything everywhere.

**Shape B: the import stands alone, autosetup is optional.** The import extension owes nothing to autosetup: it discovers, registers `/name` commands and sets the tool-name prompt section whether or not autosetup is enabled. A user with Claude Code files and autosetup off gets every imported skill in the main session and `/agents setup` by hand, as today. A user with a pi-package catalogue and no Claude Code files never sees the seed code path. The two meet only in the inventory and the `source` field.

**Transition out.** A catalogue that adopts `pi-agents` and `pi-match` in its SKILL.md files works unchanged in Claude Code, which ignores unknown fields, and in pi, which acts on them; Cursor, Codex and OpenCode follow the same spec and should leave the keys alone (not verified). Once the company's skills carry the keys, autosetup's `theirs` comes from D2 alone, the Claude Code seeds become redundant (a seed and a declaration that agree change nothing; one that disagrees is reported by `status`), and the developer can delete `.claude/` without losing the setup, because the result lives in `.pi/pi-subagents.json` and the record under the agent dir. Recommendation: annotate the catalogue once, use the seeds only for the months in which both harnesses run side by side.

### D7. Model-judged proposal (Phase 2)

For skills with no `pi-agents` key (all of today's Claude Code skills) and for projects whose stack no `pi-match` anticipated:

- `/agents setup auto suggest` builds a brief, the way `/agents create` does, and sends it with `host.sendHiddenMessage`. The brief carries: the project signals (D3) in a few lines, the agents with their descriptions and current lists, the candidate skills with descriptions, the Claude Code seeds (D6) when present, and the rules: leads only, chores never, prefer fewer, a skill fits an agent when its description names that agent's job.
- The main session answers by calling a model-only tool `agent_skills_proposal` (registered by the agent-setup plugin) with `{ assignments: { agent: [skills] }, reasons: { skill: "why" } }`. The tool validates names against the definitions and the inventory, shows the user a form with the proposal (the existing multi-select over the setup form, prefilled), and on confirm writes through D4 with the confirmed set as `theirs`. A tool is preferred to "write the file yourself" because the record has to be updated in step with the file, which the extension can do and the model should not.
- The proposal is never automatic: first contact offers `Review`, and the model is only consulted on `auto suggest`. `questionnaire` is not used here; its questions are single-choice, and the setup form already has the right checklist.

This phase is sonnet-grade work on the brief and the tool, with the design above fixed; the one open point is whether a proposal should also be offered at first contact when no skill is annotated (Decision 4).

### D8. The main session (Phase 4, optional)

Out of scope for the first delivery, as the owner suggested. Two routes exist if wanted:

- **Pi's own per-project exclusions.** Project `.pi/settings.json` `skills: ["-<path>", "!<glob>"]` is what `pi config --local` writes. Autosetup could write `-path` entries for skills that match no agent and no `pi-match` for this project. Limit, read from pi's code and not verified by running it: project-scope patterns filter project-discovered skills and package skills (through a package entry with `autoload: false` as a delta), not user-level auto-discovered skills. Also a new project file write for this package (`.pi/settings.json` is pi's, not ours), which the AGENTS.md rule would need to name.
- **The deferred `skill` tool** from skills-in-main-session: the main session carries zero skill tokens and asks for a body by name. Orthogonal to autosetup; `status` could feed the tool's listing.

Recommendation: ship Phases 1 to 3 first and measure the main session's `<skills>` section with the context breakdown; most catalogue skills are agent-facing and `disable-model-invocation` already keeps user-invoked workflows out of the prompt.

## Decisions for the owner

1. **Where the record lives.** Recommended: under the agent dir keyed by cwd (D1), so the project file holds only the result; the AGENTS.md rule already covers the agent dir, so this needs no rule change, only a line in ARCHITECTURE.md's persistence summary. `<agentDir>/pi-subagents/` is already the per-session namespace for sessions without a file (model/paths.ts:10), so the `auto/` subfolder must be named deliberately, so that nothing walking that namespace takes it for a session, or the record moves to a sibling folder. Alternative: an `auto` key in `.pi/pi-subagents.json`, one file, visible in git, which the rule would have to name. Either way the automatic write of `agents.<name>.skills` needs the rule's phrase "written on the user's command" to say that the user's first answer (or `auto mode apply`) is the command for the later automatic writes.
2. **Default mode.** The owner's sketch is apply then notify; the recommendation is that `apply` writes additions and removals of skills gone from the inventory, while removals that only lost their match are a notice in every mode until `auto apply` (D4, row five), so that a changed project signal never silently narrows an agent. A single `mode` with these fixed semantics is simpler than two settings.
3. **Metadata key names.** `pi-agents`, `pi-match`, `pi-replaces`, string values. Alternative: one `pi-subagents` key with a mini-syntax. The three keys read better in a SKILL.md.
4. **First contact when nothing is annotated.** Offer the model-judged proposal (Phase 2) at first contact, or only on command. Recommended: on command only, to keep session start free of model calls; the first-contact prompt mentions `auto suggest`.
5. **Chores.** The catalogue may name a chore in `pi-agents` (for example a `shell` skill that explains the company's check script). Recommended: honour it; the shipped chores stay at `[]` unless a skill asks. The model-judged proposal still never proposes chores.
6. **Shape A and B together or B first.** Shape B costs nothing beyond the `source` field. Shape A is Phase 3 and depends on claude-code-compat Phases 1 and 2. Recommended: build Phase 1 against a pi-package catalogue, add the seeds when the import extension exists.
7. **Committed project file.** If a team commits `.pi/pi-subagents.json`, each developer's reconcile changes it. Recommended: say so in the README and leave it to the team; the record-under-agent-dir choice already keeps the hashes out.

## Delivery order

1. **Phase 1, declared matching.** Adapter: `source` on `SkillFile`. Subagents, in the agent-setup plugin: frontmatter metadata reading (`pi-agents`, `pi-match`, `pi-replaces`), project signals, the record file, the three-way reconcile, `/agents setup auto …`, optionally a loader change that drops unknown names one by one instead of voiding the override, the session-start check with the first-contact prompt, the notice, the `auto` marker in the form. Pure functions for signals, matching and merging with table tests; a harness test for session start with a temp catalogue. README section, AGENTS.md rule, ARCHITECTURE.md persistence, `npm run check` green.
2. **Phase 2, model-judged proposal.** The brief file, `agent_skills_proposal` tool, prefilled form. A live test in the style of `routing.live.test.ts` that gives the main session a small catalogue and checks the proposal names the right agents.
3. **Phase 3, Claude Code seeds.** After claude-code-compat Phases 1 and 2: `enabledPlugins`, `.claude/skills`, `.claude/agents` `skills:` as seeds, listed in `status`.
4. **Phase 4, main session**, only if the context breakdown shows the `<skills>` section matters after Phases 1 to 3.

Each phase ships alone with docs and `npm run check` green.

## Not verified

- That a project `.pi/settings.json` `skills` pattern cannot filter user-level auto-discovered skills (read from `addAutoDiscoveredResources`, not run). Matters only for Phase 4.
- That `yaml-lite` keeps a nested `metadata:` map as an object; it parses agent frontmatter today, which has lists but no nested maps. A flat fallback (`metadata.pi-agents` as a dotted key) is a one-line change if not.
- That `path.matchesGlob` semantics match the patterns catalogue authors will write (`**`, braces). It exists from Node 22.5 and package.json declares `node >=22.19.0`, so the open question is only whether 22.x still emits an experimental warning.
- How Claude Code records a marketplace's commit; `installed_plugins.json` carries `version`, `lastUpdated` and an optional `gitCommitSha`, which is enough for the catalogue hash on the Claude Code side but was read from the research, not from a live file.
- Whether the first-contact single-choice prompt is acceptable at session start in tui mode next to pi's own trust prompt and package-update box; the throttle (once per project, then never) limits the cost.
- That Cursor, Codex and OpenCode leave unknown `metadata` keys alone. Sourced: Claude Code ignores unknown fields, OpenCode reads `metadata` for its own `opencode/autoinvoke` key, and agentskills.io defines `metadata` as free string pairs; the others' handling was not checked.
- How the tree walk honours `.gitignore`. No gitignore parser is available to the package (pi's internal `ignore` must not be imported), so D3 needs either a parser dependency or a simple fixed skip list.
