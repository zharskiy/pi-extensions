# Matt Pocock's skills: survey for pi-extensions feature and epic workflows

Source: github.com/mattpocock/skills at commit 49dd158 (main, 2026-10-09). Skill URLs: `https://github.com/mattpocock/skills/blob/main/skills/<bucket>/<name>/SKILL.md`. No separate ai-hero skills repo. Install: Claude Code plugin, Codex and Copilot plugins, `npx skills@latest add mattpocock/skills -a pi` (pi is a named target).

## 1. Inventory

Only `engineering/` and `productivity/` are shipped; `in-progress/` drafts; `misc/` frozen.

| Skill | Purpose | Category |
|---|---|---|
| engineering/ask-matt (+PHASE-BOUNDARIES.md) | Router: which skill or flow fits; idea → ship | router |
| engineering/code-review | Two-axis review (Standards, Spec) in parallel subagents | review |
| engineering/codebase-design (+DESIGN-IT-TWICE.md, DEEPENING.md) | Deep modules vocabulary: seam, interface, adapter, depth | planning/spec |
| engineering/diagnosing-bugs | Red feedback loop first, then fix and regression test | code |
| engineering/domain-modeling | Sharpens terms, keeps `GLOSSARY.md` and ADRs inline | planning/spec |
| engineering/grill-with-docs | Call grilling and domain-modeling | planning/spec |
| engineering/implement | Build one spec/ticket: tdd, code-review, commit | code |
| engineering/implement-spec | Whole spec as a ticket graph, parallel implementer subagents on one integration branch | code (orchestration) |
| engineering/improve-codebase-architecture | Finds deepening candidates, HTML report, grills the pick | research |
| engineering/pr | PR body template: Summary visual, Evidence, Merge Danger | tracking |
| engineering/prototype (+LOGIC.md, UI.md) | Throwaway code answering one design question | research |
| engineering/research | Background agent writes a cited file from primary sources | research |
| engineering/retro | Suggests environment changes after a session | review |
| engineering/setup-matt-pocock-skills | Per-repo config: tracker, labels, domain doc layout | tracking |
| engineering/tdd (+tests.md, mocking.md) | Red-green at pre-agreed seams | code |
| engineering/to-spec | Conversation into a spec, published to tracker | planning/spec |
| engineering/to-tickets | Tracer-bullet tickets with blocking edges | planning/spec |
| engineering/triage (+AGENT-BRIEF.md, OUT-OF-SCOPE.md) | Issues through triage states; agent briefs | tracking |
| engineering/wayfinder | Map of decision tickets for work larger than one session | planning/spec |
| engineering/wizard | Bash script for human-only steps | other |
| productivity/grill-me | Call grilling | planning/spec |
| productivity/grilling | Interview primitive: design tree, rounds, frontier | planning/spec |
| productivity/handoff | Handoff document to OS temp dir | other |
| productivity/teach | Multi-session tutoring | other |
| productivity/to-questionnaire | Async questionnaire for whoever holds the answer | planning/spec |
| productivity/wait-what | Re-pitch in Simplified English using the glossary | other |
| productivity/writing-for-agents (+SKILL-MECHANICS.md) | Style guide for skills and AGENTS.md | meta |
| in-progress/chief-of-staff, claude-handoff, loop-me, setup-ts-deep-modules, writing-* | drafts | |
| misc/git-guardrails-claude-code, migrate-to-shoehorn, scaffold-exercises, setup-pre-commit | frozen | |

## 2. Practices encoded

grilling: design tree worked in rounds; "Ask the whole frontier in one round: number each question and give your recommended answer." "Word each question so 'yes' accepts your recommended answer." "Finding facts is your job, never the user's … dispatch a sub-agent." "Do not act on it until the user confirms you have reached a shared understanding." Plain chat text; `.out-of-scope/native-question-tool.md` rejects structured pickers because they "push the model towards multiple-choice questions with pre-baked answers". No limit on question count.

wayfinder: "decisions, not deliverables"; map with Destination, Notes, Decisions so far, Not yet specified ("fog of war"), Out of scope. Ticket types research, prototype, grilling, task, each HITL or AFK. "never resolve more than one ticket per session." Hands off to `/to-spec`.

