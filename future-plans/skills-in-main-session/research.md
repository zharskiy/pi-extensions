# Research: skills in the main session

Research date: 2026-10-21.

## Pi 1.3.0

Source: local package `node_modules/@earendil-works/pi-coding-agent` (docs/skills.md, dist/core/skills.d.ts, resource-loader.d.ts, extensions/types.d.ts).

- The prompt shows an `<available_skills>` block with `<name>`, `<description>`, `<location>` per skill. The body is read on demand with the read tool (or bash). `formatSkillsForPrompt` builds it. It is omitted when neither read nor bash is active (open issue #9874). Skills with `disableModelInvocation` are excluded from the block.
- `Skill { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`. Exports: `loadSkills`, `loadSkillsFromDir`, `formatSkillsForPrompt`, `parseSkillBlock`.
- `DefaultResourceLoaderOptions`: `additionalSkillPaths`; `noSkills` (drops discovered and configured skills; additional and CLI paths still load); `skillsOverride` (runs after load, can return arbitrary Skill objects; `examples/sdk/04-skills.ts`). A custom `ResourceLoader` can return any `getSkills()`.
- Settings: `skills: string[]` (files or dirs; `!pattern` exclusion, `+path` include, `-path` exclude), `enableSkillCommands`, `packages`. CLI: `--skill <path>` (repeatable), `--no-skills` / `-ns`.
- `/skill:<name> [args]` (`AgentSession._expandSkillCommand`) reads the file, strips frontmatter and sends a user message `<skill name="X" location="PATH">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>` plus `<args>`. Unknown names pass through. `pi.sendUserMessage(content, {deliverAs?, expandPromptTemplates?})` with `expandPromptTemplates: true` expands skill commands programmatically.
- `resources_discover` event `{cwd, reason: "startup"|"reload"}` returns `{skillPaths?, promptPaths?, themePaths?}`. It fires after `session_start` and on `/reload`; the runtime calls `extendResources` then rebuilds the prompt. It bypasses `--no-skills` (issue #10696, closed no-action).
- `before_agent_start`: `event.systemPromptOptions` is a mutable `NormalizedBuildSystemPromptOptions` with `skills`; the handler may return `{systemPrompt}`. Re-render after mutation is unverified.
- Pi has no skill tool, lazy loader or deferred-skill mechanism. The `tool_search` and `codemode` built-ins do not cover skills.
- Upstream: no issue or PR on per-subagent skills or lazy skill loading found. Maintainers close subagent-policy requests as no-action (#9403, #10696).

## Industry

- **Agent Skills spec** (https://agentskills.io/specification): `name`, `description`, optional `license`, `compatibility`, `metadata`, experimental `allowed-tools`. Three progressive-disclosure levels: metadata (~100 tokens at startup), body (<5000 tokens on activation), resources on demand. No discovery directories defined.
- **Claude Code** (https://code.claude.com/docs/en/skills, /sub-agents): descriptions always in context, body on invocation via the Skill tool. Listing budget 1% of context (`skillListingBudgetFraction`), 1,536 chars per entry, least-used descriptions dropped first, `skillOverrides` "name-only". Subagent `skills:` preloads full bodies, up to 32, additive not restrictive. Block by omitting the Skill tool. `context: fork` + `agent:` runs a skill as a subagent. Directory precedence: enterprise > `~/.claude/skills` > `.claude/skills` > nested > `--add-dir` > plugins.
- **Codex CLI** (https://learn.chatgpt.com/docs/build-skills, /agent-configuration/subagents.md): `.agents/skills` (cwd, ancestors to repo root), `~/.agents/skills`, `/etc/codex/skills`, bundled. The prompt gets name, description, path. Index capped at 2% of context or 8,000 chars; `skills.max_context_tokens` up to 10,000. Custom agents inherit all skills; disable with `skills.config enabled=false`. `allow_implicit_invocation`.
- **OpenCode** (https://opencode.ai/docs/skills): reads `.opencode/skills`, `.claude/skills`, `.agents/skills` (project and global). A `skill` tool carries `<available_skills>` in its description; `skill({name})` loads. Per-agent `permission.skill` allow/deny/ask hides denied skills. Disabling the tool removes the list. `opencode/autoinvoke=false` metadata.
- **Gemini CLI** (https://geminicli.com/docs/cli/skills/): `.gemini/skills` or `.agents/skills` (workspace), `~/.gemini/skills` or `~/.agents/skills`. An `activate_skill` tool with user confirmation. Nothing on subagents.
- **Copilot CLI** (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills): `.github/skills`, `.claude/skills`, `.agents/skills` and user equivalents. No per-agent scoping found.
- **Amp** (https://ampcode.com/news/agent-skills): lazy loading, `.agents/skills`, `~/.config/agents/skills`, `.claude/skills` compatibility. No per-subagent model.
- **Anthropic** (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): progressive disclosure as the core principle.

## Selection accuracy

"More Skills, Worse Agents? Skill Shadowing" (https://arxiv.org/html/2605.24050v1): libraries of 52, 102 and 202 skills. Pooled pass-rate drop ~0.08 / 0.14 / 0.21. Correct-skill-only runs: 88% -> 80% -> 64% -> 53%. Shadowing (wrong skill or no skill picked) is the significant effect, not raw context overhead. Also listed but not read: arXiv 2607.17598, arXiv 2603.29919 (SkillReducer).

## Patterns

1. Index in the prompt, body on demand, with a budget (Claude Code, Codex, pi).
2. Preload into the subagent (Claude Code `skills:`).
3. Inherit then subtract or filter (Codex, OpenCode).
4. Skill as the delegation unit (Claude Code `context: fork`).
5. Tool-carried index with lazy body (OpenCode `skill`, Gemini `activate_skill`): the model for Option B.

## Not verified

- Whether Claude Code reads `.agents/skills`.
- Cursor, Factory Droid and Goose models.
- Copilot and Gemini per-agent skills fields.
- Whether Codex `skills.config` can enable as well as disable.
- The DEV/Medium "30 skills" threshold posts.
- Whether `before_agent_start` mutations of `systemPromptOptions.skills` are re-rendered.
