# Process catalogue for an agentic coding tool

Date: 2026-10-17. Scope: development and QA-automation processes an abstract agentic coding tool should support, their stages, artefacts, verification, model tier per stage, per-project variation, and fit against today's roster (planner, implementer, reviewer, general; scout, shell, fetch, image). No company, provider or model names. Sources are web search results and tool docs; several third-party pages are secondary and flagged as such in the sources list.

Tiers: **H** human, **S** strong model (planning, review, judgement), **C** cheap model (execution, search, running commands).

## 1. Master table

| # | Process | Trigger | Stages | Artefacts | Verification that closes it | Tiers per stage | Varies by project? |
|---|---|---|---|---|---|---|---|
| 1 | Bug fix | Defect report | reproduce, locate, root-cause, fix, regression test | failing test, fix diff | regression test fails before, passes after; affected suite green | repro C/S, locate C, cause S, fix C, review S | Yes: test command, scope of build |
| 2 | Hotfix / incident | Production breakage | triage, mitigate (revert/flag), minimal fix, backport, follow-up | minimal diff, incident note | targeted test plus smoke; human approves release | triage S, fix C, approve H | Yes: release flow |
| 3 | Chore fix | Linter, formatter, type or unit-test failure | run, read errors, fix, rerun | small diff | the failing command exits 0 | all C | Yes: commands, files off-limits |
| 4 | Dependency upgrade / deprecation | Advisory, version bump, deprecation warning | inventory, read changelog, bump, adapt call sites, test | diff, upgrade notes | build and tests of affected modules | inventory C, changelog C, adapt C, review S | Yes |
| 5 | Refactor | Code-health goal | pin behaviour with tests, plan steps, change in small steps, compare | diff series | existing tests unchanged and green; no behaviour diff | plan S, steps C, review S | Yes |
| 6 | Migration (framework/version/API) | Planned upgrade | survey, pattern + rules, pilot on one module, batch rollout, cleanup | migration recipe, per-module diffs | per-batch build and tests; final full CI | survey C, recipe S, batch C, review S | Strongly |
| 7 | Feature | Feature request | clarify, requirements, design, tasks, implement, verify, PR | spec, design, task list, diff, PR | acceptance criteria demonstrably met; tests; review | clarify H/S, design S, tasks S, implement C, verify C+S | Yes |
| 8 | Spike / prototype | Unknown feasibility, time-boxed | question, timebox, build throwaway, record findings, discard | findings note, optional branch | none on code; the findings answer the question | S frames, C builds, H decides | Light |
| 9 | Research / question | "How does X work / which option?" | scope, search code and web, synthesise, cite | report with evidence | claims traceable to path:line or URL | C searches, S synthesises | Rarely |
| 10 | Review of someone else's PR | PR opened | read intent, read diff, trace usages, run checks, report | ranked findings, verdict | each finding confirmed in code | S (checks run by C) | Yes: review rules |
| 11 | Test authoring (app code) | Coverage goal, new code | read code, list cases, write, run, mutate/sanity check | tests | tests pass, fail when behaviour breaks | cases S, write C | Yes |
| 12 | Documentation | Code or API changed | find stale docs, draft, check examples | docs diff | examples run; links resolve | C, S review | Mild |
| 13 | Release notes / changelog | Release cut | collect merged changes, group, draft | changelog entry | every entry maps to a merged change | C, H approves | Mild |
| 14 | Performance investigation | Slow path report | measure baseline, profile, hypothesise, change, remeasure | benchmark before/after, diff | measured improvement, no regression | measure C, hypothesis S | Yes |
| 15 | Security fix | Advisory or finding | confirm exploitability, fix, test exploit path, check siblings | diff, test | exploit test fails before, passes after; sibling scan | confirm S, fix C, review S, H approves | Yes |
| 16 | Code archaeology / onboarding | New to area | map, trace, explain | map document | reader can answer test questions | C | No |
| 17 | QA: test from ticket | Ticket with acceptance criteria | see section 4 | | | | Yes |
| 18 | QA: update tests after change | UI or API change | see section 4 | | | | Yes |
| 19 | QA: flaky triage | Intermittent failures | see section 4 | | | | Yes |
| 20 | QA: coverage-gap analysis | Planning, release | see section 4 | | | | Yes |
| 21 | QA: framework maintenance | Duplication, drift | see section 4 | | | | Yes |
| 22 | QA: manual-to-automated conversion | Manual case backlog | see section 4 | | | | Yes |
| 23 | QA: test data management | Data collisions, stale data | see section 4 | | | | Yes |
| 24 | QA: failed CI run triage | Red pipeline | see section 4 | | | | Yes |

