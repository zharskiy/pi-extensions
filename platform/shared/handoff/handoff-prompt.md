{{reason}} Your handoff is all that {{reader}} will see, so write it now as your very next step.
{{focus}}
Call the `handoff` tool with the whole handoff as its content. It saves it to:

{{path}}

If it reports errors, fix them and call it again.

Do not start new work in this turn.{{extraRules}}

Keep the handoff complete but short:
- Point to plans, specs, result files, commits and other files by path instead of copying their content.
- Mark what you did not verify yourself as unverified.
- Never copy secrets (API keys, tokens, passwords) or personal data into it; write [redacted] instead.

Use exactly these sections, in this order:

## Status
One word{{statusHint}}: {{statuses}}.

## Outcome
The current goal in one sentence, what is finished and true now, and the decisions taken, in a few bullets.

## Evidence
Delegated or background work, one bullet each, with its state and where its results land; plus commands run, tests, and file paths with line numbers that back the outcome.

## Blocker
What stops progress or waits on the user, or "none".

## Next
Concrete next steps for {{reader}}, starting with the answer the user is waiting for, if any.{{nextHint}}

## Files touched
One path per line, or "none".

Once the tool saves it without errors, end your turn without replying.
