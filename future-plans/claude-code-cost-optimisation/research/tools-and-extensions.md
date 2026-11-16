# Claude Code tool and extension surface: token and cost mechanisms

Fact sheet, verified against live docs on 2026-11-16 (fetched as `.md` pages from `https://code.claude.com/docs/en/`). Page names below are relative to that base. Version numbers are the "requires vX" notes the docs give. Anything not confirmed on a live page is marked "unverified".

## Summary table

| Feature | Saving mechanism | Main knob |
| :- | :- | :- |
| MCP tool search | Tool definitions deferred; only names and server instructions at start | `ENABLE_TOOL_SEARCH`, `alwaysLoad` |
| MCP output caps | Large results go to a file, not the context | `MAX_MCP_OUTPUT_TOKENS`, `anthropic/maxResultSizeChars` |
| Skills | Only name and description listed; body loads on invoke | `skillListingBudgetFraction`, `skillOverrides`, `disable-model-invocation` |
| Subagents | Verbose work stays in a separate context; only the final summary returns | `model`, `tools`, `maxTurns`, `omitClaudeMd` |
| Hooks | Deterministic pre/post filtering outside the model | `updatedInput`, `updatedToolOutput` |
| Plugins / LSP | Cost is names and descriptions per turn; LSP replaces grep and read loops | `/plugin`, `claude plugin details` |
| Output style, system prompt, tool removal | Shorter responses; fewer tool definitions | `outputStyle`, `--tools`, deny rules |
| Read/Bash output limits | Hard caps and spill-to-file | `bashOutputMaxChars`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` |

## MCP

Source: `mcp.md`, `costs.md`, `env-vars.md`.

### Tool search (deferred tool loading)

- What: tool definitions of MCP tools are deferred; "only tool names and server instructions load at session start". Claude finds and loads the rest through a built-in `ToolSearch` tool (`tools-reference.md`). No fixed per-server tool cap. On by default.
- Saving: definitions (schemas, long descriptions) cost nothing until a tool is needed. `costs.md` states "MCP tool definitions are deferred by default, so only tool names and server instructions enter context until Claude uses a specific tool."
- Knob: env var `ENABLE_TOOL_SEARCH`.

| Value | Behaviour |
| :- | :- |
| unset or `true` | All MCP tools deferred; falls back to upfront loading on models earlier than Opus 4 / Sonnet 4, on earlier Agent Platform models, and on Microsoft Foundry deployments hosted on Azure |
| `auto` | Threshold mode: tools load upfront while their definitions total under 10% of the context window; at 10% or more tool search turns on |
| `auto:N` | Same with custom percentage N (0-100), for example `auto:5` |
| `false` | Everything loaded upfront |

- Once tool search has been on in a conversation under `auto`, tools can stay deferred even if the total later falls under the threshold (`mcp.md`, "Tools that stay deferred below the threshold").
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` keeps tool search off and `ENABLE_TOOL_SEARCH` cannot override it (managed settings can, v2.1.227+).
- Denying `ToolSearch` or leaving it out of `--tools` makes MCP tools load upfront.
- Per-server override: `"alwaysLoad": true` in the server entry loads all its tools upfront; `"alwaysLoad": false` keeps all deferred even if the author marked tools to load upfront (v2.1.287+ for the server-level `false` case; v2.1.285+ applies to the per-tool `_meta["anthropic/alwaysLoad"]: false` override). Server authors can mark single tools with `_meta["anthropic/alwaysLoad"]: true`.
- Gateways: with `ANTHROPIC_BASE_URL`, the gateway must forward `defer_loading` fields and `tool_reference` blocks; on v2.1.305+ Claude Code retries without tool search after a 400/422 (tools then load upfront).
- Servers still connecting: with tool search the wait happens inside `ToolSearch`; without it a `WaitForMcpServers` tool is used.

### Description and instruction limits

