You have reached your context limit. Stop the current work now and hand it off.

If you have a tool that writes files (write, or bash), write the handoff to:

{{path}}

and reply with one line: the path. Otherwise reply with the handoff itself as your final message, with nothing before or after it.

Use exactly these sections, in this order:

## Status
One word: partial or blocked.

## Outcome
What is finished and true now, in a few bullets.

## Evidence
How you know: commands run, tests, file paths with line numbers.

## Blocker
What stopped you, or "none".

## Next
Concrete next steps for the agent that continues this work.

## Files touched
One path per line, or "none".

Do not start new work. Do not look for a way to write the file if you have no tool for it: the handoff as your reply is enough.
