You have reached your context limit. Stop the current work now and hand it off.

Call the `handoff` tool with the handoff as its content. It saves the handoff to:

{{path}}

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

If the tool reports errors, fix the sections and call it again. Then reply with one line, `handoff saved`, and do not start new work.
