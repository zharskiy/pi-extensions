# Skills in the main session

Research date: 2026-10-21. Question: how to let the pi main session use skills on demand without listing them all in its prompt.

- README.md (this file): context, the dropped and the deferred option, and the recommendation.
- research.md: what pi 1.3.0 ships for skills and how other agents load them.

## Context

The subagents extension gives each agent its own `skills:` allowlist. A separate change in progress makes the agent skill inventory independent of the main session: it is every skill pi discovers by default for the project and user (pi's own rules: `.pi/skills` and `.agents/skills` up to the repo root in a trusted project, `~/.pi/agent/skills`, `~/.agents/skills`, settings `skills` entries, packages). That change is not the subject of this folder. This folder keeps the options for the main session itself.

## Option A: clean by configuration (dropped)

Dropped: the owner does not want the main session started with `--no-skills`, and settings exclusions also hit the agent inventory.

- Run the main session with `--no-skills` (or `-ns`).
- Or exclude skills in settings: `skills: ["!pattern", "-path"]`.
- Or set `disable-model-invocation: true` on skills that should only be invoked explicitly.

Costs nothing. Limits:

- `/skill:name` only expands skills present in the session's loader. With `--no-skills` the user cannot call undiscovered skills from the main session by command.
- Settings exclusions also apply to the agent inventory, since that is pi's discovery too. Only the CLI flag is main-session-only.

## Option B: dynamic providing through a `skill` tool (deferred)

A custom tool registered by our extension in the main session, modelled on OpenCode's `skill({name})`.

- The tool description lists the inventory (name and description). The result returns the SKILL.md body wrapped in pi's own `<skill name="..." location="...">` block. Pi exports `parseSkillBlock`, and `/skill:name` produces the same block, with "References are relative to <baseDir>."
- With pi's built-in `tool_search` the tool can be deferred, so the main session carries zero skill tokens until it asks.
- It would replace `/skill:name` for unloaded skills: an extension command could read the file and `pi.sendUserMessage` the body.
- Alternative route: the `before_agent_start` event exposes a mutable `systemPromptOptions.skills` per turn, so an extension could decide per turn which skills to advertise (routing). Whether a mutated list is re-rendered into the prompt is unverified.
- `resources_discover` is not a fit: it adds paths only at startup and `/reload`, puts them in the prompt, and bypasses `--no-skills` (upstream issue #10696, closed as no-action).

Risk: large skill lists hurt selection accuracy more than token cost (research.md, skill shadowing). A tool listing hundreds of skills needs a routing step or a short list.

## Recommendation

Keep the main session's skills as pi loads them. Build Option B only if the main session needs skills on demand that its prompt does not list.

## Not verified

Whether `before_agent_start` mutations of `systemPromptOptions.skills` are re-rendered into the prompt; see the unverified list in research.md for the industry side.
