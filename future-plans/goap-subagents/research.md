# Research: GOAP-based subagent orchestration

Research date: 2026-10-26. Scope: this repository's subagent definitions, execution and adapter boundaries, existing tests/evals, and two first-party GOAP implementations/documentation sets. Repository citations are relative to the root and line numbers reflect this research date. External documentation was fetched on that date; mutable URLs are not pinned releases. This is a feasibility assessment, **not code, a formal specification, or an approved implementation roadmap**.

Evidence labels: **Observation** means supported by the cited source; **Inference** means analysis of that evidence; **Option** and **Recommendation** describe possible future behavior, not existing capabilities. Effort estimates and the walkthrough are illustrative judgments.

## 1. Conclusion first

**Inference:** A GOAP-based orchestration layer is feasible, but reliable goal execution would require substantially more than adding `preconditions`, `effects` and `cost` to agent Markdown. The missing work is an observed-state model, trustworthy effect validation, safe execution/replanning, and recovery/control semantics. The graph search itself is only one component.

**Recommendation:** Retain the current runner and role grants; put a bounded, opt-in action planner above them. Prefer a hybrid: reusable domain actions with explicit validation, executed by suitable existing roles, with agent-local deliberation inside bounded actions. Do not equate an agent saying “done” with a goal becoming true. Start with one narrow domain before deciding whether generalized planning earns its complexity.

A complete rebuild is unnecessary if the real need is better task routing, ordered batches, stronger result validation, or a fixed research→implement→verify workflow. A dependency graph plus validators can address those needs without searching over alternative action sequences. GOAP becomes attractive when several reusable capabilities can reach the same goal, prerequisites vary, and observed failures legitimately change the next action. This comparison is analysis, not a benchmark result.

## 2. What GOAP contributes—and what the sources do not establish

**Observation:** ReGoap's action interface separates planner-facing preconditions, effects and cost from execution through `Run` and completion/failure callbacks. CrashKonijn documents action conditions, expected effects, runtime condition validation, and sensors that supply world state. These are practical examples of a planning-model/execution distinction. [G1–G3]

**Inference:** For LLM work, an effect is a prediction to test, not an entitlement to mutate the planner's beliefs. “Agent invoked” and “agent returned text” are execution events; neither establishes “patch correct,” “tests passed,” or “user approved.” Sensors/observers may refresh state independently of an action; a mandatory manual memory update after every action is not a universal GOAP requirement.

This assessment does **not** claim that GOAP guarantees optimal plans, safe tools, deterministic LLM outcomes, or recovery from external side effects. Numeric action costs are planning estimates, not actual spending guarantees. The selected sources describe implementations, not a proof about all GOAP variants. Original STRIPS/PDDL papers and Orkin's original work were not verified; this is not an academic-history survey. ReGoap README excerpts supplied during research were internally inconsistent, so no factual claim or quotation here relies on that README.

## 3. Current system: retain versus rebuild

**Observations:**

| Surface | What exists | Consequence for GOAP |
|---|---|---|
| Agent definitions | Markdown/frontmatter defines roles, prompts, tool/skill/child grants, optional worktree/MCP—not task preconditions/effects. [R1] | Role identity is not an action contract. |
| Dispatch | The model chooses an agent; runner validates definition, caller grants, depth, child cap, skills and model before queueing. [R2] | Retain authorization; add task eligibility and planning separately. |
| Execution | Semaphore, workspace placement, child spawning and events support lifecycle/activity/usage. [R3] | Reuse execution plumbing rather than replacing it with a planner. |
| Completion | Abort/error/empty output fails; otherwise selected nonempty text can close as done. A `Status:` line helps select/display text but is not semantic validation. [R4] | Separate session completion from validated action success. |
| Coordination | Batch terminal settlement/outbox wake callers; grants/depth limit nesting; context handoff starts a successor. [R5] | Keep wake/handoff mechanics, but do not treat them as planning or effect proof. |
| Persistence | Manifests recover history, marking open records interrupted/failed. [R6] | This is not durable plan execution or automatic restart. |
| Isolation | Shared cwd is default; optional Git worktrees place work separately. Adapter selects tools and cwd/session directories. [R7–R8] | Neither selected tools nor a worktree proves OS sandboxing or conflict-free execution. |
| Limits/control | Concurrency/depth/child and context limits, status, stop and usage exist. [R9–R10] | These are useful foundations, not a hard aggregate monetary budget or complete plan-control UI. |

