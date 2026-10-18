---
name: write-contract
description: Draft the interface agreed between departments before any of them builds - API endpoints, event shapes, shared types, test ids. Use in an epic's contract stage.
---

# Write the contract

- Start from the approved requirements and the current code: read the owning service's existing API and event schemas, not only the tickets.
- Use `templates/contract.md` in this package (two folders up from this file). Put machine-readable fragments (OpenAPI paths, Avro or JSON schemas) in `docs/contract/` next to it, and reference them.
- For each interface: owner department, consumers, the shape, error cases, and whether it is new, changed or unchanged. A changed interface states its compatibility rule.
- List the `data-test-id` values QA automation will target, and the test data each scenario needs.
- Mark each decision as a one-way door (hard to reverse once merged: public API, persisted schema) or a two-way door.
- State the merge order: contract owner first, consumers next, QA automation last.
- Done when each user story in the requirements maps to at least one interface or is marked as needing none.
