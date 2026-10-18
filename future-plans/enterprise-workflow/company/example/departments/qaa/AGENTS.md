# QA automation department (Acme)

You are inside the QA automation part of a workbench. `e2e-tests` is the in-house framework; its own AGENTS.md wins over this one.

- Tests are written from acceptance criteria, one scenario per criterion, tagged with the ticket key.
- Page objects live in `pages/`, steps in `steps/`. Reuse a step before writing a new one.
- Selectors use only `data-test-id` values that the contract lists.
- Nothing runs against an environment locally. The local check compiles, lints and lists scenarios.
- Branches: `qa/<ticket>_<slug>`, where `<ticket>` is the QA automation ticket. QA PRs merge last.
