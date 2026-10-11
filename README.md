# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), shipped as one pi package (`pi-extensions-mz`). Pinned to pi 1.1.0.

- [subagents](extensions/subagents/README.md): background agents run, watched and messaged from the main session; what they spend is reported to spending.
- [session-limits](extensions/session-limits/README.md): the main session hands itself over to a new session before its context fills up.
- [spending](extensions/spending/README.md): the session's total spend in the footer, the main session plus everything other extensions report, such as subagents at every depth.

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
```

## Update

```bash
pi update --extensions              # git install
git -C pi-extensions pull           # local checkout; then /reload in pi
```

## Develop

```bash
npm install
npm run check                       # typecheck, biome, vitest
```

## Layout

- `core/adapter/`: the shared pi adapter, the only code that imports pi. `contract.ts` is the interface every extension depends on; `pi-adapter.ts` exports `createPiExtension(boot, { root, namespace, childExclude })`. It knows nothing about any extension: each entry point passes its root, its namespace for custom entries and the source directories child sessions must not load.
- `core/manager/`: the shared plugin manager (ordering, typed bus, services, contribution report), generic over each extension's event map, service map and settings, plus settings file helpers and session data paths.
- `core/test/`: mirrors `core/`; `core/test/helpers/fakes.ts` holds the fake host, runtime and child shared by every extension's tests, and only `core/test/adapter/` tests import pi.
- `extensions/<name>/{src,test,prompts}`: one folder per extension, with its own README. `src/index.ts` is the single entry that connects the extension's parts; `package.json` lists every entry file under `pi.extensions`.
- Outside `core/adapter` code imports only `core/adapter/contract.ts` and the shared `core/manager/` modules; each extension's `src/index.ts` may also import `core/adapter/pi-adapter.ts`. `core/` never imports from `extensions/`.
- Extensions never import each other. They talk over pi's event bus (`pi.events`), for example the `session-limits:busy` and `spending:usage` channels.
- `test/architecture.test.ts` enforces these rules. `PLAN.md`, `docs/` and `research/` hold the plan, the deviations from it and the research behind it.
