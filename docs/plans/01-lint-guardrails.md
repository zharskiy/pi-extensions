# 01 Lint guardrails

Status: research done, nothing applied. Verified against the installed Biome 2.5.15, knip 6.43.0 (installed in a scratch dir, not the repo), TypeScript 7.0.2 and Node 26 locally (CI uses Node 22). "Verified" means a rule was run on a scratch fixture or on a copy of this repo; anything else is marked **unverified**.

## Summary

| Area | Biome 2.5.15 | Gap filled by |
| --- | --- | --- |
| Import cycles | `suspicious/noImportCycles` (stable, not in `recommended`, must be enabled) | — |
| Layering / import restrictions | `style/noRestrictedImports` with `patterns[].group` gitignore globs, one override per source folder depth | — (a small structure test caps folder depth) |
| Unused locals, imports, params, private members | `noUnusedVariables`, `noUnusedImports`, `noUnusedFunctionParameters`, `noUnusedPrivateClassMembers` | — |
| Unused exports, exported types, enum members, files, dependencies | not available (no cross-file "unused export" rule, nothing in nursery) | **knip 6** |
| Unused public class members | not available | nobody (knip 6 dropped `classMembers`); convention: make non-API members `private`/`#` |

Recommended toolchain: **Biome** (cycles, layering, local dead code) + **knip 6** (project-level dead code) + **tsc** (types only; its `noUnused*` flags duplicate Biome). No ESLint. dependency-cruiser only if the per-depth Biome overrides become a burden.

Key findings:

- `noRestrictedImports` matches the **import specifier as written**, not the resolved path. Relative specifiers change with folder depth, so every directional rule needs one override per depth. With depth ≤ 3 below `extensions/<name>/` that is 9 overrides (fixture: 23 of 23 bad imports flagged, 0 false positives).
- Overrides do **not merge** options of the same rule: the last matching override wins, so each override carries the full pattern list (verified).
- `!` negation works in both `files.includes` and `overrides[].includes`, and inside `group` (later entries win, gitignore style). Character classes (`[!.]`) are rejected by the config parser.
- `noPrivateImports` + `@package` scopes a symbol to **its own directory and subdirectories**, not to a package or an extension (a nested `package.json` does not change this). It can not express "other extensions use only `index.ts`" without also blocking `api/ → core/`. Re-exports through a barrel are not checked. Not a replacement for `noRestrictedImports`; keep it on as an opt-in `@package`/`@private` tag.
- `noImportCycles` needs no extra config in 2.5.15 (the project scanner starts automatically; `files.experimentalScannerIgnores` is deprecated in favour of `!!` force-ignore in `files.includes`). Cost on this repo: lint 0.108 s → 0.128 s for 348 files. It already finds one real cycle today: `core/adapter/pi-footer.ts → pi-notice.ts → pi-ui.ts → pi-footer.ts`.
- knip 6 parses with oxc and does not use the TypeScript API, so TypeScript 7 (which ships no classic JS API: `typescript` has no `main`, only `./unstable/*`) is not a problem. Run on a repo copy: 0.28 s, 1 unused file, 7 unused exports, 3 unused exported types. Tools that need the classic TS API (`ts-unused-exports`, `ts-prune`, knip 5 `classMembers`, madge's TS support) would need a second, older `typescript` install.


## Guardrail matrix

Rule numbers R1–R16 refer to [02-target-architecture.md](02-target-architecture.md) section 3.

| # | Guardrail | Rule | Tool | Rule / config | Verified |
| --- | --- | --- | --- | --- | --- |
| 1 | No import cycles | R1 | Biome | `suspicious.noImportCycles: "error"` (`ignoreTypes` default `true`: `import type` breaks a cycle, `import { type X }` does not) | yes |
| 2 | Only `pi-adapter/**` and `test-framework/pi/**` import `@earendil-works/*`, `typebox` | R2 | Biome | group `@earendil-works/*`, `@earendil-works/*/**`, `typebox`, `typebox/**` in every other override; `test-framework/pi/**` override listed after `test-framework/**` drops it | yes (pattern); exemption ordering by the "last override wins" finding |
| 3 | `pi-adapter` imports nothing from the repo; `types/` imports only `types/` | R3 | Biome | override `pi-adapter/**`: `**/extensions/**`, `**/extension-manager/**`, `**/ui-kit/**`, `**/shared/**`, `**/test-framework/**`, `**/evals/**`, `**/test/**`; `pi-adapter/types/**` adds `../**`; `pi-adapter/tests/**` lifts the test-framework ban | yes (same pattern kind as before) |
| 4 | `extension-manager` imports only `pi-adapter/index.ts`, `shared/index.ts` | R4 | Biome | override `extension-manager/**`: barrels for the two, `**/ui-kit/**`, `**/extensions/**`, test code | yes |
| 5 | `shared` imports only `pi-adapter/index.ts`; `ui-kit` only that and `shared/index.ts` | R5 | Biome | overrides `shared/**`, `ui-kit/**`; their `tests/**` lift the test-framework ban | yes |
| 6 | Extensions reach the four roots only through `index.ts`; never test code | R6 | Biome | `**/<root>/**` + `!**/<root>/index.ts` for pi-adapter, extension-manager, ui-kit, shared; `**/test-framework/**`, `**/evals/**`, `**/test/**` (depth independent because `**` matches `..`) | yes |
| 7 | Another extension only through `extensions/<name>/index.ts`, and only from `api/` | R6, R9 | Biome | per depth d: `"../"×(d+1) + "*/**"`, `"!" + "../"×(d+2) + "**"`, `"!" + "../"×(d+1) + "*/index.ts"`; the `core/` and `ui/` overrides omit the last negation, so they ban other extensions entirely | yes, depths 0–3 |
| 8 | `core/` does not import `ui/`, `api/`, own `index.ts`, `ui-kit/`, `extension-manager/` | R7 | Biome | per core depth d: `"../"×d + {ui, ui/**, api, api/**, index.ts}` plus `**/ui-kit/**`, `**/extension-manager/**` | yes, depths 1–3 |
| 9 | `ui/` does not import `api/`, own `index.ts`, `extension-manager/` | R8 | Biome | per ui depth d: `"../"×d + {api, api/**, index.ts}` plus `**/extension-manager/**` | same pattern kind as row 8 |
| 10 | `api/` may import `core/`, `ui/` and all four roots; `tests/` any own internals plus `test-framework/**` | R9, R11 | Biome | allowed by default; `extensions/*/tests/**` overrides (depths 1–3) drop the test-framework ban | yes |
| 11 | `test-framework/` reaches the roots through `index.ts`, never extensions or evals; `pi/**` may import pi packages and `pi-adapter/**` internals; pi-free modules never import `pi/**` | R12 | Biome | overrides `test-framework/**`, then `test-framework/*.ts` + `live/**` + `eval-runs/**` adding `./pi/**`, `../pi/**`, then `test-framework/pi/**` lifting the pi-package and adapter-barrel bans | pattern for `./pi/**` **unverified**: the architecture test keeps the check until a fixture confirms it |
| 12 | `evals/` reaches extensions through `index.ts` or `tests/support/**`; nothing imports `evals/` | R13 | Biome | override `evals/**`: `**/extensions/*/**`, `!**/extensions/*/index.ts`, `!**/extensions/*/tests/support/**`; `**/evals/**` in every other override | yes (negation order) |
| 13 | `index.ts` holds only `export … from "./api/…"` | R10 | vitest | `test/architecture.test.ts` | n/a |
| 14 | Folder shape, depth ≤ 3, `*.test.ts` only in `tests/`, `*.eval.ts` only in `evals/`, no `src/` | R14 | vitest | `test/architecture.test.ts` | n/a |
| 15 | Unused imports, locals, functions, types, classes, enums (file-local) | R15 | Biome | `noUnusedImports`, `noUnusedVariables` at `error` (recommended sets them to warn) | yes |
| 16 | Unused function parameters | R15 | Biome | `noUnusedFunctionParameters: "error"` | yes |
| 17 | Unused private class members | R15 | Biome | `noUnusedPrivateClassMembers: "error"` | yes |
| 18 | Unused public class members | R15 | none | knip 6 has no `classMembers` (issue types: files, dependencies, devDependencies, optionalPeerDependencies, unlisted, binaries, unresolved, exports, nsExports, types, nsTypes, enumMembers, namespaceMembers, duplicates, catalog, catalogReferences, cycles). Convention: non-API members `private`/`#` (only 4 classes in the repo) | yes (absence) |
| 19 | Unused exports (incl. `index.ts` exports no other extension uses) | R15 | knip | `includeEntryExports: true`; pi's default export tagged `/** @public */` | yes |
| 20 | Unused exported types, enum members, files, dependencies | R15 | knip | `types`, `enumMembers`, `files` (entries for spawned fixtures), `dependencies`, `devDependencies`, `unlisted` | yes |
| 21 | Barrels | — | Biome | `noBarrelFile: "off"` (each `index.ts` is a deliberate barrel), `noReExportAll: "error"` (explicit re-exports keep the public surface reviewable) | yes |
| 22 | Module imports itself | R1 | Biome | `nursery.noSelfImport: "error"` (nursery: may change) | schema only |
| 23 | Package-private symbols | — | Biome | `noPrivateImports: "error"`, opt-in `/** @package */` = own dir + subdirs, `@private` = own file | yes |
| 24 | `pi.extensions` lists exactly the 13 `extensions/*/index.ts`; `npm pack` ships them and no test code | — | vitest + CI | `test/architecture.test.ts` compares `package.json#pi.extensions` with the folder list; CI `npm pack --dry-run` grep (plan 03 §5) | n/a |
| 25 | Unique basenames among the layer folders `pi-adapter`, `shared`, `ui-kit`, `extension-manager` | R14 | vitest | `test/architecture.test.ts` | n/a |
| 26 | `subagents` cross-plugin isolation across `api/plugins/<p>.ts`, `core/<p>/**`, `ui/<p>/**` | R14 | vitest | `test/architecture.test.ts` | n/a |
| 27 | Relative imports normalised (no `./../`) so the Biome path rules cannot be bypassed | R14 | vitest | `test/architecture.test.ts` | n/a |

What stays in `test/architecture.test.ts` after Biome and knip are on: R10, R14, the `pi.extensions` ↔ folder count, and rows 25 to 27 (unique layer basenames, `subagents` cross-plugin isolation, normalised relative imports). The `test-framework` root → `pi/**` check (row 11) is a Biome override. The provider-name and write-location rules (R16) are kept by review, not by the test. Everything else in the old import scan is deleted.

## Proposed `biome.json`

Public entries are `pi-adapter/index.ts`, `extension-manager/index.ts`, `ui-kit/index.ts` and `shared/index.ts`; at most 3 folder levels below `extensions/<name>/`. The per-depth blocks were validated against a fixture of the target tree (23 of 23 bad imports flagged); the new `ui-kit`, `shared`, `tests/**`, `test-framework/pi/**` and `evals/**` blocks use the same pattern kinds and are marked where a pattern is unverified.

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "files": { "includes": ["**", "!node_modules", "!docs", "!**/*.md", "!.claude", "!.pi"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "linter": {
    "rules": {
      "preset": "recommended",
      "correctness": {
        "noUnusedImports": "error",
        "noUnusedVariables": "error",
        "noUnusedFunctionParameters": "error",
        "noUnusedPrivateClassMembers": "error",
        "noPrivateImports": "error"
      },
      "suspicious": { "noImportCycles": "error" },
      "performance": { "noBarrelFile": "off", "noReExportAll": "error" },
      "nursery": { "noSelfImport": "error" }
    }
  },
  "overrides": [
    { "includes": ["extensions/mcp-import/tests/**"], "linter": {"rules": {"suspicious": {"noTemplateCurlyInString": "off"}}} },
    {
      "includes": ["pi-adapter/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/extension-manager/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/ui-kit/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/shared/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["pi-adapter/types/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/extension-manager/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/ui-kit/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/shared/**"], "message": "pi-adapter imports nothing from the repo (R3)." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../**"], "message": "pi-adapter/types imports only other types/ files." }
      ] } } } } }
    },
    {
      "includes": ["pi-adapter/tests/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/extension-manager/**"], "message": "Adapter tests use test-framework and the adapter only." },
        { "group": ["**/ui-kit/**"], "message": "Adapter tests use test-framework and the adapter only." },
        { "group": ["**/shared/**"], "message": "Adapter tests use test-framework and the adapter only." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["shared/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "shared/ may import pi-adapter/index.ts only (R5)." },
        { "group": ["**/ui-kit/**"], "message": "shared/ may import pi-adapter/index.ts only (R5)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["shared/tests/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "shared/ may import pi-adapter/index.ts only (R5)." },
        { "group": ["**/ui-kit/**"], "message": "shared/ may import pi-adapter/index.ts only (R5)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["ui-kit/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "ui-kit/ may import pi-adapter and shared only (R5)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["ui-kit/tests/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "ui-kit/ may import pi-adapter and shared only (R5)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["extension-manager/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/ui-kit/**"], "message": "extension-manager/ may import pi-adapter and shared only (R4)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["extension-manager/tests/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/ui-kit/**"], "message": "extension-manager/ may import pi-adapter and shared only (R4)." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../*/**", "!../../**", "!../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../*/**", "!../../../**", "!../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../../*/**", "!../../../../**", "!../../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/*/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../../../*/**", "!../../../../../**", "!../../../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/core/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "core/ must not import extension-manager (R7)." },
        { "group": ["**/ui-kit/**"], "message": "core/ must not import ui-kit (R7)." },
        { "group": ["../../*/**", "!../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../ui", "../ui/**", "../api", "../api/**", "../index.ts"], "message": "core/ must not import ui/, api/ or the extension's index.ts (R7)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/core/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "core/ must not import extension-manager (R7)." },
        { "group": ["**/ui-kit/**"], "message": "core/ must not import ui-kit (R7)." },
        { "group": ["../../../*/**", "!../../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../../ui", "../../ui/**", "../../api", "../../api/**", "../../index.ts"], "message": "core/ must not import ui/, api/ or the extension's index.ts (R7)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/core/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "core/ must not import extension-manager (R7)." },
        { "group": ["**/ui-kit/**"], "message": "core/ must not import ui-kit (R7)." },
        { "group": ["../../../../*/**", "!../../../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../../../ui", "../../../ui/**", "../../../api", "../../../api/**", "../../../index.ts"], "message": "core/ must not import ui/, api/ or the extension's index.ts (R7)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/ui/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "ui/ must not import extension-manager (R8)." },
        { "group": ["../../*/**", "!../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../api", "../api/**", "../index.ts"], "message": "ui/ must not import api/ or the extension's index.ts (R8)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/ui/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "ui/ must not import extension-manager (R8)." },
        { "group": ["../../../*/**", "!../../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../../api", "../../api/**", "../../index.ts"], "message": "ui/ must not import api/ or the extension's index.ts (R8)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/ui/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extension-manager/**"], "message": "ui/ must not import extension-manager (R8)." },
        { "group": ["../../../../*/**", "!../../../../../**"], "message": "core/ and ui/ never import another extension; only api/ may, through its index.ts." },
        { "group": ["**/test-framework/**", "**/evals/**", "**/test/**"], "message": "Shipped code never imports test code." },
        { "group": ["../../../api", "../../../api/**", "../../../index.ts"], "message": "ui/ must not import api/ or the extension's index.ts (R8)." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/tests/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../*/**", "!../../../**", "!../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/tests/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../../*/**", "!../../../../**", "!../../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["extensions/*/tests/*/*/*.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["../../../../*/**", "!../../../../../**", "!../../../../*/index.ts"], "message": "Import another extension only through extensions/<name>/index.ts." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["test-framework/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["test-framework/*.ts", "test-framework/live/**", "test-framework/eval-runs/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." },
        { "group": ["./pi/**", "../pi/**"], "message": "Pi-free test-framework modules never import test-framework/pi/** (R12)." }
      ] } } } } }
    },
    {
      "includes": ["test-framework/pi/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extensions/**"], "message": "This layer must not import extensions." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    },
    {
      "includes": ["evals/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extensions/*/**", "!**/extensions/*/index.ts", "!**/extensions/*/tests/support/**"], "message": "Evals reach extensions through index.ts or tests/support (R13)." }
      ] } } } } }
    },
    {
      "includes": ["test/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
        { "group": ["@earendil-works/*", "@earendil-works/*/**", "typebox", "typebox/**"], "message": "Only pi-adapter/** and test-framework/pi/** may import pi packages." },
        { "group": ["**/pi-adapter/**", "!**/pi-adapter/index.ts"], "message": "Import pi-adapter only through pi-adapter/index.ts." },
        { "group": ["**/extension-manager/**", "!**/extension-manager/index.ts"], "message": "Import extension-manager only through extension-manager/index.ts." },
        { "group": ["**/ui-kit/**", "!**/ui-kit/index.ts"], "message": "Import ui-kit only through ui-kit/index.ts." },
        { "group": ["**/shared/**", "!**/shared/index.ts"], "message": "Import shared only through shared/index.ts." },
        { "group": ["**/extensions/*/**", "!**/extensions/*/index.ts"], "message": "Root tests reach extensions only through index.ts." },
        { "group": ["**/evals/**"], "message": "Nothing imports evals/." }
      ] } } } } }
    }
  ]
}
```

The file has 28 overrides. The first matching override is not special: overrides do not merge, the **last** matching one wins, so each carries its full pattern list and the more specific ones (`pi-adapter/types/**`, `*/tests/**`, `test-framework/pi/**`) come after the general ones they refine.

Pattern recipe, for a file d folders below `extensions/<name>/` (d = 0 is `index.ts`):

| Purpose | Patterns |
| --- | --- |
| Root barrels and test code (depth independent) | `**/pi-adapter/**`, `!**/pi-adapter/index.ts` (same for extension-manager, ui-kit, shared); `**/test-framework/**`, `**/evals/**`, `**/test/**` |
| Deep import into another extension (`api/`, `index.ts`, `tests/`) | `U*/**`, `!U../**`, `!U*/index.ts` where U = `../` × (d+1) |
| Any import of another extension (`core/`, `ui/`) | `U*/**`, `!U../**` |
| core → ui/api/index | `C ui`, `C ui/**`, `C api`, `C api/**`, `C index.ts` where C = `../` × d |
| ui → api/index | `C api`, `C api/**`, `C index.ts` |

The overrides for `extensions/*/core/**` and `extensions/*/ui/**` can be committed before any extension has those folders: they match nothing until then, so no allowlist is needed during the per-extension migration (plan 02 §10, phase 6).

## Proposed `knip.json`

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["extensions/*/index.ts", "evals/**/*.eval.ts", "test-framework/live/fixture-mcp-server.ts"],
  "project": [
    "pi-adapter/**/*.ts",
    "extension-manager/**/*.ts",
    "ui-kit/**/*.ts",
    "shared/**/*.ts",
    "extensions/**/*.ts",
    "test-framework/**/*.ts",
    "evals/**/*.ts",
    "test/**/*.ts",
    "*.ts"
  ],
  "includeEntryExports": true,
  "vitest": { "config": ["vitest.config.ts", "vitest.live.config.ts", "vitest.evals.config.ts"] }
}
```

Notes, all verified on fixtures or a repo copy:

- The vitest and biome plugins are auto-detected; the explicit `vitest.config` list is needed so `vitest.live.config.ts`, `vitest.evals.config.ts`, `*.live.test.ts` and `*.eval.ts` count as entries.
- knip does not read `package.json` `pi.extensions`, so the extension entries are listed in `entry`. With `includeEntryExports`, the default export pi loads is reported as unused unless tagged `/** @public */` (Biome treats `@public` as the default visibility, so the two tools agree). Decided: tag the default export; no `ignoreIssues` entry.
- Files only spawned by path (today `extensions/subagents/test/live/fixtures/mcp-server.ts`, after phase 3 `test-framework/live/fixture-mcp-server.ts`) must be in `entry`.
- Exports used only inside their own file are reported (default `ignoreExportsUsedInFile: false`); today these are real findings (`setupLive`, `LIVE_LIMIT`, `RUNS_ENV`, …).
- `cycles` is off by default in knip; Biome covers it.
- Phase 0 adds knip on today's paths (`entry: ["extensions/*/src/index.ts", "extensions/subagents/test/live/fixtures/mcp-server.ts"]`, `project` = `core/**`, `extensions/**`, `test/**`, `*.ts`); phases 1–3 and 8 update the lists as folders move.

Baseline on the current tree (current paths, `entry: extensions/*/src/index.ts`): unused exports `parentTools`, `RowComponent`, `setupLive`, `teardownLive`, `UNKNOWN_LIMIT`, `LIVE_LIMIT`, `REPO_ROOT`, `RUNS_ENV`, `muted`; unused types `SourceSpend`, `ReceiptKind`, `Severity`; Biome warnings `modelLabel` (unused variable) and `live` (unused parameter), which `tsc --noUnusedLocals --noUnusedParameters` reports identically. Phase 0 fixes these 12 findings before `npm run knip` joins `check`.

## `package.json` changes

```jsonc
{
  "scripts": {
    "lint": "biome check --error-on-warnings .",
    "knip": "knip",
    "check": "npm run typecheck && npm run lint && npm run knip && npm run test"
  },
  "devDependencies": {
    "knip": "^6.43.0"
  }
}
```

- knip 6.43.0: 21 packages, 24 MB, no peer dependencies, engines `^20.19.0 || >=22.12.0` (CI Node 22 and `engines >=22.19.0` both fit).
- CI cost (local, M-series): `tsc` 0.42 s, `biome lint` 0.13 s, `knip` 0.28 s. CI is the existing `npm run check` step; no workflow change needed. Optional: `knip --reporter github-actions` for annotations.
- `--error-on-warnings` (verified flag) makes recommended rules at warn level fail CI; alternatively raise the specific rules to `error` as in the proposed config.
- No `tsconfig` change: `noUnusedLocals`/`noUnusedParameters` duplicate Biome.


## Alternatives considered

| Tool | Verdict |
| --- | --- |
| dependency-cruiser 18.7.0 | Rules on **resolved** paths with regex back-references (`extensions/([^/]+)/` → not `extensions/(?!$1)…`), depth independent, plus cycle and orphan detection and graphs. Best fallback if the per-depth Biome overrides become a burden. Adds a config DSL and a second lint pass. Not installed; TS 7 compatibility **unverified**. |
| `tsc --noUnusedLocals --noUnusedParameters` | Works with TS 7 (verified); same findings as Biome here. Redundant. |
| ts-unused-exports 11.0.1 | Needs the classic TypeScript API (peer `typescript >=3.8.3`); TS 7 has none. Last release 2024. |
| ts-prune 0.10.3 | Last release 2022, maintenance mode (README points to knip: **unverified from memory**), needs classic TS API. |
| knip 5.x | Had `classMembers`, but uses the TypeScript language service; would need a second `typescript@5` install. **Unverified**; not recommended. |
| madge 8.0.0 | Cycles and graphs only; peer `typescript ^5.4.4`. Biome covers cycles. |
| eslint-plugin-boundaries / eslint-plugin-import | Would express element-type layering cleanly but requires ESLint; ruled out by preference. |
| Biome `noPrivateImports` instead of patterns | `@package` = own directory subtree only; blocks `api/ → core/` if used as default. Kept as an opt-in tag only. |
| Path aliases (`package.json` `imports`, `#pi-adapter`) | Would let some rules be depth independent, but relative imports into other extensions still need depth patterns. Biome resolution of `#` subpaths **unverified**. |


