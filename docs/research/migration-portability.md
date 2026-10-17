# Moving to pi and the subagents extension from other coding agents

Research note, 2026-10-17. Pi is version 1.3.0. Web pages were fetched on 2026-10-17; unless a row says otherwise, that is the date for every URL below. Some rows rest on search-result snippets rather than fetched pages and say "snippet". Items the research looked for and could not find are marked "not sourced" and listed under "Could not source".

The question: how easily can a colleague who uses Claude Code, Codex CLI, Cursor, Gemini CLI (now Antigravity CLI), Copilot CLI, Amp, or Cline, Roo or Kilo move to pi plus this repo's subagents extension, and keep their skills, MCP servers, agent definitions and instruction files?

Legend: `PI/` is `node_modules/@earendil-works/pi-coding-agent/`; `SUB/` is `extensions/subagents/`. `.agents/skills` means the project directory and `~/.agents/skills` its user twin.

## What pi reads today

**Skills.** "Pi implements the Agent Skills specification" (`PI/docs/skills.md:7`). Default locations are `~/.pi/agent/skills` and `<cwd>/.pi/skills` (`PI/dist/core/skills.js:355-356`). Pi also reads `~/.agents/skills` and `.agents/skills`, the project one "discovered from the working directory through its ancestors, stopping at the repository root" (`PI/docs/skills.md:61`; `PI/dist/core/package-manager.js:297`, `2023-2058`). More paths go in the `skills` setting (`PI/docs/settings.md:156`). The documented frontmatter is the spec set: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` (`PI/docs/skills.md:67-79`). Pi does not warn when `name` differs from the folder; a malformed file or one without a description is not loaded; on a name collision the first skill found wins with a warning (`PI/docs/skills.md:83-85`). A grep of `skills.js`, `package-manager.js` and `resource-loader.js` finds no `.claude/skills` or `.codex/skills`.

**MCP.** Pi reads `~/.pi/agent/mcp.json` and, after project trust, `.pi/mcp.json`; a project entry replaces a user entry of the same name, and a project entry with no `command`, `url` or `type` overrides only `enabled`, `exposure` and `toolExposure` (`PI/docs/mcp.md:32-34`; `PI/dist/extensions/mcp/config.js:105-109`). The file holds a top-level `mcpServers` object (`config.js:55-57`); "The format matches other MCP clients" (`PI/docs/mcp.md:44`). Rules (`PI/docs/mcp.md:77-82`): server names use letters, digits, `_` and `-`; `type` is optional, a `command` means stdio and a `url` means streamable HTTP; an explicit `type` must be `stdio`, `http` or `streamable-http`; "`sse` is rejected"; `env` and `headers` take `${VAR}` or a whole-value `!command`; invalid entries are skipped. OAuth tokens live in `~/.pi/agent/mcp-auth.json` (`PI/docs/mcp.md:129`); `auth` is allowed only in the global file (`config.js:94-96`). Pi does not read `.mcp.json`, `.cursor/mcp.json` or `~/.claude.json` (`config.js:105-109` reads only the two pi files).

**Instruction files.** Per directory pi takes the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (`PI/dist/core/resource-loader.js:116`), in the agent dir, the cwd and its parents (`PI/docs/configuration.md:18`, `41-45`), without needing trust (`configuration.md:47`). `--no-context-files` turns this off (`PI/docs/cli.md:214-215`). `SYSTEM.md` and `APPEND_SYSTEM.md` replace or extend the system prompt (`configuration.md:19-20`, `32-39`).

**Agent definitions.** Pi core has none: it "skips features like sub-agents" (`PI/README.md:19`). The subagents extension loads built-in `SUB/agents`, `<agentDir>/agents` and, for trusted projects, `<cwd>/.pi/agents` (`SUB/src/plugins/agent-definitions/index.ts:12`, `26-29`); project beats user beats built-in, subfolders are allowed and the name comes from `name:` (`SUB/README.md:55`). Required fields: `name`, `description`, `limit` (integer, at least 5000), `tools`, `skills`, `subagents`; optional `model` (`name[:thinking]` or `inherit`) and `worktree` (`SUB/README.md:57-68`). The three list fields take names, `[]` or `all`, and have no default (`SUB/README.md:57`).

## Skills by product

| Product | Location | Format | Spec compliance | Reads other tools' folders | Source |
| --- | --- | --- | --- | --- | --- |
| pi | `~/.pi/agent/skills`, `.pi/skills`, `.agents/skills` | SKILL.md | yes, per its docs | `.agents` only | above |
| Claude Code | `~/.claude/skills`, `.claude/skills` (nested), plugins | SKILL.md plus own keys: `when_to_use`, `argument-hint`, `arguments`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell` | "follow the Agent Skills open standard" plus extensions | `.agents/skills` not sourced | code.claude.com/docs/en/skills |
| Codex CLI | `.agents/skills` up to repo root, `~/.agents/skills`, `/etc/codex/skills` | SKILL.md plus optional `agents/openai.yaml` | "build on the open agent skills standard" | `.claude/skills` not documented | learn.chatgpt.com/docs/build-skills |
| Cursor | `.agents/skills`, `.cursor/skills` and `~/` twins | SKILL.md; name must match folder | links agentskills.io | also `.claude/skills`, `.codex/skills` | cursor.com/docs/skills |
| Gemini CLI | `.gemini/skills`, `.agents/skills` (wins), `~/` twins | SKILL.md | yes | `.agents` | geminicli.com/docs/cli/skills/ |
| Copilot CLI | `.github/skills`, `.claude/skills`, `.agents/skills`, `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills` | SKILL.md | not sourced | `.claude`, `.agents` | docs.github.com (snippet) |
| Amp | `~/.config/agents/skills`, `.agents/skills`, `~/.agents/skills`, `.claude/skills`, `~/.claude/skills` | SKILL.md; may bundle MCP | not stated | `.claude` (can be turned off) | ampcode.com/docs/customize/skills |
| Cline | `.cline/skills`, `~/.cline/skills` | SKILL.md | not sourced | not sourced | snippet |
| Roo Code | `.roo/skills`, `.agents/skills` and `~/` twins | SKILL.md | not sourced | `.agents` | snippet |
| Kilo Code | `.kilocode/skills` or `.kilo/skills` (docs conflict), `.agents/skills`; `.claude/skills` when compatibility is on | SKILL.md | not sourced | `.agents`, optional `.claude` | snippet |

