# Nesting depth, mode switching and agent creation

Research note, 2026-10-17. Sources were fetched on that date. Most quotes came through a summarising fetch tool and are near-verbatim; two load-bearing quotes were re-checked against the raw pages on that date (the Claude Code depth text and the Cursor nesting FAQ). The Claude Code CHANGELOG has no dates, so its dates are npm publish dates. Items marked UNVERIFIED come from search snippets. Raw notes are in the session scratchpad, not in the repo.

Model and product names below are quoted from the sources. They are evidence, not recommendations for code or prompts.

## Question

Three questions feed [orchestrator-model.md](../design/orchestrator-model.md):

- (A) Is a depth of 3 (main, lead, chore) normal, or should agents not nest?
- (B) How do products switch between planning and executing, and is "build" a mode of its own?
- (C) Do products ship a command or wizard to create agents?

Terms: "depth 3" here means main, then a lead, then a chore: the main session plus two subagent layers (`maxDepth: 3`, `extensions/subagents/src/model/settings.ts:35`).

## A. Nesting depth

| Product | Nesting | Source |
| --- | --- | --- |
| Claude Code | Yes. "By default, a subagent can spawn subagents of its own, up to three layers below the main conversation." `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` sets it; "Set `1` to turn nesting off". At the limit the Agent tool is withheld. A per-agent opt-out is to omit `Agent` from `tools`. History: 2.1.172 to 2.1.216 allowed five fixed layers; 2.1.217 (2026-07-21) "no longer spawn nested subagents by default"; 2.1.219 (2026-07-24) "up to depth 3 by default (was 1)". Agent teams: "No nested teams". | code.claude.com/docs/en/sub-agents (re-checked), CHANGELOG |
| Cursor | Yes, our shape. "Since Cursor 2.5, subagents can launch child subagents ... The main agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't launch further ones." UNVERIFIED: the SDK allows any depth. | cursor.com/docs/agent/subagents (re-checked) |
| Codex | Off by default. `agents.max_depth` appears only in source ("Maximum nesting depth for V1 agent threads. Ignored by V2."), `DEFAULT_AGENT_MAX_DEPTH = 1`. Docs document only concurrency. | github.com/openai/codex `codex-rs/config/src/config_toml.rs` |
| Gemini CLI | No. "subagents cannot call other subagents", even with the `*` wildcard. The docs banner says Gemini CLI was replaced by Antigravity CLI on 2026-06-18. | geminicli.com/docs/core/subagents |
| Cline | Yes. "A subagent can start subagents of its own" (CLI and Desktop). No limit stated. | docs.cline.bot/features/subagents |
| Roo Code | Not documented. Archived 2026-05-15. | roocodeinc.github.io/Roo-Code |
| LangChain Deep Agents | Isolated subagents can use `task`; forked ones cannot. No depth counter; issue #6265 (2026-09-11): "A `task` call is unbounded today". | docs.langchain.com/oss/python/deepagents/subagents |

Literature:
- arXiv 2512.08296 (Google and MIT, v3 2026-04-08) tested only flat topologies (one orchestrator over workers). Error amplification: independent 17.2x, centralized 4.4x ("by enforcing validation bottlenecks"). Tool-heavy tasks "suffer from multi-agent coordination overhead". "Hierarchical self-organization ... remains an open question".
- Anthropic, multi-agent research system (2025-06-13): one level only; "errors compound".
- ReDel (arXiv 2408.02248): recursive delegation fails when an agent "re-delegates the task it was given" until it hits the depth limit.
- OpenAI Agents SDK: agents-as-tools can nest, no depth guidance. The Practical Guide PDF was unreadable (UNVERIFIED).

**Verdict A: depth 3 is SUPPORTED by shipped products and NEUTRAL in the literature.**
- Cursor ships exactly main, subagent, leaf. Claude Code defaults to three layers below main, one deeper than ours, after a three-day flip to no nesting in July 2026.
- Codex and Gemini CLI are more conservative (no nesting by default).
- No paper tests or warns against three levels. What evidence exists favours a verifying centre, strong leads over cheaper workers, and leaves that spawn nothing. Our chores start nothing.
- Cautions: overhead on tool-heavy tasks; little gain where one agent already succeeds; agents that re-delegate their whole task (ReDel).

## B. Mode switching

