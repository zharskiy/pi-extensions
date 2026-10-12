# Agent and model selection

Question: the user tells the main session "spawn a haiku agent to review something". Which agent runs, on which model, and what happens with "hiaku"? Does the extension need a general-purpose agent?

Outcome: the user chose harness-side resolution over recommendation (b) below, and a general agent that may start explorers and reviewers; see `docs/deviations.md` entries 4 and 20 to 23 for what was built.

Facts below were checked on 10 October 2026 against the working tree on `feat/mvp`, pi 1.1.0 at `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/` (`$PI` below) and `~/.pi/agent/`.

## 1. What happens today

### The main session cannot express a model

- The `run_agent` item schema has `agent`, `task`, `description` and `files` only, with `additionalProperties: false` (`src/plugins/run-agent/tools.ts:81-98`). There is no per-call model.
- The agent list in the tool description shows name, description and context limit, not the model (`src/plugins/run-agent/tools.ts:36-39`). The main session does not know that `reviewer` runs on `openai/gpt-6-luna`.
- `prompts/main-session.md:14` says "Pick the agent by its description in `run_agent`". Nothing mentions models.
- The model comes only from the definition file: `model: definition.model` (`src/plugins/run-agent/runner.ts:366`). `agents/reviewer.md:5` sets `openai/gpt-6-luna`.

### Likely outcomes for "spawn a haiku agent to review something"

| What the main session does | Result |
|---|---|
| Picks `reviewer` (the work is a review) and ignores "haiku" | The usual case. The reviewer runs on `openai/gpt-6-luna`. The user's model request is dropped silently. Only the progress row shows the real model, because the registry records `child.modelLabel` (`runner.ts:384-389`). |
| Adds `model: "haiku"` to the item | pi validates the arguments against the schema and throws `Validation failed for tool "run_agent" ... must NOT have additional properties` (`$PI/pi-ai/dist/utils/validation.js:299-307`). The agent loop turns the throw into an error tool result (`$PI/pi-agent-core/dist/agent-loop.js:584-591`). The model then retries without `model` (same as row 1) or tells the user it cannot choose a model. |
| Uses `agent: "haiku"` | `startBatch` throws `unknown agent(s): haiku. Available: explorer, implementer, reviewer` (`runner.ts:417-426`). Nothing starts. The model usually retries with `reviewer`. |
| Writes "use haiku" into the task text | No effect. The child's model is fixed before it reads the task. |

"something" is also too vague to review. `prompts/main-session.md:12` already tells the main session to ask first.

### If the user edits the agent file instead

- `model: haiku` fails the loader's `provider/id` pattern check (`src/plugins/agent-definitions/loader.ts:78-94`). The whole definition is dropped, with only a `notify` warning (`src/plugins/agent-definitions/index.ts:54-56`), so `reviewer` disappears.
- `model: anthropic/claude-haiku-5-5` passes the loader, which checks syntax only. The adapter resolves it with `ctx.modelRegistry.find(provider, id)` (`src/adapter/pi-adapter.ts:632`), and `find` does not check credentials (`$PI/pi-coding-agent/dist/core/model-registry.js:24-26`). On this machine `auth.json` holds only `openai`, so the spawn succeeds and the first request fails with "No API key found for anthropic". The agent closes as `failed` after the cost of a spawn.
- `model: claude-haiku-5-5` with no provider is rejected by the loader too. If it got through, the adapter's bare-id branch (`pi-adapter.ts:622-630`) searches only authenticated models and takes `matches[0]` when several providers share the id. That is a silent choice.

### "hiaku" today

Same as "haiku": no path carries a model. As an agent name it gives `unknown agent(s): hiaku`.

## 2. Which concrete model "haiku" would mean

### The catalog on this machine

`~/.pi/agent/models-store.json` overlays the bundled catalog for `anthropic` and `openai`. Credentials (`auth.json`) exist for `openai` only. Prices are USD per million tokens, input/output.