**Recommendation—retain:** definition discovery/overrides; role and capability grants; adapter session creation; semaphore; worktree placement; event collection; registry, transcript/results and caller wakeups; context handoff and cancellation. Existing prompt agents remain useful executors. Preserve the repository's adapter/import boundaries and provider-independent runtime policy. [R1–R10, R12]

**Inference—new or materially redesigned:** domain/action catalogue; goal and observed-fact representation; planner and dispatch gate; action outcome/evidence contract; dependency invalidation and resource locks; retries/reconciliation; plan journal and restart policy; plan-level UI and evaluations. Current registry records can be linked to these, but cannot stand in for them.

“Complete rebuild” has two meanings: rebuilding orchestration around explicit goals is plausible; replacing the underlying pi adapter, runner, all agents and UI is not justified by the evidence. A broad replacement would add compatibility risk without removing the need for the same validation and safety machinery.

## 4. Three modelling choices

The following are **options**, not existing features:

| Model | Example | Benefits | Main costs/risks |
|---|---|---|---|
| **Agents as actions** | `implementer(task)` predicts `patchReady` | Small catalogue; close to current dispatch; quick experiment. | Role calls are broad and stochastic. Preconditions/effects tend to become vague; one invocation may partly implement, test and document, obscuring costs and failure attribution. Parameterized, bounded tasks and validators are still necessary. |
| **Agents owning actions** | An implementer exposes `ApplyPatch`, `AddRegressionTest`, `RepairFailure` | Finer contracts and multiple capabilities per role; clearer evidence per action. | Larger action catalogue and authoring burden. If agents privately plan/schedule, competing plans, nested budgets and inconsistent state emerge. Owning a declaration must not mean bypassing central permission/dispatch checks. |
| **Hybrid** | Domain actions such as `ObserveBaseline`, `ModifyFeature`, `VerifyRevision`, assigned to allowed roles | Stable semantic contracts independent of role names; reuse current agents; deterministic commands can execute some actions without an LLM. | Requires a clear central authority for facts, validation and resources; local agent autonomy must stay inside the action boundary. |

**Recommendation:** Hybrid. Roles answer **who is permitted/suitable**; actions answer **what transition is attempted and how it is checked**. A “planner” role may propose goals/actions, but only the runtime should accept facts, authorize dispatch and settle effects. For an initial experiment, use a small hand-authored catalogue; unrestricted LLM-generated predicates/actions would add an unmeasured trust and validation problem.

## 5. Minimum semantic and execution machinery

Everything in this section is a **proposed requirement/inference**, grounded in the gaps in §3 and planning/execution separation in §2—not a claim about shipped behavior.

### Facts, preconditions and effects

- Give goals concrete satisfaction tests. Avoid uncheckable predicates such as `goodCode=true`; use scoped claims such as “specified checks passed for workspace W at revision/content fingerprint H.” Quality judgments may remain explicitly human or reviewer assessments rather than proofs.
- Model **unknown** separately from false. An unrun test is not a failed test; no approval record is not consent. Record provenance, observation time, scope/revision and relevant confidence/authority. Confidence cannot substitute for required permission or a deterministic check.
- Distinguish hard safety/permission gates from uncertain planning assumptions. Recheck hard conditions immediately before execution, including after queue waits. Invalidate dependent facts when files, configuration, goal or workspace change.
- Declare predicted effects, possible partial outcomes, invalidations and side-effect/resource footprints. Do not copy predicted effects into observed state merely because an action ends.
- Bound the state vocabulary and catalogue: arbitrary repository contents and free-text goals do not automatically form a tractable search space. Explicitly cap search time/expansions and replanning; report no plan or exhausted search honestly.

