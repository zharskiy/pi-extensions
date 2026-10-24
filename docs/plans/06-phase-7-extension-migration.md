# 06 · Phase 7 per-extension migration brief

One agent migrates one extension `<name>` from `src/` to `index.ts api/ core/ ui/ tests/` on `createManagedExtension`, with no behaviour change. Read first: [00-master-plan.md](00-master-plan.md) Phase 7, [02-target-architecture.md](02-target-architecture.md) §2.2, §3 (R6–R11, R14), §4 and the §5 table for `<name>`. Do not commit; the user reviews and commits.

## Worktree

```sh
git worktree add ../pi-ext-<name> -b refactor/phase-7-<name> refactor/modular-architecture
ln -s <main>/node_modules <worktree>/node_modules
```

Run every command from the worktree root. Do not run `npm install`, `git reset` or `git stash`, and do not run live tests (`npm run test:live`) unless the user asks.

## Scope

Edit only `extensions/<name>/**`. Off-limits, because the other migrations run in parallel and the shared wiring is already done:

- `package.json`, `package-lock.json`, `knip.json`, `biome.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.live.config.ts`, `.github/**`, `test/architecture.test.ts`.
- Root `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`, `docs/**`, `future-plans/**`. Their `src/` mentions are rewritten in Phase 9.
- `pi-adapter/`, `extension-manager/`, `ui-kit/`, `shared/`, `test-framework/`, `evals/`, every other `extensions/<other>/`.

If the migration cannot be done without one of these (a symbol missing from a root `index.ts`, a config gap, a lint rule that blocks the target layout), stop and report what is needed and why. Do not work around it.

## What is already in place

- `extensions/<name>/index.ts` is the entry, listed in `package.json#pi.extensions`. Today it is the shim `/** @public */ export { default } from "./src/index.ts";`.
- `files` publishes `extensions/*/index.ts`, `extensions/*/{api,core,ui}/**` and `extensions/*/src/**` (no `tests/`); knip's entry is `extensions/*/index.ts`.
- `test/architecture.test.ts` requires each `index.ts` to hold only `export … from "./api/…"` (or `./src/…` until migrated) and every `pi.extensions` entry to exist.
- The Biome overrides for `extensions/*/core/**`, `extensions/*/ui/**` and `extensions/*/tests/**` are on and match as soon as the folders exist.

## Target layout

```
extensions/<name>/
├── index.ts          only re-exports from ./api/
├── api/              extension.ts (createManagedExtension), plugin.ts (the Plugin), types.ts if another extension needs types
├── core/             logic, no rendering
├── ui/               rendering, forms, overlays, key handling (omit if empty)
├── tests/            *.test.ts, *.live.test.ts, fixtures; helpers in tests/support/
├── README.md  ARCHITECTURE.md  STRUCTURE.md
└── prompts/ agents/  unchanged where they exist
```

Follow the 02 §5 row for every file; `[split]` rows are the only logic cuts. Source depth stays ≤ 3 below `extensions/<name>/`. No `src/` remains. Keep basenames unique inside the extension among non-index, non-test files.

## index.ts and the shim

Replace the shim with re-exports from `api/`, keeping the tag on the default:

```ts
/** @public */
export { default } from "./api/extension.ts";
```

Only `export … from "./api/…"` statements; no `export *` (Biome `noReExportAll`), no code. Add `export type { … } from "./api/types.ts"` only when another extension or `evals/` imports the type today (none do); knip (`includeEntryExports`) flags unused entry exports, so remove rather than tag them. No `/** @public */` is needed in `api/extension.ts`.

## createManagedExtension for a plain extension

`api/plugin.ts` wraps today's boot callback in one plugin; `enable` returns `undefined` (nothing to undo, as today) or a `Disable`:

```ts
export const <name>Plugin: Plugin<never, {}, Settings | undefined> = {
  id: "<name>",
  enable({ host, runtime, settings, paths }) { create<Name>(host, …); return undefined; },
};
```

`api/extension.ts` (options in `extension-manager/managed-extension.ts`):

```ts
export default createManagedExtension({
  namespace: "pi-<name>",                       // the namespace src/index.ts passes today, unchanged
  root: resolve(import.meta.dirname, ".."),     // extension root; api/ sits one level down as src/ did
  plugins: [<name>Plugin],
});
```

