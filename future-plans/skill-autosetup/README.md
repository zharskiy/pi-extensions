# Skill autosetup: `/agents setup` proposes each lead's skills for this project

Research date: 2026-10-22, revised 2026-10-25. Question: how to give each lead agent the right skills for the project the user is in, using the skills as pi finds them on the machine, without asking the user to tick boxes agent by agent.

- README.md (this file): the problem, the release 1 design, what release 2 would be if it is ever wanted, what is out of scope, the decisions left to the owner.
- research.md: the facts behind it: what this package has today (paths re-verified 2026-10-25), pi's surface, the few industry patterns that still apply.
- implementation.md: what it takes to build release 1: files, reused pieces, new pieces, tests, docs.

## Summary

1. **Release 1 is `/agents setup`, made smart.** There is one setup feature, not two. When the user runs `/agents setup` and no agent on this machine has a skills override yet, the command asks the main session for a proposal straight away and opens the setup form with it filled in. When some agent already has an override, the command first asks "Propose skills automatically? Yes / No" with Yes preselected, and opens the plain form on No. The user runs it whenever they want. Nothing runs on its own.
2. **Leads only, and the model never hears of chores.** The `subagents` grant decides: an agent that may start subagents (`subagents` not none, `all` included) is a lead, every other agent is a chore. Leads are the agents that delegate, so they are the ones whose skills shape the work; the folder an agent file sits in plays no part (release 1 used a `chores` path segment, which misclassified user-created agents). The brief lists leads only, the tool accepts leads only. `general` is a lead; its `skills: all` is kept unless the main session proposes a narrower list. The main session's own skills are not touched.
3. **Skills are taken as they are, minus the ones agents cannot use.** The inputs are the inventory pi already builds at session start (name, description, scope, path of every skill on the machine) and a glance at the project. No frontmatter keys, no catalogue conventions. Skills whose body names an interactive tool (AskUserQuestion, questionnaire and the like) are filtered out before the brief, because agents cannot ask anyone anything. Project-level skills are marked and preferred.
4. **The model judges, the user decides, the extension writes.** The brief tells the main session to say what kind of project this is first, then to pick at most five skills per lead, most useful first. It answers through a model-only tool. The tool validates, opens the setup form with the proposal in place and marked against the current lists, and on confirm writes through the path the form uses today: `.pi/pi-subagents.json` in a trusted project, then `definitions.reload()`, then one notice. The model never writes the file.
5. **Automatic re-runs are release 2, if ever.** The 2026-10-22 design (session-start reconcile, record, three-way merge, modes) is kept below as a sketch and in git history.
6. **Out of scope.** Claude Code files, company catalogues, chores, the main session, evals.

## Follow-up shipped

After release 1 the setup form changed on the same branch:

- The tab bar has a `Leads` row and a `Chores` row (ui-kit `groupedTabBar`), Submit closing the last; leads come first.
- `/agents setup` never changes a chore's skills: a chore's tab edits model and thinking and shows its skills as a fixed row, the one-line form refuses `skills=` on a chore, and a chore's own skills override does not trigger the Yes/No question. Existing chore overrides keep applying.
- A lead is an agent whose `subagents` grant is not none (`isLead` in `core/model/agent-record.ts`), replacing the `chores` path segment and the file `skills` grant. Overrides carry no `subagents`, so they never change the role. `general` joins autosetup: its brief line reads `skills: all (every skill of its caller)` and the prompt says a lead with `all` keeps it when left out and gets a list only when a narrower one fits better.
- The skills picker has an explicit, exclusive `all` row for every lead, ticked when the agent has `all`; it replaces "an `all` draft opens with nothing ticked and keeps `all` unless a box changed".
- The model, thinking and skills pickers filter as you type; the `a`/`n` shortcuts are gone from the setup form.

## The problem, restated

- A developer has tens of skills installed, from several sources, for several unrelated projects: backend, frontend, QA automation, devops.
- Each lead has a job. `reviewer` wants the review axes and the stack conventions; `implementer` wants the conventions and the build checks; `planner` wants the ticket and brief skills.
- Today the shipped leads have `skills: []` and rely on the main session passing skills per task. The only per-project tool is `/agents setup`, which asks the user to tick skills agent by agent with no help.
- The user may override anything and must see what was written and where.

## Release 1

### R1. The entry: `/agents setup`

The one-line form `/agents setup <agent> model=… skills=…` is unchanged. The bare `/agents setup`, in tui (outside tui it refuses, as today):

1. Reads whether any agent has a `skills` override by this extension on this machine: `agents.<name>.skills` present in `<cwd>/.pi/pi-subagents.json` (trusted project only, as pi reads it) or in `<agentDir>/pi-subagents.json`. Nothing checks this today; the merged settings the extension already loads carry it (project file only when trusted), with a direct file read as the alternative.
2. **No override anywhere** → runs autosetup (R2) without asking.
3. **An override exists** → a single-choice step "Propose skills automatically for this project? Yes / No", rendered over the ui-kit select with Yes preselected, so Enter starts autosetup; a digit or a move then Enter picks the other. Yes → autosetup. No → the plain form, as today. Esc → cancel, nothing happens.

