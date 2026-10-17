# Subagent results: how a child's answer reaches its parent

Research note, 2026-10-17. Repo references are `file:line` on branch `feat/agent-workflow-revamp` and were spot-checked against the tree on that date. Product sources were fetched on that date; most quotes came through a summarising fetch tool and are near-verbatim. Items marked UNVERIFIED come from search snippets or third-party blogs. Raw notes are in the session scratchpad, not in the repo.

Abbreviations: `sa/` is `extensions/subagents/`; `pca/` is `node_modules/@earendil-works/pi-coding-agent/dist/core/` (pi 1.3.0). Product names below are quoted from the sources. They are evidence, not recommendations for code or prompts.

## Question

A user reported that subagent results were cut at "8 KB". This note answers, in order:

1. How does a child talk to its parent today, and which limits sit on that path?
2. Is there a contract that validates the result?
3. Where did "8 KB" come from, and how else is a result lost?
4. What do other products do?
5. Which options does this repo have? The design doc decides; this note does not.

## 1. The path from child to parent

Capture. The child's result is its last assistant message, not a file it writes.
- The child session exposes `lastText: () => session.getLastAssistantText() ?? ""` (`core/adapter/pi-child.ts:360`). pi takes the last assistant message, skips an aborted one with no content, joins only its text blocks and trims (`pca/agent-session.js:3562-3584`). Tool calls and thinking in that message are dropped.
- The runner also keeps the last non-blank assistant text as a fallback (`sa/src/plugins/run-agent/runner.ts:511`).
- On finish the text is `(live.child?.lastText() || live.lastText).trim()` (`runner.ts:403`). An aborted run or an error stop reason closes the agent as failed; empty text closes it as failed with "agent finished with an empty result"; anything else is stored and the agent closes as done (`runner.ts:404-421`).
- A stopped agent keeps its last text the same way, only when non-empty (`closeStopped`, `runner.ts:436-439`).
- A child asked for a handoff is read from its handoff file instead (`runner.ts:398`, validation at `runner.ts:337`).

Storage. `storeResult` writes the full text to `result.md` in the agent folder with no truncation (`sa/src/plugins/run-agent/result.ts:42-53`). It is written for every result, small or large (`sa/test/plugins/run-agent/run-agent.test.ts:115-123`). The text is also kept in memory as `record.resultText` (`sa/src/model/types.ts:64-65`).

Delivery. The parent receives one batch message once every agent of the batch has closed.
- Default `wait: false`: `run_agent` returns at once with "Started batch <id>:", one line per agent and "You will be woken once when all agents are done. End your turn now." (`sa/src/plugins/run-agent/tools.ts:229-236`).
- Later, `checkBatch` posts the batch text to the caller's outbox (`runner.ts:164-181`). For the main session that becomes a hidden custom message, `customType: "pi-subagents:wake"`, `display: false` (`sa/src/plugins/run-agent/index.ts:36-38`), sent as a follow-up that triggers a turn, or held until idle (`core/adapter/pi-adapter.ts:494-522`). Several texts are joined with `---` (`sa/src/plugins/run-agent/outbox.ts:13`). A child caller gets the same text through `child.wake`.
- `wait: true`: the call awaits the batch and returns the same text as an ordinary tool result (`tools.ts:246-250`). The adapter passes tool text through with no cap (`core/adapter/pi-tools.ts:122`).

Shape of the batch message (`result.ts:71-137`): a header line, then per agent `## <id> (<agent>) - <state>`, a `Task:` line, a summary line and optional `Chain:` and `Worktree:` lines. Only done agents, and stopped agents with text, carry a result (`result.ts:94-98`). Then the inline decision (`result.ts:102-112`): if the text is at most `inlineResultChars` long, it is inlined in full; otherwise the entry carries only `Result file: <path> (<N> chars)` and `Preview:` with the first 300 characters on one line. If `result.md` could not be written, the full text is inlined regardless of size.

Side channels carry no result. `message_agent` returns "Message delivered to <id> (<delivery>)." (`tools.ts:308`); its description says "the agent does not reply. Its result reflects the message." (`tools.ts:287`). `agent_status` shows a `last:` line, the last non-empty line of the latest text cut to 160 characters (`sa/src/plugins/agent-status/snapshot.ts:41-47`), and `result: <path>` (`snapshot.ts:110`).

