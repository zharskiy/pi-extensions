# How Claude Code names subagents to the user

Research notes, 2026-10-14. Subject: Claude Code 2.1.296 (`/Users/maxim/.local/share/claude/versions/2.1.296`). Completes `claude-code-agents-ux.md` (read that first; it covers layout, keys and timings). This file covers only identity: what each agent is called, and what the user sees about it on each surface.

Evidence conventions: `bin@N (fn)` = character offset N in `strings -n 6` of the binary, with the minified function name. `docs <page>` = code.claude.com/docs/en/<page>. `cl <version>` = CHANGELOG.md line under that version. Every claim below has one of these or is marked "unverified".

## 1. Identity model

An agent has four identifiers. Who sees each:

| Identifier | Origin | Model sees | User sees |
|---|---|---|---|
| Agent type (`subagent_type`): `Explore`, `Plan`, `general-purpose`, `fork`, custom `code-reviewer`, plugin `my-plugin:review:security` | the agent definition's `name` frontmatter ("identity comes only from the `name` frontmatter field", docs sub-agents) | yes | yes, on most surfaces. `general-purpose` shows as `Agent` in the transcript block (bin@29322114 `SFr`: type equal to `general-purpose` returns undefined, `o9n` falls back to `"Agent"`; cl 2.1.293/2.1.295 fixed a custom agent named `worker` wrongly shown as "Agent"). The panel, the detail dialog and the hook payload use the raw type. |
| `name` parameter (optional) | the model, on the Agent call: `"Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running."` (bin@17404258). "Claude … may do so on its own, without asking you first" (docs sub-agents). | yes (its address) | yes: panel row label, `Message @name…` placeholder, permission prompts, `@` typeahead ("Named background subagents currently running in the session also appear in the typeahead, showing their status next to the name", docs sub-agents). With agent teams on, a named agent becomes a teammate shown as `@name` (docs agent-teams). |
| `description` parameter (required) | the model: `"A short (3-5 word) description of the task"` (bin@17404258) | yes | yes: the main label everywhere (transcript row, completion line, `/tasks` row, detail title, panel row until a progress summary exists). |
| Agent id, e.g. `a3f9c2…` | generated: `` t?`a${t}-${s}`:`a${s}` `` with `s` = 8 random bytes hex (bin@12863662 `Fh`), i.e. `a` + 16 hex | yes, in tool results and `<task-notification>` | **no**. Not on any UI surface found. The launch result tells the model: `agentId: … (internal ID - do not mention to user.` and `This tool result is internal metadata \u2014 never quote or paste any part of it, including the agentId below, into a user-facing reply.` (bin@29366365). Only places a user can meet it: transcript file names `agent-{agentId}.jsonl` and by asking Claude ("You can also ask Claude for the agent ID", docs sub-agents). cl 2.1.286 fixed "hand-back messages showing a raw task id instead of the agent's name". |

Plain answers:

- The user never sees the internal id in the UI. Claude Code actively keeps it out (model instructions above).
- The user sees the type on the transcript launch row (`**Explore** (description)`), the panel row (when the agent has no `name`), the `/tasks` detail title (`Explore › description`) and permission prompts (`from the Explore agent`). The `/tasks` list row does not show it.
- The description is the primary label: transcript row, completion line, `/tasks` row and detail title all use it.
- The name, when the model set one, replaces the type on the panel row, in the placeholder and in permission prompts. Most agents have no name; then those surfaces fall back to the type.

## 2. Information per surface

`yes` shown, `no` not shown, `cond` conditional (condition in the notes below the table).

