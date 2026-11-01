<div align="center">

# session-limits

**Hands the main session over to a new session before its context fills up, so it can run indefinitely.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A long session eventually fills the model's context window. Before that happens, this extension has the model save a handoff with a dedicated tool, and pi continues in a new session seeded with it. You keep typing, and a notice below the editor warns when the handoff is near. When background work is still running, the switch waits for it instead of ending it, and results that arrive once a handoff is requested are attached to the new session's seed rather than answered in the old session. Messages you send while a handoff is being written or the switch waits are kept rather than answered in the old session: after an automatic handoff they are sent to the new session as your own messages once it has picked the handoff up (messages in a row become one message, images included; a message starting with `/`, such as a prompt template or skill, is sent on its own so it still expands), after `/handoff` they wait in the new session's editor, and when no new session starts they come back to your editor. Images cannot go into an editor, so after `/handoff` or when nothing switches a notice asks you to attach them again. In the terminal UI each kept message appears in the chat, drawn like your own messages, under a line saying `handing off, messages below go to the new session`; while the switch waits for background work that line adds that `/handoff` switches right away, and if no new session starts a closing line says the messages are back in the editor. In RPC mode a notice says where each message goes instead. The new session's first row says it continues the previous session, and it keeps the model and thinking level you had selected without changing pi's defaults. The previous session's transcript stays on screen above that row, closed by a `── handed off · context limit ──` rule (or `handed off · /handoff` after the command; the subagents view closes each link of an agent's chain with the same rule), drawn from the old session file (earlier handoffs too, oldest first), with all of its messages, compacted ones included (an earlier compaction is marked where it happened, with its summary), and other extensions' rows, but not the kept messages, which arrive in the new session instead; the model sees only the handoff. It is display only. When the new session compacts, that history and the messages the compaction dropped fold into one line, `── N earlier messages, compacted ──`, which ctrl+o expands; it is still there after a resume. In `/tree` these lines are labelled entries (the labeled-only filter lists them as `lineage: handoff` and `lineage: compaction`), but the earlier sessions are not tree nodes. `/export` cannot be extended and leaves the earlier sessions out; it still holds the current session's own compacted messages. After an automatic handoff the new session picks the work up by itself, whatever the handoff Status; after `/handoff` it waits for you. A handoff switch starts a session marked as created from this one, so spending carries its totals over. The context thresholds are judged exactly as the footer judges them, the subagents agent view shows an agent nearing its own limit with the same notice, and the handoff format is shared with subagents; what the main session is told to write is its own.

## What it looks like

```
 » handoff at 175k tokens · 142.3k used

 » handoff requested · 175k of 175k tokens

 ✓ handoff
   ↳ Saved ~/…

 » handoff from the previous session
   ↳ This session continues the previous session, which reached its context limit. (ctrl+o to expand)
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/session-limits/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Keep working until the context grows | A warning notice below the editor shows the handoff threshold and the tokens used, then pi switches to a new session started from the handoff. |
| Watch the footer while the context grows | The `context N of X` figure counts toward the handoff point (X, the hard threshold), so a handoff is due when N reaches X. |
| `/handoff` | A "handoff requested" row appears in the transcript (no toast), the model saves a handoff with the `handoff` tool and ends its turn without a reply (the tool row shows the save), then pi switches to a new session started from it. |
| Type a message while the handoff is being written | The message appears in the chat under a `handing off, messages below go to the new session` line; the new session reads it after the handoff. |
| Ask the model to save a handoff on its own | The `handoff` tool refuses unless a handoff was requested. |
| `/handoff finish the login tests` | The same, with the text folded into the instruction and repeated in the new session's preface. |

## Development

```bash
npm run test -- extensions/session-limits   # this extension's unit tests
npm run check                               # typecheck, biome, knip, unit tests
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
