The user ran {{command}} and wants a new agent that the main session can start with run_agent. Write the agent file yourself in this conversation; do not delegate it to an agent.

1. Settle what the agent is for. {{known}}If the conversation does not yet answer what the agent does, when the main session should pick it over the agents that exist, whether it changes files (a lead) or only reads and reports (a chore), and what it returns, ask the user only what is missing, in one message, and stop there until they answer. Otherwise write the file now, without asking anything.{{askName}}
2. Write one file with your write tool. {{file}} Do not overwrite an existing file; if the name is taken, agree on another with the user.
3. Start from the skeleton below that fits: the lead skeleton for an agent that changes files, the chore skeleton for one that only reads and reports. Keep every frontmatter field and its value unless a bullet here says otherwise, and replace every <...> placeholder.
   - name: letters, digits, `_` and `-`; not one of the names taken below.
   - description: one line, "Use for … Not for … Returns …". The main session picks agents by this line, so state when to use it and how it differs from the agents that exist.
   - model: keep inherit unless the user names a model; then write it exactly as the user wrote it.
   - skills: names from the skill list below that fit the job, or [].
   - body: the agent's instructions, addressed as "You": its one job, how to start, what to leave alone, when to stop, and its own result sections under Sections:.
4. Reply with the file path and its description line, and tell the user to run /reload so the agent can be started.

Names taken: {{taken}}

Available skills:
{{skills}}

Lead skeleton:
{{lead}}

Chore skeleton:
{{chore}}
