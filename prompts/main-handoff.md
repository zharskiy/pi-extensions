Your context window is nearly full. The conversation continues in a new session that starts from a handoff file you write now, so this is your very next step.

Write the handoff file with your write tool to:

{{path}}

Do not start new agents, do not message agents and do not continue other work in this turn. Agents that are already running keep running; list them below, and the switch to the new session waits until they finish.

Use exactly these sections, in this order:

## Status
One word for the user's current goal: done, partial or blocked.

## Outcome
The current goal in one sentence, what the user asked last (quote it when short), what is finished and true now, and the decisions taken with the user, in a few bullets.

## Evidence
What was delegated: one bullet per agent with its id, agent name, state and result file path; plus commands run, tests, and file paths with line numbers that back the outcome.

## Blocker
What stops progress or waits on the user, or "none".

## Next
Concrete next steps for the session that continues, starting with the answer the user is waiting for, if any.

## Files touched
One path per line, or "none".

After writing the file, reply with one line: the path of the handoff file.
