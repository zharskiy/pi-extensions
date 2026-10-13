# Claude Code: working indicator and notifications (reference for pi)

Researched 2026-10-13 against Claude Code **2.1.296** (local binary `~/.local/share/claude/versions/2.1.296`), the official docs (code.claude.com) and the public CHANGELOG.

Evidence labels:
- **[bin]**: verbatim from the minified JS inside the Bun binary (`strings -n 6`). Minified identifiers are kept as they appear, so `isLoading`, `mode` and so on are real field names, while one- and two-letter names are minifier output.
- **[docs]**: official documentation, quoted.
- **[CL x.y.z]**: CHANGELOG entry, quoted, with the version it shipped in.

---

## Topic A: the working indicator ("spinner")

### A.1 Facts

**A1. The spinner is a single row shown only while the turn is loading. It is suppressed in specific situations.**
[bin] Visibility condition in the REPL:
```js
cg=!nd&&!Zd&&!pp&&Jc.isLoading&&!0&&!Dr&&(!cq||aw||ws||dw)
```
where:
- `Jc.isLoading` means the main conversation is busy: `mainIsBusy: Al||Zr.isMainLoopBusy||an.getMainThreadQueueLength()>0`.
- `Zd = Aj(hEo)`, with `hEo(TS){return VN(TS)!==null}` and `VN(h){return h.open.findLast((T)=>T.userInvoked!==!0&&!ZM.has(T.kind))??null}`. **The spinner is hidden while a blocking dialog is open**, such as a permission prompt or a question.
- `Dr = V(sEo)`, with `sEo(B7){return B7.pendingWorkerRequest}`. Hidden while a worker or teammate request is pending.
- `nd = nTe(toolProgress)`, with `nTo={background_hint:!1,bash_mode_progress:!0,agent_progress:!1}`. Hidden while a user `!` bash-mode command shows its own live progress. **It is NOT hidden for `agent_progress`**, so a foreground subagent keeps the spinner.
- `cq = hasDisplayedStreamingText`, `aw = tailBlank`. **The spinner is hidden while the assistant's streaming text preview is on screen** (`hasDisplayedStreamingText:h&&(E&rc)!==0`). It comes back when the preview's tail is blank, in brief mode (`ws`), or when focus mode holds the preview (`dw`). The preview is disabled under reduced motion and in Windows Terminal: `Zqn(prefersReducedMotion, l$t())`, where `l$t(){return!!a.WT_SESSION}`.

[CL 2.1.31] "Reduced layout jitter in the terminal when the spinner appears and disappears during streaming". This confirms that the spinner appears and disappears around streamed text.
[CL 2.1.257] "Fixed the working spinner stopping while a response streams behind a slash-command panel".

**A2. Phases (`mode`) come straight from stream events.**
[bin]
```js
if(e.type==="stream_request_start"){s?.("requesting");return}
...
if(e.event.type==="message_stop"){...s?.("tool-use")...}
case"content_block_start": ... case"thinking":case"redacted_thinking":s?.("thinking");return;
                               case"text":s?.("responding");return;
                               case"tool_use":{s?.("tool-input"); ...
```
- The modes are `requesting | thinking | responding | tool-input | tool-use`. After the model message ends, the mode stays `tool-use` while tools execute.
- When the loading state resets, the mode goes back to `"responding"`: `resetLoadingState=()=>{...h.main.resetOverrides(),h.main.setMode("responding")...}`.

