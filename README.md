<div align="center">

# pinata

**Background agents, session awareness and a calmer terminal for the [pi coding agent](https://pi.dev).**

Fifteen extensions in one pi package (`@zharskiy/pinata`), built on one small shared platform.

[![CI](https://github.com/zharskiy/pinata/actions/workflows/ci.yml/badge.svg)](https://github.com/zharskiy/pinata/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick start](#quick-start) · [Sandbox](#sandbox) · [Development](#development) · [Contributing and licence](#contributing-and-licence)

</div>

## Why

Pi is a lean, extensible coding agent. This package adds what a long working day needs on top of it. The main session delegates work to background agents and keeps its own context for judgement. It hands itself over to a fresh session before its context fills, and it shows what everything costs. The terminal stays quiet and readable while all of that runs.

## What it looks like

```
 ✓ read src/stats.py:5-14
   ↳ 10 lines

 ✗ 3 agents · 4m 2s · 35 calls · 64.7k tokens · $0.25
   ↳ ✓ scout  Map the auth module · model-a:low
       1m 5s · 4 calls · 12.3k tokens · $0.04
     ✗ worker  Fix the login redirect · model-a:low
       tests failed twice · 2m 10s · 31 calls · 52.4k tokens · $0.21

 ── ⠹ Pondering · 12s (esc to interrupt) ─────────────────────────────

 my-project on main · session-name                    model-name · thinking high
 context 13.0k of 163k · cache 73%                         851.3k tokens · $0.34
 shift+tab to cycle thinking · ← to list agents
```

Tool rows from [transcript](extensions/transcript/README.md), an agent batch from [subagents](extensions/subagents/README.md), the working line from [working-indicator](extensions/working-indicator/README.md) and the status block from [footer](extensions/footer/README.md).

## Quick start

```bash
pi install npm:@zharskiy/pinata                    # the whole package, without the sandbox; pi update --extensions updates it
pi install ./pinata                                # from a local checkout; add -l for the current project only
pi -e ./pinata/extensions/<name>/index.ts          # one extension for a single run, from a checkout; git pull, then /reload in pi
```

To run pi in the sandbox with them, install with `pinata` instead ([Install, update and uninstall](#install-update-and-uninstall)).

The package installs fifteen extensions:

**Agents and tools**

- **[subagents](extensions/subagents/README.md)**: background agents you run, watch, message and stop from the main session, optionally in their own git worktree, with MCP tools. A panel below the editor and an `/agents` overlay.
- **[questionnaire](extensions/questionnaire/README.md)**: a tool the model uses to ask you a batch of multiple-choice questions in one inline form.
- **[style](extensions/style/README.md)**: `/style concise` for short, result-first replies from the main session; `/style normal` turns it off.
- **[mcp-import](extensions/mcp-import/README.md)**: `/mcp-import <claude|cursor>` copies MCP servers into pi's `mcp.json`. A dry run unless you add `apply`.

**Session awareness**

- **[session-limits](extensions/session-limits/README.md)**: hands the main session over to a new session before its context fills up.
- **[spending](extensions/spending/README.md)**: the session's total spend in the footer, subagents at every depth included.
- **[context](extensions/context/README.md)**: `/context` shows what fills the context window, per category, with cache hit rates.
- **[notifications](extensions/notifications/README.md)**: one terminal notification when pi waits for your input or a dialog waits unanswered.
- **[prune](extensions/prune/README.md)**: removes sessions, agent runs and handoff folders untouched for 180 days (`days`), keeping every session whose chain (sessions linked by parent, either way) holds an open or recent one; `/prune` shows what each interval would remove and asks before it removes, or sets the automatic interval.
- **[model-default](extensions/model-default/README.md)**: the model and thinking level you last picked (Enter in the selector, `/model <name>`, cycling, Shift+Tab) become pi's saved defaults, as Ctrl+S does, and a model switch keeps your thinking level.

**Look and feel**

- **[footer](extensions/footer/README.md)**: a three-line status block: folder, branch, model, thinking level, context, cache, cost and a key-hint row.
- **[transcript](extensions/transcript/README.md)**: tool calls as state rows: a glyph, a title and a one-line outcome you expand with `ctrl+o`.
- **[composer](extensions/composer/README.md)**: the input drawn between two full-width rules, with pi's `›` cursor as the prompt.
- **[working-indicator](extensions/working-indicator/README.md)**: a rotating verb and the elapsed time next to pi's spinner (`Pondering · 12s`).
- **[command-aliases](extensions/command-aliases/README.md)**: friendlier names for built-in commands: `/continue`, `/clear`, `/exit`.

Start pi and try:

| Try | What you see |
|---|---|
| `/agents` | The agents menu: view running and finished agents, set up models, create a new agent. |
| `/context` | What fills the context window, with cache hit rates. |
| `/style concise` | Short, result-first replies from the main session; subagents are unaffected. |

<details>
<summary>Coming from another tool</summary>

- **Skills:** nothing to do when they live in `.agents/skills`. Pi reads `~/.agents/skills` and `.agents/skills` as well as its own `~/.pi/agent/skills` and `.pi/skills`.
- **Agent definitions and instruction files:** pi reads `AGENTS.md` and `CLAUDE.md` as they are. Rewrite agents by hand: `/agents create <name>` sets up a new agent (see [subagents](extensions/subagents/README.md)), then copy the old prompt into its body.
- **MCP servers:** `/mcp-import claude` or `/mcp-import cursor` (add `project` for the project's servers) shows what it would copy; add `apply` to write it, then `/reload`. OAuth sign-ins do not transfer: sign in again with `/mcp`.

</details>

## Sandbox

The package also ships pinata, a host-side command that runs pi in a per-repository Linux container on a Colima VM (macOS). After `pinata install`, `cd repo && pi` starts pi with your providers, MCP servers, settings and packages, but the container holds placeholders instead of credentials, and its only network exit is a proxy on the host that allows a list of hosts and injects the real credentials there. `pi --no-sandbox` runs host pi. See the [pinata README](launcher/README.md), its [configuration reference](launcher/CONFIGURATION.md) and its [threat model](launcher/THREAT-MODEL.md).

### Install, update and uninstall

```bash
npm install -g --legacy-peer-deps @zharskiy/pinata@<version>   # macOS with Homebrew and Node 22.19 or newer
pinata install [--pi <version>] [--config <file>] [--yes]
pinata update [<version>] [--pi <version>]
pinata uninstall
pinata list                                                    # the sandbox VM and the pi sessions in it
```

`pinata install` installs Colima with Homebrew when it is missing, makes sure there is a host pi, registers the package with it, links `~/.local/bin/pi` to pinata, puts `~/.local/bin` on `PATH` in `~/.zshrc` (and in `~/.bashrc` and `~/.bash_profile` when they exist) and runs `pinata init`. Run again, it changes nothing. In a checkout, run `npm install`, then `node launcher/bin/pinata-dev.js install`; `pinata update` refuses there (`git pull`, then install again). Details: [pinata README](launcher/README.md#install).

**Versions are yours to pick.** The package version is the one you install, `@zharskiy/pinata@<version>` or `pinata update <version>` (`latest` by default), and pi loads the extensions of that same version, pinned as `npm:@zharskiy/pinata@<version>` in pi's settings, which `pi update --extensions` does not move. `--pi <version>` installs that pi version with npm; without it a host pi you have stays as it is, and a missing one gets the version pinata is tested with. A bare `pi update` moves an npm pi to the latest version, so pin it again with `pinata install --pi <version>`. `--pi` is refused while pi's managed install exists in `~/.pi/agent`, since pinata runs that one first; remove it with `curl -fsSL https://pi.dev/install.sh | sh` and Uninstall Pi. Pi in the sandbox follows the host pi. How releases are made: [RELEASING.md](RELEASING.md).

**One config for a team.** `--config <file>` checks the file before anything changes, then writes it over `~/.pi/agent/pinata/config.json`, with no merge, on every install that passes it.

**Uninstall.** `pinata uninstall`, with no pi session running in the sandbox, deletes the sandbox VM with its containers, volumes and images, the `pi` link, the package's source in pi, the `PATH` blocks, pinata's state and the npm package. Your config, pi's sessions, pi and Colima stay.

**Coming from the shell installer.** An install made with `launcher/install.sh` owns the `pinata` bin through the npm package `pi-extensions-mz`: run `npm uninstall -g pi-extensions-mz` before you install `@zharskiy/pinata`. A `pi install git:github.com/zharskiy/pi-extensions` source loads next to the new one and their tools clash: remove it with `pi remove <source>`.

## Development

```bash
npm install
npm run check                                     # typecheck, biome, knip, unit tests; no credentials, no network
npm run test                                      # unit tests only
PI_LIVE_MODEL=provider/id:low npm run test:live   # live tests with real agents, local only, costs money
PI_LIVE_MODEL=provider/id:low npm run evals       # prompt-quality evals with real agents, local only, costs money
```

`npm run check` is what CI runs. Live tests and evals never run in CI. Rules for coding agents are in [AGENTS.md](AGENTS.md); the evals are described in [test/evals/README.md](test/evals/README.md).

<details>
<summary>How live tests and evals use your credentials</summary>

Both need `PI_LIVE_MODEL=provider/id[:thinking]` set to a model you have pi credentials for (in pi's agent dir, `~/.pi/agent/auth.json`, or the dir in `PI_CODING_AGENT_DIR`). The optional `PI_LIVE_CHORE_MODEL` puts the chore agents on a second model. Without it, or without credentials, they fail at once with a message saying what is missing.

Each suite links your `auth.json` (and copies `models.json`, if present) into a temporary agent dir and points pi at it. Your `AGENTS.md`, skills, extensions and MCP config stay out. A token pi refreshes during a run goes through the link into the real file, so it is not lost. Everything they create lives in temporary directories, except the evals' results in the gitignored `test/evals/.results/`.

</details>

## Contributing and licence

Issues and pull requests are welcome. Run `npm run check` before you open one. Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [STRUCTURE.md](STRUCTURE.md) for where things are. Released under the [MIT licence](LICENSE).
