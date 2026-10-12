# Pi 1.1.0: SDK, sessions, cost and caching for a subagents extension

Researched 10 October 2026 against the managed install at `~/.pi/agent/install/releases/1.1.0`. Below, `$PI` means `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works`. `$CA` means `$PI/pi-coding-agent`. References are `file:line` and point to the shipped docs, `.d.ts` files and compiled `dist/*.js`. Pi's source is not in the install, so implementation claims are taken from the compiled JS.

## Executive summary

1. **Recommendation: run agents in-process with `createAgentSession()`. Keep RPC subprocesses (`RpcClient`) as a fallback behind the adapter.** The extension can import `createAgentSession`, `SessionManager`, `SettingsManager` and `DefaultResourceLoader` directly. The extension loader maps `@earendil-works/pi-coding-agent` to the host's own bundled module instance (`$CA/dist/core/extensions/virtual-modules.js`), so there is no version skew.
2. Several `AgentSession`s can run concurrently in one process. Each has its own `Agent`, `SessionManager`, `CacheWarmer`, extension runner and provider `sessionId`, which is also the prompt-cache key. There is no TUI or session singleton. The shared state is all safe: `auth.json` uses a file lock, the file-mutation queue serialises edits to the same file across agents, and the model catalog is shared.
3. **Hazards to avoid:**
   - Never call `session.setAutoCompactionEnabled()`, `setSteeringMode()` or the RPC `set_auto_compaction` command. They write to the global `~/.pi/agent/settings.json`.
   - Child settings must come from a per-agent `SettingsManager.inMemory(...)` snapshot.
   - SDK sessions trust the project by default. Pass the parent's trust decision explicitly.
4. **Cost is never taken from the provider.** Pi computes it from catalog pricing with `calculateCost(model, usage)` (`$PI/pi-ai/dist/models.js:658`). That covers tiered prices, Anthropic 1h cache writes at 2x input, and OpenAI service-tier multipliers. It is accurate for direct Anthropic, OpenAI and Google. For OpenRouter it is an estimate at catalog price (upstream routing and fees are not seen). Subscription/OAuth spend is shown as notional "(sub)".
5. **The footer and `/session` add up four things:** every assistant `usage`, every `toolResult.usage`, every `usage` entry, and every compaction or branch-summary `usage` (`footer.js:96-114`, `agent-session.js:3383-3437`). To get the combined spend into pi's own totals, put child usage into the main session as `toolResult.usage` (the supported route) or as `usage` entries (needs a cast, because `ctx.sessionManager` is typed read-only). Otherwise render our own total with `ctx.ui.setStatus`/`setFooter` from a process-wide ledger.
6. **Context budget:** `session.getContextUsage()` returns `{tokens, contextWindow, percent}`. `tokens` is the last valid assistant usage plus estimates for the messages after it. `model.contextWindow` and `model.maxTokens` are on the `Model`. Turn auto-compaction off in each child's in-memory settings. That also turns off overflow recovery (`agent-session.js:2330-2332`). Use `session_before_compact` → `{cancel:true}` as a backstop and `steer()` a "write your handoff now" message when the budget is crossed.
7. **Caching:** pi stores the prompt and tools as transcript system messages and appends deltas. Anthropic gets `cache_control` on the system prompt, the last tool and the last user/tool-result block. For about 7 Claude models and 11 GPT models, mid-conversation prompt and tool changes are cache-safe. For every other model, any change to the prompt sections or the tool set mid-agent re-sends a collapsed head and causes a full cache miss. Inside a running agent we must therefore never change the prompt, tools, model, thinking level, earlier messages or compaction.
8. **Steer vs follow-up:** a steer is delivered after the current assistant turn's tool calls finish and before the next LLM call. A follow-up is delivered only when the agent would otherwise stop. Both are appended at the tail, so they are cache-safe. "Ask a running agent a question" maps to `steer()`. "Continue an idle agent" maps to `prompt()`.
9. **Persistence:** a child is an ordinary JSONL session file (`SessionManager.create(cwd, dir, {id, parentSession})`). With `parentSession` set, `/resume` nests it under the parent. `/resume` is not read-only, though: it makes the file the active session. Our viewer should read the file itself, and `session_before_switch` can block resuming closed agents.
10. **Why in-process beats subprocess:** shared credentials and catalog, live events with full `partial` snapshots, direct access to `getContextUsage()`/`getSessionStats()`/`systemPrompt`, cross-agent file-edit serialisation, no per-agent Node start-up, and lower memory. In exchange we lose crash and CPU isolation, and a misbehaving extension in a child shares our event loop. Subprocess is the fallback for isolation and for running agents in another cwd or version.

---

## 1. Programmatic sessions

### Creating a session
`createAgentSession(options)`, declared in `$CA/dist/core/sdk.d.ts:10-65`:

| Option | Meaning |
|---|---|
| `cwd`, `agentDir` | workspace for discovery, built-in tool paths, session grouping; config dir (default `~/.pi/agent`) |
| `modelRuntime` | model/auth runtime; **if omitted a new one is created from `auth.json`/`models.json`** (`sdk.js:75`) |
| `model: Model<any>`, `thinkingLevel` | model object (not a string); level is clamped to the model |
| `tools?: string[]`, `noTools`, `excludeTools`, `customTools: ToolDefinition[]` | allowlist (supports `*` patterns, or `+name/-name` modifiers), denylist, extra tools |
| `resourceLoader` | extensions, skills, prompts, themes, context files, system prompt (default `DefaultResourceLoader`) |
| `sessionManager` | persistence (default `SessionManager.create(cwd)`) |
| `settingsManager` | settings (default `SettingsManager.create(cwd, agentDir)`, which is file-backed) |
| `sessionStartEvent` | metadata for the `session_start` event |

There is no `systemPrompt` option. The system prompt comes from the resource loader (`systemPromptOverride`, `appendSystemPromptOverride`, `skillsOverride`, `agentsFilesOverride`; see `$CA/examples/sdk/03,04,07`) or from a `before_agent_start` handler.

```ts
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir }
  from "@earendil-works/pi-coding-agent";

const settingsManager = SettingsManager.inMemory(
  { ...parentSettingsSnapshot, compaction: { ...parentSettingsSnapshot.compaction, enabled: false } },
  { projectTrusted: ctx.isProjectTrusted() },           // SettingsManagerCreateOptions.projectTrusted (settings-manager.d.ts:168)
);
const loader = new DefaultResourceLoader({
  cwd, agentDir: getAgentDir(), settingsManager,
  appendSystemPromptOverride: (base) => [...base, baseAgentPrompt, agentAdditions],
  skillsOverride: (cur) => ({ skills: cur.skills.filter(s => agent.skills.includes(s.name)), diagnostics: cur.diagnostics }),
  extensionsOverride: (r) => filterOutOurOwnFileExtension(r),
  extensionFactories: [childRuntimeExtension({ depth, agentId, ledger })],   // inline, closure-scoped
});
await loader.reload();
const { session } = await createAgentSession({
  cwd, model, thinkingLevel, resourceLoader: loader, settingsManager,
  modelRuntime,                                           // share one runtime (see risks)
  sessionManager: SessionManager.create(cwd, agentSessionDir, { id: agentId, parentSession: parentFile }),
  tools: agent.tools, excludeTools: depth >= maxDepth ? ["agent_*"] : undefined,
});
await session.bindExtensions({});   // emits session_start to the child's extensions (sdk example 14)
```

### Prompt, events, abort, steer, dispose
These are from `$CA/dist/core/agent-session.d.ts` and `docs/sdk.md:62-94`.

- `prompt(text, {images, streamingBehavior, expandPromptTemplates, source})` (`d.ts:534`). It resolves when the run finishes, including retries. While the agent is streaming it **throws unless** `streamingBehavior: "steer" | "followUp"` is passed (`sdk.md:66`). For a background agent, do not await it on the caller's path. Track completion with `agent_settled` instead.
- `subscribe(listener)` returns an unsubscribe function (`d.ts:379`). The events, in the `AgentSessionEvent` union at `d.ts:47-109` plus the core `AgentEvent`:
  - `agent_start` and `turn_start`
  - `message_start`, `message_update` and `message_end`. `message_update` carries `assistantMessageEvent` with `text_delta`, `thinking_delta`, `toolcall_start/delta/end`, plus cumulative `partial` snapshots in-process.
  - `tool_execution_start/update/end`. These carry `parentToolCallId` for nested calls.
  - `turn_end` and `agent_end {messages, willRetry}`
  - **`agent_settled {aborted}`**, which means pi will not continue automatically
  - `queue_update {steering, followUp}`
  - `compaction_start/end`, `auto_retry_start/end`, `entry_appended` and `thinking_level_changed`
- `message_end` carries the authoritative message. `agent_end` is not the end of the work, because retries, overflow recovery or queued messages can still follow (`sdk.md:92-94`, `json.md:48`).
- `abort()` aborts and waits for idle (`d.ts:635`). `waitForIdle()` waits without aborting. `clearQueue()` returns the queued texts.
- `steer(text)` and `followUp(text)` return `"queued" | "handled"` (`d.ts:555-568`). `sendUserMessage(content, {deliverAs})` and `sendCustomMessage(msg, {triggerTurn, deliverAs: "steer"|"followUp"|"nextTurn"})` are also available (`d.ts:594-615`).
- `dispose()` (`agent-session.js:992-1011`) aborts retry, compaction, bash and the agent. It then invalidates the extension context, disconnects, drops listeners, cancels the cache warmer and calls `cleanupSessionResources(sessionId)`.
- Read access: `session.messages`, `state`, `model`, `thinkingLevel`, `systemPrompt`, `getActiveToolNames()`, `getAllTools()`, `getSessionStats()`, `getContextUsage()`, `sessionFile`, `sessionId`, `isStreaming`, `isIdle`, `getLastAssistantText()`.