- Haiku: `anthropic/claude-haiku-5-5` (0.10/0.50), `anthropic/claude-haiku-4-5` (name "Claude Haiku 4.5 (latest)", 1/5) and `anthropic/claude-haiku-4-5-20251001` (dated snapshot, 1/5).
- Sonnet: `claude-sonnet-5-5` (2/10), `claude-sonnet-5` (2/10), `claude-sonnet-4-6` (3/15), `claude-sonnet-4-5` (3/15) and `claude-sonnet-4-5-20250929`.
- Opus: `claude-opus-5-5` (4/20), `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` and `claude-opus-4-5` (all 5/25), plus `claude-opus-4-5-20251101`.
- OpenAI current: `gpt-6-luna` (0.10/0.50), `gpt-6-sol` (2/10), `gpt-6.1-sol` (2/10), `gpt-6-astra` (10/50) and `gpt-5.6-luna|terra|sol`. Older: `gpt-5.x`, `gpt-4.x`, `o1`, `o3` and `o4-mini`, plus `-pro` variants up to 150/600.
- Across all bundled providers, 31 models match "haiku". They include `amazon-bedrock` (`us.`, `eu.`, `global.`, ... prefixes), `openrouter` (`anthropic/claude-haiku-5.5`, `~anthropic/claude-haiku-latest`, `:batch`), `opencode`, `github-copilot` (`claude-haiku-4.5`), `vercel-ai-gateway` (including `claude-3-haiku`), `radius` and `cloudflare-ai-gateway`.

### How pi resolves names

- **`--model <pattern>` (CLI)**: `resolveCliModel` (`$PI/pi-coding-agent/dist/core/model-resolver.js:292-464`).
  1. Exact `provider/id` or exact id. An exact id found in several providers is an error unless exactly one of those providers is authenticated (`:344-373`).
  2. Otherwise `tryMatchModel` (`:105-129`) takes every model whose id or name contains the pattern as a substring. It prefers "aliases" (ids without a `-YYYYMMDD` suffix) and returns the one whose id sorts highest by `localeCompare`. The sort is plain string order, not version order.
  3. The CLI searches all models, authenticated or not (`:297-299`).
- **I ran pi's own `parseModelPattern` against the bundled catalog plus `models-store.json`:**

  | Pattern | Searching all providers | Searching anthropic only |
  |---|---|---|
  | `haiku` | `amazon-bedrock/us.anthropic.claude-haiku-5-5` | `anthropic/claude-haiku-5-5` |
  | `sonnet` | `amazon-bedrock/us.anthropic.claude-sonnet-5-5` | `anthropic/claude-sonnet-5-5` |
  | `opus` | `amazon-bedrock/us.anthropic.claude-opus-5-5` | `anthropic/claude-opus-5-5` |
  | `haiku-4-5` | `amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` | `anthropic/claude-haiku-4-5` |
  | `hiaku` | no match | no match |

  The all-providers winner is Bedrock only because `"us.…"` sorts after `"claude-…"`. The version plays no part.
- **Fuzzy matching is not typo-tolerant.** It is a plain substring test, so `hiaku` matches nothing.
- **`/model <term>` (interactive)** (`$PI/pi-coding-agent/dist/modes/interactive/interactive-mode.js:4308-4361`) accepts only an exact reference (`findExactModelReferenceMatch`, `model-resolver.js:70-100`), searched among authenticated or scoped models. Anything else opens the picker pre-filtered with the term, and the **user** chooses. When several haiku versions exist, interactive pi asks rather than guesses.
- **`getModel` / `modelRegistry.find(provider, id)`** returns `undefined` for an unknown id. It returns the model even when its provider has no credentials. `getAvailable()` is the credential-filtered list.

### What we would have to do

There is no "right" haiku without either guessing or asking. Pi's guessing rule picks by string order across providers, so it can choose a provider the user has never used. Pi's interactive rule is to ask. An extension tool has no picker, so "ask" has to mean: return the candidates to the main session, which asks the user.

## 3. Options

Two background facts apply to every option.

- **Prompt cache.** The child's model is fixed at spawn and never changes mid-agent, so a per-call override cannot break the child's cache. The main session's cache is only at risk if the `run_agent` definition changes between turns. An optional schema property is static. Listing each agent's default model in the description is static per session. Listing the catalog in the description is not: it changes with `pi update --models`, and it would add 100+ lines. Candidates must therefore go in tool results, which are appended, never in the description.
- **Context limit.** The effective limit already caps at the model's window (`src/model/context-limit.ts`), so a model with a smaller window is handled. Thinking level is clamped to the model by pi.

### (a) No per-call override

Agents keep their file model. The main session maps the user's words to a role and tells the user that model choice is per agent file.