| Product | Enter | Enforced | Artifact | Leave | Model on leave |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Shift+Tab cycle (default, acceptEdits, plan), `/plan [desc]`, `--permission-mode plan` | Edits blocked until approval; shell through a classifier | Markdown file in `~/.claude/plans`; Ctrl+G opens it | Approval dialog ("Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"); same session, plan in context | `opusplan` (1.0.77, 2025-08-12): strong in plan, cheaper in execution |
| Codex CLI | `/plan` (not while working) | Prompt only ("You are in **Plan Mode** until a developer message explicitly ends it") | `<proposed_plan>` block, not a file | "Implement this plan?" ("Yes, implement this plan", "Yes, clear context and implement", "No, stay in Plan mode"); sends "Implement the plan." | Model unchanged; `plan_mode_reasoning_effort` |
| Cursor | Shift+Tab | Not documented | Editable plan with to-dos, saved in home dir; "Save to workspace" | Build button; UNVERIFIED: "Build Locally" / "Build in Cloud" | Not documented |
| Cline | Plan / Act toggle | "cannot modify any files or execute commands" | None built in | Switch to Act; "The conversation history carries over" | Opt-in "Use different models for Plan and Act" |
| Gemini CLI | Shift+Tab cycle, `/plan [goal]`, `--approval-mode plan` | Writes only to `.md` in the plans dir | `~/.gemini/tmp/<project>/<session-id>/plans/` | "Yes, automatically accept edits" / "manually accept edits"; same session | `general.plan.modelRouting`: Pro in plan, Flash after |

Sources: code.claude.com/docs/en/permission-modes; learn.chatgpt.com/docs/developer-commands.md and Codex `templates/plan.md`; cursor.com/docs/agent/plan-mode and the Cursor blog (2025-10-07); docs.cline.bot/core-workflows/plan-and-act; geminicli.com/docs/cli/plan-mode.

Claude Code has hidden "Yes, clear context and ..." by default since 2.1.81 (2026-03-20); `showClearContextOnPlanAccept` restores it.

Common pattern:
- Entry by a cycle key plus a `/plan` command, shown as a status badge.
- Plan mode is read-only, by tool gating (Claude, Gemini, Cline) or by prompt (Codex).
- The plan is markdown: a file in a home or temp dir, or an inline block.
- Execution starts from an approval prompt or a Build button and continues in the same session with the plan in context.
- A model change is optional and goes strong to cheaper (opusplan, Gemini routing, Cline Act model).

**Verdict B: two states, not three.** No product has a distinct third "execute the approved plan" state. Leaving plan mode is the execution step, and a cheaper model is a property of that exit. Cursor's "Build in Cloud" (UNVERIFIED) is the nearest thing to a separate execution target.

## C. Agent creation and configuration

| Product | Create | Tune existing | Source |
| --- | --- | --- | --- |
| Claude Code | `/agents` wizard added 1.0.60 (2025-07-24), tabbed 2.1.98 (2026-04-09), removed 2.1.198 (2026-07-01): "Removed the `/agents` wizard; ask Claude to create or manage subagents, or edit `.claude/agents/` directly". No reason given. Docs: "ask Claude to write it for you, or write the file yourself." The wizard's steps are UNVERIFIED. | /config, /permissions, /mcp, /model, /skills | CHANGELOG; code.claude.com/docs/en/sub-agents |
| Codex | TOML files in `~/.codex/agents/` or `.codex/agents/`; no scaffolding command | `/permissions` | learn.chatgpt.com docs |
| Cursor | "The easiest way to create a subagent is to ask Agent to create one for you", or add `.cursor/agents/*.md` | Not documented | cursor.com/docs/agent/subagents |
| Gemini CLI | Files by hand; no create command | `/agents config`: model, temperature and limits of an existing agent | geminicli.com/docs/core/subagents |
| Roo Code | Modes-view form (Name, Slug, Description, Save Location, Role Definition); also "asking Roo Code to do it for you". Archived 2026-05-15. | Same form | roocodeinc.github.io/Roo-Code |
| Cline | None | None | docs.cline.bot |

**Verdict C: no product ships a creation wizard in 2026.** Claude Code removed its wizard; Codex and Gemini never had one; Cursor documents only "ask the agent"; the one form-based creator (Roo) was archived. The pattern is agent files plus asking the model to write them. Interactive UIs survive for tuning existing configuration (Gemini `/agents config`, Claude Code `/mcp`, `/permissions`), which is the role `/agents setup` takes in the design.

## Could not source

- Why Claude Code removed its wizard.
- Whether Cursor changes model or enforces read-only in plan mode.
- Any study of a second strong layer (main plus leads) against a single orchestrator.