### Concurrency and singletons
- Each `createAgentSession` builds its own `Agent` with `sessionId: sessionManager.getSessionId()` (`sdk.js:277`), its own `CacheWarmer` (`sdk.js:192`), extension runner and tool registry. Nothing in `AgentSession` refers to a process-wide "current session".
- The module-level state I found is all benign:
  - `setDefaultStreamFn(streamSimple)` (`sdk.js:24`) is idempotent.
  - `fileMutationQueues` (`core/tools/file-mutation-queue.js:3`) is shared, which serialises `edit`/`write` to the same path across all agents. This helps us.
  - `extensionCache` (`extensions/loader.js:88`) caches factories by path, so our extension factory runs once per child session. The factory must not assume it is a singleton.
  - `commandResultCache` caches `!command` API keys.
- **Settings:** `SettingsManager.create()` is file-backed and its setters persist globally. `setCompactionEnabled` → `save()` writes `~/.pi/agent/settings.json` (`settings-manager.js:474-485, 624-631`), and `AgentSession.setAutoCompactionEnabled` calls it (`agent-session.js:2591-2593`). `applyOverrides()` (`:389`) is memory-only, but any later `save()` recomputes `settings` from global+project and silently drops the overrides (`:475`). **So each child gets a `SettingsManager.inMemory(snapshot)`.** `pi.getSettings()` returns the effective merged snapshot.
- **Auth:** `auth.json` access uses `proper-lockfile` (`core/auth-storage.js:7,33-151`), so several runtimes or processes are safe.
- **Model runtime:** extensions only see `ctx.modelRegistry`, a facade over a **private** `runtime` field (`model-registry.d.ts:21-23`, `model-registry.js:8-9`). We can either:
  - create one `ModelRuntime.create()` per extension instance and share it across children; it will not contain providers or virtual models registered by other extensions unless the children load those extensions, or
  - reach the host's runtime with `(ctx.modelRegistry as any).runtime`, which is unsupported.
- **TUI:** children are not bound to a UI. The default `_extensionMode` is `"print"` (`agent-session.js:156`) and `ctx.hasUI` is false. Extensions in a child cannot open dialogs, and the main TUI is unaffected.
- **MCP, codemode and tool_search:** these are CLI built-in extensions. **SDK sessions do not load them** (`sdk.md:116`). If an agent needs MCP, add `createMcpExtension()` to the child loader. Each child then opens its own MCP connections.

## 2. Creating child sessions from inside a running pi (extension)

- `ExtensionAPI` (`extensions/types.d.ts:1162-1383`) has **no** `createAgentSession` or child-session method. `ExtensionCommandContext.newSession/fork/switchSession` (`:286-323`) **replace** the active session and are command-only. They are not suitable for agents.
- **Importing the package works and gives the host's own instance.** For the bundled Node install (this one), the loader uses jiti with `virtualModules` (`extensions/loader.js:466-476`). `VIRTUAL_MODULES` maps `@earendil-works/pi-coding-agent` to `../../index.js` of the running bundle, alongside `pi-agent-core`, `pi-ai` (compat entry), `pi-tui` and `typebox` (`virtual-modules.js`, "Extensions can therefore import from @earendil-works/pi-coding-agent"). Unbundled builds use `alias` to the same `dist/index.js` (`loader.js:37-84`).
- The package should declare `@earendil-works/pi-coding-agent` as a `peerDependency`/`devDependency` for types only. At runtime the import always resolves to the host's copy.
- The `index.d.ts` exports include `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionServices`, `SessionManager`, `SettingsManager`, `ModelRuntime`, `DefaultResourceLoader`, `RpcClient`, `formatSkillsForPrompt`, `loadSkills`, `convertToLlm`, `serializeConversation`, `calculateContextTokens`, `estimateTokens`, `buildSessionContext` and `parseSessionEntries` (`$CA/dist/index.d.ts:6-35`).
- **Prior art:** the shipped example `$CA/examples/extensions/subagent/index.ts` uses a **subprocess** per agent: `pi --mode json -p --no-session --model … --tools … --append-system-prompt <tmpfile> "Task: …"` (`:300-341`). It reconstructs usage from `message_end` (`:362-381`). It does **not** return `usage` on its tool result, so the spend never reaches pi's own footer total.

## 3. Session persistence

- **Format** (`docs/session-format.md`): JSONL, version 3.
  - Line 1 is a header: `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}` (`:64-76`).
  - Every other line is an entry `{type,id,parentId,timestamp,…}` forming a tree. The leaf is the active branch.
  - Entry types:
    - `message`, holding an `AgentMessage`. This includes **`role:"system"` messages that persist the prompt sections and `toolsAdded/toolsRemoved`**. The first request records the full prompt and tools, and later changes are patches (`:80-87`).
    - `model_change` and `thinking_level_change`
    - `usage`, for non-context billed usage such as `cache_warm`. It counts toward totals and is hidden from the tree (`:113-121`).
    - `compaction`, which includes a full system checkpoint
    - `context_edit` and `branch_summary`
    - `custom`, which is extension state and **not** sent to the LLM
    - `custom_message`, which **is** sent to the LLM as user content
    - `label` and `session_info`, which holds the name