to-spec: "Do NOT interview the user; just synthesize". Testing seams before the spec: "Use the highest seam possible … the ideal number is one. Check with the user." Template: Problem Statement, Solution, "LONG, numbered list of user stories", Implementation Decisions, Testing Decisions ("only test external behavior"), Out of Scope, Further Notes. "Do NOT include specific file paths or code snippets." Assumes a tracker and `ready-for-agent` label.

to-tickets: tracer-bullet vertical slices: "narrow but COMPLETE path through every layer", "demoable or verifiable on its own", "sized to fit in a single fresh context window", "any prefactoring … first". Blocking edges; "work the frontier". Wide refactors use expand–contract with an integration branch and a final integrate-and-verify ticket. User quizzed on granularity, edges, merge/split before publishing. Ticket: What to build, Blocked by, Status, acceptance checkboxes. Local mode: `.scratch/<feature>/issues/NN-slug.md`.

research: background agent against primary sources; "Follow every claim back to the source that owns it"; one cited Markdown file saved "where the repo already keeps such notes".

to-questionnaire: "Grill the send, not the subject"; questions most important first, "one idea, never compound", answer stub, "why this matters" only where misreadable, "Anything else?" at the end.

domain-modeling: challenge terms against `GLOSSARY.md`, invent edge cases, cross-check claims against code. ADRs only when "Hard to reverse", "Surprising without context", "The result of a real trade-off".

codebase-design / DESIGN-IT-TWICE: "The deletion test"; "One adapter means a hypothetical seam. Two adapters means a real one." Spawn "3+ sub-agents in parallel", each a "radically different" interface under a different constraint; each returns interface, usage example, what is hidden, dependency strategy, trade-offs.

code-review: pins a fixed ref; Standards and Spec as parallel subagents ("Code that follows every standard but implements the wrong thing → Standards pass, Spec fail"). Spec axis: missing/partial, scope creep, implemented-but-wrong, quoting the spec line. Standards: Fowler smells as "judgement calls", "The repo overrides". "Do not merge or rerank findings"; 400 words per axis.

implement / implement-spec / tdd: "Test only at pre-agreed seams", "Red before green", "Refactoring is not part of the loop. It belongs to the review stage." Task graph frontier grabbed in parallel; "sparse … context pointers"; exploration notes outside the repo. Assumes the model implements in worktrees.

retro: mechanical mistake "gets a deterministic check, full stop"; `CODING_STANDARDS.md` for judgement. "The review agent should be responsible for imposing coding standards, not the implementation agent." AGENTS.md holds "only … navigation pointers".

triage / AGENT-BRIEF: brief is "the contract": "Durability over precision" (no paths or line numbers), "Behavioral, not procedural", "Complete acceptance criteria" (each "independently verifiable"), "Explicit scope boundaries". Template: Current behavior, Desired behavior, Key interfaces, Acceptance criteria, Out of scope. Reproduce before grilling.

pr: Summary as "smallest view", Evidence before/after, Merge Danger as one-way or two-way "Door" plus "Blast Radius".

ask-matt / PHASE-BOUNDARIES: "Keep steps 1–3 [grill, spec, tickets] in one unbroken context window". Each implementation starts fresh from its ticket. At a boundary: Continue, clear, handoff, subagent, compact. "Every move except Continue turns a primary source into a secondary source."

handoff: "Do not duplicate content already captured in other artifacts … Reference them by path", plus "suggested skills".

loop-me: "Push right" the checkpoint; a checkpoint presents a "Brief … never the raw output"; done means "an implementer agent could build it without asking a single question."

## 3. Practices to take, mapped onto feature and epic