| Surface | type | name | description | progress / tool | elapsed | tokens | tool uses | model | effort | status word | id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Transcript launch block row | cond (a) | cond (b) | yes | cond (c) | no | cond (d) | cond (d) | cond (e) | no | yes | no |
| Transcript completion line | no | no | yes | no | yes | no | no | no | no | yes | no |
| Panel row below the prompt | cond (f) | cond (f) | cond (g) | cond (g) | yes | yes | no | no | no | cond (h) | no |
| `/tasks` list row | no | no | yes | no | no | no | no | yes | cond (i) | yes | no |
| `/tasks` detail dialog | yes | no | yes | yes (j) | yes | yes | yes | yes | cond (i) | yes | no |
| Agent transcript view (Enter) | cond (k) | cond (k) | no | no | no | no | no | no | no | no | no |
| Permission prompt from an agent | cond (l) | cond (l) | no | no | no | no | no | no | no | no | no |
| `subagentStatusLine` hook payload | yes | cond | yes | yes (`label`) | `startTime` | yes | no | yes | cond | yes | yes (`id`) |

Notes:

- (a) Type is bold, coloured by the definition's `color`. Hidden on the rows when every agent in the block has the same type: the header then reads `Running 3 Explore agents…` and each row shows only the bold description (bin@41438586 `ym`, `hideType`; bin@41674814 `PLo`: `E=M.every(U=>U.agentType===M[0]?.agentType)`).
- (b) Name shows only on same-type rows: `**name**: description` (no `@`; bin@41438586 `ym`: `f??g??l` then dim `": ",g`). Teammates show `**@name** (Type)` with the description in the status line (bin@41674814 `PLo`: ``re=`@${J.data.name}` ``).
- (c) Status line `⎿  <last tool info>` (foreground) or `Initializing…`, `Running in the background`, `Done` (bin@41438586). Last tool info folds searches/reads, e.g. `Searching for 2 patterns, reading 3 files` (bin@41674814 `nMs`).
- (d) ` · N tool uses · 12.3k tokens` while not a resolved background launch; dropped once `background agents launched` (bin@41438586: `ue=!W&&…`).
- (e) A dim model line only when the call passed a `model` override that resolves to something other than the main model, or when the agent switched models (`a → b`) (bin@41670038 `TLo`). Placement inside the block unverified.
- (f) Label = registered `name` (no `@`) else raw `agentType` (teammates: `identity.agentName`) (bin@43289677 `P1`, bin@43299099 `name:Jr.get(Ei.id)` from `agentNameRegistry`). Never both.
- (g) One column: `progress.summary` if any, else description (bin@43304428 `Yoe`: `Nr(T.progress?.summary??"")||Nr(T.description)`). See section 4.
- (h) The elapsed slot becomes `waiting`, `idle`, `awaiting approval` (bin `BNe`, see the UX report §1). A `subagentStatusLine` hook replaces everything after the glyph with its `content` (bin@43304428 `Yoe`, `ee?.content` branch; docs statusline).
- (i) `yXe(model, effort)` = `<model display name>` or `<model display name> (<effort>)` (bin@41618549). docs sub-agents: "Claude Code names the model on the subagent's row, and adds the effort level set for that subagent, if any."
- (j) `Progress` section with `recentActivities` (last one prefixed `› `), then `Prompt` (first 300 chars), then `Error` (bin@43515900 `kG`).
- (k) No header names a local subagent; the prompt placeholder reads `Message @<name or agentType>…` cut to 20 chars (bin@43475127 `pse`, bin@43739006 `gpe`; cl 2.1.251). The header `Viewing @name · esc to return` plus the dim prompt exists only for teammates (bin `$6` uses `xh` = viewed teammate, `h.identity.agentName`).
- (l) Title row suffix `· from the <name ?? agentType> agent`, or `· from a subagent` when unknown (bin@40790770 `XY`; source `{type:"subagent",agentName:y.displayName??y.subagentName}` bin@42210223, `displayName` = the `name` param, `subagentName` = the type, bin@29355448).

## 3. Exact strings

