# Orchestrator capability: cheap delegate-only coordinator or capable deciding coordinator

Research note, 2026-10-17. Sources were fetched on that date. Most quotes came through a summarising fetch tool; the Cognition 2026-04-22 quotes were re-checked at source. Items marked UNVERIFIED come from search snippets or secondary sources. Items marked "unsourced" are claims the research looked for and could not find. Raw notes are in the session scratchpad (r1 to r5), not in the repo.

Model and product names below are quoted from the sources. They are evidence, not recommendations for code or prompts.

## Question

Should the user-facing main session run on a cheap model that only routes and delegates (the default in [agent-workflow.md](../design/agent-workflow.md), "Goals"), or on a capable model that makes the decisions itself and delegates the work? The note covers four sub-questions:

- (a) Does a cheap main session with strong subagents keep quality?
- (b) Does a strong planner with cheap executors keep quality?
- (c) Does interactive planning need the strong model in the user-facing loop?
- (d) Does any product ship a cheap delegate-only user-facing model as its default?

[orchestration-best-practices.md](orchestration-best-practices.md) Q1 (2026-10-16) covered weak orchestrators already. This note adds product defaults, cost figures and planning loops, and gives verdicts.

## How products assign model tiers

| Product | Main-session model | Planning model | Worker / subagent model | Source and date |
| --- | --- | --- | --- | --- |
| Claude Code | Top capable model by default for paid plans and API | `opusplan`: "uses `opus` during plan mode, then switches to `sonnet` for execution" | Inherits the main model unless set; docs list routing to Haiku to "control costs". Explore moved from Haiku (2.0.17) to "inherits the main session's model (capped at opus)" (2.1.198) | code.claude.com/docs/en/model-config and /sub-agents, fetched 2026-10-17; CHANGELOG (undated entries) |
| Anthropic research system | Opus 4 lead | Lead plans | Sonnet 4 subagents | anthropic.com/engineering/multi-agent-research-system, 2025-06-13 |
| Anthropic Haiku 4.5 launch | Sonnet 4.5 "break[s] down a complex problem into multi-step plans" | Same | Haiku 4.5 workers in parallel | anthropic.com/news/claude-haiku-4-5, 2025-10-15 |
| OpenAI Codex | Session model | `/plan` read-only, approval-gated (UNVERIFIED, third-party) | Inherits parent model and effort unless `agents.default_subagent_model` or per-agent `model`; stronger model for demanding agents, fast model for narrow high-volume ones | learn.chatgpt.com/docs/agent-configuration/subagents, undated, fetched 2026-10-17 |
| Cursor (IDE) | Session model | Plan Mode uses the session model; no plan/build split documented | Same as parent by default; explore subagent "uses a faster model by default" | cursor.com/blog/plan-mode, 2025-10-07; cursor.com/docs/subagents, undated |
| Cursor swarms | n/a (no user-facing coordinator) | "Planner agents, powered by the smartest models" | Workers "generally powered by faster and less expensive models" | cursor.com/blog/agent-swarm-model-economics, 2026-07-20 |
| Cursor Router | Per-turn complexity routing, cheap or frontier (UNVERIFIED detail) | Per turn | Per turn | cursor.com/blog/how-cursor-router-works, 2026-07-22 (search summary) |
| Cognition Devin Fusion | Frontier main agent: "delegate and monitor, while making the significant decisions" | Main agent | Cheaper "sidekick" | cognition.com/blog/devin-fusion, 2026-06-29 |
| Roo Code Orchestrator | Delegate-only mode, no file or command tools; model user-chosen, no official guidance | Delegated modes | User-chosen per mode ("sticky") | roocodeinc.github.io/Roo-Code/features/boomerang-tasks, updated 2026-05-15 |
| Kilo Code | Auto Model: Orchestrator mode gets Opus 4.6 (UNVERIFIED); Orchestrator mode now deprecated | Orchestrator | Implementation modes get Sonnet 4.5 (UNVERIFIED) | blog.kilo.ai (search summary); kilo.ai/docs orchestrator page, fetched 2026-10-17 |
| Cline | Plan/Act modes | "use a stronger reasoning model for planning" | "a faster model for implementation" | docs.cline.bot/features/plan-and-act, undated |
| Amp | Always a frontier model (dated chronicle entries 2025-05-22 to 2026-06-04) | Main agent plus a strong "oracle" model as a tool | Cheap search subagent (2025-12-17); "Rush" mode is user-chosen | ampcode.com/chronicle |
| Gemini CLI | Auto routing: simple prompts to Flash, complex to Pro | Session | Subagent model "Defaults to inherit" | geminicli.com/docs/core/subagents, fetched 2026-10-17 |
| Factory | Session | Spec mode can "use mixed models to configure a different model for planning" | Session | docs.factory.ai/cli/user-guides/specification-mode, undated |