| Limit | Value | Applies to | When exceeded | Source |
| --- | --- | --- | --- | --- |
| `inlineResultChars` | 4,000 chars default, range 0 to 1,000,000 | Result text in the batch message | Replaced by file path, char count and preview; never cut; `result.md` has it all | `sa/src/model/settings.ts:39`, `:63`; `result.ts:102-112` |
| Preview | 300 chars | Batch entry of an over-limit result | Cut with ellipsis, newlines collapsed | `result.ts:110` |
| Task line | 200 chars | `Task:` line of the entry | Cut | `result.ts:74` |
| `agent_status` last line | 160 chars | Status snapshot | Cut | `snapshot.ts:47` |
| `result.md` | None | Stored result | Not applicable | `result.ts:42-53` |
| Prompt advice | About 300 words plus lists, about 1,500 tokens | Child's final message | Not enforced | `sa/prompts/base-system-prompt.md:22` |
| pi `read` | 2,000 lines or 50 KB, whichever first | Parent reading `result.md` | Head kept, marker with offset to continue | `pca/tools/truncate.js:10-12` |
| pi tool result, wake message | None | `run_agent` result and hidden wake text | Not applicable | `core/adapter/pi-tools.ts:122` |

## 2. Is there a contract that validates the result?

No. The result shape is prompt-only. The contract is in every agent's system prompt (`sa/prompts/base-system-prompt.md:11-23`):

> Your last message is your result; your caller sees nothing else. Use this shape:
> Status: done | partial | blocked
> \<the sections your agent section asks for\>
> Verification: what you ran or checked and its outcome, or "none".
> Open: what is left, assumptions you made and questions, or "none".
> ...
> Keep it under about 300 words plus the section lists (about 1,500 tokens at most). Your caller gets a long result as a file.
> Never end with an empty reply.

Agent files add a per-agent `Sections:` block, and the `run_agent` description repeats the contract to the caller (`tools.ts:125-131`). No code parses `Status:`: the runner stores any non-empty final text and closes the agent as done (`runner.ts:419-421`). Tests check only the prompt and description text. The only validated artifact is the handoff file: `validateHandoff` checks the six `##` sections in order and the status word (`core/manager/handoff.ts:21`), with `partial` and `blocked` allowed for subagents (`sa/src/plugins/run-agent/handoff.ts:10`). An invalid handoff closes as handoff with `(invalid: <reasons>)`.

## 3. Where did "8 KB" come from?

No 8 KB limit exists on the result path, in this repo or in pi.
- A repo-wide search for 8192, `8 * 1024`, 8KB and 8000 finds only an 8,000 ms animation timer (`extensions/working-indicator/src/working-indicator.ts:6`).
- The only `8 * 1024` in pi is `NESTED_CALL_LIMITS.maxArgumentBytesPerCall` (`pca/nested-tool-calls.js:18-21`). It bounds the recorded arguments of nested tool calls made through `ctx.executeTool()`; over-size arguments are omitted and the record is marked incomplete. It does not touch results.

The most plausible explanation is the 4,000-character inline limit. Above it, the parent sees a file path and a 300-character preview. The main prompt tells the coordinator to "read it only when the next task needs it" (`sa/prompts/main-session.md:35`), so a parent that does not open the file sees only the preview, which looks like a truncated result. Note that the contract's own ceiling (about 1,500 tokens, roughly 6,000 characters) is above the 4,000 default, so a child that follows the contract can still land in the pointer form.

Other ways a result is lost today:
- The child ends on a tool call or a one-line sign-off. Only the last assistant message counts, and only its text blocks, so an earlier full report is replaced by the sign-off or by nothing.
- A failed child's text is not shown: failed entries carry only the error (`result.ts:94-98`), even when the child produced useful partial text before the error.
- An empty last message closes the agent as failed (`runner.ts:414-417`), even when earlier messages held the answer.
- A stopped child keeps its text only if the last message was non-empty (`runner.ts:436-439`).

## 4. What other products do

| Product | Parent receives | Documented cap on the return | Enforcement | Transcript access |
| --- | --- | --- | --- | --- |
| Claude Code | Final message only, plus `agentId`; "marked as partial" on maxTurns; partial output "with a note that the subagent was cut off" on API error | None found. Bash results spill to a file with a 2,000-char preview above about 30,000 chars | Prompt only | JSONL per subagent; resume by agent ID |
| Claude Agent SDK | "only its final message returns to the parent" | None found | None; no output-schema field | Session resume plus agent ID |
| Codex CLI | "a consolidated response" from collected results | None documented; `tool_output_token_limit` default not sourced | None described | Thread view, `/subagents` |
| Cursor | "a final message with its results"; error status on failure | None found. Shell tool: inline cut at 20k chars, file only above 40k | Prompt only | Resume by ID; background output in `~/.cursor/subagents/` |
| Gemini CLI | Output of a `complete_task` tool call, with `terminate_reason` | None found. Tool output over 40,000 chars: head 20%, tail 80%, path to full file | `complete_task` with output config; grace turn | Not documented |
| Cline, Roo, Kilo | Final reply or `attempt_completion` summary | None found | Prompt only | Not sourced |
| Amp | "their final summary" | Not sourced | Not sourced | Not sourced |

