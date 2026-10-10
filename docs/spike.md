# Spike and smoke test results

Date: 10 October 2026. pi 1.1.0, macOS, Node 26. Script: `scripts/spike.ts` (run with `node scripts/spike.ts <dir>`, env `SPIKE_MODEL`, `SPIKE_PARTS=A,B,C`). TUI runs were driven through a pseudo-terminal (150x45, fullscreen mode) by a throwaway Python script.

## Model and spend

- The configured OpenAI auth is a ChatGPT subscription (OAuth). `gpt-5.4-mini` is rejected on that backend ("not supported when using Codex with a ChatGPT account"). All runs used `openai/gpt-6-luna` (catalog $0.10 / $0.50 per M tokens), thinking `low`.
- About 70 model requests in total (spike, smoke tests, two one-line probes). Notional cost by pi's catalog: about $0.013. Because the auth is a subscription, nothing was billed per token; usage counts against the subscription quota.
- `~/.pi/agent/settings.json` and `auth.json` were never written. Children and the SDK "main" sessions used `SettingsManager.inMemory`.

## Part A: three concurrent children through the adapter (SDK script)

`createPiRuntime().spawn()` three times in parallel (spawn took 14 ms total), each with the base prompt, tools `read, ls`, its own session dir.

| Check | Result |
|---|---|
| No interference | Pass. Each session file holds only its own task, steer and results. |
| Mid-run steer | Pass. A message sent 0.8 s after start was delivered after the running tool call, before the next request, as a user message `[message from spike] ...`. |
| Idle message | Pass. Sent to a settled child, it starts a new run (`prompt`). |
| Prompt cache on the second request | Pass. Request 2 of every child read 1536 cached tokens. |
| Cache after a steer / a later run | Intermittent. Run 1: request 3 (after the idle message) read 0 in all three children. Run 2: alpha `[0,1536,0,1536]`, beta `[0,1536,1536,0]`, gamma `[1536 x5, 3584]`. No child appended a system message or tool change after the first request (checked in the session files), so the misses are not caused by prompt or tool churn. Part C shows plain pi without the extension misses the same way after 20 s idle (`[0,1536,0]`). The ChatGPT backend's cache is best-effort. |
| `dispose()` | Pass. Bounded `session_shutdown` then `dispose`, no hang, process exits cleanly. |
| Prompt record | Pass after a fix (see deviations): the child writes `pi-subagents:prompt-record` with skills, guidelines and the first provider payload (12.9 kB). |

## Part B: main session with the extension (SDK, print mode)

The extension was loaded with `additionalExtensionPaths: [src/index.ts]` into an SDK session. The model called `run_agent` (background), ended its turn, and was woken once by `sendUserMessage` with the batch result.

- Main requests: `cacheRead` 0, 2560, 2560. The request after the wake read the cached prefix; no new system message was appended by the wake, and the orchestrator section (`subagents`) stayed in place.
- Agent directory, `manifest.json`, `result.md` and the child session file (with `parentSession`) were created under `<session>/agents/<id>/`.

## Smoke tests with the real `pi` binary

1. Print mode (`pi -p -e src/index.ts`), `run_agent` with `wait: true`, two agents, then `agent_status`: both done; the run_agent tool result carried `usage` equal to the exact sum of both child sessions ($0.0007842); `agent_status` carried none (delivered exactly once); spend and delivery entries persisted.
2. TUI, background batch of two explorers: widget below the editor showed live rows (`⠧ explorer-de49 · ... · 2 tool calls · ...`) and finish rows (`✓ ... Done (4 tool calls · 2.3k tokens · 15s)`); one wake; footer segment `main $0.001 · agents $0.001 · total $0.002 (sub)`; main request after the wake read 2560 cached tokens; `/agents <id>` opened the overlay with the collapsible prompt sections (Tab + Enter expanded `System prompt · preamble`) and the transcript; Esc closed it.
3. TUI, wake while the main session is mid-turn: the agent finished at 17:46:41 while the orchestrator ran `sleep 30`; the wake was held and delivered at 17:47:13, right after the turn ended, as a single message; the next request read the cached prefix.
4. TUI, stop from the view: an implementer ran `sleep 120`; `/agents <id>` then `x` aborted it; the manifest says `stopped` / `stopped by the user`; the orchestrator got one wake, `Batch ... finished: 1 stopped`.

## Not verified

- MCP inside children. The user has no MCP servers configured, and SDK sessions do not load pi's built-in MCP extension, so agents get no MCP tools in 0.1.
- `/reload` with running agents in the TUI (covered only by unit tests: running agents are marked failed and aborted, no wake).
- Regular (non-fullscreen) TUI mode. The view uses manual windowing in both modes, so it should behave the same, but it was not run.
- Anthropic and other providers. Cache behaviour and cost were observed on OpenAI only.
- The budget handoff with a real model (unit-tested with simulated turns; no real agent was run to 100k tokens).
- `pi install` from git or npm. Local-path install was checked with `pi install -l <path>` in a scratch project: `.pi/settings.json` got the package, and `pi -p --approve` listed `run_agent, message_agent, agent_status`. The global `settings.json` was compared before and after and is unchanged.