Augment, Copilot's plan agent and Jules were not covered.

## Papers and controlled results

- **PEAR** (arXiv 2510.07505, v4 2026-01-08): "a weak planner degrades overall clean task performance more severely than a weak executor."
- **Google/MIT, "Towards a Science of Scaling Agent Systems"** (arXiv 2512.08296, 2025-12, snippet only): centralised orchestration contains error amplification (4.4x against 17.2x for independent agents); sequential tasks degrade 39 to 70% under multi-agent variants; returns diminish once the single-agent baseline passes about 45%.
- **MAST** (Cemri et al., arXiv 2503.13657, NeurIPS 2025): failures split roughly 44% system design and specification, 32% inter-agent misalignment, 24% verification (summed from per-mode figures). Top modes: step repetition 15.7%, reasoning-action mismatch 13.2%, disobeying the task spec 11.8%, incorrect verification 9.1%. Context loss was 2.80% and information withholding 0.85%. Specification and verification are decisions, and they dominate.
- **RouteLLM** (arXiv 2406.18665): "over 2 times" cost reduction without quality loss, per single query, with a trained router.
- **TwinRouterBench** (arXiv 2605.18859, 2026-05): router benchmarks treat tasks as one-shot and do not test routing inside a trajectory.
- **SWE-Router** (arXiv 2607.00053): on SWE-bench Verified, gemini-3-pro $391 / 70.4%, gpt-5-mini $16.6 / 55.6%, deepseek-v3.2 $22.6 / 62.4%. Routing improves when the router sees two exploratory turns (Route-AUC 0.627 to 0.780); gains are uneven across splits.
- **AgentRouter** (ICML 2026 listing, UNVERIFIED, self-reported): 72% cost cut at under 3% completion loss with step-level routing.
- **PlanAhead** (arXiv 2605.29927, 2026, snippet only): mixed planner/executor pairs generally beat homogeneous ones; the best pair is not simply the strongest model in each role.
- **ADaPT** (arXiv 2311.05772, 2023, snippet only): plans from one model help a smaller executor, up to +19.9%.
- **Aider architect/editor** (aider.chat/2024/09/26/architect.html, 2024-09-26), code-editing benchmark:

| Architect + editor | Pair score | Architect alone |
| --- | --- | --- |
| o1-preview + o1-mini or DeepSeek | 85.0% | 79.7% |
| Sonnet + Sonnet | 80.5% | 77.4% |
| Sonnet + DeepSeek | 78.9% | 77.4% |
| GPT-4o + DeepSeek | 74.4% | 71.4% |
| o1-mini + DeepSeek | 71.4% | 61.1% |

"Deepseek is surprisingly effective as an Editor model." One benchmark, 2024 models, small edits.

- **Cognition, "Multi-Agents: What's Actually Working"** (cognition.com/blog/multi-agents-working, 2026-04-22, industry report, not a paper, verified at source): a fast sub-frontier primary (SWE-1.5) with a strong planning "friend" (Sonnet 4.5). "SWE 1.5 was not good enough at being the primary model for this setup to really work. The cost and speed wins were real, but the quality ceiling was set by the primary, and the primary wasn't strong enough." Making it work "with an asymmetrically weaker primary" is "still an open problem, and we think it's a training one." With frontier primaries the pattern "produced real gains in the trickiest scenarios." Also: "Managers trained on small-scoped delegation default to being overly prescriptive", which "backfires when the manager lacks deep codebase context"; "multi-agent systems work best today when writes stay single-threaded."

## Cost figures

