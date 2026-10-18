---
name: feature
description: Acme feature workflow - one department, one or a few repos. From a feature ticket to approved agent briefs posted for CI.
disable-model-invocation: true
---

# Feature

Argument: the feature ticket key, for example `/skill:feature SHOP-845`. Run in the workbench root. Your job is research and writing; implementation happens on CI from the briefs you post. `templates/` and `scripts/` below are in this package, two folders up from this file.

## Before the first stage

1. Read `WORKBENCH.md`. If this ticket has a section in the stage log, you are resuming: tell the user which stages are done and continue at the first open one. Otherwise add a section for it with every stage below set to `open`.
2. Read the ticket over the tracker MCP (see the `tracker` skill) and note its department. Only that department's repos are in scope.
3. If the ticket belongs to an epic with an approved contract, read `docs/contract.md`. The contract is fixed: if the feature needs a change to it, stop and tell the user to reopen the epic's contract stage.

After every stage: set the stage to `done` in the log with the date and the artefact path or ticket keys, then go on unless the stage has a gate.

## Stages

| # | Stage | Who | Output | Gate |
|---|---|---|---|---|
| 1 | intake | `tech-lead` agent; one `scout` per repo in scope, in the same call | `docs/<KEY>/context.md` | none |
| 2 | requirements | you, with the user | shared understanding in the conversation | user confirms |
| 3 | spec | you | `docs/<KEY>/spec.md`, posted | user approves the file |
| 4 | briefs | you; `tech-lead` for a first split when the feature spans several repos | `docs/<KEY>/briefs/NN-slug.md`, posted as tasks | user approves the split, then the briefs |
| 5 | handover | you | feature status `Ready for agent` | none |

### 1 intake

Brief `tech-lead`: the ticket key; Return a digest of the ticket, its parent, linked tickets and documents, and earlier decisions on the same area. Brief each scout with the repo's absolute path under the workbench and one question: where the behaviour the ticket names lives and how it is tested. Write the digest and the scout findings to `context.md`, sources kept.

### 2 requirements

Follow the `requirements-interview` skill, with `context.md` and (for an epic) `docs/requirements.md` and `docs/contract.md` as known facts. The stage ends only when the user says the understanding is shared. Set the ticket to `Specifying` when the stage starts (tell the user first).

### 3 spec

Follow the `write-spec` skill to write `spec.md` from the conversation; do not re-interview. Show the path and a five-line summary. On approval, post it as the `tracker` skill says and set `Specified`.

### 4 briefs

Follow the `task-briefs` skill. First present the split (titles, repo, blocked-by) and quiz the user on granularity and edges; then write the briefs; then show the list of paths. On approval, create one task per brief, link `blocks`, label `agent-ready`, and record the keys.

### 5 handover

Set the feature to `Ready for agent`. Tell the user what was posted, with ticket keys. If the feature is part of an epic, say which department goes next by the merge order in `docs/contract.md`.

## Local implementation (optional, only when the user asks)

Per brief, in the order of the blocking links: `/skill:workbench branch <dept> <TASK-KEY> <slug>`, then an `implementer` with the brief as Goal, Done when and Scope, the repo path, and the department's AGENTS.md path under Where to look; then a `verifier` with the repo's check command from `WORKBENCH.md` and the brief's acceptance criteria as done-when statements. On a fail, one more `implementer` round with the verifier's evidence, then ask the user. For a change across modules, a `reviewer` with the `review-axes` skill and the brief path. The PR body follows `templates/pr-body.md`.

## Reviewing PRs that CI opened (optional)

Start a `reviewer` per PR with the `review-axes` skill, the brief's task key and path, and the diff range. Relay the two axes separately.
