# test/framework architecture

The fakes, harnesses and run helpers every test, live test and eval shares. It is never published, and no shipped code imports it. It reaches the four platform layers only through their `index.ts` (`pi-adapter`, `shared`, `ui-kit`, `extension-manager`) and never imports an extension or `test/evals/`; extension-specific helpers stay in that extension's `tests/support/`.

It has four parts, and only one of them touches pi:

| Part | Imports pi | Used by |
| --- | --- | --- |
| root modules (`index.ts`) | no | unit tests everywhere |
| `live/` | no | live tests and evals |
| `eval-runs/` | no | evals |
| `pi/`, `pi/live/` | yes | adapter-close unit tests, live tests, evals |

The pi-free parts never import `pi/`; `test/architecture.test.ts` checks that. `pi/` may import pi packages and adapter internals, the only test code besides `platform/pi-adapter/tests/` that does.

## Fakes

Unit tests run against fakes with no network and no pi session (`npm run check`, also what CI runs).

- `createFakeHost` (`fake-host.ts`) implements `Host` in memory: it records notices, widgets, entries, hidden messages (`hidden`) and displayed ones with their timing and delivery (`messages`), published messages and registered tools, and lets a test fire session, turn and idle events and assistant message starts and ends (`FakeHost.assistantStart`; `FakeHost.assistantEnd` with tool calls, `final` defaulting to no tool calls, and a reply text it adds to `chat` after the handlers ran, so `chat` holds replies and appended entries in the order pi draws them) (`createTurnScope`, `hiddenMessageTexts`).
- `FakeHost.selectModel(ref)` fires the `onModelSelect` handlers and awaits them; `saveDefaultModel` records each ref in `savedDefaults`, or returns `saveFailure` when a test sets it and records nothing. `selectThinking(level)` does the same for the `onThinkingSelect` handlers, and `saveDefaultThinkingLevel` records into `savedThinkingLevels` under the same `saveFailure`. `setThinkingLevel` sets `thinking`, which `thinkingLevel()` returns; a test replaces it to model a clamp.
- `createFakeAgentRuntime` (`fake-agent-runtime.ts`) spawns `FakeChildSession`s a test drives by hand (they keep the messages of `send` and `sendCustom` in one list, and the seed of `start`); `catalogModel` builds catalogue entries with invented refs, so no fixture names a real model.
- The fake `showForm` (`fake-form.ts`) keeps each form (`host.forms`, `host.form()`) so tests render it, press keys (`key-presses.ts`) and type into a fake text input (`backspace` deletes); it honours the abort signal.
- The fake themes (`themes.ts`: `plainTheme`, `tokenTaggingTheme`, `paintRecordingTheme`) measure, cut and wrap with the adapter's `textMetrics`, so fixtures are measured as pi would measure them.
- `startExtension` (`extension-harness.ts`) boots either a plugin list or a managed extension (`{ extension }`, running its own `boot`) on the extension manager over the fake host.
- Small helpers: `rendered-text.ts` (strip escapes), `usage-builders.ts`, `waiting.ts` (`flushMicrotasks`, `flushTimers`, `waitUntil`, `pause`), `temp-dirs.ts`, `recorded-sessions.ts` (session `.jsonl` line builders) and `valid-handoff.ts`.

## Real pi offline (`pi/`)

A few unit tests need pi's real rendering: `render-theme.ts` initialises pi's theme and keybindings, `tool-row-rendering.ts` draws tool rows and edit diffs through pi's renderers, `overlay-api.ts` opens overlays on pi's TUI, `session-files.ts` reads and writes real session files, and `offline-session.ts` (`startPiSession`) starts a real in-memory pi session on faux models over a temp agent dir and `settings.json`, with one extension factory loaded (inside a child scope when asked). These still run offline under `npm run check`.

## Live runs (`pi/live/`, `live/`)

`*.live.test.ts` and evals spawn real agents, locally only. `describeLive` (`pi/live/live-model.ts`) needs `PI_LIVE_MODEL=provider/id[:thinking]` and the credentials; it fails, never skips, when either is missing. In `beforeAll` it builds a temporary agent dir (`live-agent-dir.ts`: a link to the real `auth.json`, a copy of `models.json`, `PI_CODING_AGENT_DIR` pointed at it), and in `afterAll` removes it and restores the variable, so the user's own instructions, skills, extensions and MCP config stay out. `liveAgentModel()` returns the model from `PI_LIVE_MODEL`, `liveChoreModel()` the one from the optional `PI_LIVE_CHORE_MODEL` (else the same). `startLiveExtension` boots a plugin list or a managed extension on the real runtime (`live-runtime.ts`) over the fake host, with the extension's namespace and resolved `childExclude`; `openPiSession` opens a real pi session; `session-events.ts` fills a `RunRecord` from a live session.

The pi-free half in `live/` seeds a project from a commit (`seed-project.ts`), reads tool calls and outputs out of a session (`session-reading.ts`), sums and reports cost from pi's own figures (`cost.ts`) and serves the MCP fixture server (`fixture-mcp-server.ts`, spawned by path).

## Evals (`eval-runs/`)

The runner the suites in `test/evals/` use: `repeatRuns` runs a case `evalRunCount()` times (`PI_EVAL_RUNS`, default 1); `gradeRun`/`gradeRuns` score each `RunRecord` against a rubric of checks; `expectPassRate` with `MAJORITY` passes a case on a threshold; `reportRun`/`reportEval` print each run as it finishes and a summary per case, and append to `PI_EVAL_REPORT`; `eval-results.ts` writes `observations.jsonl` and snapshots failed sessions under `PI_EVAL_RESULTS`. How to run them is in [test/evals/README.md](../evals/README.md).