### Result validation, failure and retry

An action needs structured lifecycle/outcome data alongside the existing human-readable result: attempt identity, input/state version, artifacts, evidence references, error classification, and successful/partial/failed/cancelled/unknown outcome. A schema validates shape, not truth. Validators should inspect authoritative evidence: command exit/output plus exact target, artifact hashes/diffs, external operation receipts, or recorded user decisions. Agent prose alone is a claim. Independent review is useful evidence but is not an infallible oracle.

Keep execution success separate from goal success. Partial execution may establish some facts and invalidate others. Reobserve after errors, cancellation or handoff before choosing the next step. Retry transient, idempotent actions within explicit limits; use alternative actions for incompatible prerequisites or unsuccessful approaches. Detect repeated state/action loops. External writes, publishing and other non-idempotent work need deduplication/reconciliation or human escalation, not blind retries. Rollback/compensation may be unavailable and must not be promised generically.

### Concurrency, workspaces and nesting

GOAP search alone does not decide safe parallel execution. Track read/write resources and dependency validity; serialize conflicting writes, validate again when acquiring a lease, and invalidate observations after conflicting work. Read-only actions can still consume stale state. A worktree separates Git edits, not external resources, credentials, services or all filesystem access. [R7–R8]

Worktree-based actions need explicit base identity, artifact transfer/integration, conflict handling and **verification on the integrated target**. Passing tests in a child worktree is not passing tests after merge. Do not silently add commits or integration behavior absent user authorization.

Use one authoritative plan/state ledger initially. Child agents can reason locally, but cannot unilaterally settle parent effects. If nested planners are later supported, define subgoal contracts, ownership, child cancellation propagation, bounded depth and shared resource/budget accounting. Existing depth/child grants remain outer limits; successor handoffs must preserve the same logical action/attempt lineage rather than gaining fresh retry or spending allowance. [R5, R9]

### Permissions and cost

An action's required capabilities must be a subset of both caller and chosen executor grants; a precondition must never grant permission. Recheck approval at dispatch, constrain allowed tools and execution targets, and distinguish trusted project configuration from untrusted repository content. Tool filtering is not an OS security boundary; approval propagation and isolation for granted tools remain platform questions. [R2, R8–R9]

Plan cost could combine latency, estimated money, risk and uncertainty, with an explicit optimization policy. Learn estimates from actual pi usage without embedding provider-specific logic. A hard plan budget requires accounting across children/retries/successors, reservations before dispatch, in-flight reconciliation and stop behavior. Current usage reporting does not establish such a cap. Nor can a token/cost estimate promise exact monetary cutoff while concurrent billable operations finish. [R10, R12]

### Persistence/restart and user-visible control

Persist goal version, catalogue/schema version, observations and evidence identities, plan revisions, attempts, approvals, resource ownership and accounting under permitted session storage. [R12] Record intent before dispatch and reconcile incomplete attempts on recovery. A crash between an external side effect and its receipt makes automatic replay unsafe; “exactly once” is not implied by a journal. Reobserve workspace/external state, expire stale leases and approvals as appropriate, and ask the user when ambiguity cannot be resolved. Existing manifests provide historical visibility only. [R6]

Show the goal, candidate/selected plan, blocking/unknown facts, predicted versus validated effects, active workspace/actions, spend and why replanning occurred. Offer inspect, pause-before-next-dispatch, cancel, approve/reject risky work, change goal and manual override, with an audit trail. Cancellation stops future work; it does not undo existing effects. Define controls for non-TUI modes too: the existing interactive Escape confirmation alone is insufficient. [R10] Whether every plan needs approval or only risky steps is a product decision, not something GOAP determines.

## 6. Illustrative walkthrough: partial execution and replanning

