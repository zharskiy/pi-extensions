# Plan mode (Q4) and guards (Q8)

grill and wayfinder texts from the GitHub API (`gh api repos/mattpocock/skills/contents/...`), as of 2026-10-18.

## Q4. Plan mode, or a grill-me / wayfinder style skill?

### What the skills say

grill-me (`skills/productivity/grill-me/SKILL.md`) is a two-line entry point only the user can start: `disable-model-invocation: true` … "Call the Skill tool with "grilling"."

grilling (`skills/productivity/grilling/SKILL.md`):
> "Interview the user relentlessly until you reach a shared understanding. Map this as a design tree: every decision branches into the decisions that hang off it."
> "Work the tree in rounds. The frontier is every decision whose prerequisites are already settled … Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round."
> "Word each question so "yes" accepts your recommended answer."
> "Finding facts is your job, never the user's. When a frontier question needs a fact from the environment … dispatch a sub-agent to find it … The decisions are the user's: put each to them and wait."
> "The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding."

History: original (62f43a18) "Ask the questions one at a time. If a question can be answered by exploring the codebase, explore the codebase instead." July 2026 (170ad486) added the confirmation gate. Frontier rounds replaced one-at-a-time on 2026-07-16 (a4b2009a).

grill-me writes nothing ("writes no files and leaves no workspace behind", `docs/productivity/grill-me.md`). grill-with-docs writes `GLOSSARY.md` and ADRs. A written plan comes from `/to-spec`. Stops when the frontier is empty and the user confirms. No harness enforcement; prose only; `disable-model-invocation` only stops the model starting the skill.

wayfinder (`skills/engineering/wayfinder/SKILL.md`): planning "more than one agent session can hold". Keeps a shared map issue labelled `wayfinder:map` on the tracker (local markdown if none). Child issues typed `research` (subagent), `prototype`, `grilling`, `task`. "never … more than one ticket per session". Prose guard only:
> "## Plan, don't do — Wayfinder is planning by default … The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its Notes…"
Stops when no tickets left, hands off to `/to-spec` and `/to-tickets`.

### Evidence that a planning skill drifts into editing

- `docs/productivity/grilling.md`, "It ran out of questions and started building": "Weaker and faster models still skip the gate … the reliable fix is a line in your own AGENTS.md or CLAUDE.md telling the agent not to implement without permission."
- `docs/engineering/wayfinder.md`: "My agent started writing production code in the middle of a wayfinder session. This is the most-reported failure with this skill." One agent wrote "this map carries execution" into its own Notes, then "built on a live server".
- `docs/productivity/grill-me.md`: "Leave plan mode off. Plan mode makes the agent hurry to produce a plan, when you want it to keep asking questions."

Repo research claims: frontier-workflows.md §2 "plan mode is a permission state" describes what vendors ship, not a measurement. "Dead ends: prose prohibitions" is about standing rules in long-running work and bloated instruction files (Claude Code best practices: "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic"). Not planning-specific. Replit's agent deleted a production database despite a "code freeze" instruction (https://www.eweek.com/news/replit-ai-coding-assistant-failure/); Replit's fix was a harness-level "planning/chat-only mode".

### Risk in the owner's setting

With a developer in the loop, the realistic failure is: at the end of the interview the model starts implementing. Visible, recoverable with git, low severity.

Planning-time delegation risk is smaller than 02 assumes: `scout`, `planner`, `fetch`, `image` are already read-only via `tools` frontmatter; `run_agent` has no `tools` parameter. 02's "computed read-only delegation" and a `readOnly: true` flag duplicate what agent files guarantee. Only `implementer`, `general` (edit/write), `shell` and `reviewer` (bash) can change things; `shell` and `reviewer` are read-only by prose alone.

### Options

- (a) Skill only. No hard stop; no footer status, no plan-path record for handoff, no discrete approval event. Fine for frontier models in a watched session.
- (b) Skill plus minimal toggle. `/plan` loads the skill and blocks `edit`/`write` outside the plan file; refuses `run_agent` for agents whose tools include `edit` or `write`. No bash allowlist. pi already ships almost this as `examples/extensions/plan-mode/` (disables edit/write and adds a bash allowlist).
- (c) Full 02. Adds bash allowlist, child enforcement, model-callable enter/exit, three-way approval, persistence. Costs: allowlist friction (`npm test`, `jq`), more code, and Pocock's warning that plan mode rushes the interview.

