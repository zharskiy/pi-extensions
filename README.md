# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), shipped as one pi package (`pi-extensions-mz`). Version 0.3.0, developed and tested against pi 1.1.0.

- [subagents](extensions/subagents/README.md): background agents run, watched and messaged from the main session, inside the main session's process, optionally in their own git worktree, with a context breakdown per agent, terminal notifications and MCP for every agent with tools; what they spend is reported to spending.
- [session-limits](extensions/session-limits/README.md): the main session hands itself over to a new session before its context fills up.
- [spending](extensions/spending/README.md): the session's total spend in the footer, the main session plus everything other extensions report, such as subagents at every depth.
- [working-indicator](extensions/working-indicator/README.md): pi's working line as a spinner, a playful verb and the elapsed time of the current turn.
- [command-aliases](extensions/command-aliases/README.md): friendlier names for built-in commands (`/continue`, `/clear`, `/exit`).
- [composer](extensions/composer/README.md): the input box drawn with a rounded border in the editor's colour and a chevron prompt.

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
pi -e ./pi-extensions/extensions/command-aliases/src/index.ts
pi -e ./pi-extensions/extensions/composer/src/index.ts
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
- `core/manager/`: the shared plugin manager (ordering, typed bus, services), generic over each extension's event map, service map and settings, plus settings file helpers and the handoff format and channel names the extensions share.
- `core/test/`: mirrors `core/`; `core/test/helpers/fakes.ts` holds the fake host, runtime and child shared by every extension's tests, and only `core/test/adapter/` tests import pi.
- `extensions/<name>/{src,test,prompts}`: one folder per extension, with its own README. `src/index.ts` is the single entry that connects the extension's parts; `package.json` lists every entry file under `pi.extensions`.
- Outside `core/adapter` code imports only `core/adapter/contract.ts` and the shared `core/manager/` modules; each extension's `src/index.ts` may also import `core/adapter/pi-adapter.ts`. `core/` never imports from `extensions/`.
- Extensions never import each other. They talk over pi's event bus (`pi.events`), for example the `session-limits:busy` and `spending:usage` channels.
- `test/architecture.test.ts` enforces these rules for production code only; biome (`biome.json`) enforces that only `core/adapter/` and `core/test/adapter/` import pi packages.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains how it works, [STRUCTURE.md](STRUCTURE.md) shows where things are, [AGENTS.md](AGENTS.md) is the short guide for coding agents. `research/` holds the pi API notes the adapter was built from.