**A3. What the row contains.** It has three parts: glyph, message (verb), and a parenthesised dim group.
[bin] Render: `e(bie,{frame…})` (the animated glyph), `e(SFt,{message:c,mode:l,…})` (the verb text), then `yt`, the dim group:
```js
Et=[...L?[suffix]:[], ...!f&&Rt?[timerText "elapsedTime"]:[],
    ...!f&&_t?[ e(mn,{mode:l}) , [tokenCount," tokens"] ]:[],
    ...!f&&lt&&rt?[thinkingText]:[]]
yt = Et.length>0 ? ( "(" … ")" ) : null
```
- **Elapsed time** appears only when `it=u||q||S||ht>0||H>io||Boolean(L)`, with `io=16000`. That means: verbose, a thinking/status text present, compacting, tokens > 0, elapsed > 16 s, or a suffix. Format `rn(ms)`, for example `1m 5s`.
- **Tokens**: `` _t=`${te.arrowDown} ${Ct} tokens` `` with an arrow chosen by phase: `case"requesting":` gives `te.arrowUp` (↑), and `tool-input`/`tool-use`/`responding`/`thinking` give `te.arrowDown` (↓). The count is an estimate (`wt=Math.round(xt/4)`, response chars / 4), animated toward the target in steps. [CL 2.1.0] "Improved token count display in spinner to include tokens from background agents" and "Fixed spinner token counter to properly accumulate tokens from subagents". [CL 2.1.47] "Fixed spinner showing "0 tokens" counter before any tokens have been received".
- **Thinking text** (`no(l)`): `"thinking"`, then `"still thinking"` (≥10 s), `"thinking more"` (≥20 s), `"thinking some more"` (≥30 s), `"deep in thought"` (≥45 s). After a thinking burst ends: `` `thought for ${Math.max(1,Math.round(l/1000))}s` `` for 2 s. While recovering from the output-token limit: `picking the thought back up (n of m)`. An effort suffix is appended while thinking: `` st=`${It}${E}` `` (effortSuffix).
- **Tool timer** (`running tool for X` / `ran tool for X`, after ≥2000 ms) only when `showToolCallTimer:at`, where `at=k("tengu_shining_fractals",!1)`. This is behind a feature flag and off by default.
- Degradation on narrow terminals: the elements drop in order (thinking text, then elapsed, then tokens) according to available width.
- **"esc to interrupt" is NOT in the spinner row** in 2.1.296. It is a footer hint below the composer, shown while loading: `function IKt(h,T,…){… return[...h?[e(n,{dimColor:!0,children:e(z,{chord:T,action:"interrupt",…})},"esc")]:[], …]}`, called as `IKt(Me,…)` with `isLoading:Me`. [CL 2.1.169] "Fixed footer hints (e.g. "esc to interrupt") not showing for users with a custom statusline". Inside the spinner area, "esc to interrupt" appears only in the API-retry banner: `` ` · next try in ${_} · attempt ${t.attempt} · esc to interrupt` ``.

**A4. Visual treatment differs per phase.**
[bin] `ia(t?null:l==="requesting"&&!S?50:100)` gives a 50 ms frame while requesting and 100 ms otherwise. The shimmer sweep moves forward while requesting and backward otherwise: `Lt=… l==="requesting"?ht%dt-le:gt+le-ht%dt`. In `tool-use` the verb pulses instead of shimmering: `At=… l==="tool-use"?oo(T):0`, with `oo(l){return SC((Math.sin(l/1000*Math.PI)+1)/2)}`.
- **Thinking ≥10 s warms to amber**: `qe()` gives `Math.min(Math.max((m-1e4)/1e4,0),1)`, blended toward the theme's `warning`. [CL 2.1.141] "the spinner now warms to amber after 10 seconds to signal Claude is still working".
- **Stall**: no new tokens for >10 s outside thinking or tools (`E>1e4&&!m`) ramps `stalledIntensity` and tints toward red `{r:171,g:43,b:63}`. Telemetry thresholds are `[1e4,45000,300000]`.
- API retry and stall replace the whole row: `"Waiting for API response" · will retry in X · check your network`, or `` ` · Retrying in ${_}… · attempt ${n}/${max}` ``.
- Compaction: the message becomes `"Compacting conversation"`. Hooks produce messages such as `"Running PreCompact hooks…"`.

