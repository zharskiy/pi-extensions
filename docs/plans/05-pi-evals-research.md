# 05 Pi evals research

Question: does pi ship evals tooling we can use instead of the custom `test-framework/eval-runs/` and `evals/` planned in [03](03-test-framework-and-evals.md) and scheduled in [00](00-master-plan.md) Phases 3 and 8?

Short answer: **partial**. Pi has an evals package, but it is private to the pi monorepo, it is not published, and it is built for pi's own documentation-lift experiments. Nothing can be installed. Its runner (Sentry's `vitest-evals`) is public, but it requires vitest 4 and this repo runs vitest 5. We keep the custom design and borrow four ideas from pi's harness.

---

## 1 What pi ships

### 1.1 Installed packages (1.4.0)

All seven installed `@earendil-works/*` packages are 1.4.0, MIT. None contains evals code.

- `grep -ril eval node_modules/@earendil-works/*/dist/**/*.d.ts` hits only unrelated words (`llama-cpp-classify`, codemode prelude, TUI, telemetry attribute values).
- `pi-coding-agent/CHANGELOG.md` mentions "eval" only as "eval-restricted runtimes such as Cloudflare Workers" (TypeBox migration). No evals entry.
- `pi-coding-agent/docs/` (44 pages) has no evals page.

### 1.2 The monorepo package

`https://github.com/earendil-works/pi/tree/main/packages/evals` exists. Its `package.json`:

```json
{ "name": "@earendil-works/pi-evals", "version": "1.4.0", "private": true,
  "scripts": { "eval": "npm run eval:host && npm run eval:docs --",
    "eval:host": "vitest run --config vitest.evals.config.ts --project host",
    "eval:docs": "node --experimental-strip-types src/cli.ts" },
  "devDependencies": { "@vitest-evals/core": "0.15.0", "vitest": "4.1.12", "vitest-evals": "0.15.0", ... } }
```

| Fact | Value | Evidence |
|---|---|---|
| Name | `@earendil-works/pi-evals` | `packages/evals/package.json` |
| Published | No. `"private": true`; `https://registry.npmjs.org/@earendil-works%2Fpi-evals` returns 404 (also `pi-eval`, `pi-bench`, `pi-test`) | npm registry, npm search of the scope (32 packages, none evals) |
| Install | Only by cloning the monorepo; no exports, no `dist`, no `bin` | `package.json` has no `main`/`exports` |
| Licence | MIT (repo licence) | GitHub repo metadata |
| Stability | Internal. History is release bumps plus `fix(evals): drop autoevals dependency` (2026-10-22). No CHANGELOG, no user docs | `gh api repos/earendil-works/pi/commits?path=packages/evals` |
| Runner | `vitest-evals` 0.15.0 (Sentry, Apache-2.0); latest is 0.17.0 | npm |

Files: `src/{cli,docker,harness,plan,report}.ts`, `evals/{smoke,documentation-audit}.eval.ts`, five `*.docs.eval.ts`, `docker/` (Dockerfile, entrypoint), `test/` (unit tests of the runner).

## 2 API and concepts

### 2.1 Two kinds of eval

- **Host evals** (`*.eval.ts`): plain `vitest-evals` suites run on the developer machine. Examples: `smoke.eval.ts` (capital of France), `documentation-audit.eval.ts` (one case per docs page).
- **Docs evals** (`*.docs.eval.ts`): each case runs twice, in `without_docs` and `with_docs` Docker images, N times; the CLI pairs the arms and reports pass-rate *lift*. This is the only place pi repeats runs.

### 2.2 Defining a case

TypeScript, no frontmatter. One `describeEval(name, { harness, judges?, judgeThreshold? }, (it) => ...)` per suite, `it.for(table)` for case tables, `run(input)` inside the test:

```ts
const harness = createPiCodingAgentHarness({ noTools: "all" });
describeEval("Answer a basic prompt", { harness }, (it) => {
  it("returns the expected answer", async ({ run }) => {
    const result = await run("What's the capital of France? ...");
    expect(result.output.trim()).toBe("Paris");
  });
});
```

### 2.3 How it runs an agent