### R2. Autosetup: gathering and the brief

In the extension, with no model call:

- **Leads** from `definitions.list()`: agents whose `subagents` grant is not none. Each with name, description, tools, current skills (`all (every skill of its caller)` for an `all` grant). Chores are not mentioned anywhere in the brief. Where the agent file sits does not matter.
- **Candidate skills** from `runtime.skillCatalog()`, which gains `scope` (`project`, `user` or `temporary`, taken from the resolved resource's metadata, not from pi's `sourceInfo.scope`, which marks most discovered skills `temporary`) and `path`. Then the interactive filter: the extension reads each SKILL.md body and drops a skill that names an interactive tool or a user prompt. The term list is one constant in the extension (`AskUserQuestion`, `questionnaire`, `ask the user`, `ask_user`, and whatever the owner adds); a match is dropped silently. A skill with an empty description is listed by name alone and said to be so.
- **The project**: cwd basename and its top-level entries (names only, bounded). The main session has `read` and `ls` and is invited to look at manifests and the tree itself.

The template `prompts/autosetup-skills.md` carries everything, because the main-session prompt says nothing about hidden briefs:

- the project lines and the invitation to read more;
- the leads, one line each: name, description, tools, current skills;
- the candidate skills, one line each: `- name [project]: description`, with `[project]` only on project-level skills;
- the rules, in this order: (1) decide what kind of project this is (frontend, backend, QA automation, devops, library, mixed…) and say so in one line; (2) for each lead pick the skills that fit its job in this kind of project, at most five, ordered from most to least likely to be useful; (3) prefer project-level skills; prefer fewer; a skill fits when its description names the lead's job or this project's stack; keep a current skill only if it still fits; (4) propose full lists, not deltas; (5) a skill whose description implies asking the user is never picked;
- the answer: call `agent_skills_proposal` once with `{ project: "<one line>", assignments: { <lead>: [<skill>, …] }, reasons: { <skill>: "<why, one line>" } }`; include a lead only when its list should change; do not write any file; do not run `/agents setup`; tell the user afterwards what was saved, from the tool's result.

The command sends the filled template with `host.sendHiddenMessage`, and sets the in-memory pending mark. It shows no notice.

### R3. The tool

`agent_skills_proposal`, model-only, registered by the agent-setup plugin at enable. The questionnaire extension is the precedent for a tool that opens a form.