- Pros: no code, and no cost surprises. Spend stays predictable because the agent author chose the model.
- Cons: "a haiku agent" can never be honoured without editing a file. The main session must say so explicitly; today it drops the request silently. Users who want to compare models, or who want a cheaper or stronger run once, must keep copies of agent files.
- "haiku": `reviewer` on `openai/gpt-6-luna`, and the main session says it cannot change the model per call. "hiaku": the same.

### (b) Optional `model`: exact `provider/id` only, candidates returned on anything else

- An optional `model` field on each `run_agent` item.
- The runner validates it synchronously in `startBatch`, for the whole batch, before anything starts, like the unknown-agent check.
- An exact case-insensitive `provider/id` match with credentials starts the agent on that model. The model is echoed in the start message and the progress row.
- Anything else starts nothing and returns ranked candidates. The main session asks the user and calls again with the chosen id.
- Pros: deterministic, and never a silent choice. Cost is visible because candidates carry prices. It matches pi's interactive behaviour (exact or ask). The child's cache is unaffected.
- Cons: the first use of a short name costs one extra round trip and one question to the user. That is mitigated by remembering the choice for the conversation (prompt rule).
- "haiku": error with candidates, then the user picks, then the agent starts. "hiaku": error with typo candidates ("did you mean"), then the user picks.

### (c) Fuzzy alias resolution, newest wins, chosen id echoed back

- Reuse pi's `tryMatchModel` logic, or a numeric-aware "newest" sort, over authenticated models. Start at once and echo `reviewer on anthropic/claude-haiku-5-5`.
- Pros: zero friction when it guesses right.
- Cons:
  - **String order is not version order.** pi's own rule would pick Bedrock over Anthropic, and `claude-haiku-10` would sort below `claude-haiku-5`.
  - **The meaning drifts.** It changes silently when the catalog refreshes or the user logs into another provider.
  - **Cost surprises.** "opus" means `claude-opus-5-5` at 4/20 against the reviewer's default `gpt-6-luna` at 0.10/0.50, so 40x on input and output. The echo arrives only after spend has started.
  - **It does not help typos.** `hiaku` still matches nothing, so the main session is tempted to "fix" the name itself, which is a second, invisible guess.
- "haiku" (with Anthropic logged in): `anthropic/claude-haiku-5-5`. On this machine: no authenticated match, so it errors. "hiaku": no match, so it errors with no suggestions.

### (d) Considered and deferred: user aliases in settings

`modelAliases: { "haiku": "anthropic/claude-haiku-5-5" }` in the extension's settings file, applied as an exact key lookup before (b)'s check. It is deterministic and removes the repeated question. It can be added later on top of (b) without changing the tool contract.

## 4. Recommendation

**Adopt (b).** Ship a fallback general-purpose agent marked structurally as a fallback.

### Model parameter

- Schema: each item gets `model: { type: "string", description: "Optional. Run this agent on another model instead of its own. Exact provider/id, for example anthropic/claude-haiku-5-5. Omit to use the agent's model shown in the list." }`.
- Resolution happens in the adapter, because it needs pi's registry. The order:
  1. **Exact match.** A case-insensitive exact `provider/id` match in `modelRegistry.getAll()` (split on the first `/`).
     - If its provider has credentials, use it.
     - If not, error `provider "<p>" has no credentials; the user can run /login`. This is never a late failure after spawn.
  2. **Substring candidates.** Otherwise collect candidates: models whose `provider/id` or name contains the reference, case-insensitively.
  3. **Typo candidates.** If there are none, compare the reference with each id token (split on `-`, `.`, `_`, `/`, `:`) and each name word. Keep those within Damerau-Levenshtein distance 1, or 2 when the reference is longer than 6 characters. `hiaku`→`haiku` is distance 1.
  4. **Ranking.** Authenticated first, then the model's own provider before resellers (provider equal to the id's vendor, so `anthropic` and `openai` before `amazon-bedrock` and `openrouter`), then ids without a date suffix, then newest by numeric-aware comparison. Show at most 6, each with provider/id, name and input/output price.
  5. **Error text.** If no candidate is authenticated, say so, name the providers that would need `/login`, and show up to 3 examples.
- Any failing item rejects the whole batch: "Nothing was started."
- The start message names the model per agent: `- a-1 (reviewer, anthropic/claude-haiku-5-5)`.
- Children get the same parameter, because every agent behaves identically. Their `run_agent` description says to set it only when their task names a model.

### Exact behaviour

**"haiku" on this machine** (only `openai` has credentials):