- Server instructions, and the description of a tool loaded upfront: cut at 4,096 characters. Description of a tool loaded through tool search: 16,384 characters. Search matching reads only the part within the shorter limit, so keywords belong at the start. Before v2.1.296 the shorter limit was 2,048.
- `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (v2.1.280+) replaces both limits with one number. Some Anthropic-hosted servers at `api.anthropic.com` are exempt from the cut.
- Server instructions are described as acting "similar to how skills work": they tell Claude when to search for the server's tools.

### Output limits

- Warning when one MCP tool output exceeds 10,000 tokens (fixed). Default maximum 25,000 tokens, set with `MAX_MCP_OUTPUT_TOKENS`.
- Over the limit, a successful non-image result is saved to a file under the session `tool-results` dir and replaced by a message with the path.
- Separately, successful text results over 50,000 characters are saved to a file regardless of the env var, unless the tool declares `_meta["anthropic/maxResultSizeChars"]` in its `tools/list` entry (that value then wins for text; images still follow `MAX_MCP_OUTPUT_TOKENS`).
- Error results over about 11,000 characters keep the first 5,000 and last 5,000 characters with a marker between.
- Responses from HTTP/SSE servers over 16 MiB fail.
- Related: calls running longer than two minutes are moved to a background task (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `0` disables).

### Enable and disable per server

- `/mcp` toggles a server without deleting its config; choice stored per project in `~/.claude.json`. Settings keys: `disabledMcpServers` (opt-out list for user, plugin, managed and connector servers), `enabledMcpServers` (opt-in for default-off built-ins such as `computer-use`), `enabledMcpjsonServers` / `disabledMcpjsonServers` (approval of `.mcp.json` servers).
- `--strict-mcp-config` with `--mcp-config <file>` loads only the named servers (`cli-reference.md`).
- `--disallowedTools "mcp__*"` removes every MCP tool from context (`cli-reference.md`, `permissions.md`).

### Resources versus tools; CLI versus MCP

- Resources are referenced by `@` mention and fetched as attachments when referenced; Claude Code also provides tools to list and read resources when the server supports them (`mcp.md`, "Use MCP resources"). The docs give no token comparison between resources and tools.
- CLI guidance, verbatim in `costs.md`: "Prefer CLI tools when available: Tools like `gh`, `aws`, `gcloud`, and `sentry-cli` are still more context-efficient than MCP servers because they don't add any per-tool listing." And "Disable unused servers: Run `/mcp`". `/context` shows what MCP tools occupy.

## Skills

Source: `skills.md`, `settings-reference.md`, `env-vars.md`, `costs.md`.

### What is in context when

- Startup: a listing of every skill name plus description. Invocation: the rendered SKILL.md enters the conversation as one message and stays; the file is not re-read on later turns. Supporting files and scripts are loaded only if used; scripts are executed, not loaded, so their output rather than source enters context.
- Size guidance: keep SKILL.md under 500 lines and move reference material to separate files. `costs.md` says to move workflow-specific CLAUDE.md content into skills and keep CLAUDE.md under 200 lines.
- After compaction: the most recent invocation of each skill is re-attached, first 5,000 tokens each, 25,000 tokens combined, most recently invoked first (older skills can drop out).

### Listing budget

| Knob | Value |
| :- | :- |
| `description` + `when_to_use` per skill | truncated at 1,536 characters |
| `skillListingMaxDescChars` (settings) | per-skill cap, default 1536 |
| `skillListingBudgetFraction` (settings) | share of context window, default 0.01 (1%) |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` (env) | fixed character count; "scales dynamically at 1% of the context window, with a fallback of 8,000 characters" |

- When over budget, every name stays but descriptions of the least-invoked skills are dropped first. `/doctor` estimates listing cost and top contributors; `/context` Skills row shows the post-budget size; `/skill-doctor` (v2.1.252+) reports per-skill context cost and never-invoked skills (also `/plugin` Stats tab).
- `skillOverrides` (settings, per skill name): `"on"`, `"name-only"` (listed without description), `"user-invocable-only"` (hidden from Claude, still in `/` menu), `"off"` (hidden everywhere). Does not apply to plugin skills. `disableBundledSkills: true` or `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` removes bundled skills and workflows. `--disable-slash-commands` disables all skills for a session.

### Frontmatter fields relevant to cost

| Field | Effect |
| :- | :- |
| `disable-model-invocation: true` | Description not in context at all; user-only. Also blocks preloading into subagents |
| `user-invocable: false` | Hidden from `/` menu; Claude can still invoke |
| `context: fork` | Skill body becomes the prompt of a forked subagent without conversation history; `agent:` picks the type (default `general-purpose`); `background` defaults to true |
| `allowed-tools` | Pre-approves tools for the turn of invocation; clears at next user message |
| `disallowed-tools` | Removes tools from the pool while the skill is active |
| `model` | Model for the rest of the current turn; same values as `/model` or `inherit` |
| `effort` | `low` to `max`; overrides session effort but not `CLAUDE_CODE_EFFORT_LEVEL` |
| `paths` | Glob patterns limiting automatic activation |