- **Location:** `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<id>.jsonl` (`session-format.md:10-14`). It can be overridden with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting (`sessions.md:50`).
- **When the file is written:** it is created lazily, only once a user or assistant message exists. After that, each entry is appended synchronously with `appendFileSync` (`session-manager.js:785-813`). A crash loses at most the in-flight message.
- **Child session in its own file or directory** (`session-manager.d.ts:13-16, 371-394`):
  - `SessionManager.create(cwd, sessionDir?, { id?, parentSession? })`. A custom `sessionDir` is used as given, without the cwd encoding (`examples/sdk/11-sessions.ts:700-706`).
  - `SessionManager.open(path)` and `SessionManager.inMemory(cwd)`.
  - `SessionManager.forkFrom(sourcePath, cwd, dir, opts)`.
  - `SessionManager.list(cwd, dir)`.
- **Viewing:**
  - `/resume` and `pi --resume` show a picker that builds a **tree by `parentSessionPath`** (`modes/interactive/components/session-selector.js:164-200`). Children written to the *default* dir with `parentSession` set nest under the parent. Children in a custom dir do not appear.
  - Resuming is **not read-only**: it switches the active session, which can then be prompted. An extension can veto it with `session_before_switch` (`types.d.ts:576-580`, `{cancel:true}`) when `targetSessionFile` is a closed agent.
  - For read-only inspection: render the JSONL ourselves (`parseSessionEntries`, `buildSessionContext`), use `pi --export <file> [out.html]` (`cli.md:49`), or use `session.exportToHtml()`. A closed session file stays on disk and can be viewed at any time.

## 4. Usage and cost

**Usage shape** (`docs/message-types.md:71-90`):
```ts
interface Usage { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens;
  cost: { input; output; cacheRead; cacheWrite; total } }   // reasoning ⊂ output; cacheWrite1h ⊂ cacheWrite
```
Assistant messages always carry `usage`. `ToolResultMessage.usage?` reports nested model work done by a tool and **counts toward session totals** (`message-types.md:177`; `extensions.md:136`: "If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate"). Nested `ctx.executeTool` usage is added up automatically (`extensions.md:148`).

**Cost is computed by pi, not reported by the provider.** Every adapter normalises tokens and then calls `calculateCost(model, usage)` (`$PI/pi-ai/dist/models.js:658-677`):
```js
usage.cost.input = rates.input/1e6*usage.input; usage.cost.output = rates.output/1e6*usage.output;
usage.cost.cacheRead = rates.cacheRead/1e6*usage.cacheRead;
usage.cost.cacheWrite = (rates.cacheWrite*shortWrite + rates.input*2*longWrite)/1e6;  // Anthropic 1h = 2x input
```
`rates` takes the highest matching `model.cost.tiers[].inputTokensAbove`, based on input + cacheRead + cacheWrite. Prices are in USD per million tokens and come from the bundled or refreshed catalog (`pi update --models`) or from `models.json`/`modelOverrides`.

How accurate this is by provider:

| Provider | Token source | Accuracy notes |
|---|---|---|
| Anthropic | `cache_creation_input_tokens`, `ephemeral_1h_input_tokens` (`anthropic-messages.js:465-470, 633-650`) | Exact to list price, including 1h writes and tiers. Under OAuth/subscription the cost is notional and the footer shows "(sub)" (`footer.js:162-168`). |
| OpenAI Responses | `input_tokens − cached − cache_write`, reasoning ⊂ output (`openai-responses-shared.js:440-460`) | Exact, plus a service-tier multiplier (`openai-responses.js:304-313`) |
| OpenAI-compatible / OpenRouter | `prompt_tokens_details.cached_tokens`, `cache_write_tokens` (`openai-completions.js:1163-1191`) | **Catalog-price estimate**. OpenRouter's real per-provider price, BYOK or other fees and any `usage.cost` it returns are ignored. |
| Google | `promptTokenCount − cachedContentTokenCount`, thoughts ⊂ output (`google-generative-ai.js:171-185`) | Exact to list price, including tiers |
| Local or custom models without prices | — | `$0` |

**How the footer adds it up** (`$CA/dist/modes/interactive/components/footer.js:96-118, 151-168`). It scans **all** session entries, including compacted-away history:
```js
for (const entry of sessionManager.getEntries()) {
  if (entry.type === "usage") add(entry.usage);
  else if (entry.type==="message" && entry.message.role==="assistant") add(entry.message.usage);
  else if (entry.type==="message" && entry.message.role==="toolResult" && entry.message.usage) add(entry.message.usage);
  else if ((entry.type==="branch_summary"||entry.type==="compaction") && entry.usage) add(entry.usage);
}  // addUsageToTotals sums cost.total (core/usage-totals.js:10-16)
```
`AgentSession.getSessionStats()` (`agent-session.js:3383-3437`) and RPC `get_session_stats` use the same rule. `/session` adds a per-model breakdown (`getUsageCostBreakdown`).