## Migration notes

- Phase 0 (plan 02 §10) breaks the `core/adapter` cycle (`pi-footer` → `pi-notice` → `pi-ui` → `pi-footer`) by extracting `tuiContext`/`HostState` into `pi-tui-context.ts`, then turns `noImportCycles` on at `error` in the same PR. Starting at `warn` is not needed.
- Today extensions import `core/manager/*.ts` deep paths (~130 import lines) and `core/adapter/contract.ts` / `pi-adapter.ts` (135 lines). The barrel rules (rows 4–6) assume single public entries; phases 1 and 2 add `pi-adapter/index.ts`, `extension-manager/index.ts`, `ui-kit/index.ts`, `shared/index.ts` before the overrides for those folders are enabled.
- Biome cannot exempt type-only imports in `noRestrictedImports`. That is why `Plugin`, `PluginContext`, `Bus`, `BusOf` live in `shared/plugin-contract.ts` (re-exported by `extension-manager/index.ts`) rather than in `extension-manager/`: `core/` files declare plugin and bus types, and R7 bans `extension-manager/` from `core/`.
- Which overrides turn on when: phase 0 cycles and unused-code rules; phase 1 `pi-adapter/**` and the four generic `extensions/*/…/*.ts` overrides (depths 0–3) with two groups only (pi-package ban, `**/pi-adapter/**` + `!**/pi-adapter/index.ts`; the other groups would flag `core/test/helpers` imports that still exist), `pi-adapter/types/**` (after phase 4), `pi-adapter/tests/**` (after phase 3); phase 2 `extension-manager/**`, `shared/**`, `ui-kit/**`; phase 3 `test-framework/**`, `test-framework/*.ts`+`live/**`+`eval-runs/**`, `test-framework/pi/**`, `evals/**`, `test/**`; phase 6 the full group lists on the generic extension overrides plus `extensions/*/core/**`, `extensions/*/ui/**`, `extensions/*/tests/**`; phase 9 nothing new (the architecture test tightens).
- `test/architecture.test.ts` shrinks in phase 3 to the rows marked vitest in the matrix and tightens in phase 9 (no `src/`).
- `files.includes` excludes `docs/` (markdown only) and `.pi/` (worktrees created by `worktree: true` agents).

