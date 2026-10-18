# 06 Project rules

> Status: dropped. Date: 2026-10-18. The owner dropped guards and the `tools`/`mcp` overrides; `tools` and `mcp` already exist as agent frontmatter, and the per-agent MCP filter lives on in ../enterprise-workflow/harness/harness-side.md section 2.3. Kept because the owner may reconsider.

## Goal

Two layers of per-project rules for agents. Advisory: skills, context files and project agent files as today, plus `tools` and `mcp` in the per-agent overrides. Enforcing: `guards` in the project settings, deny lists for edited paths and shell commands per agent, applied by a tool-call hook with a one-line refusal. The open-source side ships the mechanism and abstract examples; a company keeps its rules in its own repos and a private package.

## Why

- Four instruction layers everywhere, "short advisory text, prohibitions as hooks"; "Do not run the full build" rules are hooks or permission rules in Claude Code, Cursor and Codex, never prose (frontier-workflows.md §5 and "Top 10" 8).
- Prose prohibitions are a named dead end: long instruction files get ignored (frontier-workflows.md "Dead ends").
- The catalogue's backend, frontend and QA rule sets split into implementer rules (what may change, which command validates) and validator rules (what to run) (process-catalogue.md §4).
- Today overrides cover `model`, `thinking`, `skills` only, and unknown keys are rejected with "create an own agent instead"; the project agent file is the place for prose (pi-capabilities.md §5, §8 row g; spec-review.md MUST 12).

## Design

### Advisory layer

| Source | Reaches | Change |
|---|---|---|
| `AGENTS.md`, nested context files | every agent whose cwd is under them | none |
| Skills (`.agents/skills`, `.pi/skills`, user skills) | agents by `skills` grant, override or per task | none |
| `.pi/agents/<name>.md` (`/agents create <name> project`) | one agent, whole file | none; this is where project prose for an agent goes |
| `agents.<name>.tools` | one agent | new: a subset of the file's `tools` list; it can only remove |
| `agents.<name>.mcp` | one agent | new: `true` or `false` (05-code-exploration.md) |

Rules that need reasoning ("use the module-scoped test command") go into a skill or the project agent file. Path-scoped skill loading (`paths:` globs) is not added; the company's `frontend-conventions`, `backend-conventions` and `qa-framework` skills are the substitute, granted per agent.

### Enforcing layer: guards

```json
{
  "guards": {
    "*": {
      "denyCommands": ["^git push", "^rm -rf", "docker (compose )?up"]
    },
    "implementer": {
      "denyPaths": ["src/generated/**", "**/*.lock", "src/i18n/**"],
      "denyCommands": ["^npm run build$", "^(mvn|gradle) (install|verify|build)"]
    },
    "verifier": {
      "denyCommands": ["^(mvn|gradle) (install|verify|build)"]
    }
  }
}
```

| Key | Semantics |
|---|---|
| `*` | applies to every agent and to the main session; agent entries add to it |
| `denyPaths` | globs, matched against the absolute path of `edit`, `write` and any tool input that names a file, made relative to the agent's cwd (its worktree root or the session cwd); hard: the write never happens |
| `denyCommands` | regular expressions tested against the whole `bash` command and against each part split on `&&`, `;` and `\|`; advisory in strength, since `$(…)`, newlines and `bash -c` can slip past; the hard rules are the path guards |
| Refusal | an error tool result: `guard: <agent> may not edit src/generated/api.ts (denyPaths "src/generated/**")` or `guard: <agent> may not run "npm run build" (denyCommands "^npm run build$")`; for the main session the subject is `main session` |
| Scope | user file and trusted project file merged per agent, project adding to user; an untrusted project's guards are ignored with the usual note |
| Workspace | guards for an agent come from the `.pi/pi-subagents.json` of the repo its `cwd` resolves into, merged over the user file; a repo counts as trusted when `/workspace init` recorded the user's one-time confirmation (04-workspace-and-epic.md); the session cwd's guards do not leak into another repo |

Guards never allow anything; they only deny. A guard cannot be relaxed by an agent file or a task.

### Abstract examples

| Repo kind | Advisory (skill or project agent file) | `guards` (enforcing) |
|---|---|---|
| Backend module | "Build and test only the module you changed with the module-scoped command named in AGENTS.md. Public API changes update the contract file." | deny whole-project build and integration suite commands; deny edits to merged migration files |
| Frontend | "Use design-system components; request localisation strings in Open instead of adding them." | deny edits to generated clients, compiled output and localisation folders; deny the full end-to-end suite |
| Test automation | "Reuse page objects and steps before adding new ones; locators live only in page objects. Run tests by tag or name." | deny edits to shared test data and environment config; deny the whole regression command |

Each repo keeps these in its own `.pi/pi-subagents.json`, `AGENTS.md` and `.pi/agents/`; the company's private package carries the skills and a user-level `pi-subagents.json` with the `*` guards.

## User surface

- Settings keys in `pi-subagents.json`: `agents.<name>.tools`, `agents.<name>.mcp`, `guards`.
- `/agents setup <agent> mcp=true tools=read,grep` one-line form gains the two fields; the tab form shows them.
- The `run_agent` description lists each agent's effective tools, so the main session sees overrides.

## Architecture

- `core/adapter/contract.ts`: `SpawnSpec.guards` and `Host.onToolCall` (shared with 02-plan-mode.md). `pi-child.ts` installs the guard in the child's hidden extension `tool_call`; the main session's `*` guard is installed by the adapter's `tool_call`.
- Subagents: `model/agent-override.ts` (`tools`, `mcp` parsers), `model/settings.ts` (`guards` object rule), new `model/guards.ts` (pure: merge, match path, match command, refusal text), `agent-definitions/loader.ts` (apply the two fields), `run-agent/runner.ts` (resolve guards for the agent's cwd at spawn), `agent-setup` (fields in both forms).
- Rules: no provider names; nothing new is written, so the AGENTS.md file-location rule is unchanged by this spec; guards are read from the same settings files and locations as today.

## Out of scope

Allow lists, `ask` decisions (agents cannot be asked), rewriting commands, a `prompt` override, path-scoped skill loading, limits overrides, stopping an agent after repeated refusals.

## Open questions for the owner

None; defaults taken: `tools` only removes, regular expressions for `denyCommands`, no allow lists.

## Acceptance checks

- [ ] `agents.scout.tools: [read]` leaves scout with `read` only; `agents.scout.tools: [read, bash]` is rejected because `bash` is not in the file; `agents.scout.mcp: true` connects servers.
- [ ] `agents.<name>.prompt` is rejected with "create an own agent instead".
- [ ] An `implementer` `write` to `src/generated/x.ts` returns the refusal line and writes nothing; the same path in a worktree is matched relative to the worktree root.
- [ ] `bash` with `npm test && npm run build` is refused on the second part.
- [ ] A `*` guard applies to the main session's `bash` with the subject `main session`.
- [ ] Guards from an untrusted project are ignored with one note.
- [ ] An agent with `cwd` in another repo's worktree gets that repo's guards, not the session repo's.