| Figure | Source and date |
| --- | --- |
| Agents use about 4x the tokens of chat; multi-agent systems about 15x. Token use explains 80% of performance variance. Opus lead + Sonnet subagents beat single-agent Opus by 90.2% | Anthropic, multi-agent research system, 2025-06-13 |
| Opus 4.8 planner + Composer 2.5 workers: $1,339 total, planner about two thirds of it. GPT-5.5 alone: $10,565 (its workers alone $9,373) | Cursor, agent swarm model economics, 2026-07-20 |
| Frontier main agent + cheap sidekick: about 60% lower cost at frontier-level performance (earlier figure 35%); models switched "during context compaction" via lightweight classifiers | Cognition, Devin Fusion, 2026-06-29 |
| Subagent runs consume more tokens than single-agent runs | Codex subagents docs, undated |
| Cost of re-briefing a fresh agent instead of continuing one | **unsourced**. Anthropic reports that vague briefs cause misinterpretation and duplicated work; Cognition says share full traces. No figure found |
| Resumable follow-ups against fresh spawns | **unsourced**. Anthropic built resume-from-checkpoint and external storage of subagent output; no controlled comparison found |

Two readings of the Cursor figure: a strong planner with cheap workers is far cheaper than a strong model doing everything, and the strong model still dominates the bill even when it only plans.

## Plan-mode interaction loops

Every vendor that ships planning keeps it interactive in the user-facing thread.

- **Cursor** (2025-10-07): "Answer clarifying questions on your requirements for the best output quality"; "You can edit the plan directly, including adding or removing to-dos." The session model plans.
- **Claude Code best practices** (code.claude.com/docs/en/best-practices, fetched 2026-10-17): "Separate research and planning from implementation to avoid solving the wrong problem"; Ctrl+G opens the plan for editing; an AskUserQuestion "interview" then a spec, executed in a fresh session; "If you could describe the diff in one sentence, skip the plan"; "Plan mode is useful, but also adds overhead." `opusplan` puts the strong model in that loop.
- **Codex `/plan`**: read-only, asks clarifying questions, waits for approval (UNVERIFIED, third-party only).
- **Cline Plan/Act** and **Factory spec mode**: the stronger model is placed in the planning phase.
- No vendor states why it rejects a one-shot planner subagent (unsourced). The evidence is the uniform shipped design, not a stated rationale.

The user's own earlier research, future-plans/plan-mode.md (2026-10-17), reaches the same shape: read-only research, validation of findings with the user, an editable versioned plan, explicit approval of one revision before Build.

## What the evidence supports

**(a) Cheap main session + strong subagents keeps quality: CONTRADICTED.**
- Direct test: Cognition 2026-04-22, weak SWE-1.5 primary with a Sonnet 4.5 planning friend: "quality ceiling was set by the primary."
- PEAR (2026-01-08): a weak planner hurts more than a weak executor.
- No source reports a cheap coordinator matching a strong one.
- Caveat: the closest shipped pattern, Roo's Orchestrator mode, has no official model guidance either way. Per-step agentic routers (SWE-Router, AgentRouter) are early and route per turn; they are not a fixed cheap coordinator.

**(b) Strong planner + cheap executor keeps quality: SUPPORTED.**
- Aider architect/editor (2024-09-26), Anthropic research system (2025-06-13), Haiku 4.5 announcement (2025-10-15), Cursor swarms (2026-07-20), Devin Fusion (2026-06-29), Cline Plan/Act guidance, Claude Code `opusplan`.
- Limits: the benchmarks are narrow; Cognition says writes work best single-threaded; MAST shows specification and verification failures dominate, so the executor's cheapness only helps if the spec and the check are good.

**(c) Interactive planning needs the strong model in the user-facing loop: INDIRECTLY SUPPORTED (no controlled study).**
- Every product keeps planning interactive in the main thread, and `opusplan`, Cline Plan and Factory spec mode put the stronger model exactly there.
- No source isolates the effect of model tier inside the interactive loop itself.

**(d) Nobody ships a delegate-only cheap user-facing model as default: SUPPORTED, with one nuance.**
- Claude Code, Codex, Cursor, Gemini CLI and Amp default to a capable main model, with subagents inheriting it.
- Roo and Kilo ship a delegate-only Orchestrator mode, but its model is user-chosen, and Kilo's Auto Model assigns it the strongest model (UNVERIFIED). Kilo now marks Orchestrator mode deprecated in favour of agents that "delegate to subagents automatically" (kilo.ai docs, fetched 2026-10-17).
- Cursor Router routes per turn; it is not a fixed cheap coordinator.
- No counterexample found.