**Reading the totals:**
- **Main session from an extension:** recompute from `ctx.sessionManager.getEntries()` using the rule above. `FooterDataProvider` says token stats come from there (`footer-data-provider.d.ts:11-13`). There is no `getSessionStats` on the context.
- **Child (in-process):** use `child.getSessionStats().cost` / `.tokens`, or accumulate `message_end` assistant usage live. Include `usage` entries: cache warming in the child writes them.
- **Child (subprocess):** use RPC `get_session_stats` (`rpc-commands.md:327-368`), or add up `message_end` usage from the JSON stream.

**Making the combined spend appear in pi's own footer.** There are three options:
- (a) **Supported:** give a model-visible tool result `usage` = the children's spend. The tool could be the one that delivers a batch result, or `agent_status`. pi adds it to the main session's totals and `/session`.
- (b) Append `usage` entries to the main session (`SessionManager.appendUsage(kind, provider, model, usage)`, `session-manager.d.ts:269`). They contribute to totals, get a per-model breakdown and never enter the LLM context. However, `ctx.sessionManager` is typed `ReadonlySessionManager` (`:178`), so this needs a cast. It is a private-API risk.
- (c) Leave pi's totals alone. Show `main + Σ agents` with `ctx.ui.setStatus(key, text)` or replace the footer with `ctx.ui.setFooter(factory)` (`types.d.ts:83,105-111`), fed by a process-wide ledger.

Whatever we choose, nested agents must add each assistant message exactly once, typically keyed by session id and entry id in one ledger, so nesting cannot double-count.

**Context-window usage, for the budget.** `session.getContextUsage()` and `ctx.getContextUsage()` return `ContextUsage {tokens|null, contextWindow, percent|null}` (`types.d.ts:197-203`). The implementation (`agent-session.js:3438-3472`):
- takes `contextWindow` from the model that produced the latest response (the physical model under virtual routing);
- sets `tokens` to the last valid assistant usage (`calculateContextTokens` = `totalTokens || input+output+cacheRead+cacheWrite`, `compaction.js:65-67`) plus `estimateTokens` (about chars/4) for the messages after it;
- returns `null` after a compaction until the next response.

The footer shows this percentage, coloured above 70% and 90% (`footer.js:170-182`).

## 5. Models

- `Model` (`$PI/pi-ai/dist/types.d.ts:930-952`) has these fields: `id`, `provider`, `api`, `contextWindow`, `maxTokens`, `cost {input,output,cacheRead,cacheWrite,tiers?}`, `promptCache? {short,long}` in seconds, `reasoning`, `thinkingLevelMap` and `compat`.
- **Getting the current model:** `session.model` / `ctx.model`; under virtual routing use `session.routedModel` (`agent-session.d.ts:396-403`).
- Catalog examples: Claude Opus 4.5 has 200k context and Sonnet 4.5/Opus 4.6+ have 1M. GPT-5.x/6 have 272k, except 5.4-mini at 400k (`pi-ai/dist/providers/data/*.json`). **A budget expressed as a fraction of `contextWindow` therefore varies a lot.** "About 100k" must be `min(configured, contextWindow − reserve)`.
- **Picking a model per agent from `"provider/id"`:** split on the **first** `/`, because ids can contain `/` (for example OpenRouter `anthropic/claude-…`). Then call `ctx.modelRegistry.find(provider, id)` or `modelRuntime.getModel(provider, id)`, and check `hasConfiguredAuth`. Fuzzy CLI-style patterns are handled by `resolveCliModel({cliModel, cliThinking, modelRuntime})`, which accepts `pattern:thinking` (`model-resolver.d.ts:80-92`). Pass the result as `createAgentSession({model})`.
- **Virtual models** (`docs/virtual-models.md`): a router picks a physical model and level for each request. Assistant messages record the physical model, so cost uses physical prices. Context limits come from the physical model of the latest response (`:29`). Switching the physical model between turns loses the cache. A good router returns `previous` for `continuation` and `failed` for `retry` (`:84`).
- **Thinking level** is per session. Use `createAgentSession({thinkingLevel})`, or `session.setThinkingLevel(level)`, which is recorded as a `thinking_level_change` entry and persisted globally only with `{persist:true}` (`agent-session.d.ts:661`). It is clamped to the model. Defaults come from `defaultThinkingLevel` or `modelThinkingLevels["provider/id"]` (`settings.md:13-14`).

## 6. Compaction