- Refuses, with a message the model can relay, when no proposal is pending ("run /agents setup first"), when the session is not tui, when a lead is unknown or is not a lead (a chore or an `all`-grant agent is reported as "not set up here", nothing more), when a skill is not a candidate (unknown, or filtered as interactive), or when a list has more than five entries. Unknown names are an error, not a silent drop, so the model corrects and calls again. The mark stays set across a refusal.
- Opens the setup form, built from the same `SetupContext` as today, with the proposal as the opening draft per lead while the baseline for the change marks stays the current list. Every agent still has its tab, as today; chores open unchanged (see Follow-up shipped for the role rows and the fixed chore skills). A "Proposed" line in each proposed lead's tab shows the model's reasons, and the Submit tab shows the project classification.
- **Picker order**, in the form generally: when the skills picker opens for an agent, checked skills come first in the order of the list (the proposal's order, most useful first), then the rest in inventory order. The order is fixed while the picker is open; ticking or unticking never moves a row. The list the user confirms is written in that order.
- **Scope** is per project. In a trusted project the Submit tab offers project (default) and user, as today. In an untrusted project pi does not read the project file, so the form offers the user file only and says that the result applies to every project; the user is asked, never surprised.
- On confirm calls the plugin's `save(scope, changes)`: trust check, `writeChanges`, `definitions.reload()`, the usual notice. `save` has to return what it did so the tool can report it. On cancel writes nothing.
- Returns to the model a short result: saved per lead to which file, or "cancelled by the user", or "nothing to change". Clears the mark either way.
- **Asks for a fresh session.** The brief, the model's reading of the project and the tool call all sit in the main session's context for the rest of the session and are of no further use. After a save the tool's result gives the model the path, the changed agents and the suggestion to start a new session with /new, and the model relays them; no save notice is shown on this path. The extension does not run `/new` itself: closing a session is the user's call. Nothing is lost by it: the saved overrides apply to every agent started from now on, in this session or the next.

### R4. What the user sees

First time in a project, nothing overridden:

1. `/agents setup` → no notice.
2. The main session's turn: it may read a manifest, says "This is a Kotlin backend service", calls the tool.
3. The setup form opens, proposal in place, changed fields marked, checked skills first, one agent per tab, Submit tab with the scope and the project line.
4. Confirm → no notice; the file is written.
5. The main session says what it proposed and why, where it was saved, and suggests running `/new`.

Later, with overrides in place: `/agents setup` → "Propose skills automatically for this project? Yes / No" → Yes repeats the above over the current lists; No opens the form as before.

### R5. Files written

Only the files `/agents setup` writes today, through the same function: `<cwd>/.pi/pi-subagents.json` in a trusted project, `<agentDir>/pi-subagents.json` for user scope. The AGENTS.md rule already names `/agents setup` as the user's command for the project file; one clause notes that the write may follow a model tool call, after the user confirms the form.

### R6. The pending mark

A variable in the agent-setup plugin, in memory only: set when autosetup sends the brief, cleared when the tool finishes (confirm, cancel, nothing to change, save failure) or when the session starts again, never written anywhere. A stale mark can at worst open the form, which the user cancels; nothing is written without a confirm.

## Release 2, if ever: automatic re-runs

Not planned. If release 1 proves useful and the user wants the lists kept current without running the command, the 2026-10-22 design applies, condensed:

- Trigger: session start in a trusted project, when a hash of the inventory or of the project signals differs from the last run. No timers.
- Record: under pi's agent dir, keyed by cwd, holding `mode`, both hashes, `applied` (what autosetup put in each list last time) and `declined` (what the user later removed).
- Merge per lead: new match not in the list and not declined → add; in `applied` but gone from the inventory → remove; in `applied` but removed by the user → remember as declined, never re-add; added by the user → keep, do not track.
- Modes `apply`, `propose`, `off`, chosen once and changeable by command.
- The judge would still be the model, through the same tool, so a re-run costs a model call; that cost is the main reason to wait for a request before building it.

The full version is this README as committed on 2026-10-22 (`git log -- future-plans/skill-autosetup/README.md`).

## Out of scope

- **Chores.** Never in the brief, never accepted by the tool, their skills fixed in the form (model and thinking stay editable). A chore is an agent with `subagents` none; a chore that one day wants skills is a release 2 question.
- **The main session.** Its own skill list is pi's `<skills>` section and the skills-in-main-session folder. `general` is a lead like the others; it keeps `skills: all` unless a narrower list is proposed, and the form lets the user tick a subset or `all` for it.
- **Claude Code files.** Not read. If pi ever discovers Claude Code skills, they enter the inventory like any other skill and release 1 handles them with no change here.
- **Catalogue conventions.** No `pi-agents`, `pi-match` or `pi-replaces` metadata. Skills are judged by their descriptions.
- **Project packages, `pi update`, marketplaces.** How skills arrive on the machine is pi's and the user's business.
- **Evals.** No prompt-quality eval in release 1. Whether the model calls the tool once with full lists is learned by using it; the tool accepting a repeated call while the mark is pending is the fallback.

## Decisions

All settled on 2026-10-25:

- One feature under `/agents setup`; autosetup runs unasked when no agent has a skills override on this machine, otherwise a Yes/No step with Yes preselected.
- Chores are the agents whose `subagents` grant is none and never reach the model. The role comes from the grant, not the file's folder, so a user-created agent is classified by what it may do.
- At most five skills per lead, ordered most useful first, project-level skills preferred, the model classifies the project first.
- Project signals: the top-level listing only; the main session reads manifests and the tree itself. No manifest parsing in the extension.
- Interactive filter: tool names plus common phrases (`AskUserQuestion`, `questionnaire`, `ask_user`, "ask the user", "confirm with the user"), case-insensitive, over the SKILL.md body, one constant; every exclusion is named in the notice.
- Reasons in the form: a "Proposed" line per proposed lead and the project line on the Submit tab.
- Tool gating: the tool is accepted only while the pending mark is set by `/agents setup`.
- The mark is in memory; after a save the user is asked to start a new session with `/new`.
- The main session untouched; no eval; checked skills first and no re-sorting in the picker.

## Delivery order

1. **Release 1.** Adapter: `scope` on the inventory entries. Subagents: the override check and the Yes/No step in `/agents setup`, the lead filter, the interactive filter, the template, the project listing helper, the form's proposal draft and picker order, the untrusted-scope wording, the tool, the plugin wiring, tests (unit for the lead and interactive filters, the brief, the validation, the form draft and the picker order; a plugin test through the harness with a fake form for both entry paths), README/ARCHITECTURE/STRUCTURE of the extension, the adapter and the root, the AGENTS.md clause, `npm run check` green. Details in implementation.md.
2. **Release 2, if ever.** Automatic re-runs as sketched above, only on request.

## Not verified

- How the form behaves when the opening draft differs from the baseline: `initialSetup` today uses `initial` for both, so the change is small but untested.
- Whether the main session reliably calls the tool once with full lists; the tool accepting a repeated call is the fallback.
- The brief's size with a large inventory: a hundred skills at one line each are a few thousand tokens, once per command; the template cuts descriptions at a fixed length.
- The tool is declared to the model in every main-session request once registered (the adapter cannot register a tool inactive); the gate makes it harmless but not free.