## Open questions

All eight were answered by the review of plan 02 ([04-architecture-plan-review.md](04-architecture-plan-review.md)) and the orchestrator; recorded here so the config above can be read without the other documents.

1. Public entries: `pi-adapter/index.ts` is the only one. Test-only access to adapter internals goes through `test-framework/pi/**` (R12), never through a second adapter entry.
2. `extension-manager` gets a single `index.ts`; extensions and the test framework never deep-import it. The same holds for `ui-kit/index.ts` and `shared/index.ts`.
3. `extension-manager` (and `shared`, `ui-kit`) must not import pi packages. Enforced by the pi-package group in their overrides.
4. Adapter tests live in `pi-adapter/tests/` (live tests in `pi-adapter/tests/live/`, the fake pi API in `pi-adapter/tests/support/fake-pi.ts`). Everything under `pi-adapter/**` may import pi packages; `pi-adapter/tests/**` may additionally import `test-framework/**`.
5. Non-test extension code must not import `test-framework/`, `evals/` or `test/`: `**/test-framework/**`, `**/evals/**`, `**/test/**` are in every non-test override.
6. Max depth below `extensions/<name>/` stays 3 (R14, architecture test). The overrides are written out by hand above; a generator script is not worth a build step for 13 blocks.
7. `noImportCycles` keeps `ignoreTypes: true`.
8. `/** @public */` on each extension's default export; no knip `ignoreIssues`.