- **Trigger:** `contextTokens > contextWindow − reserveTokens`, with a default reserve of 16384 and default `keepRecentTokens` of 20000 (`compaction.md:27-45`). Pi checks between turns after tool results, before a new prompt, and on provider overflow or an early `length` stop (one compact-and-retry).
- **Disabling it for a child:** use child settings `compaction.enabled=false`. `_checkCompaction` returns early when disabled, which also skips overflow recovery (`agent-session.js:2330-2332`). An overflow then ends the run with `stopReason:"error"`, so the budget must fire well before the window is full. **Do not** use `session.setAutoCompactionEnabled(false)` or RPC `set_auto_compaction`, because both persist to global settings.
- **Hooks** (`compaction.md:292-383`, `types.d.ts:587-622`):
  - `session_before_compact {preparation, branchEntries, reason: "manual"|"threshold"|"overflow", willRetry, signal}` → `{cancel:true}` or `{compaction:{summary, firstKeptEntryId, tokensBefore, usage?, details?}}`
  - `session_compact` and `session_compact_failed`
  - `compaction_start/end` session events
- **Hard-budget pattern:** in the child's inline extension, on `turn_end` (or `message_end` of the assistant), read `getContextUsage().tokens`. Past the soft line, `steer()` a "stop and write the handoff to <path>" message, which arrives after the current tool calls. Past the hard line, `abort()`. `turn_end`/`agent_before_settle` can also return `{entries:[custom_message…], continue:true}` to force exactly one more request (`types.d.ts:762-775`, `extensions.md:117`). Add `session_before_compact → {cancel:true}` as a backstop.

## 7. Prompt caching

**What pi does to keep the prefix stable:**
- The prompt is built from ordered named sections, rendered as `<name>…</name>` (`core/system-prompt.js:68-121`), in this order: `preamble` (default text, or SYSTEM.md/`customPrompt`), `tools` (one-line snippets of active tools), `rules` (guidelines), `docs`, `addendum` (APPEND_SYSTEM.md / `appendSystemPrompt`), `project_context` (AGENTS.md/CLAUDE.md files), `skills` (only if `read` or `bash` is declared), `cwd`, and then custom extension `sections`. There is **no date or time** in the prompt.
- The prompt and tool loadout are persisted as transcript `system` messages. Later changes are appended as **section patches** and `toolsAdded/toolsRemoved` (`session-format.md:80-87`; `pi-ai/README.md:1570-1601`).
- Models with `compat.supportsMidConvoSystemMessages` receive patches in place, and the prefix stays cached. In the 1.1.0 catalog that means Anthropic `claude-fable-5*`, `haiku-5-5`, `opus-4-8`, `opus-5`, `opus-5-5`, `sonnet-5-5`, and OpenAI `gpt-5.4*`, `gpt-5.5`, `gpt-5.6-*`, `gpt-6*`.
- Anthropic models that also have `supportsMidConvoToolChanges` send tool changes as `tool_addition/tool_removal` blocks with a fixed top-level tool list. **Every other model gets `collapseSystemMessages()`, a new leading system prompt and tool list, which means a full cache miss.** This includes `claude-sonnet-4-5/4-6/5`, `opus-4-5..4-7`, `haiku-4-5` and all Google models.
- **Anthropic `cache_control`** (`pi-ai/dist/api/anthropic-messages.js`):
  - `{type:"ephemeral"}`, with `ttl:"1h"` when retention is `long` (`PI_CACHE_RETENTION=long` or `cacheRetention`) (`:22-39`)
  - placed on the system text block (`:886-910`), on the **last tool** (`:1282`) and on the **last user/system/tool-result block** (`:1176-1200`)
  - under OAuth, an extra fixed "You are Claude Code…" system block comes first
- **OpenAI-style providers:** `sessionId` is sent as `prompt_cache_key`/session affinity (`pi-ai/README.md:1407-1433`). Each child has its own `sessionId`, which is good.
- **Cache warming** (`settings.md:19-21`, `core/cache-warmer.d.ts`): `cacheWarming: "streaming"` (default) or `"idle"` re-sends the last request with 1 output token before the TTL expires, when the expected saving is at least $0.05. Its cost is recorded as `usage` entries of kind `cache_warm`, so include them. A main session that sits idle while background agents run only stays warm in `"idle"` mode.
- **`showCacheMissNotices`** (default `false`, `settings.md:18`) shows transcript notices for significant cache misses (`core/cache-stats.d.ts`: missed tokens, cost, idle gap, model change), cache warming, compaction usage and provider recovery. Enable it while developing to verify that agents never miss.

