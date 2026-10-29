# Subagent wake-up latency: research

Status: research, no code changed. Pi version read: `@earendil-works/pi-coding-agent` 1.4.0 (`node_modules`).

Paths are relative to the repo root, or to `node_modules/@earendil-works/pi-coding-agent/dist/` (written `pi:`).

## 1. Symptom

The main session spawned 5 background agents with a trivial task ("what time is it"). After all of them had finished,
the main session seemed to be triggered again only about 10 s later. The expectation was that it would be triggered
the moment the last agent finished.

## 2. Measured timeline: recorded sessions

The user's run was on another machine and its files were not available, so two sources were used: the two recorded
sessions on this machine (this section, both nested) and a live reproduction of the flat case (section 7).

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

The wake fires 2–7 ms after the last top-level agent closes, in the recorded nested sessions and in four live flat
runs (section 7). The repo adds no latency. The perceived delay is model turns:

- In the nested setup only, each parent takes one more LLM turn after its children finish, to write its own result. It
  stays `running` during that turn, so its batch cannot settle: about 5–7 s.
- After the wake, the main session takes its own LLM turn: 4.6–14.7 s across the live flat runs, 3.5–5 s in the
  recorded sessions. Its thinking block is hidden and the wake message is hidden (`display: false`), so nothing
  appears in the transcript until the answer does. Only the working indicator shows. In one live run the model read
  an agent log before answering, which added a second model call; in another, the provider streamed nothing for 12 s
  after `message_start`.

Confidence: high for this machine, where every step is measured. The user's own session files were not read, so a
machine-specific cause there (section 8) is not excluded.

Not ruled out: `worktree: true` agents (teardown is awaited before the
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

## 7. Live reproduction: flat batch of 5

Four runs on this machine, repo HEAD `c565b0e`, pi 1.4.0, the extensions loaded through the `packages` entry in
`~/.pi/agent/settings.json` as in normal use. Three runs drove `pi --mode rpc` from a script that kept stdin open past
the first turn; the fourth ran the interactive TUI under a pseudo-terminal. Prompt: spawn 5 `shell` agents in the
background in one batch, each running `date`, end the turn without waiting, reply with the five times when woken.
Every batch was flat (5 `shell` agents, caller `main`, depth 2) and the main session was idle before the last agent
ended in every run, so `deliver` took the idle branch (`host.ts:152-187`); nothing was held and the 100 ms poll never
ran.

| | Run 1 (rpc) | Run 2 (rpc) | Run 3 (rpc) | Run 4 (TUI) |
|---|---|---|---|---|
| Main idle before last agent ended | 9.2 s | 34.8 s | 2.7 s | 7.7 s |
| Last agent `endedAt` → `pi-subagents:wake` | **7 ms** | **6 ms** | **6 ms** | **7 ms** |
| Wake → assistant `message_start` | 2.5 s | 1.6 s | 1.5 s | n/a |
| Wake → first streamed text or thinking | 3.8 s | 3.1 s | 13.6 s | n/a |
| Wake → final answer | 4.8 s | 10.9 s | 14.7 s | 4.6 s |

Each agent's `endedAt` came 2–5 ms after its last assistant entry. Neither the adapter nor the extension has a debug
log; the figures come from the rpc event stream and the session files. The scratch drivers and an analyzer that
reads any session folder plus an rpc log were kept outside the repo.

## 8. Diagnosing the original run on the other machine

The extension's share of the delay is the `pi-subagents:wake` entry's timestamp minus the latest `endedAt` across
`agents/*/manifest.json`; the model's share is the next assistant entry minus the wake. Files needed:

- the main session jsonl under `~/.pi/agent/sessions/<cwd key>/`, and its `<session id>/agents/` folder (manifests,
  agent jsonl files, `result.md`);
- `~/.pi/agent/settings.json`, `~/.pi/agent/pi-subagents.json`, any `.pi/settings.json`, `.pi/pi-subagents.json` and
  `.pi/agents/*.md` in the project;
- `pi --version` and the commit of the extension checkout, since the wake path changed in recent commits.

Differences that could matter there: an older extension commit, `general` instead of `shell` agents (slower final
turns), a `worktree: true` agent (teardown awaited before the batch settles), or a main session that was compacting
when the agents ended (100 ms poll, never seconds).
