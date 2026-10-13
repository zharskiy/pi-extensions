# Subagent input: remove `needs input` or route it through the main session

Research notes, 2026-10-14. Installed pi packages: `@earendil-works/pi-coding-agent` 1.1.0 (and `pi-agent-core`, `pi-codemode`, `pi-mcp`, `pi-tui` 1.1.0). `$PCA` = `node_modules/@earendil-works/pi-coding-agent/dist`.

## Question

The user: subagents are self-sufficient, only the main session is interactive. Provisional decision (decisions.md fourth pass, spec §2 "Agents never ask", plan 01 §I.4, plan 04): delete dialog forwarding; a child's `confirm`/`select`/`input` resolve to `false`/`undefined`/`undefined`, `notify` is a no-op, the `attention` field and every `needs input` surface go; `pi needs your input` stays for main-session dialogs. Is that safe, and is it the smallest correct change?

## Evidence

### 1. What can raise a dialog inside a child today

How the child UI is built:

- `core/adapter/pi-child.ts:98-122` `silentUi` stubs every UI method; `:124-131` `childUiContext(theme, prompts)` adds `theme` and the four dialog methods, which call `prompts` or, when `prompts` is undefined, fall back to `false`/`undefined`/no-op (`:127-130`). `:297-299` binds it: `session.bindExtensions({ mode: "print", uiContext: childUiContext(ctx.ui.theme, spec.prompts) })`.
- `extensions/subagents/src/plugins/run-agent/prompts.ts:42-93` `childPromptsFor` forwards each dialog to the main `HostUi` with the title `<id> (<agent>) asks: <title>`, serialised by one queue (`:14-37`), sets `record.attention` while waiting (`:61-78`), and forwards `notify` as `<id> (<agent>): <message>` (`:89-91`). Wired in `run-agent/index.ts:58,71` and `runner.ts:594`; `attention` feeds `notifications/index.ts:54-62`, `components/agent-row.ts:126-171`, `components/agent-list.ts:26`, `agent-view/view.ts:105-106`. Tests: `test/plugins/run-agent/prompts.test.ts`, `core/test/adapter/pi-child.test.ts:202-244`.
- Side effect of binding any `uiContext`: pi wraps it (`$PCA/core/extensions/runner.js:355-367`) and `ctx.hasUI` becomes `true` (`runner.js:404-406`, `:626-628`: `hasUI` is `uiContext !== noOpUIContext`). So today, and under plan 01 §I.4, every extension in a child believes a user is present.
- pi's own non-interactive mode binds no UI at all: `$PCA/modes/print-mode.js:53` calls `bindExtensions({ mode, commandContextActions… })` without `uiContext`, so the runner uses `noOpUIContext` (`runner.js:132-157`: `select`→`undefined`, `confirm`→`false`, `input`→`undefined`, `notify` no-op, a `theme` getter) and `hasUI` is `false`. `bindExtensions` keeps `uiContext` unset when it is not passed (`$PCA/core/agent-session.js:2598-2601`). This repo's conformance test already binds a session that way (`core/test/adapter/conformance.test.ts:210,298`).

Dialog callers that exist in the installed packages, and whether a child can reach them:

| Source | Call | Reachable in a child? | Denial effect |
|---|---|---|---|
| pi core tools (`$PCA/core/tools/*`: bash, read, write, edit, grep…) | none | n/a | pi has no built-in tool permission prompt; grep for `confirm`/`select`/`input`/`permission` in `core/tools` finds nothing |
| Project trust (`$PCA/core/project-trust.js:9`) | `ui.select` | no: called from `main.js`/`cli` only; the child gets `projectTrusted` from the parent (`pi-child.ts:221-223`) | n/a |
| Built-in llama extension (`$PCA/extensions/llama/index.js:59,110,126,141`) | `select`/`confirm` | no: built-ins are added only in `main.js:451`; the child loads only codemode, tool-search and mcp (`pi-child.ts:156-169`) | n/a |
| MCP `/mcp` command, sign-in (`$PCA/extensions/mcp/index.js:927,955`) | `select`, `input` | no: slash commands run only with `expandPromptTemplates` (`agent-session.js:1526`), the child prompts with `expandPromptTemplates: false` (`pi-child.ts:359`); sign-in also refuses without UI (`mcp/index.js:938-940`) | n/a |
| MCP startup/status notes (`mcp/index.js:424, 537, 1003, 1027`) | `notify` | yes: `session_start` / `before_agent_start` of each child | today: one forwarded line per child per problem (`<id> (<agent>): MCP servers need attention…`), duplicating what the main session already reported for the same config; with a no-op: dropped. No functional effect |
| MCP `tool_call` hook (`mcp/index.js:1045-1068`) | none (waits for servers) | yes | n/a |
| codemode, tool_search (`$PCA/extensions/codemode`, `tool-search`; `pi-codemode`, `pi-mcp` dist) | none | yes | n/a |
| Third-party user extensions loaded in the child (all of the user's extensions except subagents' own `src`, `pi-child.ts:241-246`, `subagents/src/index.ts:40`) | any; the canonical shape is pi's `examples/extensions/permission-gate.ts:13-30` (a `tool_call` hook), also `confirm-destructive.ts`, `dirty-repo-guard.ts`, `git-checkpoint.ts:38`, `subagent/index.ts:538` | yes, the only real source | see Risks |