De-duplication notes: "implement" in the owner's list is the middle of Feature (7), not a separate process; "feature request" is the front of Feature (clarify and requirements). Hotfix shares the bug-fix core but changes the gate (minimal diff, human release). Chore fix and dependency upgrade differ in that upgrades need reading external changelogs. The owner's list lacks: refactor, migration, review, test authoring, docs, release notes, performance, security, archaeology, and the QA set.

## 2. Per-process notes

**Bug fix.** Anthropic's guide stresses giving the agent a way to verify itself, such as a failing test or the error text, and the "explore, plan, implement, commit" loop; Kiro's bugfix spec records the current defect, expected behaviour and behaviour that must stay unchanged; a debugging skill in the Superpowers set reproduces, narrows, tests hypotheses, finds root cause, then verifies. Input: report, error text, steps. Output: fix plus a regression test. Research is needed only when the cause is unknown. Closed by a test that fails on the old code.

**Hotfix / incident.** Same core, but the first stage is mitigation (revert, feature flag) before the fix. Keep the diff minimal, skip refactoring, require a human to approve release. Cheap execution is acceptable; the judgement of what to revert is strong-tier or human.

**Chore fix.** Run the command, read the first error, fix, rerun. No planning, no research. The only rules that matter are which commands to run and which files not to touch. This is the cheapest process and the best candidate for an unattended cheap-model loop.

**Dependency upgrade / deprecation.** Inventory usages, fetch the changelog, bump, adapt, run affected tests. Needs web fetch. Risk lives in lockfiles and generated code, so project rules dominate.

**Refactor.** Behaviour-preserving. Characterisation tests first when coverage is thin, then small steps, each verified. A strong reviewer checks that no behaviour changed. Planning is required when more than one module is touched.

**Migration.** Pilot on one module, extract a written recipe, then fan out in batches. Each batch is independent and cheap; the recipe and the review are strong-tier. Needs a cross-module (and often cross-repo) survey first.

**Feature.** The spec-driven tools agree on the shape: Kiro produces requirements, design and tasks files with approval between phases, and a quick mode that skips the gates; spec-kit runs constitution, specify, optional clarify (small number of high-impact questions), plan, tasks, optional analyze (cross-artefact consistency), implement; BMAD runs optional analysis, planning, solutioning, then a story loop with one story per fresh context, and a lean quick-spec to quick-dev track. Community guides say to skip clarify and analyze for experiments and keep them for production work. Closed by acceptance criteria, tests and review.

**Spike / prototype.** Time-boxed and disposable. Output is knowledge, not code; do not apply production gates. Danger is the prototype leaking into the main branch, so the tool should work in a throwaway worktree and require a findings note.

**Research / question.** No code change. The scout (code) and fetch (web) cover this; the missing step is a synthesiser that cross-checks claims. Verification means every claim has a path:line or URL.

**Review of someone else's PR.** Google's eng-practices review guide asks for design, functionality and complexity, with the bar that a change that improves overall code health should be approved even if imperfect. Matches the reviewer agent; add project review rules.

**Test authoring (app code).** Read the unit under test, list cases including edge cases, write, run, then confirm the tests can fail. Distinct from QA automation because it lives next to the code.

**Documentation and release notes.** Mostly cheap summarisation of diffs; verification is executing examples and mapping every changelog line to a merged change. A human approves release notes.

**Performance investigation.** Measure first. Nothing is done until before/after numbers exist. The measuring is shell work, the hypothesis is strong-tier.

**Security fix.** Confirm the issue is real, fix, write a test that exercises the exploit path, scan for sibling occurrences. Human approval is non-optional.

**Code archaeology / onboarding.** Pure read-only mapping; same agents as research.

## 3. QA automation (section for the owner's question: "is there anything else?")

