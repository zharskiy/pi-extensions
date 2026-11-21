# Extension independence

> Status: open, a refactoring plan for all fifteen extensions and the platform, research first. One of fifteen extensions checked; the platform audit done. Date: 2026-11-20, revised 2026-11-21 at `51f54c22`. Started on the `feat/retention` worktree at `c7e3f023`. It says what to look for, how, where shared knowledge should go, and in which order to move it. The direction is the owner's decision (section 1); the designs are not decided. Findings come from reading code; nobody ran pi to confirm them.

## 1. The principle

The owner's words: extensions ideally should know nothing about each other. It should be possible to enable and disable extensions individually. If some extensions are coupled, it is better to move common logic to the upper level. The extension manager is that common upper level.

Their rule for the platform, also in their words: "platform/shared must be having something purely shareable, not something specific to an extensions, reflect that in the plan. so we'll be refactoring the whole list of extensions".

How this plan reads the rule (interpretation, not the owner's words):

- Code under `platform/` is generic. It names no extension and encodes no format, layout, setting, channel or rule that one extension owns.
- Knowledge one extension owns lives in that extension, and others reach it through its `index.ts`.
- This holds for all four platform layers, not only `platform/shared`, and for their docs.
- A format that two extensions write, with no single owner (the handoff protocol), is not settled by the rule's words; see section 8, question 1.

Why it matters:

- Each extension is its own entry in `package.json` `pi.extensions` (`package.json:48-65`), so pi loads them one by one and a user can turn any of them off (pi's resource config, `pi config`, see `launcher/README.md:162`). An extension that silently relies on another breaks, or does the wrong thing, when the user does that.
- Knowledge that two extensions share drifts. When the owner changes a format, the copy in the other extension keeps the old one and nothing fails until data is lost.
- The layers already exist: `platform/pi-adapter` (pi knowledge), `platform/shared` (generic helpers), `platform/ui-kit` (generic widgets), `platform/extension-manager` (the plugin runtime every extension boots on). See the root `ARCHITECTURE.md:8-18`. None of them may import an extension (`biome.json:63`, `:187`, `:259`, `:331`).

## 2. What counts as knowing about another extension

| Kind | Example | How to find it |
|---|---|---|
| A. Imports | `import … from "../../subagents/index.ts"` | grep, Biome already bans inner files |
| B. On-disk layouts another extension owns | prune reading `<stem>/agents/<id>/manifest.json`, which subagents writes | folder and file names in path joins |
| C. Names, strings, setting keys, record fields, constants copied instead of imported | the literal `"pi-subagents"`, a manifest field `worktree.cleanup` | grep for every other extension's namespace and key names |
| D. Runtime assumptions that another extension is on | waiting for a bus message nobody sends when the sender is off; assuming a cleaner runs | read `api/plugin.ts`, every `subscribe`, `require`, `has` |
| E. Reverse leaks into the platform | a `platform/` module that holds one extension's format, layout, setting or channel, or exists only for one extension; platform docs that name an extension | grep `platform/` for the extension's names; [platform-audit.md](platform-audit.md) |

Pi's own formats (the session header, `parentSession`, the sessions folder) are not another extension's knowledge. Read them through the adapter. A format in `platform/shared` that one extension owns (for example `spending:totals`, `platform/shared/channels/host-channels.ts:134`) is no longer fine under the owner's rule: it is kind E, even when every reader imports it. A format with several writers and no owner waits on section 8, question 1.

## 3. Phases

1. **Research per extension.** Sections 4 and 5, one `findings/<x>.md` per extension. Prune is done.
2. **Platform audit.** [platform-audit.md](platform-audit.md): every module of the four layers rated PURE, SHARED FORMAT, ONE EXTENSION'S or MIXED, with owner and destination. Done for code; the docs mentions are counted, not listed.
3. **Contract and composition level.** Decide how an owner publishes knowledge (through its `index.ts`, from `api/`), where generic contracts live (types only, in the platform), and whether a composition root above the extensions is wanted. [footprint-declarations.md](footprint-declarations.md), section 3, works this out for the cleanup case. Needs the owner's answers to section 7.
4. **Move knowledge back, extension by extension.** One PR per owner, moving its ONE EXTENSION'S modules out of `platform/` (the destinations column of [platform-audit.md](platform-audit.md)) and wiring its readers through `api/`. Order by harm: agent runs first (it can lose data, `findings/prune.md` #3), then spending's and session-limits' channels, footer's status prefixes, the `ui-kit` limit figures, the `pi-footer` key in the adapter, then platform docs.
5. **Enforcement tests.** Section 9.

## 4. Method, per extension

Run these from the repository root. Replace `<x>` with the extension's folder name. Use plain `grep`; if a shell hook shortens output, run it raw.

1. List the extensions: `ls extensions` and the `pi.extensions` list in `package.json`. Note every other extension's namespace: `grep -rn 'NAMESPACE =\|namespace:' extensions/*/api extensions/*/core --include='*.ts'`.
2. Imports (kind A): `grep -rn 'from "' extensions/<x> --include='*.ts' | grep -v /tests/ | grep -v '"node:'`. Anything under `extensions/` other than `<x>` is a finding.
3. Strings (kind C): for each other extension `<y>`, grep `<x>` for its namespace (`pi-<y>`), its folder name, its setting keys (from `extensions/<y>/core/settings.ts` or its `api/extension.ts`), its custom entry types (`<namespace>:<kind>`) and its status keys: `grep -rn -i -E 'pi-<y>|<y>|<key1>|<key2>' extensions/<x> --include='*.ts' --include='*.md'`. Also grep for generic words that hint at another extension's data: `agents`, `manifest`, `handoff`, `worktree`, `branch`, `subagent`, `limit`, `spending`, `usage`, `footer`, `hint:`, `mirror:`.
4. On-disk layouts (kind B): `grep -n -E 'join\(|readdir|opendir|readFile|lstat|rm\(|unlink|writeFile' -r extensions/<x> --include='*.ts' | grep -v /tests/`. For every path it builds, find who writes that path (grep the path parts across `extensions/` and `platform/`). The writer is the owner.
5. For every finding, open the owner's definition and note `file:line`. Check whether the owner exports it through `platform/shared/index.ts`, `platform/pi-adapter/index.ts` or its own `index.ts`.
6. Runtime (kind D): read `extensions/<x>/api/plugin.ts` (or `api/plugins/*.ts`). For every `host.subscribe`, `host.publish`, `services.require`, `has`, every custom entry type it reads and every file it reads that it did not write, answer: what happens when the other side is disabled? Then the other way: grep every other extension for `<x>`'s names, to see whether one relies on `<x>` being on.
7. Reverse leaks (kind E): `grep -rn -i '<x>' platform --include='*.ts' --include='*.md'`. For a feature branch, also `git diff origin/main...HEAD --stat -- . ':!extensions/<x>'` and read each hunk.
8. Platform ownership: what in `platform/` exists only for this extension, and what of this extension's knowledge sits in `platform/`? Start from the rows of [platform-audit.md](platform-audit.md) that name `<x>` as a user or owner. For each, list who reads it and from which layer (`api/`, `core/`, `ui/`): a reader's `core/` and `ui/` cannot import `<x>` (`biome.json:567-569`), so the move needs a value passed down from `api/`.
9. Existing checks: `biome.json` (`noRestrictedImports` per folder) and `test/architecture.test.ts` cover imports only. Note anything the extension does that they would not catch.
10. Write `findings/<x>.md` in the format of section 6 and tick the checklist below.

Do not run the extension against real data. Reading `~/.pi/agent` or the temp dir is not needed for this check.

## 5. Checklist

| Item | Status | Findings |
|---|---|---|
| platform audit | code checked 2026-11-21 | [platform-audit.md](platform-audit.md) |
| command-aliases | unchecked | |
| composer | unchecked | |
| context | unchecked | |
| footer | unchecked | |
| mcp-import | unchecked | |
| model-default | unchecked | |
| notifications | unchecked | |
| prune | checked 2026-11-20, updated 2026-11-21 | [findings/prune.md](findings/prune.md) |
| questionnaire | unchecked | |
| session-limits | unchecked | |
| spending | unchecked | |
| style | unchecked | |
| subagents | unchecked | |
| transcript | unchecked | |
| working-indicator | unchecked | |

Leads for the unchecked ones. The channels and prefixes are now checked in code in [platform-audit.md](platform-audit.md), section 1; what each receiver does when the sender is off (kind D) is not. The footer reads session-limits' `session-limits:limits` channel and spending's `spending:totals`, and places statuses by footer's own `hint:` and `mirror:` prefixes, which subagents and spending write. Subagents holds results while session-limits hands off (`pi:handoff-pending`, `pi:held-results`). Spending counts subagents' cost from `spending:usage`.

## 6. Findings file format

One file per extension: `findings/<extension>.md`. It opens with the date and commit checked and a one-sentence verdict. Then:

- **Imports**: the grep and its result.
- **Findings table** with these columns: `#`, what it knows, where (`file:line`), owner of that knowledge (`file:line`), rating, proposed decoupling, size.
- **Reverse direction** table: changes in `platform/` or other extensions that exist for this one, and this extension's knowledge that sits in `platform/` (method step 8).
- **With another extension disabled**: one line per related extension, and one for this extension disabled.
- **Not checked**: what was left open.

Ratings:

- **REAL COUPLING**: the extension restates or relies on something another extension owns. A change there breaks or harms this one.
- **ACCEPTABLE**: shared through the owner's `index.ts`, a generic platform module or the adapter as intended, or pi's own format; say why.
- **NOT COUPLING**: looks related but is not.
- **RISK**: not coupling to another extension, but an assumption that breaks when extensions are turned on and off one by one.

`findings/prune.md` is the worked example.

## 7. Where shared knowledge should go

Decision rules, in order:

1. **Pi's formats** (session files and headers, the sessions folder, agent dir paths): `platform/pi-adapter`. No extension restates them.
2. **Generic mechanisms and contracts** (guards, text layout, settings files, the plugin contract, a types-only contract such as a footprint): `platform/shared` or `platform/ui-kit`. They name no extension and hold no extension's data.
3. **A format, layout, setting or channel one extension owns** (the agent run folder, `spending:totals`, `session-limits:limits`, the `hint:` prefix): in the owner's folder, published from its `api/` and re-exported by its `index.ts` (`test/architecture.test.ts:450`). Readers import it in their own `api/` (`biome.json:447`) and pass values to their `core/` and `ui/`, which may not import another extension (`biome.json:567-569`). Not in `platform/`.
4. **A format written by two extensions with no single owner** (the handoff protocol: `platform/shared/handoff/`, written by session-limits and subagents): undecided, section 8, question 1. Neither writer can own it today, because subagents uses it in `core/` (`extensions/subagents/core/model/paths.ts:12`).
5. **Behaviour every extension needs from the runtime** (which sessions are open, one record per process, settings loading): `platform/extension-manager`, as a generic mechanism, so it holds whenever any extension is loaded.
6. **Importing another extension's `index.ts`** is the way to reach rule 3 knowledge. No extension does it yet. It loads the owner's whole module graph (every `index.ts` re-exports `./api/extension.ts`), so import only pure values. If the owner wants no extension to name another, a composition root above the extensions does the importing instead (section 8, question 2).
7. **Docs** say what an extension does alone. A mention of another extension says "if it is enabled". Platform docs name no extension.

For cleanup-style knowledge, [footprint-declarations.md](footprint-declarations.md) applies these rules: each writer declares its footprint in its own `api/`, the types-only contract sits in `platform/shared/footprint/`, and prune keeps the generic engine. Its first step moves `platform/shared/agent-runs/agent-runs.ts`, added by PR #43 as an interim step, back to subagents.

## 8. Open questions for the owner

1. Does a format with several writers and no single owner (the handoff protocol, the `pi:busy` and `pi:awaiting-input` channels) stay in `platform/shared` as "purely shareable", or must each have one owning extension? If one owner, subagents' `core/` loses direct access (rule 4).
2. May a reader's `api/` import the owner's `index.ts` (rule 6), or do they want a composition root above the extensions, so that no extension names another? The root needs changes to `test/architecture.test.ts:442-447` and new Biome overrides. [footprint-declarations.md](footprint-declarations.md), section 3.3.
3. A reader's `core/` that uses an owned format (footer's `core/segments.ts:8-9` uses `mainLimit` and `SpendingTotals`) cannot import it. Should `api/` pass the values and functions down, or may the reader keep its own copy of a type? A copy is the drift the plan wants to stop.
4. Importing `index.ts` loads the owner's whole module graph. Should an extension be allowed a lighter published file (for example `extensions/<x>/api/published.ts` importable directly), which needs a Biome and architecture-test change?
5. When an extension is disabled, should its old data still be cleaned up by another extension (static declarations allow it) or left alone until the owner is enabled again (runtime registration)? See [footprint-declarations.md](footprint-declarations.md), section 3.2.
6. Should the liveness marker (prune finding #8) move into the extension manager, so that any loaded extension of this package marks its session as open?
7. Should a test boot each extension alone, with every other one off, to catch kind D?

Answered by the owner's rule and dropped: whether a shared module in `platform/shared` was enough for agent runs (no: it is one extension's layout), and whether platform docs may name the extension that first needed a feature (read as no; interpretation).

## 9. Enforcing it afterwards

- An architecture test in `test/architecture.test.ts` that, for every extension, fails when its shipped files (outside `tests/` and its docs) contain another extension's namespace (`pi-<y>`) or folder name as a string. An allowlist names the cases decided as acceptable, each with a reason. The namespaces come from the extensions' own `NAMESPACE` or `namespace:` values, so a new extension is covered without editing the test.
- The same test for `platform/`, code and docs: shipped files there never name an extension or an extension's namespace. Today it would fail on `platform/shared/agent-runs/agent-runs.ts:18`, `platform/shared/channels/host-channels.ts:10`, `:134`, `:178` and `platform/pi-adapter/ui/footer.ts:17`, among others.
- A boot test that starts each extension alone on the fake host (`startExtension` in `test/framework/`) and runs a session start and shutdown without errors.
- Biome's `noRestrictedImports` already covers kind A; nothing more is needed there.