**Hypothetical only; these are not current action names or tested capabilities.** Goal: repair a parsing defect in an approved scope, with the regression and required checks passing on the final integrated target, and a review recorded. No publish/push permission is assumed.

| Step | Preconditions and prediction | Actual evidence and state transition |
|---|---|---|
| `ObserveBaseline` via read/test executor | Repository available, target fingerprint known; predicts baseline evidence available. | Command receipt identifies baseline H0 and an existing unrelated failure. `baselineKnown(H0)=true`; `requiredChecksPass(H0)=false`. |
| `ModifyFeature` via implementer | Approved scope, baseline known, write lease/worktree allocated; predicts candidate patch and regression test. | Agent reports “done,” but diff inspection finds a patch and no regression test. Set `candidateExists(H1)=true`; regression evidence remains **unknown**, not true. Invalidate H0-derived verification for the changed target. The action is partial. |
| Replan: `AddRegressionTest`, then `VerifyRevision` | Candidate exists; no valid test evidence. | Add test at H2. Actual test run fails on an uncovered edge case. Record failing evidence for H2, release leases; do not retry the same modification blindly or claim the goal. |
| Replan: `RepairFailure` | Reproducible failure evidence and remaining authorized budget. | Scoped repair produces H3; fresh regression passes. A required unrelated check remains red. The planner cannot redefine the user's acceptance goal to ignore it. It reports the blocker and asks whether to authorize additional scope or stop. |
| Conditional continuation | Only if user authorizes new scope/budget and work completes. | Integrate if needed; rerun required checks on the final target H4 and record review against H4. Only matching evidence can satisfy the goal. Without authorization or passing evidence, return partial/blocked. |

**Inference:** The useful behavior here is not merely choosing a different role. It is preserving partial evidence, refusing invented effects, invalidating stale checks, selecting an alternative next action and respecting a scope/budget boundary. If a fixed workflow already handles these branches well, a general GOAP search may add little value.

## 7. Compatibility and migration choices

**Recommendation:** Keep direct `run_agent` usable for unconstrained/manual work and make planned execution explicitly opt-in. Existing user/project Markdown agents should not acquire fabricated preconditions through automatic conversion of role prose. An adapter can invoke them as executors for separately authored actions. Version new action/fact/result/journal formats independently of historical agent manifests.

Plan/action/attempt IDs should link to current agent IDs, session transcripts, usage and successor chains; a legacy agent “done” can close the child session while its planned action remains unvalidated. Preserve existing result rendering for direct calls and explain this distinction in planned status. Avoid two independent schedulers fighting over the same slot/resource accounting.

**Option:** Run an observe-only comparison of proposed plans against existing routing before enabling dispatch, then constrain an opt-in trial to one domain. This is a way to reduce uncertainty, not an approved delivery sequence. Retiring legacy behavior would require explicit compatibility decisions, migration tooling/docs and user acceptance. Any later extension implementation would trigger the repository's documentation/check rules; this research adds no extension code. [R12]

## 8. Evaluation needed before trusting it

**Observation:** Existing live tests cover real-agent execution/grants/nesting/handoff/worktrees; existing prompt-quality evals address routing, planner recall, review and implementation. They do not establish GOAP correctness. Live tests/evals are local, credentialed and paid; repeated eval runs record cost/duration and failed sessions. `npm run check` excludes those live/eval runs. [R11]

**Recommendation—deterministic checks:**

- Small known domains: reachable/unreachable goals, competing actions, unknown facts, invalid schema and bounded search; compare with explicit expected plans/state transitions, not merely fluent explanations.
- Reject unsatisfied/stale preconditions and unauthorized effects; validate partial and contradictory results; invalidate checks on workspace revision changes.
- Fault-injected execution: retry bounds, cancellation during queue/execution/validation, context successor identity, missing evidence, validator failure, deduplication and ambiguous external side effects.
- Scheduler races: conflicting resource claims, integration changes, nested budget reservations, child cancellation, slot starvation and lease expiry.
- Crash/restart at each intent/execution/evidence boundary; ensure no unapproved replay and distinguish historical records from resumable actions.

