---
name: update-pi
description: Upgrade the pi coding agent that this repository builds on, both the `@earendil-works/pi-*` packages in package.json and the `pi` binary on this machine, and absorb the release. Use whenever the user asks to update, upgrade or bump pi, mentions a new pi version or release, asks what changed in pi, wonders whether pi now ships something an extension here does by hand, or finds that `npm run check` broke after a pi release. Also use when `pi --version` and the version in package.json disagree. The outcome is a branch where the adapter compiles against the new pi, product behaviour is unchanged, pi's new reusable parts replace hand-rolled ones where that is possible without changing behaviour, and the checks are green.
---

# Update pi

Pi moves fast and its releases carry both breaking changes and new building blocks. This repository is a set of extensions for pi, so each release can break the adapter or make part of an extension redundant. An upgrade is done when the repo compiles and tests against the new pi, the `pi` binary on this machine runs the same version, every changelog entry that touches this repo has been acted on or consciously deferred, and the user's experience of the extensions is exactly what it was before.

Two things stay fixed through the whole process. The product does not change: commands, UI, prompts, written files and timings look and behave the same before and after, so the existing tests are the contract and are not loosened to make an upgrade pass. And pi stays behind the adapter: only `platform/pi-adapter/` and `test/framework/pi/` import pi packages (biome enforces this), so every fix and every reuse lands there or behind an adapter export.

## 1. Orient

Start from a clean tree on a fresh branch off `main`, named like `chore/update-pi-<new-version>`, because the result is a branch, not a commit on `main`.

Find the three versions and write them down for the final report:

```sh
node -p "require('./package.json').devDependencies['@earendil-works/pi-coding-agent']"   # repo floor
pi --version                                                                               # machine
npm view @earendil-works/pi-coding-agent version                                           # latest
```

If the user named a version, use that instead of latest. The three packages `pi-ai`, `pi-coding-agent` and `pi-tui` are released in lockstep, so they always move together to the same version.

## 2. Update the repo's dependency

```sh
npm install -D @earendil-works/pi-ai@^<v> @earendil-works/pi-coding-agent@^<v> @earendil-works/pi-tui@^<v>
```

Keep the caret so users on a newer patch still install. `peerDependencies` stay `*`. Check `node_modules/@earendil-works/pi-coding-agent/package.json` for `engines.node`: if pi raised its Node floor, raise `engines` in package.json and the Node version in `.github/workflows/ci.yml` to match, otherwise CI tests against a Node that pi no longer supports.

## 3. Read the changelog, all of it between old and new

The changelog ships with the package: `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` (pi-ai and pi-tui have none; their changes are in the same file). Read every entry from the version above the old one down to the new one, not only the latest heading, because a skipped minor release has its own breaking changes. If the local file is missing or truncated, use `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md` and the releases page of `https://github.com/earendil-works/pi`.

Sort every entry into one of three buckets. Be generous with the first two: an entry that looks unrelated often renames something the adapter imports.

- **May break us.** Anything under Changed, Removed, Deprecated or Breaking, plus any Fixed entry about behaviour the adapter relies on (session files, usage figures, keybindings, theme, tool rendering, extension lifecycle). Check it against what we actually import: the named imports in `platform/pi-adapter/**` and `test/framework/pi/**` (grep for each symbol the entry mentions, including inside multi-line `import {` blocks), and the pi commands and files the extensions use (settings, session directory, agent dir).
- **May replace something we built.** New Features and Added entries that overlap with an extension's job. The list of extensions and what each does is in the root `README.md` and `ARCHITECTURE.md`; compare each new capability against that list, not against your memory of pi.
- **Irrelevant.** Everything else. Name them in the report with one word so the user can see they were considered.

## 4. Fix what broke

Run `npm run typecheck` first: it finds renamed and removed imports faster than reading. Then `npm run test`. Fix inside the adapter so extensions keep their current API; if a fix cannot be contained there, say so before spreading it, because an adapter-wide API change is a design decision the user should see.

A behaviour change in pi (not a type change) shows up as a failing test or as nothing at all. For each "may break us" entry with no compile error, find the test that covers that path or run that path once by hand. Do not change a test's expectation to match pi's new behaviour; the expectation describes the product. If pi now behaves differently and the extension's output would change, compensate in the adapter, or if that is not possible, stop and tell the user what would change.

## 5. Reuse what pi now provides

For each "may replace something we built" entry, decide one of:

- **Adopt.** Pi's primitive can be wrapped behind the adapter so that the extension's observable behaviour (commands, UI text and layout, prompts, files written, cost accounting) stays identical and the existing tests pass unchanged. Then replace our implementation with pi's and delete the dead code; `npm run knip` will confirm nothing dangling remains. Smaller code that leans on pi is the goal, because pi maintains that code from now on.
- **Adopt partially.** Pi covers the mechanism but not the behaviour (for example pi adds a primitive our extension already has a richer version of). Use pi's piece underneath and keep our layer on top. Say in the report which part stayed ours and why.
- **Defer.** Adopting would change what the user sees, or pi's version is incomplete for our use. Record the entry, the reason and what pi would need to add, in the report. Deferring is a user decision when behaviour is at stake, so ask before dropping a reuse that would be a clear win otherwise.

Reuse that touches `extensions/<name>/` code must come with that extension's `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md` in the same diff; `test/docs-sync.test.ts` fails otherwise. Describe what changed structurally, such as "the X is now pi's Y, wrapped by the adapter".

## 6. Update pi on this machine

The repo and the machine must agree, because the global pi loads this repository as a package (`packages` in `~/.pi/agent/settings.json`). Update the machine only after step 4 is green, so the user's daily pi is never pointed at an adapter that does not compile against it.

Check how pi is installed before touching it:

```sh
readlink "$(command -v pi)"; cat ~/.pi/agent/install/managed-install.json 2>/dev/null
```

A managed install (symlink into `~/.pi/agent/install/`, `managed-install.json` present) updates itself with `pi update` (which is `pi update --self`; `--force` reinstalls when already current). An npm global install uses `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<v>`; a Nix install is the user's to update, say so. Afterwards `pi --version` must print the new version. Start `pi` once in this repo and quit, so that extension load errors against the real binary are seen rather than assumed.

## 7. Verify and hand over

`npm run check` must pass; it is what CI runs. Then offer the two local-only suites and run the ones the user accepts, since both call real models and need pi credentials and `PI_LIVE_MODEL`:

- `npm run test:live` exercises the real agent paths through pi and catches runtime behaviour changes that unit tests mock away. Recommend it when any entry landed in the "may break us" bucket.
- `npm run evals` checks prompt quality and is the slowest. Recommend it only when prompts or the subagents extension changed.

Commit on the branch with the repo's convention, `build(deps): upgrade pi to <v>`, with a body that names the breaking entries handled and the reuse decisions, so the next upgrade can read what was deferred. Do not push or open a PR unless asked.

Close with a report in this shape:

```
pi <old> → <new> (machine: <version>, repo: ^<new>)
Breaking: <entry> → <what was done, file>
Reused: <entry> → adopted | partial | deferred, <reason>
Irrelevant: <n> entries (<a few words each>)
Docs: <files touched>
Checks: check ✓, live <ran ✓ | skipped by user>, evals <ran ✓ | skipped by user>
Branch: <name>, <n> commits
```