| String | Surface | Source |
|---|---|---|
| `Running **3** agents…` / `Running **3** Explore agents…` | transcript header | bin@41674814 `PLo` |
| `**Explore** (Map the auth module) · 4 tool uses · 12.3k tokens` | transcript row, mixed types | bin@41438586 `ym` |
| `**Map the auth module**` | transcript row, same type | bin@41438586 `ym` (`hideType`) |
| `**auth-mapper**: Map the auth module` | transcript row, same type, named | bin@41438586 `ym` |
| `code-improver(Suggest code improvements)` | transcript row as described by docs | docs sub-agents (older render; the bin uses `Type (description)`) |
| `Agent "Map the auth module" finished` + ` · 3m 12s` | completion line | bin@25566689 `` pt=`${Mon}${r}" ${Ze}` ``, `Mon='Agent "'`; duration from UX report §4 |
| `○ auth-mapper (+2)  Reading runAgent.ts   1m 5s · ↓ 12.3k tokens` | panel row | bin@43304428 `Yoe`, `zRt` `` ` (+${n})` `` |
| `name · description · token count` | panel row, as docs describe it | docs statusline |
| `Map the auth module   running   provider/model (high)` | `/tasks` row | bin@43523940 `NG`: `label:h.description`, meta `running|done|waiting|parked[, unread]`, `yXe` |
| `@researcher` | `/tasks` row, teammate | bin@43582647 `EWe`: ``label:`@${h.identity.agentName}` `` |
| `Explore › Map the auth module` (`Async agent` when no description) | `/tasks` detail title | bin@43515900 `kG`: `[go," › ",Mo]`, `T.description||"Async agent"` |
| `✓ Completed · 1m 5s · 12.3k tokens · 4 tools · provider/model (high)` | `/tasks` detail subtitle | bin@43515900 `kG` |
| `Message @auth-mapper…` / `Message @Explore…` | prompt placeholder in an agent view | bin@43739006 `gpe`; cl 2.1.251 |
| `Viewing @researcher · esc to return` | header, teammate view only | bin `$6` (UX report §3) |
| `<title> · from the auth-mapper agent` | permission prompt | bin@40790770 `XY` |

## 4. The progress summary

What it is: a model-written 3-5 word line about the agent's current action, not a tool name and not the agent's own text. Mechanism (bin@29215893, `_r`, `[AgentSummary]`):

- A timer every 30 s (`hl=30000`) forks the agent's context and makes one extra model call, `maxTurns:1`, all tools denied (`"No tools needed for summary"`), `querySource:"agent_summary"`.
- Prompt: `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.` plus `Previous: <last summary> \u2014 say something NEW.` and examples `Good: "Reading runAgent.ts"`, `Good: "Fixing null check in validate.ts"`, `Bad (too vague): "Investigating the issue"`.
- Reply accepted only if one line, at most 100 chars, no heading or code fence (`Ml`); otherwise dropped (cl 2.1.274 "Fixed a sub-agent's progress summary being replaced by a runaway multi-paragraph reply").
- Skipped when the transcript has fewer than 3 messages or did not change since the last tick.
- Written to `progress.summary` of a running task only (`uQo`, bin@25573143).

When it replaces the description: from the first accepted summary (earliest about 30 s after start) until the row leaves; the panel never goes back to the description while the agent runs. Enabled when `enableSummarization` is true: SDK option, or interactive session with fork mode on (the default, cl 2.1.232) or coordinator mode (bin@29356092, bin@42510988; `ene()` = fork mode).

Where else it goes: the hook's `label` ("Short progress summary of the task when Claude Code has one, otherwise the same text as `description`", docs statusline; bin@43626859 `D1t`), and the model's `task_status` attachment as `deltaSummary` (bin@23931023 `Dur`). The detail dialog does not use it (it lists `recentActivities`). Cost: cl 2.1.128 "Fixed sub-agent progress summaries missing the prompt cache".

## 5. Comparison with this repository's spec

Repo identity: `id` (`explorer-3f2a9c1b7d0e`), `agent` (definition name), `description`, `task`, `model` label. There is no `name` parameter (`extensions/subagents/src/plugins/run-agent/tools.ts:103-108`), so `agent` plays both Claude's type and name roles.