**Operations our extension must never do inside a running agent** (child or main):
1. Change prompt sections. This covers mutating `systemPromptOptions` in `before_agent_start` differently from run to run, changing `appendSystemPrompt`, AGENTS.md or skills mid-agent, and calling `reload()`. `before_agent_start` runs on **every** `prompt()`, so its output must be deterministic for an agent.
2. Return `systemPrompt` from `before_agent_start` (a forced prompt), or use `context_with_system` / `before_provider_request` to rewrite the head.
3. Change the active tool set (`setActiveTools`, `setActiveToolsByName`, registering a new `direct` tool, `tool_search` activation, MCP servers connecting late) or change tool descriptions. Fix the tool loadout before the first request. Register every tool up front, and pick the depth-limited set with `excludeTools` at creation.
4. Change the model (`setModel`, `cycleModel`, a virtual router switching) or the thinking level. Anthropic budget-based thinking keys the cache on `budget_tokens` (`cache-warmer.d.ts:14-20`).
5. Edit or drop earlier messages: `context` handlers that transform history, `context_edit` entries, `navigateTree`/branching, compaction (manual or auto) and branch summaries.
6. Insert anything other than at the tail. Steer, follow-up, `sendMessage` and custom messages are appended at the end and are safe. `custom` entries and `usage` entries are not context and are safe.
7. Leave an agent idle longer than the TTL (300 s short / 3600 s long for Anthropic) without warming, if it will be resumed.
8. Re-encode images or change `images.blockImages` mid-agent.

## 8. Headless fallback: print, JSON and RPC

- **`pi -p` / `--print`:** prints only the final text.
- **`pi --mode json "prompt"`:** a header line, then JSONL session events, then exit. It cannot accept follow-ups. `message_update` lines contain deltas only (`json.md:70-99`).
- **`pi --mode rpc`:** long-lived. Commands on stdin are `prompt` (with `streamingBehavior`), `steer`, `follow_up`, `abort`, `clear_queue`, `get_state`, `get_messages`, `get_session_stats`, `set_model`, `set_thinking_level`, `compact`, `get_entries` and `export_html` (`rpc-commands.md`). Responses and events go to stdout. Use **`RpcClient`** (exported) for `start/stop/onEvent/prompt/steer/followUp/abort/getSessionStats/getMessages/waitForIdle/promptAndWait` (`modes/rpc/rpc-client.d.ts:14-247`).
- Framing rule: split on LF only. Do not use Node `readline` (`json.md:15-19`).
- **Useful flags:** `--model provider/id[:thinking]`, `--thinking`, `--tools a,b`, `--exclude-tools`, `--append-system-prompt <text|path>`, `--system-prompt`, `--session-dir`, `--session-id`, `--no-session`, `-e <ext>`, `--no-extensions`, `--no-skills`, `--skill <path>`, `-nc` (no context files) and `--no-mcp` (`cli.md`). Launch it the way the example does (`subagent/index.ts:249-263`: `process.execPath` + `process.argv[1]`).
- **Disabling compaction in a subprocess:** there is no per-process settings flag. Load a tiny `-e budget-guard.ts` that returns `{cancel:true}` from `session_before_compact` and enforces the budget. **Not** `set_auto_compaction`, which persists globally.

**Pros of a subprocess:** crash, memory and CPU isolation; a hard kill; can run another pi version or cwd; mirrors the shipped example.

**Cons of a subprocess:**
- about 1 Node start-up and full resource discovery per agent;
- no shared file-mutation queue, so parallel agents can clobber the same file;
- events are delta-only and come over a pipe;
- `systemPrompt` and tools must be fetched via `get_messages` or the session file;
- no `ctx.ui` in children, beyond the RPC extension-UI subprotocol;
- each process refreshes OAuth separately, though it is lock-safe;
- every agent loads all user extensions unless `--no-extensions`.

## 9. Steering vs follow-up

- **Steer:** queued while the agent runs. It is delivered **after the current assistant message's tool calls complete, before the next LLM call** (`rpc-commands.md:46-48`, `agent-core/README.md:385-422`).
- **Follow-up:** delivered **only when the agent has no more tool calls or steering**, that is, when it would otherwise stop.
- `steeringMode` / `followUpMode` are `"one-at-a-time"` (default) or `"all"` (`settings.md:29-30`). Read them from settings. The setters persist globally.
- `prompt()` while streaming requires `streamingBehavior`, otherwise it throws.
- Extension commands (`/x`) are rejected by `steer`/`followUp`.
- Aborting returns queued messages to the caller (`clearQueue()`), and `abort` also continues remaining queued messages (`rpc-commands.md:128`).
- **Mapping to our UX:**
  - "Ask a running agent a question" → `steer(question)`. The answer arrives at the next turn.
  - "Continue an idle agent" or "question during the post-stop grace delay" → `prompt(text)`.
  - "Queue work for after it's done" → `followUp`.
  - Waking the caller when a batch is done → `pi.sendMessage({customType, content, display}, {triggerTurn:true, deliverAs: isStreaming ? "followUp" : undefined})` or `pi.sendUserMessage`. Both append at the tail and are cache-safe.

## 10. Skills, prompt templates and the effective system prompt

