The user ran {{command}} and wants a new agent that the main session can start with run_agent. Write the agent file yourself in this conversation; do not delegate it to an agent.

1. Settle what the agent is for. {{known}}Ask the user, in one message, only what the conversation does not already answer: what the agent does, when the main session should pick it over the agents that exist, whether it changes files (a lead) or only reads and reports (a chore), and what it returns.{{askName}} Then stop and wait for the answer. If nothing is missing, ask no question and go straight to writing the file.
2. Write one file with your write tool. {{file}} Do not overwrite an existing file; if the name is taken, agree on another with the user.
3. Follow the skeleton below: keep every frontmatter field and replace every <...> placeholder.
   - name: letters, digits, `_` and `-`; not one of the names taken below.
   - description: one line, "Use for … Not for … Returns …". The main session picks agents by this line, so state when to use it and how it differs from the agents that exist.
   - kind: the skeleton is a lead. For a chore set limit: 80000, tools: [read, grep, find, ls], subagents: [] and mcp: false, and drop the lead-only bullets from the body.
   - model: keep inherit unless the user names a model; then write it exactly as the user wrote it.
   - skills: names from the skill list below that fit the job, or [].
   - body: the agent's instructions, addressed as "You": its one job, how to start, what to leave alone, when to stop, and its own result sections under Sections:.
4. Reply with the file path and its description line, and tell the user to run /reload so the agent can be started.

Names taken: {{taken}}

Skills of this session:
{{skills}}

Skeleton:
{{template}}
