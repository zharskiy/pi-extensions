{{reason}} The conversation continues in a new session that starts from a handoff file you write now, so this is your very next step.
{{focus}}
Write the handoff file with your write tool to:

{{path}}

Do not start new work in this turn. Work already running in the background keeps running, and the switch to the new session waits for it; list it below.

The next session sees only this file, so keep it complete but short:
- Point to plans, specs, result files, commits and other files by path instead of copying their content.
- Mark what you did not verify yourself as unverified.
- Never copy secrets (API keys, tokens, passwords) or personal data into the file; write [redacted] instead.

Use exactly these sections, in this order:

## Status
One word for the user's current goal: done, partial or blocked.

## Outcome
The current goal in one sentence, what the user asked last (quote it when short), what is finished and true now, and the decisions taken with the user, in a few bullets.

## Evidence
Delegated or background work, one bullet each, with its state and where its results land; plus commands run, tests, and file paths with line numbers that back the outcome.

## Blocker
What stops progress or waits on the user, or "none".

## Next
Concrete next steps for the session that continues, starting with the answer the user is waiting for, if any. When skills of this session fit those steps, end with a line `Skills: <names>` so the next session reads them first.

## Files touched
One path per line, or "none".

After writing the file, reply with one line: the path of the handoff file.