- **Skill discovery** (`docs/skills.md:43-63`):
  - `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, `.agents/skills/` (walking up to the repo root), plus `settings.skills` and packages
  - directories with `SKILL.md`, discovered recursively
  - only name, description and path go into the prompt; the model reads `SKILL.md` on demand
  - `disable-model-invocation: true` hides a skill from the prompt; `/skill:name args` expands it explicitly
- **Per-agent skill subset:** `DefaultResourceLoader({ skillsOverride: cur => ({skills: cur.skills.filter(...), diagnostics}) })` (`examples/sdk/04-skills.ts`), or `noSkills: true` + `additionalSkillPaths`. The `skills` section is **omitted unless `read` or `bash` is a declared tool** (`system-prompt.js:102-109`).
- **Prompt templates:** `.md` files in `~/.pi/agent/prompts/` and `.pi/prompts/`, expanded by `prompt()` before the agent sees them (`docs/prompt-templates.md`). Per agent: `promptsOverride` / `noPromptTemplates`.
- **Prompt assembly:** see section 7. Watch out for one thing. **`systemPromptOverride` / SYSTEM.md replace the `preamble` and also drop the `tools`, `rules` and `docs` sections** (`system-prompt.js:78-96`). To keep pi's tool list and guidelines and still add our base prompt and per-agent prompt, use `appendSystemPromptOverride` (the `addendum` section), or add custom `sections` in a `before_agent_start` handler. `agentsFilesOverride` / `noContextFiles` control AGENTS.md.
- **Reproducing the full effective prompt:**
  - (1) `session.systemPrompt` (rendered exactly as the transcript replays it, `agent-session.js:1057-1059`) plus `session.getAllTools()` / `getActiveToolNames()` (names, descriptions, JSON schemas, `promptGuidelines`). In an extension use `ctx.getSystemPrompt()`; command contexts also have `getSystemPromptOptions()` for the structured inputs.
  - (2) The authoritative record is the session file's `role:"system"` messages, replayed with pi-ai `getCurrentSystemPrompt(messages)` / `getCurrentTools(messages)`.
  - (3) Byte-exact capture of what was sent: a `before_provider_request` handler in the child's inline extension that stores `payload`. Use this because forced prompts are projected and not recorded (`agent-session.d.ts:497-513`), and because `context_with_system`, `before_provider_request`, OAuth identity blocks and hidden declarations can all differ from (1) and (2).

---

## Risks and unknowns

1. **Private or unstable APIs:**
   - reaching the host `ModelRuntime` (`(ctx.modelRegistry as any).runtime`)
   - appending `usage` entries through the read-only-typed `ctx.sessionManager`
   - `AgentSession` internals

   All of these must stay inside the adapter. The docs say "pi's API still changes", and 1.1.0 already renamed packages (`@mariozechner` → `@earendil-works`).
2. **A separate `ModelRuntime` per extension** will not see providers or virtual models that other extensions registered on the host, unless children load the same extensions. Sharing the host runtime means child extensions re-register providers on it, with unknown side effects on dispose or reload.
3. **Recursive extension loading:** `DefaultResourceLoader` in a child discovers *all* user and project extensions, including ours and any footer, UI or permission extensions. Without `ctx.hasUI`, permission-gate extensions may block or fail differently. Filter with `extensionsOverride` and inject ours inline with depth context. The start-up cost of `loader.reload()` per child has not been measured.
4. **Project trust:** SDK `SettingsManager` defaults to `projectTrusted: true`. We must pass the parent's `ctx.isProjectTrusted()`, or a child could load untrusted project extensions or skills.
5. **Settings writes:** the setters (`setAutoCompactionEnabled`, `setSteeringMode`, `setFollowUpMode`, `setCacheWarmingMode`, `setModel/ThinkingLevel({persist:true})`) write to global settings. `applyOverrides` is lost on any `save()`. Use only `SettingsManager.inMemory` for children.
6. **Cost accuracy:** OpenRouter and other aggregators are catalog-price estimates. Subscription and OAuth usage is notional. Catalog prices can lag provider changes until `pi update --models`. Unknown-price models count as $0. The footer should label estimated or subscription totals.
7. **Budget vs overflow:** with compaction disabled, a context overflow ends the agent with an error and no recovery. The budget check runs after a turn, and one turn of large tool output (for example a big `read`) can overshoot. Cap tool output and leave headroom of at least `maxTokens` plus the largest expected tool result.
8. **Cache safety depends on the model:** on models without `supportsMidConvoSystemMessages` (many current Claude Sonnet/Opus 4.x, all Google models), *any* prompt or tool delta is a full miss. Our design must fix the loadout at creation, and other installed extensions might still mutate prompts per run. Turn on `showCacheMissNotices` and add a test that asserts `cacheRead > 0` on turn 2+.
9. **Event-loop sharing:** an extension doing CPU work in one child delays all agents and the TUI. Large `message_update` partial snapshots on many parallel agents could add GC pressure. Not measured.
10. **Persisting into the default session dir** puts children into `/resume` (nested under the parent). A user can then resume a "closed" agent unless we veto it with `session_before_switch`. The alternative is a custom dir, which keeps children out of pi's picker entirely.
11. **Unverified at runtime:** everything above was read from docs, `.d.ts` and compiled JS. Nothing was executed.
