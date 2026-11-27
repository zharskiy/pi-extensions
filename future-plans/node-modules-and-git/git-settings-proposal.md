# Proposal: git settings against lock collisions

Status, 2026-11-27: a proposal; its point put to the owner, the `includeIf` form, was answered the same day (below), and implementation has not started and starts on the owner's word. It builds on the owner's decision in [README.md](README.md#decision); the findings behind it are in [research/git.md](research/git.md#lock-errors). Each point was checked against the code on 2026-11-27; `path:line` references are to `launcher/` unless named otherwise.

*2026-11-27, later:* the open points were researched; each now carries a recommendation, and the steps are in [plan.md](plan.md). The recommendations are not owner decisions, except where marked. *Owner, 2026-11-27:* asked about the `includeIf "gitdir:/"` form, "that's okay": point 1 is agreed; the other points were not put to the owner one by one and stand as the plan's choices.

Decided by the owner since, 2026-11-27:

- `pinata uninstall` removes the global settings again, and only what lies between `# pinata begin` and `# pinata end`. Nothing outside the markers is touched: a `GIT_OPTIONAL_LOCKS` line or a git config value the user wrote themselves stays.
- In the container, pinata's own environment values and the user's `env.set` are two sources and nothing is merged. Where both name a variable, the `env.set` value replaces pinata's. A user's config on another machine may already hold an `env.set`.

## What it sets

| Setting | Mac | Container |
|---|---|---|
| `GIT_OPTIONAL_LOCKS=0` | the marked block in the shell profile | the container environment |
| `core.checkStat=minimal` | the global git config | the rendered `~/.gitconfig` |
| `core.trustctime=false` | the global git config | the rendered `~/.gitconfig` |

What each changes and costs: [git.md](research/git.md#what-each-setting-changes-and-costs).

## Mac: shell profile

`export GIT_OPTIONAL_LOCKS=0` becomes a second line inside the existing block, in the same files. Today the block is `# pinata begin`, `export PATH='<home>/.local/bin':"$PATH"`, `# pinata end` (`cli/pinata/path-block.ts:27`), in `~/.zshrc`, created when missing, and in `~/.bashrc` and `~/.bash_profile` when they exist (`path-block.ts:11`, `:44-48`).

- `pinata install` writes it (`cli/pinata/install.ts:90`); `pinata uninstall` removes it with the block (`cli/pinata/uninstall.ts:173`).
- `pinata uninstall --sandbox` keeps the block (`uninstall.ts:161-166`), so it would keep the variable too. Recommended: it keeps the git block as well.
- `pinata update` rewrites the block. It runs `npm install -g` and then the new copy's `pinata install --yes` (`cli/pinata/update.ts:21-29`), which calls the same block writer. The writer replaces everything between one pair of markers and writes the file only when the text changes (`path-block.ts:30-34`).
- Machines with the old block get the new line at their next `pinata update`, or `pinata install`; in a checkout, `pinata update` refuses and the user runs `git pull` then `pinata install` (`update.ts:9-11`). Until then they keep the old block and nothing breaks. An older pinata's uninstall cuts whatever lies between the markers, so it removes the new line too.
- A file with an unpaired or repeated marker line is left as it is with a warning (`path-block.ts:21-24`), so it gets no variable either.
- *2026-11-27:* the block is appended at the end of the profile (`path-block.ts:31`), so the plain export overrides a `GIT_OPTIONAL_LOCKS` the user exported earlier in the file; one exported after the block wins. Recommended: keep the plain export the owner asked for and say so in the docs ([plan.md](plan.md#git-settings), G8).
- *2026-11-27:* two existing faults to fix with this change ([plan.md](plan.md#git-settings), G9): the block body is a JS string written as latin1 (`path-block.ts:27`, `:34`), which mangles a non-ASCII home path in today's PATH line too; and the writer's messages name only `PATH` (`path-block.ts:36-40`).

## Mac: global git config

The owner's rule is that uninstall removes only what lies between the markers, so pinata's part of the global git config sits in a marked block too. A git config file takes `#` comment lines, so the same two marker lines work there. Three shapes were considered:

- (a) `git config --global core.checkStat minimal` and `core.trustctime false`; on uninstall, `--unset` both. It does not fit the rule: nothing marks the keys as pinata's, and `--unset` also removes a value the user had set before the install.
- (b) a marked block holding one `[include]` entry, `path = <pinata's file>`. Pinata owns that small file, which holds the two keys.
- (c) a marked block holding the two keys themselves under `[core]`. It needs no extra file, but git writes a user's later `git config --global core.<name>` into the last `[core]` section of the file, which is the one inside the block, so uninstall would delete the user's setting with it.
- (d), added 2026-11-27: a marked block holding one `[includeIf "gitdir:/"]` entry, `path = <pinata's file>`, the same file as (b).

Checked here on git 2.50.1 with throwaway global files (`GIT_CONFIG_GLOBAL`): with (c), `git config --global core.editor vim` wrote `editor = vim` between the markers and `core.checkStat default` replaced pinata's value there; with (b), both landed in the user's own `[core]` section outside the block.

*2026-11-27:* (b) was first recommended, then rejected on a further test with the same setup: a user's later `git config --global --add include.path <x>` wrote `path = <x>` inside pinata's `[include]` section, between the markers, and a plain `git config --global include.path <x>` replaced pinata's path; either way uninstall would delete the user's include. With (d) the same `--add` created a new `[include]` section outside the block. `gitdir:/` matched a repository, a worktree and a bare repository; outside a repository nothing applies, which changes nothing, since both keys only matter with an index.

Recommended: (d). The owner declined `includeIf "gitdir:<root>/"` as a way to scope the settings to the workspace ([README.md](README.md#decision)). This use is not scoping: `gitdir:/` matches every repository, so the settings stay global as decided. *Owner, 2026-11-27:* "that's okay": agreed.

Precedence: git reads an included file as if its contents stood at the `include.path` line, and the last value found wins ([git-config, Includes](https://git-scm.com/docs/git-config#_includes)). An entry at the end of the global file therefore overrides the user's own values for the two keys in that file; an entry at the start lets them win. A repository's `.git/config`, `-c` and `GIT_CONFIG_COUNT` outrank both. Checked here on git 2.50.1 with a throwaway global file (`GIT_CONFIG_GLOBAL`): `checkStat = default` followed by the include read `minimal`; with the included file deleted, git read `default` and reported no error.

*2026-11-27:* recommended position: the start of the global file. A user's own value for either key then wins, set before or after the install (tested with (d): a later `git config --global core.trustctime true` read `true`; on an empty file git appended `[core]` after the block). That is the owner's `env.set` rule applied to git config. At the start the markers are also safe from git's own edits: `git config --global --remove-section` deletes the comment lines after the section it removes, and with the block at the end it deleted a marker line and left an unpaired marker, which the writer then leaves alone with a warning. Inferred: a value set only in `$XDG_CONFIG_HOME/git/config` still loses when `~/.gitconfig` also exists, because git reads the XDG file first.

So the included file must not live in `<state>`: `pinata uninstall --sandbox` removes `<state>` (`uninstall.ts:161-166`), and the settings would vanish silently while the shell block stays.

*2026-11-27:* recommended location: a static file shipped in the installed package, for example `<package>/launcher/<folder>/gitconfig`, as the `pi` link already points into the package (`cli/pinata/install.ts:86`); `pinata update` installs into the same global prefix (`cli/pinata/update.ts:23`). "Files written" then gains only the block. When the package is removed the settings stop with it, since git ignores a missing include silently, also on a machine whose older pinata does not know the git block. A file under `<agent dir>` would outlive the package, follow `PI_CODING_AGENT_DIR` and need its own row in "Files written" and its own removal.

The global file is `~/.gitconfig`, or `$XDG_CONFIG_HOME/git/config` (`~/.config/git/config` by default) when only that exists ([git-config, Files](https://git-scm.com/docs/git-config#FILES)); `git config --global` picks the same way, and `GIT_CONFIG_GLOBAL` overrides both.

The host's identity read (`hostpi/tools/git.ts:27`) follows includes but asks only for `user.name` and `user.email`, which pinata's file does not hold, so the identity is unchanged.

The config keys reach every git on the Mac, apps started from the Dock included; the shell variable reaches only git started from a terminal.

## Container

- `GIT_OPTIONAL_LOCKS: "0"` in the container environment. *2026-11-27:* not next to `GIT_TERMINAL_PROMPT` in `sandboxEnv` (`container/spec.ts:140`), which is spread after `env.set`, but in a defaults object spread before `...config.env.set` (`container/spec.ts:290-295`), so `env.set` replaces it by name ([plan.md](plan.md#git-settings), G7).
- The two `core` keys in the rendered `tools/gitconfig` (`provision/render.ts:161-164`, `:184`), which the entrypoint copies to `~/.gitconfig` (`image/entrypoint.sh:111`). Today that file is rendered only when it has an identity or a glab host (`render.ts:178-179`, `:184`); with these keys it is always rendered. *2026-11-27:* recommended: `[core]` first in the file, before any `[user]` section. The render dir is rewritten every launch, so the change reaches the next launch without an image rebuild.
- Not through `GIT_CONFIG_COUNT`: a user's `env.set` may already set it, as the documented recipe "Git remotes with SSH URLs" does (`CONFIGURATION.md:726-745`), and `env.set` does not refuse the name (`CONFIGURATION.md:474`). One counter cannot hold two lists, so pinata's entries and the user's would have to be merged, which the owner ruled out. Without a merge the user's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` would replace pinata's by name and pinata's keys would be lost. In the rendered file they stay, and a user's `GIT_CONFIG_*` entry for the same git key still outranks the file.

Trade-off: the rendered file is global scope, so a repository's own `.git/config` outranks it. A repository that sets `core.checkStat` or `core.trustctime` itself keeps its value in the container. Attempt 1 passed its container settings by `GIT_CONFIG_COUNT` "so they outrank the shared config" ([prior-attempts.md](research/prior-attempts.md#git)).

Decided: a user's `env.set` may override `GIT_OPTIONAL_LOCKS`. The name does not join the refused list beside `GIT_TERMINAL_PROMPT` (`CONFIGURATION.md:474`). *Corrected 2026-11-27:* this text said `env.set` is applied after pinata's own values; the code does the opposite today: `env.set` is spread first and pinata's values override it (`container/spec.ts:290-295`), harmless only because `env.set` refuses pinata's names (`config/validate.ts:101-102`). The change must place pinata's `GIT_OPTIONAL_LOCKS` before `env.set`, as above. The names that list refuses today are not part of this decision.

## Not included

Attempt 1 also set `core.ignorecase=false` and `safe.directory=*` in the container ([prior-attempts.md](research/prior-attempts.md#git)).

- `core.ignorecase=false`: attempt 1 set it because "the shared config says `true` for the Mac's disk, which is wrong for the volume and hides files there" (`future-plans/synced-workspace/attempt-1-architecture.md:65`): its container tree lived on a docker volume, a Linux filesystem. On the live share the container's tree is the Mac's own folder, so the value git wrote for the Mac's disk describes it. Inferred; whether the owner's volume is case-insensitive was not checked.
- `safe.directory`: set nowhere in `launcher/` today ([current-behaviour.md](research/current-behaviour.md), 49) and no trouble was reported in daily use. The lab did hit "detected dubious ownership" after a root `ls -ln`, since virtio-fs reports ownership as whoever looked first, and notes that pinata's root `chown` execs could trigger the same ([lab-vm.md](research/lab-vm.md)). It has nothing to do with locks; it stays a point for the index guard (A2), not this proposal.

## Marker naming

Recommended: keep `# pinata begin` and `# pinata end`. The owner suggested "pinata start" and "pinata end" with `//`. `//` is not a comment in a shell file, so such a line would run as a command. Renaming would also orphan the blocks already written on installed machines: the writer finds only the names it knows (`path-block.ts:6-8`, `:18`), so it would append a second block and leave the old one. Open point for the owner.

## Limits

- The shell variable reaches only git started from a terminal. Apps started from the Dock do not see it; IntelliJ IDEA sets it for its own git since 2019.1 ([prior-attempts.md](research/prior-attempts.md#git)).
- Real writes (`add`, `commit`, `checkout`, `stash`) still take `index.lock` and can still collide.
- A stale lock file left by a killed git, and parallel `worktree: true` subagents, are not affected.
- None of this was tested on the owner's workspace. The evidence is attempt 1's measurement: without the variable 96 of 144 Mac statuses wrote the index, with it 0 of 30; without the two `core` settings every `git status` rewrote every entry of a 40,000-file index, 0.8 s on the Mac and 4 s in the container ([prior-attempts.md](research/prior-attempts.md#git)).
- The empty-index hazard stays: no setting removes it while one index is shared ([git.md](research/git.md#correctness-two-gits-on-one-index-through-the-share)).

## Lifetime

The owner's recorded end state is the code in the VM ([README.md](README.md#decision)). Once git runs on one system these settings are no longer needed, so the removal path matters as much as the install: whatever pinata writes must come out cleanly, also from machines that installed an older version.

## What implementation will have to touch

- `launcher/ARCHITECTURE.md`, "Files written": the `pinata install` and `pinata uninstall` bullets (the block's new line, the global config entry, pinata's file); the `pinata update` bullet already says it writes what `pinata install` writes.
- `AGENTS.md`: its files rule allows pinata's host side only what "Files written" lists; its docs-sync rule requires `launcher/README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md` to change with the code (`test/docs-sync.test.ts`).
- `launcher/THREAT-MODEL.md`: pinata would change git's behaviour for every repository on the Mac.
- `launcher/README.md`, install step 3 and the `pinata uninstall` row, which describe the block as a `PATH` block; `launcher/CONFIGURATION.md` if `GIT_OPTIONAL_LOCKS` joins the refused list.
- The block writer's message, which names only `PATH` (`path-block.ts:36-40`).
- Tests for install, update and uninstall (`launcher/tests/cli/pinata/install.test.ts`, `update.test.ts`, `uninstall.test.ts`), and for the container environment and the rendered git config.

## Open points

Each point is the owner's to agree. Recommendations of 2026-11-27, with the reasons and evidence in [plan.md](plan.md#git-settings):

1. The global git config: recommended (d), a marked block with one `[includeIf "gitdir:/"]` entry and a file pinata owns. *Answered 2026-11-27:* the owner agreed this use of `includeIf`, "that's okay". (b), plain `[include]`, was rejected on test; (c), the keys in the block, does not survive a user's later edit; (a), setting and unsetting the keys, does not fit the uninstall rule.
2. A user who already has a value for one of the keys: recommended, defer to it by placing the block at the start of the global file. Skipping a key would need re-checking at every install; the position gives the same result.
3. Where pinata's included file lives: recommended, a static file shipped in the installed package.
4. Whether `pinata uninstall --sandbox` keeps the settings: recommended, keep both blocks. *Corrected 2026-11-27:* the reason given here was "pinata itself stays installed"; the `pinata` command, the extensions and the config stay, but `--sandbox` does remove the `pi` link (`uninstall.ts:159`). The full `pinata uninstall` removes them (decided).
5. The marker names: recommended, keep `# pinata begin` and `# pinata end`.
6. Whether `pinata doctor` reports the settings: recommended, no check now. It exists and has no git check today (its areas are host, sandbox, network and credentials, `cli/commands/doctor-checks.ts:31-57`), and it checks none of the install artefacts; if such checks are added, they cover all of them together. Attempt 1 left the same question open ([prior-attempts.md](research/prior-attempts.md#open-decisions)).

Added by the research, also recommendations: the container order (`env.set` spread after pinata's default), the shell line's position, and the two writer faults, each above and in [plan.md](plan.md#git-settings) (G7 to G9).