Value independent of enforcement: `exit_plan_mode` plus three-way approval has real value (turns "do not act until the user confirms" into a discrete event). State entry for handoff: only "record the plan file path in the handoff". `enter_plan_mode`: little value without enforcement.

Recommendation: (b), skill first, toggle second. Ship a `plan` skill adapted from `grilling` (frontier rounds, recommended answers, facts via scouts, decisions from the user, confirmation gate). Writes `<session folder>/workflow/plan.md` (or a to-spec step does) and records the path in the handoff. `/plan` loads the skill and turns on one `tool_call` rule: block `edit`/`write` outside the plan file, refuse write-capable agents. Leave with approve / keep planning / abandon. Drop from 02: bash allowlist, computed read-only list, guard propagation to children, model-callable `enter_plan_mode`, persistence entry. (a) is defensible for frontier models with the developer watching, plus one AGENTS.md line.

## Q8. Guards, or skills that say "do not commit" / "never touch these files"?

### Evidence

- Anthropic (https://code.claude.com/docs/en/best-practices): "Use hooks for actions that must happen every time with zero exceptions." "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic." Example hook: "blocks writes to the migrations folder." "When the context window is getting full, Claude may start forgetting earlier instructions." "If your CLAUDE.md is too long, Claude ignores half of it."
- HumanLayer (https://www.humanlayer.dev/blog/writing-a-good-claude-md): "Claude frequently ignores your CLAUDE.md file's contents"; frontier models follow "~150-200 instructions with reasonable consistency".
- IFScale (https://arxiv.org/abs/2507.11538): adherence drops with instruction count; best models ~68% at 500 instructions; bias toward earlier instructions.
- Gap: no measured data on a single short prohibition in coding agents. "Most of the time" is the problem only when nobody is watching.

### Where the prose goes

A skill is the weakest place for a prohibition: only the description sits in the prompt; the body loads on demand. Prohibitions belong in AGENTS.md or the agent file body. "Do not commit, push or change git state unless the task says so" is already in `leads/implementer.md` and `leads/general.md`.

### Two cases by cost

| | (i) Main session, developer watching | (ii) Unattended parallel subagents |
|---|---|---|
| "Do not commit" | Prose is enough; visible and reversible. | Prose mostly works. Risk: every shipped agent has `worktree: false`, so `git commit -a` in the shared tree sweeps sibling edits. `push` is the irreversible one. |
| "Never touch generated files" | Prose plus review. | Easy to miss in review, silently overwritten on regeneration. Enforcement clearly pays. |

### What pi provides today

- No deny-list setting (`docs/security.md`). Only whole-tool selection: `defaultTools`, `--tools` / `--exclude-tools`.
- Skill `allowed-tools` is pre-approval, not restriction.
- Hooks are pi's route: `examples/extensions/protected-paths.ts` (~20 lines on `tool_call` blocking `write`/`edit` to listed paths) and `permission-gate.ts`.
- A user-installed extension already reaches subagents: `core/adapter/pi-child.ts:210–215` filters child extensions only by `childExclude` (= `extensions/subagents/src`, `src/index.ts:34`). A ~20-line extension in `~/.pi/agent/extensions/` or a trusted project's `.pi/extensions/` runs in every subagent with no guards code. Caveats: it cannot tell which agent it runs in (global rules); not verified that project extensions load from the child's cwd.

### Weaknesses in 06

`denyCommands` is "advisory in strength". `denyPaths` only covers `edit`/`write`; bash can still `sed -i`. Both halves stop accidents, not a determined model. The accidental case is the real threat; a short path rule covers it.

Recommendation: prose for advice, plus one small enforced path list. No per-agent guards, no `denyCommands`. Keep "do not commit" as the existing prose line. Shared-worktree sweep is better solved with `worktree: true` for parallel implementers. For "never touch these files": a single `protectedPaths` glob list in user settings and the trusted project's settings, enforced on `edit`/`write` in `tool_call` for main session and every child (pi's `protected-paths.ts` with globs and a settings key). Could ship as a standalone pi extension or just be documented. Drop from 06: `*`/per-agent keys, `denyCommands`, workspace-per-repo resolution. Keep `tools` and `mcp` overrides. Add a fixed child-only `git push` rule later if ever needed.

Files: `future-plans/02-plan-mode.md`, `future-plans/06-project-rules.md`, `research/frontier-workflows.md`, `core/adapter/pi-child.ts`, `node_modules/@earendil-works/pi-coding-agent/examples/extensions/protected-paths.ts`, `.../examples/extensions/plan-mode/`.
