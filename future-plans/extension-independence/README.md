# Extension independence

> Status: open, one of fifteen extensions checked. Date: 2026-11-20. Started on the `feat/retention` worktree at `c7e3f023`. A research plan: it says what to look for, how, and where shared knowledge should go. Nothing here is decided. Findings come from reading code; nobody ran pi to confirm them.

## 1. The principle

The owner's words: extensions ideally should know nothing about each other. It should be possible to enable and disable extensions individually. If some extensions are coupled, it is better to move common logic to the upper level. The extension manager is that common upper level.

Why it matters:

- Each extension is its own entry in `package.json` `pi.extensions` (`package.json:49`), so pi loads them one by one and a user can turn any of them off (pi's resource config, `pi config`, see `launcher/README.md:162`). An extension that silently relies on another breaks, or does the wrong thing, when the user does that.
- Knowledge that two extensions share drifts. When the owner changes a format, the copy in the other extension keeps the old one and nothing fails until data is lost.
- The layers already exist: `platform/pi-adapter` (pi knowledge), `platform/shared` (formats and helpers), `platform/extension-manager` (the plugin runtime every extension boots on). See the root `ARCHITECTURE.md:8-18`.

## 2. What counts as knowing about another extension

| Kind | Example | How to find it |
|---|---|---|
| A. Imports | `import … from "../../subagents/index.ts"` | grep, Biome already bans inner files |
| B. On-disk layouts another extension owns | prune reading `<stem>/agents/<id>/manifest.json`, which subagents writes | folder and file names in path joins |
| C. Names, strings, setting keys, record fields, constants copied instead of imported | the literal `"pi-subagents"`, a manifest field `worktree.cleanup` | grep for every other extension's namespace and key names |
| D. Runtime assumptions that another extension is on | waiting for a bus message nobody sends when the sender is off; assuming a cleaner runs | read `api/plugin.ts`, every `subscribe`, `require`, `has` |
| E. Reverse leaks into the platform | a `platform/` helper that exists only for one extension, or platform docs that name an extension | grep `platform/` for the extension's name; read the branch diff |

Pi's own formats (the session header, `parentSession`, the sessions folder) are not another extension's knowledge. Read them through the adapter. A format in `platform/shared` (the handoff document, the bus channels in `platform/shared/channels/host-channels.ts`) is the agreed way to share and counts as fine, as long as the extension imports it rather than restating it.

## 3. Method, per extension

Run these from the repository root. Replace `<x>` with the extension's folder name. Use plain `grep`; if a shell hook shortens output, run it raw.

1. List the extensions: `ls extensions` and the `pi.extensions` list in `package.json`. Note every other extension's namespace: `grep -rn 'NAMESPACE =\|namespace:' extensions/*/api extensions/*/core --include='*.ts'`.
2. Imports (kind A): `grep -rn 'from "' extensions/<x> --include='*.ts' | grep -v /tests/ | grep -v '"node:'`. Anything under `extensions/` other than `<x>` is a finding.
3. Strings (kind C): for each other extension `<y>`, grep `<x>` for its namespace (`pi-<y>`), its folder name, its setting keys (from `extensions/<y>/core/settings.ts` or its `api/extension.ts`), its custom entry types (`<namespace>:<kind>`) and its status keys: `grep -rn -i -E 'pi-<y>|<y>|<key1>|<key2>' extensions/<x> --include='*.ts' --include='*.md'`. Also grep for generic words that hint at another extension's data: `agents`, `manifest`, `handoff`, `worktree`, `branch`, `subagent`, `limit`, `spending`, `usage`, `footer`, `hint:`, `mirror:`.
4. On-disk layouts (kind B): `grep -n -E 'join\(|readdir|opendir|readFile|lstat|rm\(|unlink|writeFile' -r extensions/<x> --include='*.ts' | grep -v /tests/`. For every path it builds, find who writes that path (grep the path parts across `extensions/` and `platform/`). The writer is the owner.
5. For every finding, open the owner's definition and note `file:line`. Check whether the owner exports it through `platform/shared/index.ts`, `platform/pi-adapter/index.ts` or its own `index.ts`.
6. Runtime (kind D): read `extensions/<x>/api/plugin.ts` (or `api/plugins/*.ts`). For every `host.subscribe`, `host.publish`, `services.require`, `has`, every custom entry type it reads and every file it reads that it did not write, answer: what happens when the other side is disabled? Then the other way: grep every other extension for `<x>`'s names, to see whether one relies on `<x>` being on.
7. Reverse leaks (kind E): `grep -rn -i '<x>' platform --include='*.ts' --include='*.md'`. For a feature branch, also `git diff origin/main...HEAD --stat -- . ':!extensions/<x>'` and read each hunk.
8. Existing checks: `biome.json` (`noRestrictedImports` per folder) and `test/architecture.test.ts` cover imports only. Note anything the extension does that they would not catch.
9. Write `findings/<x>.md` in the format of section 5 and tick the checklist below.

Do not run the extension against real data. Reading `~/.pi/agent` or the temp dir is not needed for this check.

## 4. Checklist

| Extension | Status | Findings |
|---|---|---|
| command-aliases | unchecked | |
| composer | unchecked | |
| context | unchecked | |
| footer | unchecked | |
| mcp-import | unchecked | |
| model-default | unchecked | |
| notifications | unchecked | |
| prune | checked 2026-11-20 | [findings/prune.md](findings/prune.md) |
| questionnaire | unchecked | |
| session-limits | unchecked | |
| spending | unchecked | |
| style | unchecked | |
| subagents | unchecked | |
| transcript | unchecked | |
| working-indicator | unchecked | |

Leads for the unchecked ones, from the root `ARCHITECTURE.md:18` only, not checked in code: the footer reads session-limits' `session-limits:limits` channel and labels its figure from it; the footer moves statuses with the `hint:` prefix and hides those with `mirror:` (subagents' `hint:subagents`, spending's `mirror:spending`); subagents holds results while session-limits hands off (`pi:handoff-pending`, `pi:held-results`); spending includes subagents' cost. Each is a bus channel or prefix in `platform/shared`, so the question per lead is kind D: what the receiver does when the sender is off.

## 5. Findings file format

One file per extension: `findings/<extension>.md`. It opens with the date and commit checked and a one-sentence verdict. Then:

- **Imports**: the grep and its result.
- **Findings table** with these columns: `#`, what it knows, where (`file:line`), owner of that knowledge (`file:line`), rating, proposed decoupling, size.
- **Reverse direction** table: changes in `platform/` or other extensions that exist for this one.
- **With another extension disabled**: one line per related extension, and one for this extension disabled.
- **Not checked**: what was left open.

Ratings:

- **REAL COUPLING**: the extension restates or relies on something another extension owns. A change there breaks or harms this one.
- **ACCEPTABLE**: shared through `platform/shared` or the adapter as intended, or pi's own format; say why.
- **NOT COUPLING**: looks related but is not.
- **RISK**: not coupling to another extension, but an assumption that breaks when extensions are turned on and off one by one.

`findings/prune.md` is the worked example.

## 6. Where shared knowledge should go

Decision rules, in order:

1. **Pi's formats** (session files and headers, the sessions folder, agent dir paths): `platform/pi-adapter`. No extension restates them.
2. **A format or layout two extensions both read or write** (the handoff document, an agent run folder, a bus payload): `platform/shared`, next to its writer's helpers. The writer keeps the authority: its authors change the shared module, and the reader picks the change up by import. This is how the handoff layout already works (`platform/shared/handoff/handoff-document.ts:58-61`).
3. **Behaviour every extension needs from the runtime** (which sessions are open, one record per process, settings loading): `platform/extension-manager`, so it holds whenever any extension is loaded.
4. **Importing another extension's `index.ts`** is allowed by the rules (`ARCHITECTURE.md:18`) but no extension does it today. Avoid it: it ties load order and makes "disable one" harder to reason about. Use it only for a pure value with no runtime, and only if rules 1 to 3 do not fit.
5. **Docs** say what an extension does alone. A mention of another extension says "if it is enabled".

A wider option for cleanup-style extensions such as prune: extensions register with the extension manager what they leave on disk per session and how to judge it, and the cleaner asks the manager. Its weakness: a disabled extension registers nothing, so its old data is never judged. Rule 2 does not have that gap, because the shared module is code, loaded whether or not its owner is enabled.

## 7. Open questions for the owner

1. Is a shared module in `platform/shared` (rule 2) enough, or do they want the registration model of section 6 through the extension manager?
2. When an extension is disabled, should its old data still be cleaned up by another extension (rule 2 allows it) or left alone until the owner is enabled again (the registration model)?
3. Should the liveness marker (prune finding #8) move into the extension manager, so that any loaded extension of this package marks its session as open?
4. May platform docs name the extension that first needed a feature, or should they describe the feature only? Today several do (`findings/prune.md`, R4).
5. Should a test boot each extension alone, with every other one off, to catch kind D?

## 8. Enforcing it afterwards

- An architecture test in `test/architecture.test.ts` that, for every extension, fails when its shipped files (outside `tests/` and its docs) contain another extension's namespace (`pi-<y>`) or folder name as a string. An allowlist names the cases decided as acceptable, each with a reason. The namespaces come from the extensions' own `NAMESPACE` or `namespace:` values, so a new extension is covered without editing the test.
- The same test for `platform/`: shipped files there never name an extension.
- A boot test that starts each extension alone on the fake host (`startExtension` in `test/framework/`) and runs a session start and shutdown without errors.
- Biome's `noRestrictedImports` already covers kind A; nothing more is needed there.
