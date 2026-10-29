# Subagent wake-up latency: research

Status: research, no code changed. Pi version read: `@earendil-works/pi-coding-agent` 1.4.0 (`node_modules`).

Paths are relative to the repo root, or to `node_modules/@earendil-works/pi-coding-agent/dist/` (written `pi:`).

## 1. Symptom

The main session spawned 5 background agents with a trivial task ("what time is it"). After all of them had finished,
the main session seemed to be triggered again only about 10 s later. The expectation was that it would be triggered
the moment the last agent finished.

## 2. Measured timeline

The two sessions on disk are both "5 agents, each spawns 3 agents to check the time": 5 `general` parents (callerId
`main`) and 15 `shell` leaves. Times come from each agent's `manifest.json` `endedAt` and from the timestamps of the
main session's jsonl entries.

| Event | Oct 28 session | Oct 27 session |
|---|---|---|
| Last leaf agent done | 17:32:51.246 (`shell-adf8d56f3cb2`) | 09:24:01.085 (`shell-1e7d9d7222e4`) |
| Its parent receives "Batch finished" | 17:32:51.247 | 09:24:01.085 |
| Last top-level parent done (own final LLM turn) | 17:32:56.558 (`general-250bab0de6ad`), +5.3 s | 09:24:08.048 (`general-8969987f6f67`), +7.0 s |
| Main `pi-subagents:wake` entry | 17:32:56.562, **+4 ms** | 09:24:08.050, **+2 ms** |
| Main assistant answer written | 17:33:00.071, +3.5 s | 09:24:12.833, +4.8 s |
| Last leaf done → main answer | 8.8 s | 11.7 s |

Every agent turn in these sessions takes about 5–7 s, even for running `date`. The parents run at `:medium` thinking.
The main session runs at `defaultThinkingLevel: "high"` with `hideThinkingBlock: true`.

## 3. Path from completion to wake

1. The child's pi session ends its run: `_startRun` → `_emitAgentSettled` awaits the child's extension
   `agent_settled` handlers and then emits the event (`pi:core/agent-session.js:683-690`, `:1471`).
2. The adapter maps that to `{ type: "settled" }`. If messages are queued, it resumes the child instead
   (`platform/pi-adapter/child/child-runtime.ts:281-291`).
3. `handleEvent` handles `settled` → `finish` → `registry.close` (`extensions/subagents/core/run-agent/runner.ts:601`,
   `:462`).
4. `agent:closed` → `onClosed` → `checkBatch`, all synchronous. When every record in the batch is closed, it calls
   `callerOutbox(callerId).post(batchText)` (`runner.ts:170-187`, `:198-212`).
5. The main outbox collects posts in one microtask and calls `host.sendHiddenMessage({ customType: "pi-subagents:wake" })`
   (`extensions/subagents/api/plugins/run-agent.ts:59-76`).
6. The adapter's `deliver` (`platform/pi-adapter/runtime/host.ts:189-215`) handles the message one of two ways:
   - during a run, a followUp with `triggerTurn` (`:144`);
   - when idle, `queueMicrotask(deliverHeld)` → `pi.sendMessage(first, { triggerTurn: true })` (`:152-187`, `:211`).
7. pi's `sendCustomMessage` starts a run right away. It defers only while `agent_settled` handlers are still being
   emitted (`pi:core/agent-session.js:1844-1870`).

## 4. Timers and waits on or near the path

| What | Value | Where | When it applies |
|---|---|---|---|
| Outbox batching | microtask | `run-agent.ts:71` | always, about 0 ms |
| Adapter idle delivery | microtask | `host.ts:211` | main session idle, about 0 ms |
| Held-message poll | 100 ms | `host.ts:82` | main session neither idle nor running (compacting) |
| Child abort wait | 5 s | `runner.ts:120` | stopping or aborting an agent |
| Child shutdown wait | 2 s | `child-runtime.ts` `SHUTDOWN_TIMEOUT_MS` | teardown; awaited before the batch settles **only for `worktree: true` agents** (`runner.ts:322-336`), which also wait for the worktree release |
| Stop grace | `stopGraceSeconds` 60 s | `extensions/subagents/core/model/settings.ts:53`, `runner.ts:525` | only for agents the user stopped; normal completion skips it |
| Concurrency cap | `maxConcurrent` 12 | `settings.ts:44` | queues launches beyond 12; delays starts, not the wake |
| Panel refresh | 100 ms running / 1 s idle, throttle 250 ms | `extensions/subagents/core/components/refresh.ts:4-6`, `settings.ts:52` | UI only |
| MCP startup wait | 10 s | `pi:extensions/mcp/index.js:39`, `:1035` | first prompt of a session or child only, not completion |

Nothing on the path adds seconds for normal (non-worktree) agents. This repo's extensions skip child sessions
(`platform/pi-adapter/runtime/extension.ts:41`), and no third-party extensions are installed, so no child
`agent_settled` handler can stall step 1.

## 5. Root cause

The wake fires 2–4 ms after the last top-level agent closes. The repo adds no latency. The perceived delay is two
model turns:

- In the nested setup, each parent takes one more LLM turn after its children finish, to write its own result. It
  stays `running` during that turn, so its batch cannot settle: about 5–7 s.
- After the wake, the main session takes its own LLM turn: about 3.5–5 s. Its thinking block is hidden and the wake
  message is hidden (`display: false`), so nothing appears in the transcript until the answer does. Only the working
  indicator shows.

Confidence: high. The logs measure each step directly.

Not ruled out: a run that was not saved in these sessions; `worktree: true` agents (teardown is awaited before the
batch settles); third-party extensions with slow `agent_settled` handlers, if any are installed later.

## 6. Options

**(a) Make the wake visible.** Show a compact "batch finished: N done" row in the main transcript when the wake is
sent, so the user sees right away that the main session was triggered. Either send the wake with `display: true` plus
a registered renderer, or have the transcript extension draw the row.

- Files: `extensions/subagents/api/plugins/run-agent.ts`, a renderer under `extensions/subagents/ui/run-agent/`, and
  the docs required by `test/docs-sync.test.ts`.
- Existing coverage: `extensions/subagents/tests/plugins/run-agent/run-agent.test.ts` ("wakes the caller once when all
  three are done", "joins a busy turn as a hidden follow-up", "merges batches that settle in the same tick while idle
  into one wake", "delivers at once when idle and holds while busy"), and
  `platform/pi-adapter/tests/host.test.ts` ("sends a hidden follow-up while a run is active").
- New behavioural test: when a background batch settles while the main session is idle, the main transcript shows
  one visible batch-finished row in the same tick, and the main session starts a run.

**(b) Lower thinking levels** for the main session or for the parent agents. This shortens both model turns, at the
cost of answer quality. It is configuration, not code.

Recommendation: no latency fix is warranted. The wake path is already immediate. Option (a) is a cheap UX
improvement if the hidden turn keeps reading as a delay.
