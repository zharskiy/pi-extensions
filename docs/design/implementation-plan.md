# Implementation plan: agent workflow redesign

Design: `docs/design/agent-workflow.md` (local, gitignored; give implementers the path, do not reference it from committed files). S = `extensions/subagents`, A = `core/adapter`.

Rules for every package: respect AGENTS.md (only `core/adapter` and `core/test/adapter` import pi; no provider or model names in code or prompts except the shipped agent files' `model:` lines and the README sentences listing them; files written only under the agent or session dir, except handoffs and worktrees). Code style: no for-loops, no comments, blank lines around if-blocks and multi-line declarations, concise names, no positional booleans, no nested ternaries. Do not commit. Do not run `npm run test:live`. Each package runs `npm run test` for its own test files (`npx vitest run <paths>`) and `npx tsc --noEmit -p .` where its change can break types elsewhere; the full `npm run check` is the last wave. Packages in one wave touch disjoint files and can run in parallel.

## Wave 1

### WP1 Adapter: tool restriction and skill names (opus)

- Goal: `Host.restrictTools(keep)` and `AgentRuntime.skillNames()` exist and behave as in the design (Code changes, Adapter), including the `tools: all` snapshot and resume via a session entry.
- Files: `core/adapter/contract.ts` (Host :265-275, AgentRuntime :407), `core/adapter/pi-adapter.ts` (createPiHost :84 and :370, before_agent_start :220-226, runtime accessors :481-494), `core/test/helpers/fakes.ts` (fake host and runtime), `core/test/adapter/pi-adapter.test.ts` or a new `core/test/adapter/pi-restrict-tools.test.ts`, `core/test/adapter/conformance.test.ts` (one offline check that pi's `setActiveTools` drops non-kept tools and ignores unknown names).
- Judgement needed: when a restriction made in `before_agent_start` takes effect; the removed-names entry format; how resume with explicit `--tools` merges with the stored entry.
- Depends on: none.
- Acceptance: new adapter tests cover keep-only removal, no-op without change, late-registered tool removed on the next run, `activeTools` returns active plus removed (live and after resume), `skillNames`; `npx vitest run core/test` passes; `npx tsc --noEmit` passes.

### WP2 Settings (sonnet)

- Goal: add `delegateOnly` (boolean, true), `delegateOnlyTools` (list, `["read", "write", "questionnaire"]`), `maxChildrenPerAgent` (6, 0..50), `fetchTimeoutSeconds` (20, 1..300), `fetchMaxBytes` (5000000, 10000..100000000), `fetchMaxChars` (40000, 1000..1000000).
- Files: `S/src/model/settings.ts` (type :9-23, defaults :27-41, schema :45-59), the existing settings test under `S/test/model/` (create `settings.test.ts` there if none covers the schema).
- Depends on: none.
- Acceptance: tests for defaults, accepted values, out-of-range and wrong-type values dropped with a warning; `npx vitest run S/test/model` passes.

### WP3 Fetch core functions (sonnet)

- Goal: pure, tested `fetchPage(url, limits, signal)` and `readableText(html)` as specified in the design (Code changes, new plugin `fetch-tool`), with `limits = { timeoutSeconds, maxBytes, maxChars }` as a parameter (no settings import). Node's global `fetch` only; no new dependency.
- Files (new): `S/src/plugins/fetch-tool/fetch.ts`, `S/src/plugins/fetch-tool/text.ts`, `S/test/plugins/fetch-tool/fetch.test.ts`, `S/test/plugins/fetch-tool/text.test.ts`.
- Depends on: none.
- Acceptance: text tests (title, script/style/comment/svg removal, block tags to lines, list items, entities, whitespace, non-HTML passthrough, unsupported type) and fetch tests with `vi.stubGlobal("fetch", ...)` (redirect final URL, 404 returned as status not error, timeout message, byte cap truncation, char cap `n of m`, non-http refused, abort honoured); no network in tests; `npx vitest run S/test/plugins/fetch-tool` passes.

### WP4 Roster, prompts and the explorer rename (sonnet)

- Goal: ship the eight agent files and the two prompts exactly as written in the design; drop the fixed output line from prompt assembly; make every existing test that loads the shipped agents pass with `scout` in place of `explorer`.
- Files: `S/agents/explorer.md` (delete), `S/agents/{scout,plan,implementer,reviewer,general,fetch,shell,image}.md`, `S/prompts/main-session.md`, `S/prompts/base-system-prompt.md`, `S/src/plugins/agent-definitions/prompt.ts`, `S/test/plugins/agent-definitions/agent-definitions.test.ts`, `S/test/helpers/{harness,records,overlay}.ts` where they name the shipped agent, every test under `S/test/` that starts the shipped `explorer` through the harness (run-agent, nesting, successor-chain, models, stop-grace, message-agent, worktree, render, describe-run-agent, limits, usage-report, agent-status, agent-panel, agent-view, components), `S/test/live/{run-agent,nesting,grants}.live.test.ts`. Snapshots and fixtures that use "explorer" only as a record name stay unless a test fails.
- Depends on: none (no source code besides `prompt.ts`).
- Acceptance: agent-definitions tests assert the eight shipped names, no `explorer`, exact field order, no warnings, no cycles, prompt assembly without the old output line, base prompt contains `Status: done | partial | blocked`; the main prompt file is at most 45 lines; `npx vitest run S/test` passes.

## Wave 2

### WP5 run_agent: skills parameter, spawn cap, description, task text (opus)

- Goal: implement the design's runner, tool and task changes: `skills` per item (union, validation against `runtime.skillNames()`, `read` requirement, error texts), per-chain spawn cap with the refusal text, the new `describeRunAgent` text (Skills line, Cap line for agent callers via `RunAgentLimits.childCap`, credentials sentence, result contract with Status, no Tasks line), schema `skills`, and the `Agent folder:` line in `composeTask`.
- Files: `S/src/plugins/run-agent/runner.ts` (startBatch :680-714, spawn spec :589-597, launches :739), `S/src/plugins/run-agent/tools.ts` (:60-163), `S/src/plugins/run-agent/task.ts`, `S/test/plugins/run-agent/{run-agent,describe-run-agent,nesting,successor-chain}.test.ts` as needed, new `S/test/plugins/run-agent/skills.test.ts` and `S/test/plugins/run-agent/spawn-cap.test.ts`.
- Judgement needed: chain-root lookup for the cap, carrying item skills into successors, keeping all validation before `registry.create`.
- Depends on: WP1 (`skillNames` in contract and fakes), WP2 (settings), WP4 (renamed tests).
- Acceptance: the design's unit tests for skills, cap, description, task text and spawn spec; nothing registered on refusal; `npx vitest run S/test/plugins/run-agent` passes; `npx tsc --noEmit` passes.

### WP6 fetch-tool plugin (sonnet)

- Goal: a `fetch-tool` plugin that provides a `fetchTool` service returning the `fetch` `ToolSpec` (A/contract.ts:53-71) built on WP3, reading limits from settings, with the result text format and error handling from the design.
- Files: new `S/src/plugins/fetch-tool/index.ts`, `S/src/plugins.ts` (register, no requirements), the service map type in `S/src/model/` (add `fetchTool`), new `S/test/plugins/fetch-tool/plugin.test.ts`, `S/test/plugins.test.ts` if it lists plugin ids.
- Depends on: WP2, WP3.
- Acceptance: tests for the service's tool spec (name `fetch`, parameters `{ url }`, result text lines, `Truncated:` only when cut, errors as `isError` text) with stubbed `fetch`; the plugin can be disabled through `disabledPlugins`; `npx vitest run S/test/plugins/fetch-tool S/test/plugins.test.ts` passes.

## Wave 3

### WP7 run-agent plugin wiring: delegate-only and fetch grant (sonnet)

- Goal: in `S/src/plugins/run-agent/index.ts`, call `host.restrictTools([...agent tools, ...settings.delegateOnlyTools])` after `setMainPrompt` when `delegateOnly` is on (:151-154); in `childTools` (:47-72) add the fetch tool when the definition's `tools` is a list containing `fetch` and the service exists; pass `childCap: settings.maxChildrenPerAgent` in child limits.
- Files: `S/src/plugins/run-agent/index.ts`, new `S/test/plugins/run-agent/delegate-only.test.ts`, new `S/test/plugins/run-agent/fetch-grant.test.ts` (keep WP5's test files untouched).
- Depends on: WP1, WP5, WP6.
- Acceptance: delegate-only on, off, and agent-status disabled; children never restrict; fetch tool present only for a `tools` list naming `fetch`, absent for `all` and for other lists, absent when the plugin is disabled; Cap line present in child descriptions; `npx vitest run S/test/plugins/run-agent` passes.

### WP8 Live routing suite (opus)

- Goal: `S/test/live/routing.live.test.ts` as described in the design (Tests, Live): a real main-like session on `PI_LIVE_MODEL` with `main-session.md` as its system prompt and a recording `run_agent` that has the real schema and `describeRunAgent` text over the shipped roster; the listed request cases; brief-field assertions; the skills case with a temporary skill.
- Files: `core/test/adapter/live.ts` (a helper that builds the main-like session with pi's SDK and a system prompt override; pi imports stay in `core/test/adapter`), `S/test/helpers/live.ts` (only if a shared helper belongs there), new `S/test/live/routing.live.test.ts`.
- Judgement needed: building a session whose system prompt replaces pi's (as `replaceMainPrompt` does) without touching production code; making assertions robust to wording while strict on agent choice.
- Depends on: WP4, WP5.
- Acceptance: `npx tsc --noEmit` passes and `npx vitest run --config vitest.live.config.ts --list` (or equivalent collection without running) includes the suite; do not run it. The owner runs `PI_LIVE_MODEL=... npm run test:live` locally.

## Wave 4

### WP9 Docs (sonnet)

- Goal: update `S/README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` as listed in the design's Docs section; no reference to `docs/`.
- Files: `S/README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`.
- Depends on: WP1 to WP8.
- Acceptance: the README frontmatter table is unchanged in shape (agent-definitions test reads it, :382); `npx vitest run S/test/plugins/agent-definitions` passes; the README's model sentences are the only place outside agent files naming models.

### WP10 Full check (sonnet)

- Goal: `npm run check` passes.
- Files: none planned; fix only formatting (biome) and obvious type errors; report anything else with file and line instead of changing behaviour.
- Depends on: WP9.
- Acceptance: `npm run check` exit 0, output summary in the report.

### WP11 Review (opus, read-only)

- Goal: review the whole diff against the design and AGENTS.md rules; findings ranked with path:line and a ship verdict.
- Depends on: WP10.
- Acceptance: a findings list; fixes go back to the owning package's agent.
