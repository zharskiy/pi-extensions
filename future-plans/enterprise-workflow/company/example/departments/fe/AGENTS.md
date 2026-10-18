# Frontend department (Acme)

You are inside the Frontend part of a workbench. Each folder next to this file is a clone of a Frontend repo; its own AGENTS.md wins over this one.

- Micro-frontends in React and TypeScript, hosted by `web-shell`. A feature lives in one micro-frontend unless the shell's routing or layout changes.
- API clients are generated from the Backend `openapi.yaml`. Never hand-write a client for a contracted endpoint.
- Every user-visible string goes through the localisation keys in `src/i18n/`.
- Elements that QA automation targets carry `data-test-id`; the contract lists the ids an epic needs.
- Branches: `feat/<ticket>/<slug>`, where `<ticket>` is the Frontend ticket.