| Surface | Repo spec shows | Claude Code shows | Difference |
|---|---|---|---|
| Transcript row (`plans/00-ux-spec.md:63`, D1) | `agent (description) · provider/model:high`, "the only row that names the model" | `**Type** (description) · N tool uses · X tokens`; type dropped when all rows share it; model only when overridden | Repo always shows the model here; Claude almost never does. Repo never folds the shared type. |
| Completion line (§3, D1) | `Agent "description" finished · 1m 5s` | same | none |
| Panel row (`plans/00-ux-spec.md:173-175`, D2) | `agent`, always the description, tool-name activity in the stats | name or type, progress summary else description, `elapsed · ↓ tokens` | Repo keeps the description and adds the last tool name; Claude swaps in a model-written summary. Neither shows the model. |
| List row (`plans/00-ux-spec.md:292`, D3) | panel grammar: `agent`, description, activity, stats | description only, status word, `model (effort)` | Repo shows the agent name and no model; Claude shows the model and no type. |
| View header (`plans/00-ux-spec.md:347`, D4) | line 1 `<glyph> <id> · state · model`, line 2 description, line 3 stats | title `Type › description`, subtitle `status · elapsed · tokens · tools · model (effort)`; no id | Repo leads with the hex id; Claude never shows an id and leads with type and description. |
| Agent transcript first item (`plans/00-ux-spec.md:360`) | `Task from <caller> (agent id <id>): <task>` | detail dialog `Prompt` section, first 300 chars | Repo shows the id in the visible user message. |
| Other id sightings (`plans/00-ux-spec.md:81`, `:109`) | `Status unavailable · /agents <id>`, `message_agent <id> …` | none; `SendMessage` targets are hidden from the user | Repo uses the id as the user's handle (`/agents <id>`); Claude has no user-facing handle except `@name`. |
| Forwarded dialog / permission prompt | not specified in §3-§6 | `· from the <name or type> agent` | gap |

### Recommendations (options, the orchestrator decides)

1. View header: lead with `agent › description` like `Explore › Map the auth module` (bin `kG`) and demote the id to a dim tail or the stats line; it can stay because `/agents <id>` needs it.
2. Model label: Claude puts `model (effort)` on the `/tasks` row and detail subtitle, and in the transcript only when overridden (bin `NG`, `kG`, `TLo`); option to move it from the transcript row to the list row and the view stats line.
3. Same-agent batches: fold the shared name into the header (`Running 3 explorer agents…`) and show only descriptions on the rows (bin `ym` `hideType`).
4. Progress text: Claude replaces the description with a 30 s model-written summary at an extra model call per agent per tick; keeping the description plus tool-name activity (current spec) is the cheap option.
5. Optional middle path for 4: show `activity.text` in the view header only, never in the panel, so rows stay distinguishable by description.
6. `message_agent` call line and `Status unavailable · /agents <id>`: option to render `agent "description"` instead of the raw id, matching Claude's rule that ids are internal.
7. Forwarded dialogs from agents: append `· from the <agent> agent` to the dialog title (bin `XY`). (Moot after the decisions' fourth pass, 2026-10-14: agents never ask the user, so no agent dialog reaches the main session.)
8. `Task from <caller> (agent id <id>)`: the id there is model-facing; option to hide the parenthesis when rendering for the user, keeping it in the model's copy.

## Not verified

- Where the conditional model line (`TLo`) sits inside the transcript block, and whether it shows for background launches.
- Whether `/tasks` Enter on a local agent opens the `kG` dialog or the newer `nQ` detail screen (gated by `isBackgroundDetailScreenEnabled`); `nQ`'s contents were not decoded.
- Whether a viewed local subagent (not a teammate) shows any header line; only the `Message @…` placeholder was found.
- The id prefix variant `a<label>-<hex>`: which label is passed for subagents was not traced.