**Recommendation—live evaluation:** Compare direct delegation, a fixed dependency workflow and planned execution on the same bounded tasks across repeated runs. Include alternative paths, partial writes, stale facts, failed tests and user rejection. Measure independently validated goal completion, false-success rate, forbidden dispatch/effect rate, recovery correctness, replans/retries, user interventions, latency and actual aggregate cost. Report dispersion and failed sessions, not only successful anecdotes. Validator false acceptance is a central metric. Establish acceptable thresholds before trial; this research supplies no performance or reliability result.

## 9. Rough effort and uncertainty

These are **planning judgments, not quotations, benchmark results or commitments**. Units are focused engineer-weeks for one experienced TypeScript engineer familiar with this repository; calendar time increases with reviews, interruptions and external decisions. Ranges include design, tests and documentation, but exclude building an OS sandbox, provider/runtime changes, broad domain catalogues and unattended high-impact external transactions.

| Scope | Rough effort | Assumptions and exclusions |
|---|---:|---|
| Bounded feasibility experiment | 2–4 weeks | One domain, approximately 5–10 hand-authored actions, existing runner retained, serial writes, deterministic validators, no automatic crash resume, minimal plan display. Answers whether planning helps; not production-safe general autonomy. |
| Usable opt-in hybrid | 8–14 weeks total, including experiment | Reliable state/evidence model, revalidation/retries, conflict controls, aggregate accounting, useful controls/status, versioned persistence with conservative restart, compatibility and deterministic/live evaluations. Requires decisions in §10 and limited side effects. |
| Broad orchestration replacement | 4–8+ engineer-months total | Several domains, nested plans, mature UI/non-TUI controls, migration and difficult recovery/concurrency cases. Highly sensitive to catalogue scope and approval/isolation requirements; not a prediction that all existing modules must be rewritten. |

The dominant uncertainty is **whether useful goals can be represented and validated affordably**, not which graph-search library to install. Additional domain actions, independent validators, worktree integration and safe external side effects can each expand the effort. The sources reviewed are Unity/C# GOAP examples; this research did not evaluate a TypeScript library, dependency suitability or a production-ready planner package. A dependency decision remains open.

## 10. Decisions required and feasibility verdict

The user must decide:

1. **Problem:** dynamic alternative-path planning, or simply better routing/ordered workflows and stronger checks? What repeated failure justifies GOAP?
2. **Domain:** which first goal family, and who authors/maintains its facts, actions and validators?
3. **Truth:** which evidence can satisfy each acceptance condition, and which judgments require human approval?
4. **Authority:** proposal-only, approval per plan, or autonomous bounded execution? Which side effects are prohibited?
5. **Resources:** shared workspace versus isolated worktrees; who integrates; how are conflicts and nested ownership handled?
6. **Limits:** cost/latency/risk objective, budget enforcement expectations, retry/replan ceilings and cancellation semantics?
7. **Recovery:** stop-and-report after restart, reconcile then ask, or automatic resume for a defined idempotent subset?
8. **Compatibility and success:** retain direct delegation indefinitely? Which reliability, cost and usefulness thresholds justify broader migration?

**Unresolved platform facts:** child approval behavior in relevant pi modes, isolation properties of granted tools, and runtime-level child-session resume were not established by the examined repository evidence. Do not promise those properties based on tool lists, worktrees or manifests. Original academic-source verification and library selection also remain open; neither prevents a bounded design assessment.

**Feasibility verdict:** feasible as a narrow, evidence-driven planner/executor layer; not justified as a wholesale rebuild on current evidence. The hybrid preserves proven mechanics while making missing semantics explicit. If goals/actions cannot be bounded and effects independently observed, GOAP would mostly formalize optimistic prose and should not be adopted. No implementation is approved by this note.

## Sources