- `ctx.paths.root` replaces the `paths.root` the old callback read (style, session-limits prompts). `ctx.paths.agentDir` is there too.
- `host?: (host) => Host` wraps the host before anything sees it (session-limits: `host: conversationOnly`).
- `settings?` replaces a hand-written `watchSettings(...)` call. Two variants, both with `defaults(paths) => C`:
  - files: `{ defaults: () => defaults, schema, file: SETTINGS_FILE }`; the manager loads the user and project files on every session start before any plugin's session-start handler and reports errors as warnings under `namespace`;
  - custom: `{ defaults, reload(settings, info, runtime, notify) }`, patching `settings` in place (subagents).
  Plugins read `ctx.settings.x` at use time; the object is patched in place, matching today's getter semantics.
- `childExclude?` (resolved against `root`), `skillInventory?`, `disabled?(settings)`, `onError?(error, host)`: plain extensions pass none of them today and keep it that way. `onError` defaults to rethrow, as a plain boot error propagates to pi today.
- The manager registers `onSessionShutdown → disableAll()`; do not add your own.

## Layer rules (Biome, exact)

- `core/**` (R7): may import own `core/`, `shared/index.ts`, `pi-adapter/index.ts`. Banned: pi packages (`@earendil-works/*`, `typebox`), `pi-adapter/**` and `shared/**` except their `index.ts`, all of `extension-manager/**` and `ui-kit/**`, any other extension, `test-framework/`, `evals/`, `test/`, and own `ui`, `ui/**`, `api`, `api/**`, `index.ts` (as `../ui/…` at `core/*.ts`, `../../ui/…` one level deeper, and so on). Plugin contract types come from `shared/index.ts`, not `extension-manager/`.
- `ui/**` (R8): may import own `ui/`, own `core/`, `ui-kit/index.ts`, `shared/index.ts`, `pi-adapter/index.ts`. Banned: pi packages, the three roots except their `index.ts`, all of `extension-manager/**`, any other extension, test code, own `api`, `api/**`, `index.ts`.
- `api/**` (R9, composition root): may import own `api/`, `core/`, `ui/`, the four roots through `index.ts` only, and another extension only through `extensions/<other>/index.ts`; no pi packages, no test code.
- `index.ts` (R10): only `export … from "./api/…"`.
- `tests/**` (R11): anything in the extension, `test-framework/**` (incl. `pi/`), the four roots through `index.ts`, another extension only through its `index.ts`; never `evals/`.
- No import cycles (R1), no unused exports, files, locals or parameters (R15).

## Tests

Tests already live in `tests/` (Phase 3). Rewrite their imports from `../src/…` to the new `../core/…`, `../ui/…`, `../api/…` paths; move local helpers into `tests/support/`. Assertions stay unchanged apart from import paths. Tests that booted `src/index.ts` boot the extension through `startExtension({ extension, runtime })` from `test-framework/index.ts`, or the plugin through `startExtension({ plugins: [<name>Plugin], settings, root, runtime })`.

## Docs inside the extension

- `ARCHITECTURE.md`: what the extension does at runtime (hooks, channels, settings, session entries), copied from the extension's section of the root `ARCHITECTURE.md` and its README's architecture paragraph, then corrected to the new paths. Leave the root file alone.
- `STRUCTURE.md`: the file map of `index.ts`, `api/`, `core/`, `ui/`, `tests/`, one line per file.
- `README.md`: rewrite the `src/…` paths (the architecture paragraph, any `pi -e …/src/index.ts`) to the new ones.

## Acceptance

1. `npm run check` green (typecheck, Biome with zero `noRestrictedImports` findings, knip, all unit tests).
2. `npx vitest run extensions/<name>` green.
3. `grep -rn 'src/' extensions/<name>` empty. Hits that are test data unrelated to the folder (e.g. a fixture path `src/auth.ts`) are allowed; list them in the report.
4. `git status` shows changes only under `extensions/<name>/`.

Report: files moved (old → new), the `[split]` cuts made, check summary lines, the grep result and anything that needed a shared file.
