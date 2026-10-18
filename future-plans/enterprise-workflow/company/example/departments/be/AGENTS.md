# Backend department (Acme)

You are inside the Backend part of a workbench. Each folder next to this file is a clone of a Backend repo; its own AGENTS.md wins over this one.

- Services are Kotlin, Spring Boot, Gradle. Check command per repo is in the workbench `WORKBENCH.md`.
- Public HTTP APIs are described in `api/openapi.yaml` in the owning service. A contract change lands there first, in its own PR.
- Events are Avro schemas in `events/`. Never change a field's type; add a new field with a default.
- Branches: `feature/<ticket>-<slug>`, where `<ticket>` is the Backend ticket, not the epic.
- Backend owns the contract when an epic adds or changes an API. Frontend and QA automation work against the merged contract.