### Repository evidence

Paths and ranges below identify the evidence behind the observations; future behavior elsewhere in this note is explicitly analysis/proposal.

- **R1:** `extensions/subagents/core/model/agent-schema.ts:9–22`; `core/agent-definitions/fields.ts:38–58`; `core/agent-definitions/loader.ts:32–53`; `extensions/subagents/agents/leads/planner.md:14–20`. The unprefixed `core/` paths here and below are under `extensions/subagents/`.
- **R2:** `extensions/subagents/core/run-agent/tools.ts:101–130`; `core/run-agent/runner.ts:737–750,791–905` (selection/grants/depth/cap and pre-spawn validation).
- **R3:** `extensions/subagents/core/run-agent/runner.ts:599–703`; `core/run-agent/semaphore.ts:12–44`; `core/agent-status/snapshot.ts:78–105` (runtime/scheduling/observations).
- **R4:** `extensions/subagents/core/run-agent/runner.ts:458–486`; `core/run-agent/result.ts:41–60` (completion/result selection). Code behavior, rather than prose status conventions, grounds the completion claim.
- **R5:** `extensions/subagents/core/run-agent/runner.ts:161–179,369–443,737–750,1000–1073`; `core/run-agent/outbox.ts:13–28`; `extensions/subagents/api/plugins/run-agent.ts:40–86` (settlement/handoff/nesting/stop).
- **R6:** `extensions/subagents/core/agent-registry/registry.ts:20–50,59–107`; `core/model/manifest.ts:33–78`; `extensions/subagents/api/plugins/agent-registry.ts:35–40` (manifest history/restoration).
- **R7:** `extensions/subagents/core/run-agent/placement.ts:25–47` (shared/worktree placement).
- **R8:** `platform/pi-adapter/types/runtime.ts:39–57`; `platform/pi-adapter/child/child-runtime.ts:62–69,140–153,179–195` (spawn specification, selected tools/settings/session creation). These establish configuration, not OS isolation.
- **R9:** `extensions/subagents/core/model/settings.ts:43–56,109–123,141–145`; `extensions/subagents/api/plugins/limits.ts:18–57` (limits/trusted settings/context controls).
- **R10:** `extensions/subagents/api/plugins/interrupt.ts:17–43`; `api/plugins/agent-status.ts:15–18,34–57`; `api/plugins/usage-report.ts:5–10`; `core/run-agent/runner.ts:290–298,556–564` (stop/status/usage).
- **R11:** `test/evals/README.md:3–24`; `extensions/subagents/tests/live/run-agent.live.test.ts`; `grants.live.test.ts:35–41,67–90`; `nesting.live.test.ts:14–55`; `handoff.live.test.ts:26–51`; `worktree.live.test.ts` (existing evaluation/mechanics coverage).
- **R12:** Root `ARCHITECTURE.md`, sections “Layers,” “Repo rules,” “Who enforces what,” and “Files the extensions write”; `AGENTS.md`, checks/rules; `STRUCTURE.md`, “Published vs development-only”; `future-plans/README.md:3` (architectural/write/check conventions and topic-folder convention).

### External primary sources

- **G1:** ReGoap, [`IReGoapAction<T,W>` source](https://raw.githubusercontent.com/luxkun/ReGoap/master/ReGoap/Core/IReGoapAction.cs): planner preconditions/effects/cost versus `Run` and completion/failure callbacks. Accessed 2026-10-26. No ReGoap README quotations are used.
- **G2:** CrashKonijn GOAP v3, [Actions](https://goap.crashkonijn.com/classes/actions.md): action configuration conditions, effects, cost and `ValidateConditions`. Accessed 2026-10-26.
- **G3:** CrashKonijn GOAP v3, [Sensors](https://goap.crashkonijn.com/classes/sensors.md) and [What is GOAP?](https://goap.crashkonijn.com/readme/theory.md): world-state sensing and explanatory execution/re-evaluation cycle. Accessed 2026-10-26.