- Dynamic context injection: `` !`cmd` `` inline or a fenced block opened with ` ```! `. Output replaces the placeholder, so Claude receives data, not the command. Runs with the Bash default 2-minute timeout, goes through permission rules, a non-zero exit aborts the invocation. `disableSkillShellExecution: true` disables it.
- Bundled script pattern: `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` and the body calls `${CLAUDE_SKILL_DIR}/scripts/render.sh`.

## Subagents

Source: `sub-agents.md`, `env-vars.md`, `costs.md`.

### Isolation as the main saving

- Each non-fork subagent starts with a fresh context: its own system prompt (not the Claude Code prompt), the delegation message, CLAUDE.md and git status (except Explore, Plan, and any with `omitClaudeMd`), preloaded skills, sibling roster. It does not inherit output style or auto memory. The main session receives only the subagent's final summary. `costs.md`: delegate tests, docs fetching and log processing so verbose output stays out of the main context. The subagent's requests "still draw on your usage"; they count toward the same usage limits.
- Built-ins: Explore and Plan (read-only; skip CLAUDE.md and git status "to keep research fast and inexpensive"), general-purpose, claude (catch-all), statusline-setup (Sonnet), claude-code-guide (Haiku). Explore and Plan run on the parent's model, with an exception when the parent is Fable (Explore then uses Opus via subscription, Console or `ANTHROPIC_BASE_URL`, and stays on Fable on cloud providers). A user subagent named `Explore` with `model: haiku` overrides the built-in. `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes them.

### Frontmatter (only `name` and `description` required)

`tools` (allowlist, inherits all if omitted), `disallowedTools`, `model` (`sonnet`, `opus`, `haiku`, `fable`, full ID, `inherit`), `effort` (`low`-`max`), `skills` (full content injected at startup, up to 32 names), `maxTurns` (stops the agent; output marked partial and resumable, v2.1.246+), `background`, `isolation: worktree`, `memory`, `mcpServers` (inline servers connect at start and disconnect at finish), `hooks`, `permissionMode`, `omitClaudeMd` (v2.1.271+), `autoCompactWindow` (100000-1000000, v2.1.296+), `experimental.cacheTtl` (`5m` or `1h`, v2.1.248+).

- Model resolution: per-invocation `model` param, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) forces one model on all subagents, teammates and workflow agents; forks and `model: inherit` skills still use the parent's model.
- Description cost: combined descriptions of custom subagents over 15,000 tokens trigger a startup warning; keep descriptions short and put detail in the system prompt, which loads only on run.
- Limits: 20 concurrent (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), nesting depth 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `1` disables nesting). Deny a type with `permissions.deny: ["Agent(Explore)"]`.

### Forks, background, resume

- Fork: a subagent that inherits the whole conversation, same system prompt, tools, model and history; its tool calls stay out of the parent and only the result returns. Because system prompt and tool definitions are identical, its first request reads the parent's prompt cache, so it is cheaper than a fresh subagent for tasks that need the same context (unverified: the exact "costs less than" wording was not found on the live page; `prompt-caching.md` confirms a fork's first request reads the parent's cache). On by default (`CLAUDE_CODE_FORK_SUBAGENT=0` turns off); `/subtask <task>` starts one; `permissions.deny: ["Agent(fork)"]` blocks them. A fork cannot spawn forks. A fork does use the parent's output style.
- Background: with fork mode on, spawned subagents run in the background by default; Ctrl+B backgrounds a running one. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` makes Claude wait. Background agents get a reduced tool set.
- Resume: `SendMessage` by ID or name resumes a subagent with full history (and the chance to read its prompt cache); Explore and Plan are one-shot. Transcripts under `~/.claude/projects/{project}/{sessionId}/subagents/` removed after `cleanupPeriodDays` (30).
- Cost reporting: `/usage` attributes recent usage to skills, subagents, plugins and individual MCP servers as shares (`costs.md`, "Plan usage breakdown"); `--max-budget-usd` includes subagent spend and blocks new spawns at the cap. Per-subagent token breakdown in `-p` JSON output: unverified (not checked).

### Multi-agent warnings and sizes

- Agent teams (`agent-teams.md`, `costs.md`): "significantly more tokens than a single session"; "approximately 7x more tokens than standard sessions when teammates run in plan mode" (found on `costs.md` only; `agent-teams.md` says only "significantly more tokens"); usage roughly proportional to team size. Guidance: start with 3-5 teammates, 5-6 tasks each, keep spawn prompts focused (teammates load CLAUDE.md, MCP servers and skills automatically), shut down finished teammates. Disabled by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Teammate model order: spawn prompt, definition `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, lead's model; teammates on the lead's model inherit its effort.
- Workflows (`workflows.md`, "Cost"): "a single run can use meaningfully more tokens"; run on a small slice first; `/workflows` shows per-agent tokens and lets you stop. A `Large workflow` warning appears above 25 scheduled agents or a projected 1.5 million tokens. Up to 16 concurrent agents by default (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1-256). Agents with the same model, effort, type, tools, schema and working directory share a prompt-cache prefix. `/effort ultracode` makes Claude plan a workflow for every substantive task and turns off the large-run checks; docs say each request then uses more tokens and time.