`src/harness.ts`, `createPiCodingAgentHarness(options)`:

```ts
type PiCodingAgentHarnessOptions = { name?; model?: { provider; id }; noTools?; tools?; customTools?;
  workspaceFiles?: Record<string, string>; transformSystemPrompt?; expectedPiDocumentation? };
```

Per run it:

1. Makes `mkdtemp(pi-eval-)` with `workspace/`, `home/`, `home/.pi/agent`, `sessions/`.
2. Overrides `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR` (`applyIsolatedEnvironment`) and copies the one stored credential into an `InMemoryCredentialStore` (`readStoredCredential(provider, authPath)`).
3. Writes `workspaceFiles` into the workspace (no git, no checkout).
4. Builds one `AgentSession` through the public SDK: `createAgentSessionServices({ cwd, modelRuntime, resourceLoaderOptions: { extensionFactories } })` then `createAgentSessionFromServices({ ..., thinkingLevel: "off", tools, customTools })`.
5. **Fails if any non-inline extension loaded**: `Isolated eval loaded unexpected extensions`. The only inline extension is its own system-prompt transform; options expose no way to add one.
6. Calls `session.prompt()` per step (`{ type: "reload" }` steps call `session.reload()`), then converts `session.messages` to `vitest-evals` transcript events (`message`, `tool_call`, `tool_result`) and usage from `session.getSessionStats()` (tokens, tool calls, `estimatedCostUsd` when the model has pricing).
7. Saves the session JSONL as an artifact and deletes the temp root.

Model: `PI_PROVIDER` + `PI_MODEL` env, or `options.model`. Thinking is always `off`.

### 2.4 Scoring

- Plain vitest `expect` on `result.output`, `toolCalls(result)`, `result.usage`.
- `vitest-evals` judges: `StructuredOutputJudge` (strict JSON match), `ToolCallJudge` (expected tool names and arguments), LLM judges through a `judgeHarness`. `judgeThreshold: null` records scores without failing.
- A structured-verdict trick: a custom tool `submit_documentation_audit` with a TypeBox schema, `constrainedSampling`, and `terminate: true`; the test asserts on its arguments.
- **No pass rate over N runs in host evals.** `vitest-evals` has no repeat primitive. Repetition exists only in `cli.ts` for docs evals (`--runs-per-variant`, `PI_EVAL_RUNS_PER_VARIANT`), tied to Docker variants and paired lift.

### 2.5 Reporting, cost, time, parallelism

- `vitest-evals/reporter` terminal output (scores, tokens, cost), Vitest JSON with run metadata, a local report UI (`vitest-evals serve`), a GitHub Action.
- Docs runs write `.eval/<timestamp>_<id>/` with `protocol.json`, `observations.jsonl`, per-arm `vitest.json`, session files, `report.{json,txt}`. Flags `no-lift`, `negative-delta`, `saturated`, `flaky`.
- Config: `pool: "forks"`, `maxWorkers: 1`, `fileParallelism: false`, 300 s test and hook timeouts. No cost budget.

## 3 Mapping against plan 03

### 3.1 What pi's harness cannot do for us

| Need | Pi evals |
|---|---|
| Load an extension from this repo (subagents, wake) | No. Rejects any non-inline extension; options do not accept `extensionFactories` |
| Fake host plus real runtime (our `createLiveHarness`) | No. Real `AgentSession` only |
| Child agents, wake messages, successor chains, nesting | No concept; one session, one prompt loop |
| Seed a project from a git SHA, apply a diff, plant a defect, run hidden tests | No. `workspaceFiles` map only |
| `provider/id:thinking` from one env var, chore model | No. `PI_PROVIDER`/`PI_MODEL`, thinking forced `off` |
| Majority of N runs with a threshold | No in host evals |
| Spend across a chain of agents | Single-session usage only |
| UI widgets, overlays, footer | No; and our live tests do not need it either |
| Install as a dependency | No, private |

### 3.2 Piece by piece