Typical shape of an in-house Selenium/Java-style framework, abstractly: a **page-object layer** (one class per screen or component holding locators and actions), a **step or keyword library** (reusable business steps composed from page objects), a **test layer** (scenarios calling steps, often tagged by suite), a **test-data layer** (builders, fixtures, environment files, seeded accounts), plus **configuration** (environments, browsers, grid) and **reporting**. Changes ripple bottom-up: a UI change touches page objects, a business change touches steps, a new scenario touches tests and data.

Industry material (2025–2026) describes: Playwright's built-in planner, generator and healer agents (explore the app and write a Markdown plan, turn the plan into test files verifying selectors live, run the suite and repair failures or mark a test as fixme when the product looks broken; a seed test supplies fixtures and auth); self-healing locators that combine text, role and layout signals and flag larger breaks; and analytics that aggregate CI history to surface intermittent tests. Much of the vendor material is marketing; treat figures as directional.

| QA process | Input | Output | Research needed? | Verification |
|---|---|---|---|---|
| Write tests from ticket / acceptance criteria | ticket, criteria, product access | scenarios, steps, page objects, data | Only for unknown screens: a quick look at existing page objects to reuse; skip when criteria and screens are already covered | New test passes on the target build; fails when the behaviour is broken (negative check); review |
| Update tests after UI/API change | diff of app change, failing tests | edited locators, steps, data | Small: find all usages of the changed element | Run only the affected tag or suite; dry run (compile and collect) first |
| Flaky-test triage | CI history, failing runs | cause (timing, data, order, env), fix or quarantine | Yes: history comparison | Repeat run N times green; quarantine is a human decision |
| Coverage-gap analysis | requirements/ticket list, existing tests, coverage report | gap list ranked by risk | Yes, this is the research | Gap list reviewed by human; no code change |
| Page-object / fixture maintenance | duplication, drift report | consolidated classes | Yes, usage survey | Compile; run suites that use the changed class |
| Manual case to automated | manual steps | automated scenario | Light: map steps to existing step library | Run; compare results with manual expectation |
| Test data management | collisions, stale data | builders, cleanup, seeds | Yes: where data is created and shared | Run twice in parallel and in reversed order |
| Failed CI run triage | pipeline log | classification: product bug, test bug, infra, data; next action | Yes, logs | Classification backed by log lines; re-run of the failing test only |

Whether research is needed depends on the task size, matching the owner's remark: adding a test to a known area skips research; a framework refactor or coverage analysis requires it. A cheap "do we need research?" decision belongs to the planner step, not to hard-coded process definitions.

## 4. Project-type variation

The owner's examples (backend: do not trigger the compiler across the whole project; frontend: do not change localisation or generated files) are the norm. Tools place such rules in four layers:

- **Always-loaded instruction file** (AGENTS.md or tool-specific equivalent): commands, "Don't" lists, generated-file boundaries; scoped per-directory files are a recognised pattern for directory-specific rules and validation commands. Advisory only.
- **Skills / on-demand instructions**: process playbooks loaded when relevant (for example "how to write a page object in this repo").
- **Spec/steering files**: Kiro-style steering and spec-kit's constitution give project principles the planner reads.
- **Hooks**: deterministic enforcement. Claude Code's PreToolUse hooks can block edits by exiting with code 2; the official example protects lock files and `.git/`. Rule of thumb from community sources: markdown rules are advisory, hooks enforce. If a rule must hold, make it a hook or a permission rule.

Abstract example rules:

- Backend: (1) build and test only the module you changed using the module-scoped command; (2) never run the full integration suite locally, CI does; (3) do not edit migration files already merged; (4) public API changes require updating the contract file.
- Frontend: (1) never edit generated clients or compiled output; (2) do not add or change localisation strings, request them in the task; (3) run the component's unit tests and type check, not the whole end-to-end suite; (4) use design-system components, no new styling primitives.
- QA automation: (1) reuse existing page objects and steps before adding new ones; (2) locators live only in page objects; (3) run only tests selected by tag or name, never the whole regression; (4) do not change shared test data or environment config without asking; (5) a new test must show a failing run on a deliberately broken condition or a review note explaining why not.

These rules belong in two roles: **implementer rules** (what may be changed and which command validates) and **validator rules** (what to run, what output means pass). A process definition should reference "the project's verify command" rather than a literal one, so the same process works across stacks.

## 5. Roster fit and gaps