## MCP by product

| Product | Location | Format | Shape vs pi | Reads other tools' files | Source |
| --- | --- | --- | --- | --- | --- |
| pi | `~/.pi/agent/mcp.json`, `.pi/mcp.json` | `mcpServers`; `${VAR}`, `!cmd`; `timeout` in seconds | n/a | none | above |
| Claude Code | `.mcp.json`; `~/.claude.json` (user, local) | `mcpServers`; `type` `stdio`, `http`, `sse` (deprecated), `ws`; `headersHelper`; `timeout` in ms; `${VAR}`, `${VAR:-default}` | same; remote entries need `type: http` | Claude Desktop import only | code.claude.com/docs/en/mcp |
| Codex CLI | `~/.codex/config.toml`, trusted `.codex/config.toml` | TOML `[mcp_servers.<name>]`; `env_vars`, `bearer_token_env_var`, `env_http_headers`, `http_headers_helper` | different | own import (below) | learn.chatgpt.com/docs/extend/mcp?surface=cli |
| Cursor | `.cursor/mcp.json`, `~/.cursor/mcp.json` | `mcpServers`; `envFile`; `${env:NAME}`, `${userHome}`, `${workspaceFolder}` | same, other variable syntax | none | cursor.com/docs/context/mcp |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers` | `url` means SSE, `httpUrl` means streamable HTTP; `trust`, `includeTools`, `excludeTools`; `$VAR`, `${VAR}`, `%VAR%` | mostly; `httpUrl` unique | none | geminicli.com/docs/tools/mcp-server/ |
| Copilot CLI | `~/.copilot/mcp-config.json`; `.mcp.json` (walking up), `.github/mcp.json` | `mcpServers`; `type` `local`, `http`, `sse`; `tools` | mostly; `local` for stdio | reads `.mcp.json` | docs.github.com |
| Amp | `amp.mcpServers` in `~/.config/amp/settings.json` or `.amp/settings.json` | `command`, `args`, `env`, `url`, `headers`; `${VAR}` | same entry, other key | not sourced | ampcode.com/docs/customize/mcp |
| Cline | `cline_mcp_settings.json`; CLI `~/.cline/mcp.json` | `mcpServers` plus `disabled`, `autoApprove` | same | none | snippet |
| Roo Code | not sourced | | | | |
| Kilo Code | `kilo.jsonc` (user, project, `.kilo/`) | top-level `mcp`; `local` with command array and `environment`, `remote` with `url` | different (OpenCode style) | n/a | kilo.ai/docs/automate/mcp/using-in-kilo-code |

## Agent definitions by product

| Product | Location | Format and required fields | Reads other tools' folders | Source |
| --- | --- | --- | --- | --- |
| pi + SUB | `~/.pi/agent/agents`, `.pi/agents` | Markdown; `name`, `description`, `limit`, `tools`, `skills`, `subagents` | none | above |
| Claude Code | `.claude/agents`, `~/.claude/agents`, plugins | Markdown; `name`, `description`; many optional keys; "ignores unrecognized fields without reporting an error" | none | code.claude.com/docs/en/sub-agents |
| Codex CLI | `.codex/agents`, `~/.codex/agents` | TOML; `name`, `description`, `developer_instructions` | none | learn.chatgpt.com/docs/agent-configuration/subagents.md |
| Cursor | `.cursor/agents`, `.claude/agents`, `.codex/agents` and `~/` twins | Markdown; none required (`model`, `readonly`, `is_background`) | `.claude`, `.codex` | cursor.com/docs/subagents |
| Gemini CLI | `.gemini/agents`, `~/.gemini/agents` | Markdown; `name`, `description`; no skills field found | none | developers.googleblog.com; fields from morphllm.com (third party) |
| Copilot CLI | `.github/agents/*.agent.md`, `~/.copilot/agents` | not sourced | not sourced | third party |
| Amp, Cline, Roo, Kilo | not sourced | | | |

## Instruction files by product

| Product | Files | Reads AGENTS.md / CLAUDE.md | Source |
| --- | --- | --- | --- |
| pi | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` per directory, first found | both (one per directory) | above |
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`; `@path` imports | AGENTS.md only without a CLAUDE.md (v2.1.277+) or via `@AGENTS.md` | code.claude.com/docs/en/memory |
| Codex CLI | `AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`; 32 KiB cap | CLAUDE.md only via the fallback list | learn.chatgpt.com/docs/agent-configuration/agents-md |
| Cursor | `.cursor/rules/*.mdc`, `AGENTS.md` | AGENTS.md; CLAUDE.md not mentioned | cursor.com/docs/context/rules |
| Gemini CLI | `GEMINI.md` in home, workspace and parents | AGENTS.md if `context.fileName` lists it | geminicli.com/docs/cli/gemini-md/ |
| Copilot CLI | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, combined | both | docs.github.com |
| Amp | `AGENTS.md` up to `$HOME`, fallback `AGENT.md` or `CLAUDE.md` | both | ampcode.com/docs/customize/agents-md |
| Cline, Roo, Kilo | not sourced | | |

## Migration by asset

**Skills.** Unchanged: any skill already in `.agents/skills` or `~/.agents/skills`. Move: skills in `.claude/skills`, `.cursor/skills`, `.gemini/skills`, `.github/skills`, `.cline/skills` or `.roo/skills` go to `.agents/skills` (shared with other tools) or `.pi/skills`, or get listed in the `skills` setting. Traps: Claude-only keys (`context`, `agent`, `paths`, `model` and the rest) are outside pi's documented set; pi says "Most invalid fields produce warnings rather than stopping startup" (`PI/docs/skills.md:7`), but whether they take effect is not sourced, and a skill that relies on them behaves differently. Codex `agents/openai.yaml` is not read. A subagent's `skills:` names resolve only if the skill is loadable from a pi location.

**MCP.** Unchanged: an `mcpServers` entry from Claude Code, Cursor or Cline copies into `mcp.json`; Amp's entries copy out of `amp.mcpServers`. Rewrite: Codex TOML, Gemini, Kilo. Pi's own conversion table (`PI/docs/mcp.md:104-113`):

| Client | Conversion |
| --- | --- |
| Claude Desktop, Claude Code, Cursor | Copy the existing `mcpServers` entry. |
| VS Code | Move from top-level `servers`; replace `${input:...}` with `${NAME}`. |
| Codex | Convert `[mcp_servers.<name>]` TOML fields to JSON. |
| OpenCode | `local` to stdio, split the `command` array, rename `environment` to `env`, `{env:NAME}` to `${NAME}`; `remote` to a URL entry. |

Traps:
- Variables. Claude `${VAR}` and `${VAR:-default}`; Cursor `${env:VAR}`, `${userHome}`, `${workspaceFolder}`; Codex names variables in fields (`env_vars`, `bearer_token_env_var`, `env_http_headers`); Gemini `$VAR`, `${VAR}`, `%VAR%`; Amp `${VAR}`; Copilot passes only `env` and a local server inherits only `PATH`. Pi documents `${VAR}` and `!command` only, so Cursor variables and `:-default` need rewriting (mcpport README, github.com/Abdalkaderdev/mcpport).
- Transport. Pi rejects `sse` (`PI/docs/mcp.md:79`) and `ws` is not in its list (`mcp.md:78`). Gemini `url` means SSE and `httpUrl` means streamable HTTP, so a Gemini `httpUrl` becomes pi `url` and a Gemini `url` needs a new endpoint. Copilot `type: local` must become `stdio` or be dropped. Claude requires `type: http` on remote entries while pi treats a bare `url` as HTTP, so a file shared by both must keep `type`; tools that read a Claude `url` without `type` treat it as stdio (mcpport README).
- Units. Claude `timeout` is in milliseconds, pi's in seconds.
- OAuth. Every tool keeps its own token store; sign in again with `pi mcp login` (`PI/docs/mcp.md:127`). Pre-registered clients must add pi's redirect `http://127.0.0.1:<port>/callback` or set `callbackUrl` (`mcp.md:146`); Cursor uses `http://localhost:8787/callback` and Amp `http://localhost:8976/oauth/callback` (their MCP pages). A server that accepts only known clients can be given `oauth.clientName` (`mcp.md:150-158`). `auth` cannot sit in a project file (`config.js:94-96`).
- Header helpers. Claude `headersHelper` and Codex `http_headers_helper` map to a whole-value `!command`.

**Agent definitions.** Nothing carries over: pi's subagents extension reads none of `.claude/agents`, `.codex/agents`, `.cursor/agents` or `.gemini/agents` (`SUB/src/plugins/agent-definitions/index.ts:26-29`). The Markdown body (Claude, Cursor, Gemini) or Codex `developer_instructions` becomes the prompt; the frontmatter is rewritten. Every file must add `limit`, `tools`, `skills` and `subagents` (`SUB/README.md:57-67`). Claude tool names and model aliases are not pi values; `permissionMode`, `maxTurns`, `memory`, `readonly`, `is_background`, `temperature`, `max_turns`, `timeout_mins` and inline `mcpServers` have no counterpart. The loader warns about unknown keys and ignores them ("unknown field(s) ignored: ...", `SUB/src/plugins/agent-definitions/loader.ts:33-40`), so a copied file with leftover keys still loads.

**Instruction files.** Unchanged: `AGENTS.md` and `CLAUDE.md`. Rename or merge: `GEMINI.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.claude/rules/`, `CLAUDE.local.md`. Trap: one file per directory, so a directory with both `AGENTS.md` and `CLAUDE.md` loads only `AGENTS.md` (`resource-loader.js:116`); pi documents no `@path` import, so a CLAUDE.md that is only `@AGENTS.md` still works because AGENTS.md wins, but other imports are not followed.

## Existing tooling

- `pi mcp add` writes stdio or HTTP entries with `--env`, `--header`, `--bearer-token-env-var` and OAuth options (`PI/docs/cli.md:324-325`); `pi mcp list` validates (`PI/docs/mcp.md:96`). It has no importer.
- Codex import: detects and imports configuration, skills, hooks, MCP servers, subagents and sessions; CLAUDE.md maps to AGENTS.md, hooks import as command hooks only, `$ARGUMENTS` commands and subagent model names are skipped. Third-party sources only (codex.danielvaughan.com posts of 2026-05-13 and 2026-07-24, which disagree on versions); the vendor's own import page was not fetched. It targets Codex, not pi.
- mcpport (github.com/Abdalkaderdev/mcpport): lists, lints, syncs and converts MCP configs across Claude Code, Codex, Gemini CLI and Cursor; dry run unless `--apply`; drops unknown options such as `startup_timeout_sec`, `trust`, `envFile`. It does not list pi.
- Seen by title, not evaluated: MCP Config Converter (mcp.directory/tools/mcp-config-converter), Skill Porter (mcpmarket.com/tools/skills/skill-porter-cross-platform-ai-converter), Codeman guide (getcodeman.com/guides/share-mcp-servers-claude-code-codex-gemini). Not checked: rulesync, ruler, add-mcp, the `skills` CLI.

## Gaps

1. Pi does not load `.claude/skills` or `.codex/skills`; Claude Code writes `.claude/skills`, and Cursor, Amp, Copilot CLI and Kilo read it.
2. Pi reads only its two `mcp.json` files, none of `.mcp.json`, `.cursor/mcp.json`, `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.copilot/mcp-config.json`.
3. Copilot CLI reads Claude's `.mcp.json` natively; pi does not.
4. Pi rejects `sse`, so Claude SSE entries, Gemini `url` entries and Copilot `sse` entries need a new endpoint.
5. Pi documents neither `${VAR:-default}` nor Cursor's `${env:NAME}`, `${workspaceFolder}`, `${userHome}`.
6. Pi documents spec skill fields only; Claude-only keys and Codex `agents/openai.yaml` are outside it.
7. Pi reads no `GEMINI.md`, `.cursor/rules/*.mdc`, `.claude/rules/`, `CLAUDE.local.md` or `.github/copilot-instructions.md`, and documents no `@path` import.
8. The subagents extension reads agents only from built-in, `~/.pi/agent/agents` and trusted `.pi/agents`.
9. No other product's agent file is valid for it: required `limit`, `tools`, `skills`, `subagents` exist nowhere else, and Codex agents are TOML.
10. This repo's agents name skills that must be loadable from a pi location (gap 1).
11. Neither pi nor this repo ships an importer.
12. Roo MCP and instruction paths, Cline and Kilo instruction files, Amp and Copilot agent formats: not sourced.

## Verdicts

1. **Skills port best.** SKILL.md is shared by every product, and `.agents/skills` is read by pi, Codex, Cursor, Gemini, Copilot, Amp, Roo and Kilo, so a team that keeps skills there needs no conversion. `.claude/skills` is not read by pi; those skills need a move or a `skills` setting entry, and Claude-only keys lose their effect.
2. **MCP ports with a copy** for the JSON-shaped tools (Claude Code, Cursor, Cline, Amp, Copilot) and **a rewrite** for Codex TOML, Gemini and Kilo. Even a copy needs variable syntax checked (Cursor), `type` values fixed (Copilot `local`) and OAuth re-login everywhere. `sse` endpoints are the one hard stop: they need a streamable HTTP endpoint.
3. **Agent definitions do not port.** Every format differs, and pi's requires `limit`, `tools`, `skills` and `subagents`, which nobody else has. Each agent is a rewrite of the frontmatter around a reused prompt.
4. **Instruction files port for AGENTS.md and CLAUDE.md users only.** Gemini, Cursor rules and Copilot instructions need renaming or merging into AGENTS.md.

## Could not source

- Claude Code: whether it reads `.agents/skills`.
- Pi: how unknown skill frontmatter keys are treated beyond "warnings"; `${VAR:-default}` support.
- Subagents extension: whether unknown frontmatter keys are rejected or ignored (not tested).
- Antigravity CLI: whether `.gemini/` paths and `httpUrl` survive the move (Gemini docs say the switch was 2026-06-18; Google post developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/, search result only, says skills, hooks, subagents and extensions stay without full parity).
- Roo MCP and instruction paths; Cline, Roo, Kilo instruction files; Amp, Cline, Roo, Kilo agent formats; Copilot agent fields; Amp cross-tool MCP loading.
- Codex: the vendor's own import page; whether `.claude/skills` is read.