| Plan 03 piece | Decision | Reason |
|---|---|---|
| `test-framework/pi/live/startLiveExtension` | Keep custom | Pi cannot load our extension or a fake host |
| `openPiSession` (03 §1.4, wake bootstrap) | Keep custom, borrow isolation | Same SDK calls pi uses (`createAgentSession`, `SessionManager.create`, `ModelRuntime.create`). Borrow `HOME`/`PI_CODING_AGENT_DIR` override and `InMemoryCredentialStore` + `readStoredCredential` instead of linking `auth.json` |
| `test-framework/live/session-reading` / `sessionFacts` | Hybrid | Keep ours; reshape output to pi's event list (`message`, `tool_call`, `tool_result`) so tool-call assertions read one normalised list |
| `eval-runs/repeatRuns`, `evalRunCount` | Keep custom | Nothing to replace it with |
| `eval-runs/gradeRuns`, `expectPassRate(MAJORITY)` | Keep custom | Same |
| `eval-runs/reportEval` + `PI_EVAL_REPORT` | Keep custom, borrow record shape | Use pi's run record (`output`, `events`, `usage{inputTokens, outputTokens, toolCalls, costUsd}`, `timings.totalMs`, `errors`) for the JSON line |
| `evals/<extension>/<subject>/*.eval.ts` layout | Keep | Matches pi's `*.eval.ts` naming; pi's flat folder suits one subject, ours has four |
| `vitest.evals.config.ts` | Keep, align settings | Pi uses `pool: "forks"`, `maxWorkers: 1`, `fileParallelism: false`. Add `pool: "forks"` to ours |
| `npm run evals` | Keep | Same shape as pi's `eval:host` |
| `PI_EVAL_RUNS` | Keep | Pi's `PI_EVAL_RUNS_PER_VARIANT` is docs-only. Keep `PI_LIVE_MODEL`, not `PI_PROVIDER`/`PI_MODEL`: one var carries thinking |
| planner / reviewer / implementer evals | Keep custom | Need git seeding, chains, hidden tests, majority |
| routing eval | Keep custom, optional borrow | Closest to pi's shape (one main session, stubbed tools, assert on tool-call arguments). Could later run on `vitest-evals` with `ToolCallJudge` |
| wake, grants, handoff, nesting, run-agent, worktree live tests | Keep custom | Mechanics, not quality; outside any evals tool. See §4.3 for a faux-provider option |

## 4 Recommendation

### 4.1 Verdict

Do not adopt. There is nothing to install, and its runner library conflicts with our vitest. Borrow four things, all small:

1. **Run record shape** from `harness.ts` (`toTranscriptEvents` + `getSessionStats` usage). Pi-free type in `test-framework/eval-runs/`, filled by `test-framework/pi/live/`.
2. **Isolation** from `applyIsolatedEnvironment` and the in-memory credential copy.
3. **Vitest settings**: `pool: "forks"`, one worker, no file parallelism.
4. **Session snapshot per run**, kept on failure, as pi does with `PI_SESSION_SNAPSHOT_ARTIFACT`.

Keep the door open to `vitest-evals` later by making `GradedRun` hold that record. A later switch then wraps `runChain` in `createHarness({ run })` without touching rubrics.

### 4.2 Revised Phase 3 (changes only)