Sources (2026-10-17): code.claude.com/docs/en/sub-agents, /tools-reference, /agent-sdk/subagents; learn.chatgpt.com/docs/agent-configuration/subagents; cursor.com/docs/subagents; geminicli.com/docs/core/subagents.md and `packages/core/src/agents/local-executor.ts`; docs.cline.bot/features/subagents; roocodeinc.github.io/Roo-Code/features/boomerang-tasks; ampcode.com/docs/models-and-subagents.

Issue history:
- anthropics/claude-code #58109 (2026-05-11, closed "not planned" 2026-06-10): the Task tool returns only the last text block, so a run ending on a tool call loses its report. Same root cause as #20190. Workaround: put all output in a final text-only block.
- #44067 (2026-04-06, closed as duplicate 2026-04-09): a subagent hitting max_tokens loses all its work; the parent gets only a failure.
- #73372 (2026-07-02, closed "not planned" 2026-09-14): a subagent stopped for budget or context is reported as completed with no marker.
- openai/codex #16051 (2026-03-27): a finished subagent's result never reaches the parent ("The sub-agent handoff did not complete normally in this run."). Workaround: write to a file the parent reads. Cited via a third-party blog (codex.danielvaughan.com, 2026-03-29).
- Cursor forum, "The 20k-40k character loss zone for the shell tool": output between 20k and 40k characters is cut and not saved; staff confirmed 2026-06-11, still reproducible 2026-10-01. This is a tool limit, not a subagent limit.

Patterns:
- Every product returns the child's final message as free text; intermediate tool calls stay in the child.
- No vendor documents a cap on the return itself. Caps exist on ordinary tool results, and the common answer to overflow is spill to a file plus a preview (Claude Code) or head and tail plus a path (Gemini CLI).
- The shape is prompted, not enforced. Only Gemini CLI comes near enforcement.
- Full transcripts stay reachable out of band (Claude Code, Cursor, Codex).
- Silent loss is the recurring failure, and the known modes match ours: last block only, failures that drop partial work, stops reported as success.

## 5. Options for this repo

Each option lists cost and precedent. None is chosen here.

a. Raise the inline default and align it with the contract's ceiling. About 300 words plus lists, about 1,500 tokens, is roughly 6,000 characters; the 4,000 default sits below it. Cost: one default in `settings.ts:39` and the README line; more parent context per batch. Precedent: no product documents a return cap, so the number is ours to set.

b. Head with a marker instead of pointer plus preview. Inline the head up to the limit, then one line with the remaining size and the file path, so the `Status:` line and the first section always arrive. Cost: a change in `result.ts:102-112` and its tests; the parent still reads the file for the tail. Precedent: Gemini CLI's head and tail with path; Claude Code's file path plus 2,000-character preview for Bash.

c. Show a failed or stopped child's last text as partial output with a note. Cost: `result.ts:94-98` and the failed branch in `runner.ts:404-412` would store text; the parent must treat it as unverified. Precedent: Claude Code's API-error "cut off" note and maxTurns "partial" marker; the requests in #44067 and #73372.

d. Shape check with one grace retry. If the final text has no leading `Status:` line, send the child one follow-up asking for the result in the Result shape and take the next message; otherwise close with a shape note. Cost: one extra child turn in the worst case and a small parser in the runner. Precedent: Gemini CLI's `complete_task` grace turn.

e. A real schema or a structured completion tool. Cost: a new tool, a schema per agent and failure handling for invalid output; heavier than d. Precedent: only Gemini CLI's `complete_task`; no other product does it.

f. Leave as is and rely on the prompt. Cost: none; the loss modes in section 3 remain. Precedent: the norm across Claude Code, Codex, Cursor, Cline, Roo and Amp.

## Verdicts

**(i) A cap on the return is not where products protect the parent.** No vendor documents one. They protect through prompted summaries, file spill with a preview, and transcripts the parent can open (section 4).

**(ii) Prose result contracts are the norm, and their loss modes are known.** Ours is prompt-only like everyone's except Gemini CLI. The same losses appear in public issues: last block only (#58109), failures that drop partial work (#44067), stops reported as success (#73372).

**(iii) The reported 8 KB was most plausibly the preview behaviour.** No 8 KB limit exists on the path; above 4,000 characters the parent sees a path and 300 characters unless it opens `result.md`.

## Could not source

- A documented size cap on the subagent return in any product.
- Codex's default `tool_output_token_limit`, and whether it drops the tail (UNVERIFIED blog claim).
- Gemini CLI transcript access for subagents, and whether `processOutput` validates the schema.
- Limits and transcript access for Cline, Roo, Kilo and Amp.
- Whether a provider's max-output-token setting cut a child's final message in the reported case.
