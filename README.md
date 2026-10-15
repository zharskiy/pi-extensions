# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), shipped as one pi package (`pi-extensions-mz`). Version 0.4.0, for pi 1.2.0 or later within pi 1 (developed and tested against pi 1.2.0).

- [subagents](extensions/subagents/README.md): background agents run, watched and messaged from the main session, inside the main session's process, optionally in their own git worktree, with MCP for every agent with tools. A panel below the editor (under the footer block when the footer is installed) shows the running agents (`↓` to select, `←` for the list), `/agents` lists them and opens any agent's view, the `run_agent` block's rows show each agent's outcome, and agents never ask you anything; what they spend is reported to spending.
- [session-limits](extensions/session-limits/README.md): the main session hands itself over to a new session before its context fills up.
- [spending](extensions/spending/README.md): the session's total spend in the footer, the main session plus everything other extensions report, such as subagents at every depth.
- [working-indicator](extensions/working-indicator/README.md): pi's working line as a spinner, a playful verb and the elapsed time of the current prompt.
- [notifications](extensions/notifications/README.md): one terminal notification when pi waits for your input (after the work and any background agents are done) and one when a dialog waits unanswered.
- [command-aliases](extensions/command-aliases/README.md): friendlier names for built-in commands (`/continue`, `/clear`, `/exit`).
- [composer](extensions/composer/README.md): the input drawn between two full-width rules in the editor's colour, with a chevron prompt.
- [questionnaire](extensions/questionnaire/README.md): a `questionnaire` tool the main session's model uses to ask you a batch of independent multiple-choice questions in one inline form (tabs, number keys, a typed answer per question), with a notification when it waits.
- [style](extensions/style/README.md): `/style concise` makes the main session and every subagent answer in short, result-first replies; `/style normal` turns it off, and the footer shows the style while one is on.
- [context](extensions/context/README.md): `/context` prints what fills the context window into the transcript: a usage grid, the estimated tokens per category (system prompt, tools, memory files, skills, messages, free space, compaction reserve), the cache hit rate of the last turn and the session, and every file, skill and tool with `Ctrl+O`.
- [footer](extensions/footer/README.md): replaces pi's footer with a multi-line block right below the editor, above the subagents panel: context, session cache hit rate, cost, model, session total including agents, folder, branch, thinking level and the other extensions' statuses.

## Install

```bash
pi install ./pi-extensions                      # local checkout; add -l for the current project only
pi install git:github.com/zharskiy/pi-extensions
```

Either installs all extensions. To try one for a single run without installing, pass its entry file:

```bash
pi -e ./pi-extensions/extensions/subagents/src/index.ts
pi -e ./pi-extensions/extensions/session-limits/src/index.ts
pi -e ./pi-extensions/extensions/spending/src/index.ts
pi -e ./pi-extensions/extensions/working-indicator/src/index.ts
pi -e ./pi-extensions/extensions/notifications/src/index.ts
pi -e ./pi-extensions/extensions/command-aliases/src/index.ts
pi -e ./pi-extensions/extensions/composer/src/index.ts
pi -e ./pi-extensions/extensions/questionnaire/src/index.ts
pi -e ./pi-extensions/extensions/style/src/index.ts
pi -e ./pi-extensions/extensions/context/src/index.ts
pi -e ./pi-extensions/extensions/footer/src/index.ts
```

## Update

```bash
pi update --extensions              # git install
git -C pi-extensions pull           # local checkout; then /reload in pi
```

## Develop

```bash
npm install
npm run check                       # typecheck, biome, vitest; no credentials, no network
PI_LIVE_MODEL=provider/id:low npm run test:live   # real agents, local only, costs money
```

`npm run test:live` runs the `*.live.test.ts` files, which `npm run check` and CI never run. Set `PI_LIVE_MODEL=provider/id[:thinking]` to a model you have pi credentials for (in pi's agent dir, `~/.pi/agent/auth.json`, or the dir in `PI_CODING_AGENT_DIR`); without it, or without credentials, the live suites fail at once with a message saying what is missing. The runs never read that agent dir otherwise: each suite copies its `auth.json` (and `models.json`, if present) into a temporary agent dir and points pi at it, so your `AGENTS.md`, skills, extensions and MCP config stay out, and a token pi refreshes during a run is not written back. Everything they create lives in temporary directories.

## Layout

- `core/adapter/`: the shared pi adapter, the only code that imports pi. `contract.ts` is the interface every extension depends on; `pi-adapter.ts` exports `createPiExtension(boot, { root, namespace, childExclude })`. It knows nothing about any extension: each entry point passes its root, its namespace for custom entries and the source directories child sessions must not load.
- `core/manager/`: the shared plugin manager (ordering, typed bus, services), generic over each extension's event map, service map and settings, plus settings file helpers and the handoff format and channel names the extensions share, and the token and duration formatters (`format.ts`).
- `core/test/`: mirrors `core/`; `core/test/helpers/fakes.ts` holds the fake host, runtime and child shared by every extension's tests, and only `core/test/adapter/` tests import pi packages directly; the fake theme measures with the adapter's `textMetrics`.
- `extensions/<name>/{src,test,prompts}`: one folder per extension, with its own README. `src/index.ts` is the single entry that connects the extension's parts; `package.json` lists every entry file under `pi.extensions`.
- Outside `core/adapter` code imports only `core/adapter/contract.ts` and the shared `core/manager/` modules; each extension's `src/index.ts` may also import `core/adapter/pi-adapter.ts`. `core/` never imports from `extensions/`.
- Extensions never import each other. They talk over pi's event bus (`pi.events`), for example the `pi:busy`, `pi:awaiting-input` and `spending:usage` channels.
- `test/architecture.test.ts` enforces these rules, and that extension tests reach the adapter only through `contract.ts` and `core/test/adapter/`; biome (`biome.json`) enforces that only `core/adapter/` and `core/test/adapter/` import pi packages.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains how it works, [STRUCTURE.md](STRUCTURE.md) shows where things are, [AGENTS.md](AGENTS.md) is the short guide for coding agents.