## Hooks as token tools

Source: `hooks.md`, `hooks-guide.md`, `costs.md`.

| Mechanism | Detail |
| :- | :- |
| PreToolUse `updatedInput` | `hookSpecificOutput.updatedInput` replaces a tool's arguments before it runs. `costs.md` example: a Bash hook rewrites `npm test`, `pytest`, `go test` to `... 2>&1 \| tail -n 100`, keeping only the last 100 lines. Doc claim: log grep hook can cut "tens of thousands of tokens to hundreds" |
| PostToolUse `updatedToolOutput` | Replaces the tool result Claude sees; value must match the tool's output shape; works for built-in and MCP tools (`updatedMCPToolOutput` is the MCP-only older field). Only changes what Claude sees; telemetry captures the original |
| `additionalContext` | Injected as a system reminder at the hook point; available on PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, UserPromptExpansion, SessionStart, SubagentStart, Stop and others. `UserPromptSubmit` cannot replace the prompt, only add context |
| SessionStart | `additionalContext` added before the first prompt (also `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`) |
| PreCompact / PostCompact | PreCompact stdout (exit 0) becomes instructions for the compaction summary, max 10,000 characters per hook |
| Output cap | `additionalContext`, `systemMessage`, `initialUserMessage` and plain stdout: 10,000 characters each. Over the cap the text is saved to a file and replaced by the path plus a 2,000-character preview (not for PreCompact stdout). No setting raises it |
| Handler types | `command`, `http`, `prompt`, `agent`, `mcp_tool` |
| `if` field | e.g. `"if": "Bash(rm *)"` avoids spawning the handler unless the call matches |

- `PostToolUse` `decision: "block"` only adds a reason; Claude still sees the original output, so use `updatedToolOutput` to shrink it.
- Hook handlers themselves cost no model tokens (plugin `details` shows "harness-only - no model context cost"), except `prompt` and `agent` hooks which call a model.
- Stop/SubagentStop block loop cap: 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).

## Plugins and LSP

Source: `plugins/overview.md`, `plugins/measure.md`, `plugins/code-intelligence.md`, `costs.md`.

- Context cost: for every enabled plugin, the names and descriptions of its model-invocable skills, agents and commands are in context every turn, used or not; bodies load on use. Plugin MCP servers follow MCP tool search. Hooks and MCP servers get no per-component estimate in `plugin details`; use `/context` (`MCP tools` category).
- Measure: `claude plugin details <name>` (shell) prints always-on and on-invoke token estimates. Official-marketplace plugins show "Context cost" (`Every turn:` and `When invoked:`) in `/plugin`; highlighted at 2,000 tokens or more per turn. The Installed tab lists "Not used recently" plugins. `/skill-doctor` also covers plugin skills.
- Reduce: shorten descriptions, split large plugins. Scope: user, project (committed `.claude/settings.json`) or local, so a plugin can be enabled only where needed. Plugin skills are not covered by `skillOverrides`; manage them via `/plugin`.
- Code intelligence: LSP plugins (13 listed, for example `typescript-lsp`, `pyright-lsp`, `gopls-lsp`, `rust-analyzer-lsp`; binary installed separately) add a read-only `LSP` tool for symbol lookup and push diagnostics after each edit. `costs.md`: "A single 'go to definition' call replaces what might otherwise be a grep followed by reading multiple candidate files", and type errors surface without running a compiler. Install: `/plugin install typescript-lsp@claude-plugins-official`. Not available in cloud sessions. No measured savings figures in the docs.

## Output styles, system prompt, tool removal

Source: `output-styles.md`, `cli-reference.md`, `permissions.md`, `env-vars.md`.

