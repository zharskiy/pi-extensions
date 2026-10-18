---
name: epic
description: Acme epic workflow - several departments (BE, FE, QAA) in one workbench. Epic requirements, then a contract, then one feature per department.
disable-model-invocation: true
---

# Epic

Argument: the epic key, for example `/skill:epic SHOP-812`. Run in the workbench root of that epic. `templates/` is in this package, two folders up from this file.

## Before the first stage

Read `WORKBENCH.md`. If the epic's section of the stage log has stages marked `done`, tell the user where things stand and continue at the first open stage; check that the epic's tracker status matches the log and say so if it does not. Otherwise create the section with every stage `open`.

After every stage: set it to `done` in the log with the date and the artefact path or ticket keys.

## Stages

| # | Stage | Who | Output | Gate |
|---|---|---|---|---|
| 1 | intake | `tech-lead`; one `scout` per repo, same call | `docs/context.md` | none |
| 2 | requirements | you, with the user | `docs/requirements.md`, posted to the epic | user confirms understanding, then approves the file |
| 3 | contract | `tech-lead` drafts, you revise with the user | `docs/contract.md` (+ schema fragments in `docs/contract/`), posted | user approves; one-way door |
| 4 | split | you | one feature ticket per department, created | user approves the list |
| 5 | departments | the `feature` workflow, once per department ticket | specs and briefs per department | as in `feature` |
| 6 | close-out | you | epic `In delivery`, merge order posted | none |

### 1 intake

As in `feature` stage 1, over the epic and all its repos.

### 2 requirements

Set the epic to `Discovery` (tell the user first). Follow `requirements-interview` at the level of user-visible behaviour across departments; leave department detail for stage 5. When the user confirms, follow `write-spec` with `templates/requirements.md`, write `docs/requirements.md`, and post it on approval.

### 3 contract

Brief `tech-lead` to draft the contract with `write-contract` and `templates/contract.md` from `docs/requirements.md` and the scouts' findings. When the user wants alternatives, start two or three `tech-lead` drafts in one call, each under a different constraint named in its brief, and compare them for the user. Walk the user through every interface in the draft, numbered, with your recommendation. On approval, post it, set `Contract agreed`.

### 4 split

Propose one feature per department that has work: title, department, the repos, what it delivers against the contract, and the merge order (contract owner first, QA automation last). The contract owner's feature always starts with a brief that publishes the contract into its repo (for example `api/openapi.yaml`); every other department's first brief is blocked by it. On approval, create the features under the epic with `Department` set, link each to the contract attachment, and record their keys in `WORKBENCH.md`.

### 5 departments

For each department feature in merge order, run the `feature` workflow from its stage 1. Requirements there are narrow: only what the epic left open for that department. The user may run departments in separate pi sessions in this workbench; each session works on one feature key and touches only its section of the log.

### 6 close-out

When every department feature is `Ready for agent`, comment the merge order and the list of feature and task keys on the epic and set `In delivery`.

## When the contract has to change

Only the user reopens stage 3. Revise `docs/contract.md`, post it with what changed, and list the department tasks whose briefs mention the changed interface so the user can decide which to rewrite.