**A5. The verb is chosen once per turn, at random. It does not rotate on a timer and does not change between phases.**
[bin]
- The verb list (189 entries, from "Accomplishing" to "Zigzagging", including "Pondering", "Cogitating", "Noodling", "Schlepping", "Clauding") is `var v=["Accomplishing","Actioning",…]`.
- Customisation: `function jFt(){let n=ft().spinnerVerbs;if(!n)return v;if(n.mode==="replace")return n.verbs.length>0?n.verbs:v;return[...v,...n.verbs]}`.
- Pick: `xU(jFt())` (lodash `sample`).
- Per-agent spinner state is created with `defaultVerb:xU(jFt())`. `resetOverrides()` re-rolls it: `` z(){let r=xU(jFt())??"";…defaultVerb:r} ``. That runs from `resetLoadingState` at turn boundaries.
- Message precedence: `ht=C??(dt===void 0?void 0:Kut(dt,Q))??(T||gt)`. That is, override message (hooks, compaction), else **the in-progress todo's `activeForm`/`subject`**, else the turn's random verb, else the component's own random fallback (`xU(jFt())??"Working"`).
- An ellipsis (`…`) is appended.

**A6. Rows below the spinner.**
[bin]
- A dim second row: `Next: <next pending todo>`, or `Tip: …`. Time-based tips: after 30 s `"Use /btw to ask a quick side question without interrupting Claude's current work"` (only if /btw has never been used), and after 30 min `"Use /clear to start fresh when switching topics and free up context"`.
- With the task list expanded, the todo list renders under the spinner.
- [docs] "While Claude works, Claude Code shows a one-line tip under the spinner".

**A7. Foreground subagent (Agent tool).**
[bin] `agent_progress` does not suppress the spinner (A1). The token counter includes subagent tokens ([CL 2.1.0]).
[docs] "Foreground subagents block the main conversation until complete. Permission prompts are passed through to you as they come up."
For the terminal OSC 7501 status, the engine distinguishes `subagent_running` from `turn_running`: `work:n==="tool-use"&&s?"subagent_running":"turn_running"`.

**A8. Background subagents do not drive the main spinner.**
- [bin] The spinner requires `isLoading`. When the main turn ends with background agents still running, the turn-end line reads "Waiting for N background agent(s) … to finish" instead of the "Cooked for" line: `r(n,{dimColor:!0,children:["Waiting for",re,ge,oe," to finish"]})`, where `re` is `` ` background ${ce===1?"agent":"agents"}` ``. [CL 2.1.152] "The post-response timer now shows "Waiting for N background agents/workflows to finish" … and reports the cumulative time once their results are processed".
- The footer shows a count pill: `` `${T} ${h?"bg":"background"}` `` (dense or wide). There is also a subagent panel below the prompt ([docs]: "Claude Code clears a background subagent's row from the subagent panel below the prompt input…"). After a success the footer shows `/tasks to see subagents` for 30 s ([docs]; [bin] `children:"/tasks to see subagents"`).
- [CL 2.1.212] "Changed the `←` footer hint to pulse `N done` for a moment when a background agent finishes while nothing needs your input".
- The prompt is free. [docs] "Background subagents run concurrently while you continue working."
- [docs] "A background subagent's results reach Claude as a completion notification in a later turn." [bin] a completion is queued as a `task-notification` command that the model processes, which starts a new main turn and brings the spinner back.
- The OS terminal progress bar (OSC 9;4) stays **indeterminate** while background agents are pending, even with the main session idle: `if(u||m||f)return"indeterminate";return"completed"`, where `f` is `hasPendingBackgroundWork`.

**A9. Turn-end line.**
[bin] `var Vc=["Baked","Brewed","Churned","Cogitated","Cooked","Crunched","Sautéed","Worked"]`, picked by a hash of the message (`Yc(m)`). [CL 2.1.246] example: `✻ Sautéed for 23s · done 6:05 PM`. [CL 2.1.144] custom `spinnerVerbs` do not apply here ("past-tense built-ins like "Worked for 5s" are restored there"). Setting: `showTurnDuration` (default true).