- Output styles add instructions sent with every request. Built-ins: Proactive, Concise (v2.1.237+; first sentence states the result, simple answers in one to three sentences, full detail kept for errors and safety), Explanatory, Learning (the last two lengthen output by design). Set with `/output-style <name>` or `"outputStyle"` in settings (case-sensitive, for example `"Concise"`); stored at local project level by the command. Custom styles: Markdown in `~/.claude/output-styles` or `.claude/output-styles`; unless `keep-coding-instructions: true`, a custom style removes Claude Code's built-in software-engineering instruction section on the full system prompt (it has no effect on the shorter prompt). Switching mid-session applies from the next message and keeps the prompt cache (the new style arrives as a conversation message; `prompt-caching.md#changing-output-style`, listed under actions that keep the cache; before v2.1.251 it applied only after `/clear`). Non-fork subagents ignore the style. Docs say style instructions add input tokens, offset by caching.
- System prompt flags: `--system-prompt` / `--system-prompt-file` replace the whole prompt; `--append-system-prompt` / `--append-system-prompt-file` append; `--append-subagent-system-prompt` (non-interactive, v2.1.205+) appends to every subagent. `--exclude-dynamic-system-prompt-sections` moves per-user content into the first user message for cache reuse. `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1` selects a shorter prompt with abbreviated tool descriptions; on by default for newer models, the full prompt is default for Haiku 4.5, Sonnet 5, Opus 4.7 and earlier in those families. Exact token size of each prompt: unverified.
- Tool removal: `--tools "Bash,Edit,Read"` (`""` disables all; MCP tools unaffected). A bare tool name in `--disallowedTools` or `permissions.deny` (for example `Edit`, `"*"`, `"mcp__*"`) "removes the tool from Claude's context entirely, so Claude never sees it" (`permissions.md`; but `prompt-caching.md` says that with tool search active a mid-session deny keeps the request's tool definitions unchanged to preserve the cache: the tool cannot be called, the definition is removed only when tool search is off); scoped rules such as `Bash(rm *)` keep the tool and only deny matching calls. Mid-session additions take effect from the next call. The per-tool prompt token savings are not quantified in the docs.
- Minimal modes: `--bare` / `CLAUDE_CODE_SIMPLE=1` skip hooks, skills, subagents, plugins, MCP, auto memory and CLAUDE.md, leaving Bash, read and edit tools. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` drops built-in commit/PR instructions and the git status snapshot. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` also exist.

## Permissions and limits that keep content out

Source: `permissions.md`, `tools-reference.md`, `settings-reference.md`.

- `permissions.deny` with `Read(./.env)` or `Read(./secrets/**)` blocks file tools from reading a path; applied best-effort to Grep, Glob, `@` mentions and pasted image paths. Rules use gitignore syntax. This is documented as a security control; the docs do not present it as a token saver, but it keeps large trees (for example `Read(node_modules/**)`) out by the same means (inference, not documented as such).
- `respectGitignore` (default true) only affects the `@` file picker, not Grep or Read (`settings-reference.md`).
- Read tool: one call returns at most 25,000 tokens (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`) and refuses whole files over 256 KB; over-limit reads return a `PARTIAL view` first page or an error pointing to `offset`/`limit` or Grep. Large images are downscaled; image files over 128 MB are refused.
- Bash output: valid result inline up to about 30,000 characters (`bashOutputMaxChars` setting, clamped 4,000-128,000, v2.1.261+; `BASH_MAX_OUTPUT_LENGTH` default 30,000, max 150,000). Beyond that the full output is saved to a file with a preview of up to 2,000 characters. Failed commands: about 10,000 characters head and tail.

## Code review and other bundled multi-agent commands

Source: `code-review-local.md`, `code-review-setup.md`, `code-review-costs.md`, `ultrareview.md`.

- `/code-review [low|medium|high|xhigh|max|ultra] [target] [--fix|--comment|--max-findings n]`: runs as a background forked subagent with its own context. `low` reports only high-confidence findings; `medium` to `max` broaden coverage. Without a level it reuses the last typed level, else the session effort. The docs give no token figures per level.
- `ultra` / `claude ultrareview`: cloud fleet of reviewer agents; 3 free runs on Pro, Max and Ultra, then usage credits, "typically $5 to $25" per review, with an estimate shown before launch.
- Managed Code Review service (GitHub PRs): review level Quick, Standard (default), Deep, each costing more; billed on tokens through usage credits to the organization; "After every push" multiplies cost by pushes; monthly spend limit settable. No per-level dollar figures given.

## Not verified

- Per-level token or dollar numbers for `/code-review` effort levels and managed Code Review levels.
- A documented per-subagent token/cost breakdown in `-p` or stream-json output.
- The token size of the full versus shorter system prompt, and per-tool token cost of built-in tool definitions.
- Whether built-in tools (not MCP) are ever deferred through `ToolSearch`; the tools reference says only that it loads "deferred tools" when tool search is enabled.
- Whether `Read` deny rules measurably reduce tokens; documented only as a security feature.