A `tool_call` hook that returns `{ block: true, reason }` turns the call into an error tool result with that reason (`$PCA/core/extensions/runner.js:957-971`, `pi-agent-core/dist/agent-loop.js:508`); the agent sees it and continues.

### 2. This repo's own extensions

- All seven extensions boot through `createPiExtension`, which returns at once inside a child (`core/adapter/pi-adapter.ts:258-260`, `insideChildSession` in `pi-scope.ts:13`). None of their dialogs can run in a child.
- session-limits' only `confirm` (`extensions/session-limits/src/limits.ts:223-233`, `/session-handoff` with busy work) is a main-session command, and the extension is active only in `tui`/`rpc` (`conversation.ts:3-6`).
- A nested `run_agent` is a custom tool built by the parent's runner (`runner.ts:593`, `pi-child.ts:280`) and uses no dialog (`run-agent/tools.ts` has no `ui` call). Its own children got forwarded prompts through the same `promptsFor`; that path goes with the forwarder.
- `agent-view/index.ts:212` `select("Open agent")` and the other `host.ui.notify` calls are main-session only.

Conclusion: in the shipped configuration nothing raises a dialog in a child. Only user-installed third-party extensions can, mostly as permission gates on `tool_call`.

### 3. Claude Code behaviour (2.1.x)

- `AskUserQuestion` is removed from every subagent, foreground or background, even when listed in `tools` (docs sub-agents, "Available tools": "The first filter removes these tools, even when listed in the `tools` field: `AskUserQuestion` …"). Subagents can never ask the user a question.
- Permission prompts: background subagents surface them in the main session. Docs sub-agents, "Run subagents in foreground or background": "When a background subagent reaches a tool call that needs permission, Claude Code surfaces the prompt in your main session and names the subagent that is asking. Approve to let the subagent continue, or press Esc to deny that one tool call without stopping the subagent." The agent's tool call waits; the agent itself is not paused otherwise.
- History (CHANGELOG.md): 2.1.20 "Changed background agents to prompt for tool permissions before launching" (pre-grant, then auto-deny anything else); 2.1.186 "Changed background subagents to surface permission prompts in the main session instead of auto-denying; the dialog shows which agent is asking, and Esc denies just that tool"; 2.1.285 "`claude -p --permission-prompt-tool`: a background subagent's permission request now goes to the prompt tool instead of being auto-denied"; 2.1.290 the prompt shows the stop-all chord.
- Auto-deny still exists as a mode: `permissionMode: dontAsk` "Auto-deny permission prompts. Explicitly allowed tools still work"; and `bypassPermissions`/`acceptEdits`/auto mode in the main conversation are inherited by subagents (docs sub-agents, "Permission modes").
- So Claude Code forwards permission prompts (not questions) because its built-in tools need permission by default; pi has no built-in permission layer (§1), so the case Claude Code solves by forwarding barely exists here.

Sources:

- https://code.claude.com/docs/en/sub-agents, sections "Available tools", "Permission modes", "Run subagents in foreground or background" (fetched 2026-10-14).
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, entries 2.1.20, 2.1.186, 2.1.285, 2.1.290.
- Local notes: `claude-code-agents-ux.md:206-207,240`, `claude-code-agent-identity.md:73`.

### 4. Child system prompt

The child prompt is pi's prompt plus `promptAppend` (`pi-child.ts:234`), filled from `extensions/subagents/prompts/base-system-prompt.md`, the agent body and the output contract (ARCHITECTURE.md "Agent definitions and prompts"). The adapter adds no prompt text of its own (it only records `promptGuidelines`/`toolGuidelines`, `pi-child.ts:69-79`), and should not: prompt wording belongs to the subagents extension. `base-system-prompt.md:3` already says "You work alone: nobody answers questions while you run", and `:6` routes real ambiguity to `Status: blocked`. Nothing tells the model what a refused confirmation looks like.

## Risks of denial defaults

