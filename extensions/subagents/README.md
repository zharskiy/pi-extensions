<div align="center">

# subagents

**Background agents the main session runs, watches, messages and stops, each with its own context.**

Part of [pi-extensions](../../README.md) · [Quick start](#quick-start) · [Development](#development) · [Contributing](#contributing)

</div>

## Why

A long task fills the main session's context with searches, edits and test output. This extension lets the main session delegate that work with `run_agent` to agents that run in the background, each with its own context. Every batch runs in the background: the caller, the main session or an agent that started agents of its own, is woken once per batch with all results, and the main session can check on, message and stop any agent. Until the model starts answering a batch's results, the work counts as still going, so the transcript's `worked` rule sits above the answer to the last results, not above a reply given while agents still run. Once session-limits has requested a handoff, results that arrive are not sent to the old session; they go into the new session's seed instead, and are sent as usual if the handoff is cancelled or fails. Starter agents ship with the package (a scout, a planner, an implementer, a reviewer and more), and you can add your own as Markdown files. After a handoff, `/fork` or `/clone` the new session lists the previous session's agents too, as finished agents you can open and read, also after you resume it. The handoff format is shared with session-limits, and an agent's handoff request and a successor's seed show in its view as the same rows. The agent view shows what the main session would show and nothing more: its header reads `working context 81.2k of 100k` in the footer's colours (warning past the soft level, bold error at the limit), the same `» handoff at 100k tokens · 81.2k used` notice appears above its hints while the agent runs past the soft level, a message you send it is a user row like its task, and a finished batch shows only as its block turning done; the agent itself is told nothing until its limit, when it is asked to hand off. The view of a chained agent shows every link's transcript in order, each closed by the same `── handed off · context limit ──` rule the main session draws after a handoff, with the successor's handoff row below it (it also holds the successor's copy of the task, so while that row is collapsed the task shows once, at the top), and keeps your place when a new link starts; a link it cannot read shows its error under the transcript, and a new link with nothing written yet only a dim note; what an agent is told to write is its own. After saving a handoff the agent ends without a reply; the tool row in its view shows the save. An agent that hands off while agents it started still run waits for them instead of stopping them, also when its context limit cut it off after the handoff was saved, and the agent that continues its work starts with all their results.

## What it looks like

```
 ✗ 3 agents · 4m 2s · 35 calls · 64.7k tokens · $0.25
   ↳ ✓ scout  Map the auth module · model-a:low
       1m 5s · 4 calls · 12.3k tokens · $0.04
     ✗ worker  Fix the login redirect · model-a:low
       tests failed twice · 2m 10s · 31 calls · 52.4k tokens · $0.21
     ⊘ reviewer  Review the diff of PR 5 · model-b:high
       Stopped · 3s · 0 calls · worktree removed
```

## Quick start

```bash
pi install git:github.com/zharskiy/pi-extensions   # the whole package
pi -e ./pi-extensions/extensions/subagents/index.ts   # this extension alone, from a checkout
```

Start pi and try:

| Try | What you see |
|---|---|
| Nothing running, empty prompt | The footer's hint row offers `← to list agents` (key dim, words muted), set as the `hint:subagents` status. |
| Ask for work that splits well, like "find every place we parse dates and review them" | The main session calls `run_agent`, ends its turn and is woken with every result once the batch is done. |
| `/agents` | The agents menu: view running and finished agents, set up models and skills, create a new agent. `c` in an agent's view (hinted "c to copy request") copies its request (the provider payload) to the clipboard, through pi's own clipboard routes; over SSH this needs a terminal that accepts OSC 52 (set `PI_CLIPBOARD_OSC52=1` for a remote tmux attach). The letter keys (`x`, `shift+x`, `r`, `c`) also work in a Russian, Ukrainian or Belarusian layout, on the same physical keys. |
| `/agents setup` | The main session proposes up to five skills for each lead agent (an agent that may start subagents, `general` included) from what it sees of the project (it asks first once some agent other than a chore has its skills set, Yes preselected), then a form with one tab per agent, leads on a `Leads` row and chores on a `Chores` row, shows the proposal to change or confirm: model, thinking level and, for leads, skills (a chore's skills are shown but fixed). Each tab lists the fields with a ` (changed)` mark and two preset rows, `Previous` (the settings the agent has now) and, for a lead with a proposal, `Suggested`; Enter on a preset applies it, and the one equal to the current choice reads ` (in use)`. The skills list starts with an `all` row that gives the agent every skill its caller has; type in any picker to filter it, and the description of the skill under the cursor shows below the list. An open picker fits inside the rows the fields, presets and info lines occupy under the agent's name, with the filter beside its title, so the form keeps one height at a given width across tabs and while any picker is open (the tab bar still wraps at narrow widths), and nothing shifts as you move between tabs, open a picker or scroll and filter it; the Submit tab lists each change as `name: field new (was old)`, every one that fits above the file choice, with `... (N more items)` on the last row only when they do not all fit. The one-line form, `/agents setup <agent> model=… thinking=… skills=…`, refuses `skills=` on a chore. In a project you have not trusted it saves to your user file, which applies to every project. Saving to the project creates `.pi/` when needed, with a `.pi/.gitignore` (`*`) that keeps it out of git; delete that file to track `.pi/`. After a proposal is saved, the main session tells you and suggests `/new` to free the tokens the setup took. |
| `/agents create` | The main session asks what the new agent should do and writes its file. |
| While agents run, "stop the reviewer, I changed my mind" | The main session calls `stop_agent` with the agent's id: it stops at once, with no grace period, and its result, with any partial output and the reason (`stopped by the main session: …`), still arrives with the rest of its batch. The main session does not restart it unless you ask. It stops only agents it started, and only when you ask or their work is no longer needed; an agent that starts agents of its own can stop those the same way. |
| Esc in an empty prompt while agents run | Asks `Stop running agents?`: Yes stops them (running ones get their grace), No leaves them. Esc while pi is working interrupts pi first; press it again to stop agents. While agents run, use `/tree` instead of double Esc. With no agent running, Esc is pi's own. |

<details>
<summary>What you need</summary>

A model configured in pi. The shipped agents name specific models; without credentials for those, pick one of your models per agent with `/agents setup`. An agent file without a `model` line runs on the main session's model.

</details>

## Development

```bash
npm run test -- extensions/subagents   # this extension's unit tests
npm run check                          # typecheck, biome, knip, unit tests
PI_LIVE_MODEL=provider/id[:thinking] npm run test:live    # real agents, local only, costs money
PI_LIVE_MODEL=provider/id[:thinking] npm run evals        # prompt-quality evals, local only, costs money
```

The full set of commands is in the root README's [Development](../../README.md#development) section; rules for coding agents are in [AGENTS.md](../../AGENTS.md).

## Contributing

Issues and pull requests at [github.com/zharskiy/pi-extensions](https://github.com/zharskiy/pi-extensions) are welcome. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are.