**A10. Terminal tab title** (outside the spinner, but part of "is it working").
[bin]
```js
var C6=["◐","◑"],T6="✳",Ost=960; … let je=M&&!Te?C6[Me]??T6:T6; … `${je} ${ee}`
```
While busy (`isAnimating: po==="busy"`), the glyph alternates ◐ and ◑ every 960 ms. It only advances while the terminal is focused (`Qc()` reads `isTerminalFocused`). When idle the title shows ✳. The title text is the session title, AI title, agent type or haiku title, falling back to `"Claude Code"`. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` turns it off.

### A.2 Unconfirmed or inferred
- **Exact behaviour when text starts streaming.** The code hides the spinner row while a streaming-text preview is displayed (A1), and the changelog confirms appear/disappear jitter. The nuance of `tailBlank` (the spinner re-shows while the preview's last line is still being held back) is inferred from `hideTrailingLine:m===null&&!!u` and was not observed live. Design reading: the indicator yields its row to live text and returns when text stops, for example at tool calls.
- **Separator between elements in the dim group.** The code reserves width for `" · "` (`ro=ae(" · ")`), so elements are probably joined with ` · ` inside the parentheses. The join component (`Se`) was not read.
- **Effort suffix wording** (`k7t(model, …, effort)`), for example " with high effort", was not resolved.
- Whether `defaultVerb` is re-rolled at turn start or at turn end. `resetLoadingState` is called at both boundaries in practice. Either way the verb is stable within a turn.

---

## Topic B: notifications

### B.1 Facts

**B1. Channels.**
[bin] `var tY=["auto","iterm2","terminal_bell","iterm2_with_bell","kitty","ghostty","notifications_disabled"]`. With `auto` the channel follows the terminal:
```js
case"Apple_Terminal":return await w()?"terminal_bell":"no_method_available";
case"iTerm.app":return"iterm2"; case"kitty":return"kitty"; case"ghostty":return"ghostty"; default:return"no_method_available"
```
Apple Terminal gets a bell only if the profile's bell is not off. Other terminals get nothing unless configured. Kitty and Ghostty notifications are titled `"Claude Code"` (`var p="Claude Code"`). `iterm2_with_bell` sends both OSC 9 and BEL.
Settings labels in the UI: `iTerm2 (OSC 9)`, `Terminal Bell (\a)`, `Kitty (OSC 99)`, `Ghostty (OSC 777)`, `iTerm2 w/ Bell`.
[docs] "By default Claude Code sends a desktop notification only in Ghostty, Kitty, and iTerm2." Notification hooks always run: "the `preferredNotifChannel` setting, including `notifications_disabled`, changes only how you're alerted, not whether your hook runs."

**B2. Notification types.**
[bin] `FPs=["permission_prompt","idle_prompt","auth_success","elicitation_dialog","agent_needs_input","agent_completed","elicitation_url_dialog","worker_permission_prompt","push_notification","computer_use_enter","computer_use_exit","quota_auto_resume_fired","quota_auto_resume_stale","quota_auto_resume_disabled","model_refusal_fallback","auth_storage_failure","plugin_notification"]`. The send path is `ZMr`: it runs Notification hooks (`S0`), then the configured channel.

**B3. `idle_prompt`: the only "turn finished" notification.**
[bin] The notifier class (`_$`) arms a timer when a query completes:
```js
this.#r=this.#e.clock.setTimeout(()=>{ if(this.#e.getLastInteractionTime()>M)return;
  if(this.#e.backgroundAgents.getSnapshot()){ …wait until they finish, then re-arm…; return }
  let L=this.#e.now()-M;
  if(!this.#t.isLoading&&!this.#o&&!this.#e.isDialogOnScreen()&&!this.#e.hasPendingLoopWakeup()
     &&!this.#e.hasArmedQuotaAutoResume()&&L>=this.#e.getIdleNotifThresholdMs()&&M!==this.#n)
     this.#n=M,this.#e.sendIdleNotification() }, …getIdleNotifThresholdMs())
sendIdleNotification:()=>{YD({message:"Claude is waiting for your input",notificationType:"idle_prompt"},…)}
```
- Threshold: `messageIdleNotifThresholdMs:60000` (global config default).
- It fires once per completed query (`M!==this.#n`).
- It is suppressed if the user typed or interacted after completion, if a dialog or overlay is open, if a loop wakeup or quota auto-resume is pending, or **while background agents run**. In that last case it waits for the agents and then re-arms.
- No terminal-focus check is involved. "Away" means no input since completion.
- [docs] "`idle_prompt` | Claude finished responding about 60 seconds ago and you haven't typed since". Also: "only if you haven't typed since and no background agent, such as a background subagent, is still running."
- [CL 2.1.288] "Fixed `idle_prompt` notification hooks firing while background agents are still running".
- [docs] "When Claude finishes a task or pauses for a permission prompt, and you appear to be away from the terminal, it fires a notification event."

**B4. Permission and other dialogs: 6 s after the dialog appears, if you have not typed.**
[bin] `aVt=6000`. Dialog hook:
```js
function qve(h,T,M){… Di(()=>{if(!Awo(aVt,Me))return; … YD({message:h,notificationType:T},…)}, we?null:aVt)}
function Awo(h,T){return Date.now()-Math.max(Ip(),T)>=h}   // 6 s since max(last keystroke, dialog shown)
function dW(h,T){qve(h.text,h.type??"permission_prompt",T)}
```
Texts, from the dialog registry `Yg` [bin]:
- Tool permission, computer-use and similar prompts: `nS={text:"Claude needs your permission"}`.
- `"Teammate setup needs your input"` (agent_needs_input)
- `"Auto mode has a classifier billing notice to acknowledge"`
- `"Managed settings need your review before they apply"`
- `"A sandboxed command needs network access"`
- `"An MCP server needs your input"` (elicitation_url_dialog)
- `"Claude Code wants to enter plan mode"`
- `"Claude proposed a session goal"`

The SDK-host path (Desktop or VS Code) sends the hook-only text `` `Claude needs your permission to use ${toolName}` ``, also after `aVt` (6 s), and it is not deferred by typing.
[docs] "`permission_prompt` | … and the prompt has waited about six seconds"; "The timer starts when the permission prompt appears, and each keystroke defers it." The hook input example is `"message": "Claude needs your permission", "title": "Permission needed"`.

**B5. Background work and notifications.**
- **Background Agent-tool subagents: no desktop notification when one finishes.** [bin] no `YD(...)` call is tied to subagent completion. The completion reaches the model as a task notification ([docs] "results reach Claude as a completion notification in a later turn"). The UI shows the footer `N done` pulse and the `/tasks to see subagents` hint. [CL 2.1.144] "Added elapsed duration to background subagent completion notifications (e.g. "Agent completed · 3h 2m 5s")". These are transcript notices, not OS notifications.
- **The only OS-level signal is indirect.** `idle_prompt` is held back until all background agents finish. After that (and after the model processes their results, if that starts a new turn), the 60 s idle timer runs.
- **`agent_completed` / `agent_needs_input` are for background *sessions*** (agent view, `claude agents`), not for subagents. [bin] `` `${_.label} ${_.outcome==="failure"?"failed":"finished"}` `` (agent_completed) and `` `${_.label} needs your input: ${…}` `` / `` `${_.label} needs your input` `` (agent_needs_input). No notification is sent for `outcome==="stopped"`, for self-driving sessions, or for the first-seen success. [docs] "`agent_completed` | A background session finishes or fails. Fires only while agent view is open in a terminal".

**B6. Bell, tab title and progress when a turn completes.**
- [bin] On query completion `markQueryComplete` calls `this._host?.axBell()`. `axBell` is `gXe()`, which rings BEL **only in screen-reader mode** (`nt()` reads `isScreenReaderEnabled`, the `InternalAccessibilityContext`), throttled to 500 ms. The same accessibility bell rings when a dialog is revealed and when a tool that ran >5 s completes (`if(Date.now()-S.current>Lf)v()`, `Lf=5000`). **In normal mode no bell is sent at turn end** unless `preferredNotifChannel` is a bell channel, and then only through the 60 s `idle_prompt`.
- Tab title: busy ◐/◑ changes to idle ✳ (A10). OSC 9;4 progress is cleared (`"completed"`) unless background work is pending. [CL 2.1.128] "terminal progress indicator (OSC 9;4) … stays visible across the full turn".
- OSC 7501 Program Status Protocol (2.1.295+) reports working, waiting on you, or done: `{kind:"work",work:"compacting"|"subagent_running"|"turn_running"}` or `{kind:"awaiting_user",awaiting:…}`.
- [docs] terminal-config: "When Claude finishes a task … and you appear to be away from the terminal, it fires a notification event." The implementation of "away" is idle input time, not window focus.

**B7. Related settings** [bin and docs]:
- `messageIdleNotifThresholdMs` (60000)
- `preferredNotifChannel` ("auto")
- `terminalProgressBarEnabled` (true): "Emit OSC 9;4 progress sequences during long operations"
- `showStatusInTerminalTab` (experimental, gated)
- `inputNeededNotifEnabled`: "Push to mobile when a permission prompt or question is waiting"
- `agentPushNotifEnabled`
- `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`

### B.2 Unconfirmed or inferred
- `taskCompleteNotifEnabled` exists in the config key list, but no reader was found in the TUI code. It is probably legacy, or Remote Control or mobile only.
- Whether a task notification from a background agent completing while the main session is idle always starts a model turn immediately. This is inferred from the queue and wake router (`task-notification`, `wakeRouter`) and from [CL 2.1.280] ("resuming … with unfinished background agents … starting a model turn on its own"). It is not verified live.
- Kitty and Ghostty title text: for core notifications `title||"Claude Code"`. The iTerm2 OSC 9 body is the message only (no title).

---

## Design-relevant takeaways for pi

1. **Show the indicator only while the main turn is loading.** Hide it while a blocking dialog (permission or question) is open, and while the user's own `!` shell command shows live progress. Keep it during tool execution and foreground subagents.
2. **Yield the row to streaming assistant text.** While text is visibly streaming, the text is the progress signal. Bring the indicator back when streaming stops (tool calls, thinking, waiting).
3. **Use one random verb per turn**, picked at turn start and stable for the whole turn. Never rotate it on a timer. An in-progress todo's `activeForm` overrides the verb, and so do system overrides such as hooks or compaction. Allow `append` or `replace` customisation of the list.
4. **Line format:** `<glyph> <Verb>… (<elapsed> · ↓ <N> tokens · <thinking status>)`. Show elapsed only after about 16 s, or once tokens exist. Use ↑ while waiting for the first byte and ↓ afterwards. Drop parts right to left on narrow terminals.
5. **Show phase through styling, not words.** Use a fast forward shimmer while requesting, a slower reverse shimmer while responding or thinking, and a pulse during tool use. Thinking shows `thinking` → `still thinking` (10 s) → `thinking more` (20 s) → `thinking some more` (30 s) → `deep in thought` (45 s), with an amber tint after 10 s, then `thought for Ns` for 2 s. Tint red after 10 s with no tokens. Replace the line with a retry banner on API errors.
6. **Put "esc to interrupt" in the footer hint line under the composer while loading**, not in the spinner row.
7. **Background agents never drive the main indicator.** The prompt is free. Show a footer pill (`N background`), a per-agent panel, and a brief `N done` pulse or `/tasks` hint on completion. At turn end print `Waiting for N background agents to finish` instead of the duration line. Deliver results to the model as a later-turn notification.
8. **Send the "turn finished" desktop notification only as `idle_prompt`:** "Claude is waiting for your input", 60 s after the turn completes. Send it only if there has been no keystroke since, no dialog is open, and **no background agent is running**. If agents are running, wait for them and then re-arm. Send it once per completion and never immediately at turn end.
9. **Notify for permission and question dialogs 6 s after they appear**, deferred by each keystroke. Texts: "Claude needs your permission" (hook path: "Claude needs your permission to use <Tool>"). Other dialogs use their own one-line texts ("An MCP server needs your input", "Claude Code wants to enter plan mode", …).
10. **Do not notify on:** each subagent completion, each tool completion, turn completion itself (no immediate bell), or user-stopped agents. Per-agent "finished/failed" OS notifications exist only for separate background *sessions* in an agents view.
11. **Choose the channel per terminal:** iTerm2 OSC 9, Kitty OSC 99, Ghostty OSC 777, Apple Terminal bell (only if the profile bell is on), otherwise none. Users can force `terminal_bell`, `iterm2_with_bell` or `notifications_disabled`. User hooks run regardless of channel.
12. **Use cheap ambient signals instead of noise:** a tab-title glyph (◐/◑ while busy and focused, ✳ idle), OSC 9;4 indeterminate progress during the turn and while background work is pending, and an optional status protocol. Ring a bell at turn end and on long-tool completion only in screen-reader mode.
