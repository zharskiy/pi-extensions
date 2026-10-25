# Skill autosetup: a command that proposes each agent's skills for this project

Research date: 2026-10-22, revised 2026-10-25. Question: how to give each subagent the right skills for the project the user is in, using the skills as pi finds them on the machine, without asking the user to tick boxes agent by agent.

- README.md (this file): the problem, the release 1 design, what release 2 would be if it is ever wanted, what is out of scope, the decisions left to the owner.
- research.md: the facts behind it: what this package has today (paths re-verified 2026-10-25), pi's surface, the few industry patterns that still apply.
- implementation.md: what it takes to build release 1: files, reused pieces, new pieces, tests, docs.

## Summary

1. **Release 1 is one command.** `/agents autosetup` asks the main session to propose a skills list per agent for the current project and lets the user confirm it in the setup form that already exists. The user runs it whenever they want: after installing skills, after cloning a project, after adding an agent. Nothing runs on its own.
2. **Skills are taken as they are.** The only inputs are the skill inventory pi already builds at session start (name and description of every skill on the machine), the agent definitions (name, description, tools, current skills) and a glance at the project. No frontmatter keys, no catalogue conventions, no file format of ours in SKILL.md. A skill written for any harness qualifies the moment pi lists it.
3. **The model judges, the user decides, the extension writes.** The command sends a brief to the main session, the way `/agents create` does. The main session answers through a model-only tool. The tool validates the names, opens the setup form prefilled with the proposal and marked against the current lists, and on confirm writes through the same path the form uses today: `.pi/pi-subagents.json` in a trusted project, then `definitions.reload()`, then one notice. The model never writes the file.
4. **Automatic re-runs are release 2, if ever.** The 2026-10-22 design (session-start reconcile, a record of the last automatic choice, three-way merge, `apply`/`propose`/`off` modes) is kept below as a sketch and in git history. It is not built until release 1 has been used and the user asks for it.
5. **Claude Code, company catalogues, chores and evals are out of scope.** Importing `.claude/` files is the claude-code-compat folder's question and may never be wanted. How a company publishes skills is the company's business; this feature works on whatever pi discovers.

## The problem, restated

- A developer has tens of skills installed, from several sources, for several unrelated projects: backend, frontend, QA automation.
- Each agent has a job. `reviewer` wants the review axes and the stack conventions; `implementer` wants the conventions and the build checks; `planner` wants the ticket and brief skills; chores want nothing.
- Today the shipped leads have `skills: []` and rely on the main session passing skills per task; `general` has `all`. The only per-project tool is `/agents setup`, which asks the user to tick skills agent by agent with no help.
- The user may override anything and must see what was written and where.

## Release 1: `/agents autosetup`

### R1. The command

`/agents autosetup` is a fourth word of the `/agents` command, next to `view`, `create` and `setup`, served by the agent-setup plugin. It needs the interactive terminal, like the form, because the confirmation is a form. Outside tui it says so and stops.

It gathers, in the extension, with no model call:

- the agents from `definitions.list()`: name, description, tools, effective skills list, every agent alike; agents whose grant is `all` are listed as such and excluded from the proposal, because there is nothing to pick for them;
- the inventory from `runtime.skillCatalog()`: name and description, as pi lists them; a skill with an empty description is listed by name alone and said to be so;
- the project: the cwd basename and its top-level entries (names only, bounded). Nothing deeper: the main session has `read` and `ls` and the brief invites it to look at manifests and the tree itself when the listing is not enough.

It fills a prompt template (`prompts/autosetup-skills.md`, next to `create-agent.md`), sends it with `host.sendHiddenMessage`, and notifies "asked the main session to propose agent skills". It marks a proposal as pending so the tool accepts the next call. The mark is an in-memory variable of the plugin: set here, cleared when the tool is called, gone when the session ends. A stale mark can at worst open the form, which the user cancels; nothing is written without a confirm.

### R2. The brief

The template carries everything, because the main-session prompt says nothing about hidden briefs:

