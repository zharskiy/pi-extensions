# extension-manager architecture

The plugin runtime every extension boots on. It imports only `platform/pi-adapter/index.ts` and `platform/shared/index.ts`; it never imports `platform/ui-kit/`, an extension or test code. Extensions reach it through `index.ts`, and only from their `api/` folder, which is their composition root. The plugin and bus types it works with live in `platform/shared/plugin/plugin-contract.ts`, so an extension's `core/` can name them without importing this folder.

## createManagedExtension

Each extension's `api/extension.ts` default-exports `createManagedExtension({ namespace, root, plugins, host?, settings?, childExclude?, skillInventory?, disabled?, onError? })` (`managed-extension.ts`). It resolves `childExclude` against `root`, builds a `boot(host, runtime, paths, overrides?)` and hands it to the adapter's `createPiExtension(boot, { root, namespace, childExclude, skillInventory })`. The pi factory it returns carries `boot` and the resolved `options`, so the test harnesses (`startExtension({ extension })` and `startLiveExtension({ extension })` in `test/framework/`) run the same boot on the fakes or on a live runtime without going through pi.

The boot:

1. Wraps the host when `host` is given (session-limits narrows it to the conversation).
2. When `settings` is given, starts from `defaults(paths)` and registers the reload in `host.onSessionStart` before any plugin enables, so every plugin's session-start handler sees the new values. The reload is either the user-then-project file merge (`schema` and `file`, through `loadSettingsFiles`) or the extension's own `reload(settings, info, runtime, notify)`. It patches one settings object in place, so plugins read `ctx.settings.x` at use time; errors are warnings named `<namespace> settings: …`, each reported once. Boot `overrides.settings` are applied after every reload.
3. Builds the manager with the plugins, the settings, `paths` (`root`, `agentDir`) and the ids `disabled(settings)` returns.
4. Registers `disableAll()` on session shutdown.
5. Rethrows errors unless `onError` is given; a plugin that throws while enabling fails the boot.

Thirteen extensions pass one plugin from `api/plugin.ts` whose `enable` wires host, core and ui; subagents passes eleven from `api/plugins.ts` with settings, `childExclude: [root]`, `skillInventory: true`, `disabled` and a notifying `onError`.

## The manager

`createExtensionManager` (`extension-manager.ts`):

- A `Plugin` is `{ id, requires?, enable(ctx) => disable? }`. `ctx` holds `host`, `runtime`, `bus`, `settings`, the service registry and `paths` (`root`, `agentDir`).
- Plugins are sorted topologically by `requires`; a cycle throws. A plugin in the disabled list is skipped silently; one whose required plugin is off or missing is skipped with one warning at session start.
- Plugins talk two ways: the service registry (`provide`, `require`, `has`; `require` throws when no enabled plugin provided the key) and the typed in-process bus (`createBus` in `bus.ts`, keyed by the extension's event map type; subagents uses `agent:changed`, `agent:turn`, `agent:closed`, `agent:usage`, `batch:settled`). A throwing bus listener goes to `onError`.
- `disableAll()` runs the disable callbacks in reverse order, one after another; a failing callback goes to `onError` and the rest still run.

## Settings

Each extension's settings are `<agentDir>/<file>` (user) and `<cwd>/.pi/<file>` (project, read only when the project is trusted). `parseSettings` (`platform/shared/plugin/settings-files.ts`) validates each known key against a schema (number range, string list, choice of strings, or an object with its own `parse`); invalid keys are dropped and reported, the rest applies. Settings are read once per session start, defaults then user then project, because pi builds a new extension per session; nothing reloads live. `reportSettingsErrors` (`settings-errors.ts`) is the once-per-message warning.