| Practice | Source | Stage(s) | Form |
|---|---|---|---|
| Rounds over the frontier, recommended answer per question, facts to scouts, nothing proceeds until confirmed | grilling | requirements | skill. Questionnaire tool can carry a round but keep free text possible. |
| Interview and write-up separate; synthesise `requirements.md` without re-interviewing | to-spec | requirements | skill |
| Spec template: problem, solution, numbered user stories, out of scope; no file paths | to-spec | requirements | skill text; fold user stories beside `WHEN … THE SYSTEM SHALL`; Out of Scope required |
| Agree testing seams before design | to-spec, tdd | requirements → design | `design.md` gains "Seams under test", approved at the design gate |
| Design It Twice: 3 parallel planners, compare | codebase-design | design / contract | skill, optional stage variant; valuable for epic `contract/` (one-way door) |
| Deep-module vocabulary, deletion test | codebase-design | design | planner agent file lines or `skills: [codebase-design]` |
| Glossary and ADRs inline, ADR only under three conditions | domain-modeling | requirements, design | skill; for epics point at the code-map glossary |
| Tracer-bullet slices, prefactoring first, blocking edges, expand–contract | to-tickets | tasks | planner agent file: batches become a graph with `Blocked by` |
| Quiz the user on granularity and edges before publishing | to-tickets | tasks | stage: feature `tasks` gets a `user` gate (now `none`) |
| Brief = contract: behavioural, durable, acceptance criteria, out of scope | AGENT-BRIEF | tasks → implement (esp. CI) | planner file and a skill; the format to hand to the work-management MCP |
| Work the frontier as blockers clear | implement-spec | implement | main prompt or skill |
| Context pointers, not pasted content | implement-spec, handoff | all | main prompt; mostly there |
| Two-axis review, never merged; Spec axis quotes the spec line | code-review | review / verify | stage: two reviewer tasks (Standards, Spec vs `requirements.md` and `design.md`); Spec axis is the judgement half the verifier can't do |
| Smell baseline as judgement, repo overrides | code-review | review | skill passed to reviewer, replaceable by company |
| Refactoring belongs to review | tdd | implement, review | implementer file already says so |
| Red before green | tdd, diagnosing-bugs | implement, verify | bug-fix already; optional implementer skill line for feature |
| Questionnaire for absent stakeholder | to-questionnaire | requirements (epic) | skill; artefact filed via MCP |
| Research from primary sources, every claim cited | research | requirements, spike | scout and fetch agent files |
| Decision map with fog of war | wayfinder | before epic requirements | later; now: "Not yet specified" and "Out of scope" sections in `epic.md` |
| Push the checkpoint right; brief, not raw output, at gates | loop-me | every `user` gate | main prompt |
| Phase boundary order; keep requirements → design → tasks in one window | ask-matt | whole feature flow | workflow body: hand off only at stage boundaries |
| Retro: mechanical → check, judgement → standards | retro | after review | later skill |
| PR body with evidence and merge danger | pr | epic PR step | skill for the text; MCP or `gh` posts it. "Door" fits `design.md`/`contract/` too |

## 4. Leave out

- Everything that writes to the tracker: setup's tracker section, labels, `ready-for-agent`, publishing in to-spec/to-tickets, triage state machine, wayfinder's claim/assign/close, implement-spec's draft PR, code-review's `#123` lookup. All belongs to the MCP. Pocock abstracts the tracker as `docs/agents/issue-tracker.md`; right seam, but company-side.
- Triage as a process; keep only the agent-brief format.
- Model implementation inside the skill (implement, implement-spec, tdd as main-session skill).
- Harness/editor specifics: git-guardrails-claude-code, setup-pre-commit, migrate-to-shoehorn, scaffold-exercises, setup-ts-deep-modules, `/clear` `/compact`.
- prototype's capture step (throwaway branch + tracker pointer); spike already discards code.
- wizard, teach, writing-*, wait-what, chief-of-staff.
- Removing the questionnaire tool: keep it, allow free text and a recommended default.

## 5. Structure to copy

- Short composable files: median ~500 words; grill-me 22, grill-with-docs 35. Big material in sibling files by pointer.
- Frontmatter: `name`, `description`, `disable-model-invocation: true` for user-invoked. User-invoked description is a one-line summary; model-invoked carries "Use when …" triggers (model-invoked descriptions cost context every turn).
- Chaining: `Call the Skill tool with "grilling"`. User-invoked may call model-invoked, never another user-invoked. Wrappers are compositions. Maps onto workflow stages naming skills per stage.
- Router skill (`ask-matt`); pi equivalent is `/workflow` with descriptions plus a README "which workflow" section.
- Hard vs soft dependencies (ADR 0001): skills needing config say so in one line; skills that only get sharper degrade gracefully. Good for code-map and conventions.
- Writing rules: every step ends on a checkable completion criterion; leading words ("tracer bullet", "frontier"); positive targets not prohibitions; no no-ops; single source of truth per meaning.
- `.out-of-scope/` folder: one file per rejected idea with reason. Stops re-litigating ("no classifier", "no tiers").
- Harness owns recursion limits; skills carry no "don't recurse" prose.
- Distribution: copy editable files or managed plugin pinned by sha; `plugin.json` lists shipped skills explicitly.