- the project lines from R1 and an invitation to read more if needed;
- the agents, one line each: name, description, tools, current skills;
- the skills, one line each: `- name: description`;
- the rules: a skill fits an agent when its description names that agent's job or stack; prefer fewer; keep what is already there unless it clearly does not belong here; never propose for agents marked `all`; propose full lists, not deltas;
- the release 1 policy on chores: agents that do one mechanical job on instruction (run commands, fetch a page, describe an image, apply exact edits, find things in the code) get no skills in this release; propose only for agents that take a task needing judgement. This sentence is the only place chores are treated differently (see "Chores" below);
- the answer: call `agent_skills_proposal` once with `{ assignments: { <agent>: [<skill>, …] }, reasons: { <skill>: "<why, one line>" } }`, including only agents whose list should change; do not write any file; do not run `/agents setup` yourself; tell the user what was saved afterwards, using the tool's result.

### R3. The tool

`agent_skills_proposal`, model-only, registered by the agent-setup plugin at enable (the plugin has `host`, `definitions`, `runtime` and the `save` closure in scope). The questionnaire extension is the precedent for a tool that opens a form.

- Refuses, with a message the model can relay, when no proposal is pending ("run /agents autosetup first"), when the session is not tui, or when a name is unknown: an agent not in the definitions, an agent with grant `all`, a skill not in the inventory. Unknown names are an error, not a silent drop, so the model corrects and calls again. Any agent with a list grant is accepted; the tool does not know leads from chores.
- Opens the very same setup form, built from the same `SetupContext`, with one addition: the proposal as the opening draft per agent while the baseline for the change marks stays the current list. The form already marks changed fields; the user sees each proposed change, edits what they want, picks the scope and confirms or cancels. The model's `reasons` are shown as a "Proposed" line in the agent's tab; small, optional.
- Skills list order, in the form generally and not only here: when the picker opens for an agent, checked skills come first, then the rest, each group in inventory order; the order is fixed for as long as the picker is open, so ticking or unticking never moves a row. Today the picker lists the inventory in one fixed order with checks scattered through it.
- Scope: the setup is per project. In a trusted project the Submit tab offers project (default) and user, as the form does today. In an untrusted project the project file is not read by pi, so the form offers the user file only and says that the result will apply to every project; the user is asked, never surprised.
- On confirm calls `save(scope, changes)`: trust check, `writeChanges`, `definitions.reload()`, the usual notice "saved … to <path>; agents started from now on use it". On cancel writes nothing. `save` returns nothing today; it has to return an outcome (saved to which path, or the failure) so the tool can report it.
- Returns to the model a short result: what was saved per agent and to which file, or "cancelled by the user", so the model's next message to the user is right. Clears the pending mark either way.

### R4. What the user sees

1. `/agents autosetup` → notice "asked the main session to propose agent skills".
2. The main session's turn: it may read a manifest or two, then calls the tool.
3. The setup form opens with the proposal in place and changed fields marked, checked skills first, one agent per tab, Submit tab with the scope.
4. Confirm → notice "pi-subagents: saved implementer (skills), reviewer (skills) to /…/.pi/pi-subagents.json; agents started from now on use it" (the existing `changeSummary` wording).
5. The main session says what it proposed and what was saved, with the reasons.

Running the command again later proposes afresh over the current lists; the brief carries them, so a sensible model keeps what fits and the form shows only real changes. There is no memory of past runs in release 1.

### R5. Files written

Only the files `/agents setup` writes today, through the same function: `<cwd>/.pi/pi-subagents.json` in a trusted project, `<agentDir>/pi-subagents.json` for user scope. The AGENTS.md rule names `/agents setup` as the user's command for the project file; `/agents autosetup` is added to that parenthesis, with the note that the write happens after the user confirms the form.

### R6. Chores

Chores are out of scope for release 1, and the mechanism must not know it. The command lists every agent, the tool accepts every agent with a list grant, the form shows every agent, exactly as `/agents setup` does. The decision to leave chores alone sits one level up, in the brief's policy sentence (R2), where the author of the prompt owns it. Supporting chores later is a change to that sentence and nothing else. If the model proves unreliable at telling a chore from a lead by its description, the next cheapest place is the agent file, where its author could opt the agent out of proposals; that is still above the mechanism and still not a chore flag in the platform.

## Release 2, if ever: automatic re-runs

Not planned. If release 1 proves useful and the user wants the lists kept current without running the command, the 2026-10-22 design applies, condensed:

- Trigger: session start in a trusted project, when a hash of the inventory (names and descriptions) or of the project signals differs from the last run. No timers.
- Record: under pi's agent dir, keyed by cwd, holding `mode`, both hashes and `applied` (what autosetup put in each list last time) and `declined` (what the user later removed).
- Merge per agent: new match not in the list and not declined → add; in `applied` but gone from the inventory → remove; in `applied` but removed by the user → remember as declined, never re-add; added by the user → keep, do not track.
- Modes `apply` (write and notify), `propose` (notify, apply on command), `off`, chosen at a one-time first-contact prompt and changeable by command.
- The judge would still be the model, through the same tool, so a re-run costs a model call; that cost is the main reason to wait for a request before building it.

The full version, with the merge table and the record format, is the README at the commit before this revision.

## Out of scope

- **Claude Code files.** `.claude/skills`, `.claude/agents` `skills:` lines and `enabledPlugins` are not read. If pi ever discovers Claude Code skills (claude-code-compat's import extension), they enter the inventory like any other skill and release 1 handles them with no change here. That folder decides whether that import is wanted at all.
- **Catalogue conventions.** No `pi-agents`, `pi-match` or `pi-replaces` metadata, no declared matching. Skills are judged by their descriptions. A company may still describe its skills so that the judgement is easy ("Use when reviewing Kotlin"); that is good skill writing, not a convention of ours.
- **The main session's own skill list.** Trimming pi's `<skills>` section is the skills-in-main-session folder.
- **Project packages, `pi update`, marketplaces.** How skills arrive on the machine is pi's and the user's business.
- **Evals.** No prompt-quality eval of the proposal in release 1. Whether the model calls the tool once with full lists is learned by using it; the tool accepting a repeated call while the mark is pending is the fallback.
- **Chores.** No proposals for them in release 1, by brief policy only (R6).

## Decisions for the owner

1. **Outside tui.** Refuse, like the form (recommended), or let the tool apply the proposal without confirmation in `rpc`/`print`/`json` modes. Refusing keeps every write behind a confirm in release 1.
2. **Project signals.** Top-level listing only, the model reads further itself (recommended: no manifest parsing in the extension, and the model is better at reading a `build.gradle.kts` than a regex is), or parse `package.json` and friends in the extension to save the model a tool call.
3. **Tool gating.** Accept the tool only after the command marked a proposal pending (recommended: ties every write to a user command, which is what the AGENTS.md rule asks), or always accept it so the user can also ask in plain words "set up skills for my agents". The second can come later by lifting the gate.
4. **Reasons in the form.** Show the model's one-line reason under each proposed skill (recommended, small) or leave the form as it is and let the main session's message carry the reasons.

Settled on 2026-10-25: the command is `/agents autosetup`; the pending mark is a variable in the agent-setup plugin, set by the command, cleared when the tool is called, gone with the session, never written to disk; chores are excluded by the brief only (R6); no eval in release 1; the setup is per project and the Submit tab's scope choice is the question to the user, with the user file as the only answer in an untrusted project; checked skills first and no re-sorting in the picker.

## Delivery order

1. **Release 1.** The `autosetup` word, the template, the project listing helper, the form's proposal draft and picker order, the tool, the plugin wiring, tests (unit for the brief, the validation, the form draft and the picker order; a plugin test through the harness with a fake form), README/ARCHITECTURE/STRUCTURE of the extension and the root, the AGENTS.md parenthesis, `npm run check` green. Details in implementation.md.
2. **Release 2, if ever.** Automatic re-runs as sketched above, only on request.

## Not verified

- How the form behaves when the opening draft differs from the baseline: `initialSetup` today uses `initial` for both, so the change is small but untested; see implementation.md.
- The tool is declared to the model in every main-session request once registered (the adapter cannot register a tool inactive); the gate in R3 makes it harmless but not free. implementation.md sizes the cost and the later adapter hook.
- Whether the main session reliably calls the tool once with full lists rather than several times with deltas. Use answers this; the tool accepting repeated calls (last one wins while pending) is the fallback.
- The brief's size with a large inventory. At one line per skill, a hundred skills are a few thousand tokens, once per command; acceptable, but the template should cut descriptions at a fixed length.