- `test-framework/eval-runs/run-record.ts` (pi-free): `RunRecord = { output; events: RunEvent[]; usage: { inputTokens; outputTokens; toolCalls; costUsd?: number }; timings: { totalMs }; errors: string[] }`, `RunEvent = message | tool_call | tool_result`.
- `test-framework/pi/live/session-events.ts`: `sessionEvents(messages)` and `runUsage(session)` (from `getSessionStats()`), next to `live-agent-dir.ts`.
- `test-framework/pi/live/live-agent-dir.ts`: `prepareAgentDir` copies the selected credential through `readStoredCredential` into the temp agent dir and sets `PI_CODING_AGENT_DIR`/`HOME` for the run, restored in `teardownLive`. Unit test the restore.
- `costOf`/`reportCost` read `RunRecord.usage.costUsd`; missing pricing stays "unavailable", never `$0` (pi's rule).
- No new dependency. No deletion from 03 §3.

### 4.3 Optional Phase 3b: faux-provider mechanics tests

`@earendil-works/pi-ai` 1.4.0 exports a scripted provider: `fauxProvider(options)`, `fauxAssistantMessage`, `fauxToolCall`, `fauxText` (`dist/providers/faux.d.ts`). Pi uses it in its own `packages/coding-agent/test/*.test.ts`. With it, parts of `wake`, `grants` (exact tool list, no write without grant) and `nesting` could run as unit tests in CI with scripted tool calls. Model-following parts stay live. Lives in `test-framework/pi/faux/`. Provider and model ids are invented (`faux/model`), which fits AGENTS.md. Decide after Phase 3; not required.

### 4.4 Revised Phase 8 (changes only)

- `vitest.evals.config.ts`: add `pool: "forks"`, `maxWorkers: 1` to the 03 §5 row.
- `reportEval` writes `RunRecord` per run to the `PI_EVAL_REPORT` JSON line; when a run fails, its session files are copied under the report dir.
- Answer 03 §7 Q6 with pi's choice: a gitignored `evals/.results/<timestamp>/` holding one `observations.jsonl` and session snapshots, plus the console lines. Writing there is fine: the AGENTS.md file rule binds extensions, not tests.
- Keep `PI_EVAL_RUNS`, `PI_LIVE_MODEL`, `MAJORITY`, the four suites as planned.
- Add a "revisit `vitest-evals`" item to Phase 9 with the trigger: a `vitest-evals` release whose peer range includes vitest 5.

### 4.5 What to delete from 03

Nothing structural. Two edits:

- §3.3 `RunCost` becomes `RunRecord["usage"]`.
- §7 Q6 closes as in §4.4.

## 5 Risks

| Risk | Detail | Mitigation |
|---|---|---|
| vitest peer conflict | `vitest-evals` 0.17.0 peers `vitest >=4 <5`; this repo pins `vitest` 5.0.3; pi pins 4.1.12 | Do not add it now; revisit on a vitest-5 release |
| Wrong-scope harness | `@vitest-evals/harness-pi-ai` 0.17.0 peers `@mariozechner/pi-ai >=0.67 <1`, the old scope, not `@earendil-works` 1.4.0 | Never use it |
| Copying private code | `harness.ts` is MIT but private and changes with every pi release | Borrow patterns, do not vendor the file |
| SDK coupling | Borrowed calls (`createAgentSessionServices`, `getSessionStats`, `readStoredCredential`, `fauxProvider`) are 1.4.0 exports | Confine them to `test-framework/pi/` (already the only test folder allowed to import pi); the peer range is `^1.4.0` |
| Provider/model names | Pi's README and examples name real providers and models. We must not copy those into code, prompts, cases or docs | Model only from `PI_LIVE_MODEL`; faux ids are invented |
| CI | Pi runs evals by hand, not in CI. Our rule: `test:live` and `evals` never in CI | Unchanged. Only faux tests (§4.3) could join `npm run check` because they make no network calls |
| Thinking level | Pi forces `thinkingLevel: "off"`; our shipped agents carry `:thinking` | Keep our `provider/id:thinking` parsing; do not copy pi's default |

## 6 Evidence

- Pi evals package: `https://github.com/earendil-works/pi/tree/main/packages/evals` (`package.json`, `README.md`, `src/harness.ts`, `evals/smoke.eval.ts`, `evals/documentation-audit.eval.ts`, `evals/extensions.docs.eval.ts`, `vitest.evals.config.ts`).
- npm: `https://registry.npmjs.org/@earendil-works%2Fpi-evals` (404); `https://www.npmjs.com/package/vitest-evals` (0.17.0, peer `vitest >=4 <5`).
- `vitest-evals` README: `https://github.com/getsentry/vitest-evals/blob/main/packages/vitest-evals/README.md`.
- Installed SDK: `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` (exports `createAgentSession`, `createAgentSessionServices`, `createAgentSessionFromServices`, `InlineExtension`, `readStoredCredential`, `runPrintMode`, `runRpcMode`, `RpcClient`); `node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts`.
- Local: `package.json` (`vitest` 5.0.3), `core/test/adapter/live.ts` (`openMainLikeSession` uses `createAgentSession`).
