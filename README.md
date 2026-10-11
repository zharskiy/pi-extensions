# pi-extensions

Extensions for the [pi coding agent](https://pi.dev), shipped as one pi package (`pi-subagents-mz`). Pinned to pi 1.1.0.

- [subagents](extensions/subagents/README.md): background agents run, watched, messaged and paid for from the main session.
- [session-limits](extensions/session-limits/README.md): the main session hands itself over to a new session before its context fills up.

## Install

```bash
pi install ./pi-extensions                      # local checkout; add -l for the current project only
pi install git:github.com/zharskiy/pi-extensions
```

Either installs both extensions. To try one for a single run without installing, pass its entry file:

```bash
pi -e ./pi-extensions/extensions/subagents/src/index.ts
pi -e ./pi-extensions/extensions/session-limits/src/index.ts
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

- `extensions/<name>/{src,test,prompts}`: one folder per extension, with its own README. `package.json` lists every entry file under `pi.extensions`.
- Only `extensions/<name>/src/adapter/` talks to pi; the rest of an extension depends on its own `src/adapter/contract.ts`, and only `test/adapter/` tests import pi.
- Extensions never import each other. They talk over pi's event bus (`pi.events`), for example the `session-limits:busy` channel.
- `test/architecture.test.ts` enforces these rules. `PLAN.md`, `docs/` and `research/` hold the plan, the deviations from it and the research behind it.