| Source | What the agent sees | Acceptable? |
|---|---|---|
| Third-party `tool_call` permission gate, `hasUI` true (provisional decision as written in plan 01 §I.4) | gate asks, gets `undefined`/`false`, blocks with its "user said no" reason, e.g. `Blocked by user` (`permission-gate.ts:27-28`) | Works but lies: the model believes the user refused, and may report "the user denied X" or ask the caller to ask again. Also emits `ui_prompt_start/end` in the child (`runner.js:369-390`) for a dialog nobody sees |
| Same gate, `hasUI` false (no `uiContext` bound) | gate takes its headless branch: `Dangerous command blocked (no UI for confirmation)` (`permission-gate.ts:20-23`), the path extension authors already write for `pi -p` | Yes: honest reason, same outcome |
| Third-party tool that asks inside `execute` (`subagent/index.ts:538-545` style) | tool returns its cancel text (`Canceled: … not approved`) | Yes: tool fails, agent continues |
| Extension `select`/`input` outside tools (session hooks, `git-checkpoint.ts:38`) | nothing; the hook takes its "no" branch | Yes |
| MCP / other `notify` | nothing | Yes; main session reports the same MCP state |
| Model works around a block (e.g. rewrites `rm -rf` to dodge a gate pattern, or retries) | repeated blocked calls, or a gate bypassed | The one real risk. One prompt line covers it (Recommendation) |

No source makes the agent hang or error: every denial resolves at once, and a blocked tool call is an ordinary error result.

## Why not "make it work via the main session"

Forwarding is what `prompts.ts` does today, and it contradicts self-sufficient agents. A forwarded dialog blocks the agent's tool call for as long as the user does not answer, so a background agent silently stalls while its panel row keeps running and its context and wall clock tick. Dialogs from several agents queue serially in the one interactive surface (`prompts.ts:14-37`), so the user answers questions out of the order the work happened, for agents they did not start directly (nested ones), without the context the agent had. A modal dialog takes the main session's editor while the user may be mid-prompt or the main model mid-turn, so the "prompt is always free" goal (decisions goal 1) breaks; it also needs its own notification, row state, list subtitle, view suffix and `attention` bookkeeping (the surfaces the fourth pass removes). Claude Code accepts that cost only because its built-in tools require permission by default; pi has no such layer, so forwarding would buy almost nothing here, and the decision the agent needs belongs to its caller, which already gets `Status: blocked` results.

## Recommendation

Confirm the provisional decision (no forwarding, no `attention`, no `needs input`, main-session dialog notification only), with two small amendments:

1. **Bind no UI context in children instead of a denying one.** Call `session.bindExtensions({ mode: "print" })` exactly as pi's print mode does (`print-mode.js:53`) and delete `childUiContext` and `silentUi`.
   - pi then supplies `noOpUIContext`, with the same denial values the decision specifies (`runner.js:132-157`).
   - `ctx.hasUI` is `false`, so extensions take their documented headless branch and give honest block reasons.
   - No `ui_prompt_*` events fire in children.
   - This deletes code rather than keeping a hand-written copy of pi's no-op UI.
   - Checked: in pi core `hasUI` is read only by extensions (`runner.js:455` is interactive-only shortcut diagnostics; `project-trust.js:49` is not called for children; `mcp/index.js:938` is a command). The child loses `ctx.ui.theme` from the parent and gets pi's global theme from `noOpUIContext`; no child consumer of the theme was found (agent transcripts are rendered by the main session).
2. **One line in `extensions/subagents/prompts/base-system-prompt.md`**, after line 3: "- Nobody can approve anything while you run: confirmations are refused at once. If a tool call is blocked for lack of approval, do not retry it or work around it; finish what you can and list the blocked step in your result." No provider names; it stops retry loops and gate-dodging, and routes the need to the caller through the existing result contract.

Rejected amendments:

- A `pi-subagents:dialog-denied` entry or `✗ confirm denied` transcript line: blocked tool calls already show as error results in the agent view; dialogs outside tools have no consequence worth a surface.
- Keeping `notify` forwarded: its only real producer is MCP status, already shown in the main session.

## Changes the plans would need if the recommendation is adopted

- `plans/01-adapter-foundations.md` §I.4: replace the `childUiContext(theme)` bullet with "delete `silentUi` and `childUiContext`; spawn binds `bindExtensions({ mode: "print" })` with no `uiContext` (pi's `noOpUIContext`: same denial values, `ctx.hasUI` false)"; replace the three `childUiContext` tests with one spawn test asserting `bindExtensions` gets no `uiContext` (fake at `core/test/adapter/pi-child.test.ts:301`), and drop the `Theme`/`ExtensionUIContext` imports.
- `plans/01-adapter-foundations.md` §I.4 ARCHITECTURE.md step 4 text: "binds no UI, like pi's print mode: dialogs resolve to their denials, `notify` does nothing, `ctx.hasUI` is false".
- `plans/00-ux-spec.md` §2 "Agents never ask": change the code pointer from `childUiContext` to "the child binds no UI context (pi's no-op UI, `ctx.hasUI` false)".
- `plans/04-main-transcript.md` (agents-never-ask section): add the `base-system-prompt.md` line above, and in the README sentence (line ~394) say the denial reaches extensions as "no UI" (`ctx.hasUI` false).
- `plans/research/decisions.md` fourth pass: append "children bind no UI context (`ctx.hasUI` false) so permission gates block with their headless reason; the agent prompt says blocked approvals are not retried".