```
Error: model "haiku" is not usable. Nothing was started.
Models matching "haiku" exist, but none of their providers has credentials: anthropic, amazon-bedrock, openrouter, opencode, github-copilot, vercel-ai-gateway (31 models), for example anthropic/claude-haiku-5-5, anthropic/claude-haiku-4-5, anthropic/claude-haiku-4-5-20251001.
Tell the user. They can log in with /login, or the agent can run on its own model.
```

The main session asks: "No Haiku model is usable (Anthropic is not logged in). Run the reviewer on its default openai/gpt-6-luna, or log in first?"

**"haiku" with Anthropic logged in:**

```
Error: model "haiku" is not an exact provider/id. Nothing was started.
Usable models matching "haiku", newest first:
- anthropic/claude-haiku-5-5 (Claude Haiku 5.5, $0.10/$0.50 per Mtok)
- anthropic/claude-haiku-4-5 (Claude Haiku 4.5 (latest), $1/$5 per Mtok)
- anthropic/claude-haiku-4-5-20251001 (Claude Haiku 4.5, $1/$5 per Mtok, dated snapshot)
Ask the user which one to use, then call run_agent again with that provider/id.
```

The main session asks once, suggesting the first entry. It then uses the chosen id whenever the user says "haiku" again in this conversation.

**"hiaku":** the same flow, with the header `No model matches "hiaku". Did you mean (closest names):`. With Anthropic logged in it lists the same three. On this machine it gives the "not usable" text. The main session never silently rewrites "hiaku" to "haiku": the user confirms the pick.

**"anthropic/claude-haiku-5-5" on this machine:** `Error: provider "anthropic" has no credentials ...`, before any spawn.

### Rule text for `prompts/main-session.md`

Replace the "Pick the agent by its description" bullet (line 14) with this section, placed after "Before delegating":

```markdown
# Choosing the agent and its model

- Choose the agent from the work, never from a model name. "A haiku agent to review X" is the reviewing agent with a model override; "an opus agent to fix Y" is the editing agent with a model override. Search and understanding go to a read-only agent, changes to an editing agent, checks of a change to a reviewing agent.
- Agents in the fallback list of `run_agent` are only for work that no other listed agent fits. Never pick one because the user named a model, said "an agent" without a role, or because the task is small; work out the role from what has to be done.
- Each agent runs on the model shown next to it in `run_agent`. Leave `model` out unless the user names a model for this work.
- When the user names a model, pass it in `model`. If you know the exact `provider/id`, pass that; otherwise pass the user's words unchanged. Never correct, complete or replace a model name yourself.
- If `run_agent` returns model candidates instead of starting, ask the user which one to use, listing the candidates with their prices and suggesting the first. Use the chosen `provider/id` whenever the user names that model again in this conversation.
- If no candidate is usable, tell the user why (for example, the provider is not logged in) and ask whether to run the agent on its own model. Never drop a requested model silently.
```

### Sentences for the `run_agent` description (`describeRunAgent`)

- Agent list line format: `- reviewer: <description> (model openai/gpt-6-luna, context limit 80000 tokens)`. Use `model: the caller's model` for `inherit` or unset.
- Fallback agents go in a separate block after the main list, headed `Fallback agents (only when no agent above fits the work):`.
- Add to "Rules":
  - `- Choosing: pick the agent whose description fits the work. Use a fallback agent only when no agent above fits; never because a model was named or no role was given.`
  - `- Model: each agent runs on the model shown next to it. Set \`model\` only when the user (or, for an agent, its task) names one, as an exact provider/id. Any other value starts nothing and returns the matching models to choose from.`

### General-purpose agent: yes, as a structural fallback

**Why it is needed.** Today, work that is neither search, nor a scoped code change, nor a review falls to `prompts/main-session.md:8`: "do the work yourself only if it is small; otherwise tell the user which agent is missing". Examples are running a benchmark and summarising it, reproducing a bug from logs, drafting a document, or a mixed investigate-and-script task. The coordinator runs on a cheap model on purpose and should not absorb that work. One fallback closes the gap.

**How it is kept from competing with the role agents.**

1. **A `fallback: true` frontmatter flag, not wording alone.** `describeRunAgent` lists flagged agents in their own block after the role agents, under the "only when no agent above fits" heading. This also works for user-added agents.
2. **The name `general`.** It is neutral, sorts between the role agents in the main block, but lives in its own block. It does not say "general-purpose", which invites "use me for anything".
3. **The description opens with the negative scope.**
4. **The main-session rule above.** "Fallback list ... never because a model was named or no role was given." So "spawn a haiku agent" with no task never maps to `general`. The main session asks what the agent should do, or derives the role from the task.

