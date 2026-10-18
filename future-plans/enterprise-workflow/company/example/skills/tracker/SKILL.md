---
name: tracker
description: How Acme's work-management tool is used over its MCP server - ticket types, statuses, link types, labels and where documents go. Use before reading or writing any ticket.
---

# Tracker conventions

The tracker MCP server is `acme-work`. Its tools are reached through codemode; look up exact names with `tool_search` the first time.

## Ticket types and hierarchy

Epic, then Feature (one per department taking part), then Task (one per agent brief). A feature belongs to exactly one department, set in the `Department` field (`BE`, `FE`, `QAA`).

## Statuses used by the workflows

| Ticket | Status | Set when |
|---|---|---|
| Epic | `Discovery` | requirements interview starts |
| Epic | `Contract agreed` | the user approves the contract and it is posted |
| Epic | `In delivery` | every department feature is `Ready for agent` |
| Feature | `Specifying` | the feature flow starts |
| Feature | `Specified` | the spec is approved and posted |
| Feature | `Ready for agent` | its briefs are posted as tasks |
| Task | `Ready for agent` | posted with the `agent-ready` label; CI picks it up |

Never move a ticket past a status the table does not list; humans own the rest.

## Where documents go

- Requirements, spec, contract: a ticket attachment named after the file (`requirements.md`, `spec.md`, `contract.md`), replaced on each revision, plus a one-line comment `Updated <file>: <what changed>`.
- Brief: the task's description, verbatim, nothing else.
- Links: `blocks` between tasks; `relates` from each department feature to the epic's contract attachment.

## Rules

- Read freely. Write only from the main session and only right after the user approved that exact write. Show the user what will be created or changed (ticket, field, text) before the call.
- After each write, record the ticket key or the status change in `WORKBENCH.md`.