| Stage | Today's agent | Gap |
|---|---|---|
| Locate, map, explain | scout | Explorer across repos: scout is single-codebase |
| Web/docs/changelog | fetch | None |
| Run tests/build, report | shell | None for running; no agent that judges whether the result proves the goal |
| Plan / design | planner | Requirements interviewer: nothing questions the user or product ticket before planning |
| Edit and check | implementer | Fine for bug, chore, refactor; a test author with QA-framework conventions is missing |
| Review | reviewer | Fine; lacks project-specific review rules loading |
| Reproduce bug | general | Reproducer (writes the failing test first) |
| Verify against acceptance criteria | none | Verifier: runs the project's verify command, checks criteria one by one, reports pass/fail with evidence |
| CI-log triage | shell + scout, manual | Triager: classify failure, owner, next action |
| Flaky repeat runs | shell | A loop runner with stats; shell is single-pass |
| Batch rollout (migration) | many implementers by hand | Fan-out coordinator with a shared recipe |
| Docs / release notes | general | Writer (cheap) |
| Performance measurement | shell | Benchmark comparer |
| Browser/UI exploration for QA | image (screenshots only) | UI explorer driving the app |
| Spike frame/disposal | general | Worktree + findings-only convention |
| Process selection | main session prompt | A process router: pick process, stages, rigor level (lean vs full) |

Mapping by process: bug fix (scout, general for repro, implementer, shell, reviewer); chore fix (implementer alone, or shell then implementer); upgrade (fetch, scout, implementer, shell); refactor and migration (planner, scout, implementer, reviewer); feature (planner, [interviewer gap], implementer batches, [verifier gap], reviewer); research and archaeology (scout, fetch); review (reviewer); QA processes (scout for page-object survey, implementer as test author with QA rules, shell to run subsets, reviewer; gaps: test author, triager, UI explorer, verifier).

## 6. Design implications

1. Define processes as data (stage list, tier per stage, verify step, rigor level), not as new agents; most stages reuse existing roles.
2. Provide a lean and a full path per process, as spec-kit and BMAD do, selected by size and risk.
3. Make "verify" a first-class stage with a project-supplied command and rules.
4. Keep human gates only where cost of error is high: requirements, release, security, quarantine.

## Sources

- Anthropic, Claude Code best practices (explore, plan, implement, commit; verification): https://code.claude.com/docs/en/best-practices
- Anthropic, Claude Code hooks guide (PreToolUse blocking, file protection example): https://code.claude.com/docs/en/hooks-guide
- Kiro specs (requirements, design, tasks; bugfix spec; quick plan): https://kiro.dev/docs/specs
- GitHub spec-kit, via summaries (constitution, specify, clarify, plan, tasks, analyze, implement): https://docs.plannotator.ai/frameworks/github-spec-kit and https://codemyspec.com/blog/github-spec-kit-guide (secondary)
- BMAD-METHOD (phases, story loop, quick flow), secondary: https://www.mintlify.com/bmad-code-org/BMAD-METHOD/concepts and https://www.augmentcode.com/guides/bmad-method-ai-development
- Superpowers skills (brainstorming, writing-plans, systematic-debugging, verification-before-completion), aggregator pages, secondary: https://skills.sh/obra/superpowers
- Google engineering practices, code review: https://google.github.io/eng-practices/review/
- Playwright test agents (planner, generator, healer): https://playwright.dev/docs/test-agents
- Self-healing and flaky-test material (vendor, directional): https://www.ranger.net/post/self-healing-test-scripts-ai-fixes-broken-tests and https://shiftsync.tricentis.com/software-testing-blogs-69/ai-tip-of-the-week-8-using-ai-to-tackle-flaky-automated-tests-2392
- AGENTS.md scoping and rule practice (community, advisory vs hooks): https://claudeskills.info/skills/majiayu000/spellbook/agentsmd-scaffold/ and https://aws.github.io/modern-data-architecture-accelerator/packages/utilities/agent-rules/index.html
- Repo: extensions/subagents/README.md, agents/leads/*.md, agents/chores/*.md, prompts/main-session.md

Limits: I did not find a primary source for acceptance-criteria-to-test generation or for Atlassian/GitLab workflow stages; the QA rows for those, the incident, performance, security and release-note stages are synthesised from general practice rather than cited tool docs.