**Answer to "fallback only when the user names no role?"** No. The trigger is "no role agent fits the work", not "the user named no role". The user rarely names roles; the main session derives them from the work.

File `agents/general.md`:

```markdown
---
name: general
description: Fallback for work that no other agent fits, such as running commands and summarising their output, reproducing a problem, drafting a document, or a task that mixes searching, scripting and small edits. Not for pure search, scoped code changes or reviews.
fallback: true
tools: read, grep, find, ls, edit, write, bash
model: openai/gpt-6.1-sol
thinking: medium
limit: 100000
subagents: []
---
You handle one task that does not fit a specialised agent.

- Work out the steps the task needs and do them; read before you change anything.
- Change only what the task asks for. Do not commit, push or change git state unless the task says so.
- Run the commands that prove the result where that applies, and report their outcome.

Return:
1. What you did, one line per step or file (`path - change`).
2. Commands you ran and their result.
3. Anything left undone, risky or better suited to a specialised agent next time.
```

Model choice: `openai/gpt-6.1-sol`, the same as `implementer`, because the agent can edit and run commands. `inherit` would tie it to the deliberately cheap coordinator model.

## 5. Code changes for the recommendation

- `src/adapter/contract.ts`: add `ModelCandidate` (`ref`, `name`, `price`, `usable`) and `ModelResolution` (`{ ok: true; ref }` or `{ ok: false; reason: "unknown" | "no-auth"; candidates; providersWithoutAuth }`). Add `resolveModel(ref: string): ModelResolution` (synchronous) to `AgentRuntime`.
- `src/adapter/pi-adapter.ts`: implement `resolveModel` with `ctx.modelRegistry.getAll()` and `hasConfiguredAuth`. In `resolveModel` (lines 611-640), check credentials on the `provider/id` path and reject ambiguous bare ids, instead of taking `matches[0]`.
- `src/plugins/run-agent/model-match.ts` (new): pure ranking and typo logic (substring, Damerau-Levenshtein on id tokens, vendor-first, undated-first, numeric-aware newest-first) and candidate error text, so it can be unit tested without pi.
- `src/plugins/run-agent/runner.ts`: add `model?: string` to `BatchItem` (line 29). Validate every item's model in `startBatch` next to the unknown-agent check (lines 417-426) and throw the candidate text on failure. In `launch`, pass `item.model ?? definition.model` to `spawn` (line 366).
- `src/plugins/run-agent/tools.ts`: add the `model` property to the item schema (lines 83-94). Show the model in `agentList` (line 38) and the fallback block. Add the two rule lines to `describeRunAgent` (lines 57-64). Include the model in the start message (line 152). Widen `DelegateAgent` to include `model` and `fallback`.
- `src/plugins/run-agent/index.ts`: pass definitions with `model` and `fallback` to `describeRunAgent` (line 74). The child `run_agent` builder gets the same fields when nesting lands.
- `src/manager/types.ts`: add `fallback: boolean` to `AgentDefinition`.
- `src/plugins/agent-definitions/loader.ts`: parse an optional boolean `fallback` (default false). Optionally validate `model` against the catalog at session start through `resolveModel` and warn, rather than failing at first request.
- `agents/general.md` (new): the file above.
- `prompts/main-session.md`: replace line 14 with the "Choosing the agent and its model" section above.
- `test/helpers/fakes.ts`: add a `resolveModel` stub to the fake runtime with a small catalog (two haiku versions, one unauthenticated provider).
- `test/plugins/run-agent/model-match.test.ts` (new): cover `haiku` (three ranked candidates), `hiaku` (typo candidates), exact id without credentials, exact id ok, the ranking order, and that no candidate list goes to the description.
- `test/plugins/run-agent/run-agent.test.ts`: add a batch with one bad model that starts nothing, an override passed to `spawn`, and a start message naming the model.
- `test/plugins/run-agent/describe-run-agent.test.ts`: add a model shown per agent, a fallback block after the role agents, and a check that the output is stable across calls.
- `test/plugins/agent-definitions/agent-definitions.test.ts`: cover the `fallback` flag parsing and the shipped `general.md` loading.
