# Installing pinata across an organisation

This guide is for the people who roll pi out to a company's Macs. It covers the one command that installs pi, pinata's extensions and the `pi-sandbox` launcher, how to call it from the company's own install script, how to configure it, how to update and roll back, and what the command promises to keep stable. For a single machine, the [README](README.md#quick-start) is enough.

> **Before the first release.** Every version, URL and command below names release 0.5.0, the first release with the one-step installer. Until it is out, neither `@zharskiy/pinata` on npm nor the `v0.5.0` release assets exist, and the commands fail at the download. Release 0.5.0 is the earliest version they work with.

## What the command does

<!-- x-release-please-start-version -->

```bash
sh install.sh --package-version 0.5.0 --root ~/work --config /path/to/org-config.json
```

<!-- x-release-please-end -->

`install.sh` at the root of a release is the bootstrap. Run as the user who will use pi (never as root), it does three things and stops at the first that fails:

1. **pi.** If pi's managed install is missing from the agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), it downloads pi's own installer (`https://pi.dev/install.sh`) and runs it without a terminal, so the installer takes its defaults, asks nothing and edits no shell startup file. If a managed pi is already there, it leaves it alone: pi's installer over an existing install upgrades pi to the latest release, so the bootstrap never runs it twice.
2. **The package.** `npm install -g --omit=peer @zharskiy/pinata@<version>`. This is the npm package with the extensions and the launcher. It is not pi.
3. **The packaged installer.** It hands over to `launcher/install.sh` inside the package it just installed, so all the real work is done by code of the version you asked for. That installer installs Colima with Homebrew when it is missing, writes the launcher's `config.json`, starts the `pi-sandbox` VM, installs the extensions into pi (`pi install npm:@zharskiy/pinata@<version>`), puts `~/.local/bin` first on `PATH` in the shell startup files, writes a receipt and runs `pi sandbox doctor` as a smoke check.

pi and pinata (`@zharskiy/pinata`) are two different things installed two different ways:

| | what it is | how it gets onto the Mac |
| --- | --- | --- |
| pi | the coding agent | only pi's own installer, `curl -fsSL https://pi.dev/install.sh \| sh`, which creates the managed install in the agent dir. The launcher runs only this install on the host; a pi found anywhere else is not used. |
| pinata (`@zharskiy/pinata`) | this repository: the extensions and the `pi-sandbox` launcher | `npm install -g`, done by the bootstrap. The extensions are then registered in pi as a pi package by `pi install`. |

### Prerequisites

The bootstrap checks these and exits with 69, naming the missing piece, before it changes anything:

- macOS 13 or newer.
- [Homebrew](https://brew.sh). The packaged installer uses it to install Colima 0.8.0 or newer.
- Node 22.19 or newer, with npm, on `PATH`. The bootstrap does not install Node.
- `curl`, only when pi has to be installed.
- git, when the extensions come from a git source.
- Network access to `pi.dev` (pi's installer and release metadata), the npm registry (`registry.npmjs.org`, or your mirror), and `github.com` when you fetch the bootstrap or the package from a GitHub release.

The command does not install Node, Homebrew, git or any provider credentials, does not sign anyone in, and does not write pi's own `settings.json` beyond the `packages` entry that `pi install` adds and the changelog marker it carries over on an update ([What users see after an update](#what-users-see-after-an-update)).

## The one-liner and the pinned form

Always fetch the bootstrap from a release (`/releases/download/vX.Y.Z/`), never from `main`: `main` moves, a release does not, and the bootstrap of a release installs that release's package by default. Each release also carries `SHA256SUMS`, the checksums of the bootstrap and of the package tarball (`zharskiy-pinata-<version>.tgz`).

For one machine, the short form pipes the bootstrap into `sh` and skips the checksum:

<!-- x-release-please-start-version -->

```bash
curl -fsSL https://github.com/zharskiy/pi-extensions/releases/download/v0.5.0/install.sh | sh -s -- --root ~/work
```

<!-- x-release-please-end -->

The whole script is one function called on its last line, so a download cut off half way runs nothing.

For a company script, pin and verify:

<!-- x-release-please-start-version -->

```bash
version=0.5.0
base=https://github.com/zharskiy/pi-extensions/releases/download/v$version
dir=$(mktemp -d)
curl -fsSL -o "$dir/install.sh" "$base/install.sh"
curl -fsSL -o "$dir/SHA256SUMS" "$base/SHA256SUMS"
(cd "$dir" && grep ' install.sh$' SHA256SUMS | shasum -a 256 -c -)
sh "$dir/install.sh" --package-version "$version" --root ~/work --config ./org-config.json
```

<!-- x-release-please-end -->

Pass `--package-version` even though the bootstrap has the same default: the script then says in one place which version the company runs, and a vendored copy of an older bootstrap still installs the version you name.

`sh install.sh --version` prints `@zharskiy/pinata bootstrap <version> (bootstrap api 1)`. `--dry-run` changes nothing and prints what would happen; once pi and the wanted version are installed, it also runs the packaged installer's own dry run, which validates `--config` and the roots; without them it prints the packaged installer's command the real run would start and exits 0, so `--config` and the roots are checked only by the real run.

## Wiring it into the company's install script

A typical company script installs pi, signs the user in and copies default settings. Add this command as the last step:

1. **Install pi.** Keep a step that runs pi's installer, or drop it and let the bootstrap do it. The bootstrap does nothing to an existing managed pi. If your current step installs pi any other way, replace it with pi's installer: the launcher does not use any other pi. To make a failure fatal instead of installing pi, pass `--skip-pi`: the bootstrap then exits 69 when no managed pi exists.
2. **Sign in and set up credentials**, as you do today.
3. **Copy default settings** (see [Default settings](#default-settings)). Do this before the bootstrap, or merge rather than overwrite: copying a whole `settings.json` over the user's afterwards removes the `packages` entry the installer wrote.
4. **Run the bootstrap** with the pinned version, the roots and the org config.

[launcher/examples/org/](launcher/examples/org/) has a commented `company-install.sh` that does all of this and handles every exit code, an org `config.json`, a `settings.json` fragment and an update script.

### Vendoring or fetching

- **Fetch** the bootstrap of the pinned release at install time and check it against `SHA256SUMS`, as above. The pin and the checksum sit together in your script.
- **Vendor** it: commit the bootstrap of one release into your script repository and pass `--package-version` to move. A vendored bootstrap keeps working against newer package versions: it passes every option it does not know to the packaged installer unchanged, so new options work through it. Replace it when a release note asks you to.

### Mirrors and private registries

| need | what to pass |
| --- | --- |
| The package from your own store instead of the npm registry | `--package <spec>`: any `npm install -g` spec, for example the release tarball `https://github.com/zharskiy/pi-extensions/releases/download/v<version>/zharskiy-pinata-<version>.tgz`, a copy of it on `https://files.example.com/`, or a local path. It wins over `--package-version`. It replaces only the source of `npm install -g`: the extensions still come from `npm:@zharskiy/pinata@<version>` through `pi install`, on the host and again in the sandbox. Without access to the public npm registry, point npm at a registry mirror that carries `@zharskiy/pinata` (your usual `npm config`, next row), or pass `--extensions-source git:…` (next rows but one), which shows no changelog notice after an update. |
| npm itself through a private registry | your usual `npm config` (`registry`, auth): the bootstrap runs plain `npm`. |
| The extensions in pi from git instead of npm | `--extensions-source git:github.com/zharskiy/pi-extensions@v<version>` (or your mirror's host and path, with the release tag). |
| pi's installer from a mirror | `--pi-installer https://mirror.example.com/pi/install.sh`, or a local file, or `PI_INSTALLER_URL`. |
| pi's release metadata from a mirror | `PI_INSTALLER_API_BASE=https://mirror.example.com/pi/api/installer/releases`: pi's installer and `pi update` read releases there. |

The sandbox installs the extensions again inside the container from the same source, so the npm registry or the git host of that source must be in `egress.allow` of the launcher config. Otherwise pi inside reports the package as failed to install.

### Every option

Bootstrap options (root `install.sh`):

| option | environment | meaning |
| --- | --- | --- |
| `--package-version X` | `PINATA_VERSION` | package version to install; default: the bootstrap's own version |
| `--package SPEC` | `PINATA_PACKAGE` | full `npm install -g` spec, which replaces only the source of `npm install -g`; wins over `--package-version` |
| `--skip-pi` | | never run pi's installer; exit 69 when no managed pi exists |
| `--pi-installer URL\|FILE` | `PI_INSTALLER_URL` | pi's installer; default `https://pi.dev/install.sh` |
| `--dry-run` | | change nothing, print the plan; forwarded to the packaged installer when pi and the wanted version are installed, otherwise the bootstrap prints the packaged installer's command that the real run would start, and exits 0 |
| `--version` | | print the bootstrap's version and API |
| `-h`, `--help` | | usage |
| | `PI_CODING_AGENT_DIR` | pi's agent dir; default `~/.pi/agent` |
| | `PI_INSTALLER_API_BASE` | passed through to pi's installer |

Precedence: a flag always wins over an environment variable, and `--package` wins over `--package-version`. So the package comes from the first of `--package`, `--package-version`, `PINATA_PACKAGE`, `PINATA_VERSION` and the bootstrap's own version that is set; `--package-version 0.6.0` wins over a `PINATA_PACKAGE` left in the environment. Every other argument goes to the packaged installer in order, after `--with-extensions`.

Packaged installer options (`launcher/install.sh`, installer API 1):

| option | environment | meaning |
| --- | --- | --- |
| `--root DIR` (repeatable) | `PI_SANDBOX_ROOTS` (`:`-separated) | workspace roots: folders pi may start in and the only folders the VM shares; `--root` wins |
| `--config FILE` | | organisation config to install as the launcher's `config.json` |
| `--config-conflict keep\|replace\|fail` | | what to do when the user edited `config.json`; default `keep` |
| `--with-extensions`, `--no-extensions` | | install this package into pi; the bootstrap passes `--with-extensions`, and `--no-extensions` wins |
| `--extensions-source SPEC` | | pi package source; default `npm:@zharskiy/pinata@<version>`; implies `--with-extensions` |
| `--cpu N`, `--memory GiB`, `--disk GiB` | | VM size; default: CPU count 2 to 8, half the memory 4 to 10 GiB, 60 GiB disk |
| `--no-smoke` | | skip the `pi sandbox doctor` smoke check |
| `--dry-run` | | validate and print the plan, change nothing |
| `--version` | | print `@zharskiy/pinata <version> (installer api 1)` |
| | `PI_CODING_AGENT_DIR` | pi's agent dir |
| | `PI_SANDBOX_USER_CONFIG` | path of the launcher config file |
| | `PI_SANDBOX_STATE_DIR` | the launcher's state folder |

`PI_SANDBOX_NPM_SPEC`, `PI_INSTALL_BOOTSTRAP_API` and `PI_INSTALL_BOOTSTRAP_VERSION` are internal plumbing between the two stages, not public API: the bootstrap sets them for the packaged installer (the npm spec it installed, and its own API and version for the receipt). Do not set them in a company script; they may change without an API bump. An unknown option is an error (64), so a typo never passes silently; an option newer than the package you pinned fails the same way, naming the option and the installer's version.

### Exit codes

Both stages use one table. Every error message starts with the step that failed.

| code | meaning | what a wrapper does |
| --- | --- | --- |
| 0 | installed, or the dry run found nothing wrong | carry on |
| 64 | usage: unknown option, missing or invalid value | fix the script; an option newer than the pinned package needs a newer `--package-version` |
| 69 | a prerequisite is missing: root user, not macOS, Homebrew, Node, npm, managed pi under `--skip-pi`, Colima too old, or a package version that predates this installer | tell the user what to install, then run again |
| 70 | a step failed: pi's installer, brew, npm, Colima or `pi install`; the install is incomplete | show the message; running the same command again is safe |
| 73 | `~/.local/bin/pi` is a file the installer did not create and will not replace | ask the user to move it, then run again |
| 75 | pi sessions are running; nothing was changed | retry later, for example at the next login or after the user quits pi |
| 78 | configuration rejected: invalid `--config`, refused roots, or an edited `config.json` under `--config-conflict fail` | fix the org config in your repository, or decide on the user's edit |
| 79 | installed, but the smoke check failed | show the user the output of `pi sandbox doctor`; do not loop |
| 130 | interrupted (SIGINT, Ctrl-C) | the install may be incomplete; running the same command again is safe |
| 143 | terminated (SIGTERM) | as 130 |

Codes may be added in later versions: a wrapper treats any non-zero code it does not know as a failure. An unexpected failure inside a step (a command the installer does not expect to fail, such as a write to a full disk) is reported as 70 with the step's name, never as the raw status of that command.

## Configuring the launcher

### The org config

`--config FILE` installs a complete launcher config (`<agent dir>/pi-sandbox/config.json`, or `PI_SANDBOX_USER_CONFIG`). Every key is described in [launcher/CONFIGURATION.md](launcher/CONFIGURATION.md) and in the JSON schema [launcher/schema/sandbox-config.schema.json](launcher/schema/sandbox-config.schema.json); validate your file against the schema in your own CI. The installer validates it again with the launcher version it installs, before it writes anything, and exits 78 naming the key when it is invalid. So a config written for a newer launcher cannot silently break an older one: keep the version pin and the config file together in your script repository and change them in one commit.

[launcher/examples/org/config.json](launcher/examples/org/config.json) is a starting point.

### Workspace roots

`--root DIR` (repeatable) or `PI_SANDBOX_ROOTS` sets `workspaceRoots`: pi starts only inside a root, and the VM shares only the roots instead of the whole home. Given with `--config`, the roots replace `workspaceRoots` of the file. Roots differ per user more often than the rest of the config, so pass them as options rather than in the file. See [Workspace roots](launcher/CONFIGURATION.md#workspace-roots) for what a root may not be.

### When the user changed the config

The installer treats `config.json` like a package's config file. It remembers, in its receipt, the checksum of the last config it wrote.

| situation | result |
| --- | --- |
| no `config.json` | written (`created`) |
| same as the org config | left alone (`unchanged`) |
| still what the installer last wrote | replaced (`updated`) |
| edited by the user, or older than the installer, with `keep` (default) | left alone; the org config is written beside it as `config.proposed.json`, with a notice on how to adopt it (`kept`) |
| the same, with `replace` | moved to `config.json.bak` (one backup, overwritten each time); the org config is written (`replaced`) |
| the same, with `fail` | nothing written, exit 78 |

A `config.json` the installer writes from `--root` alone is recorded the same way, so a later `--config` updates it. A `config.json` written before the receipt recorded it (by hand, or by a version before 0.5.0) has no recorded checksum and counts as the user's. For a first org rollout onto machines that may already have one, pass `--config-conflict replace` if the org config must win: the previous file stays in `config.json.bak`.

The config stays the user's file: they can edit it after the install, and the next install keeps their edit by default. This is convenience, not enforcement. The launcher reads no file above the user's.

## Default settings

pi and the extensions read plain JSON files under the agent dir, so a company pre-seeds them by copying files there, before or after the install. Every file is optional; a missing key takes its default.

| file under `~/.pi/agent/` | read by | shape |
| --- | --- | --- |
| `settings.json` | pi | pi's own settings; see pi's settings documentation. Also holds `selfUpdateCommand` ([below](#updating-pi-itself)). |
| `pi-subagents.json` | subagents | `{ "maxConcurrent": 12, "maxDepth": 3, "agents": { "<agent>": { "model": "inherit", "thinking": "low", "skills": ["<skill>"] } }, "disabledPlugins": [] }`; see [subagents](extensions/subagents/README.md) |
| `pi-style.json` | style | `{ "style": "concise" }` or `"normal"` |
| `pi-notifications.json` | notifications | `{ "channel": "auto", "idleDelayMs": 20000, "dialogDelayMs": 6000 }`; `channel` is `auto`, `bell` or `off` |
| `pi-session-limits.json` | session-limits | `{ "softRatio": 0.45, "hardRatio": 0.6, "softTokens": 125000, "hardTokens": 175000 }` |
| `mcp.json` | pi's MCP support | `{ "mcpServers": { "<name>": { "command": "…", "args": ["…"] } } }` |
| `agents/<name>.md` | subagents | your own agent definitions; see [subagents](extensions/subagents/README.md) |
| `pi-sandbox/config.json` | launcher | install it with `--config` instead of copying, so updates are tracked |

`settings.json` is the user's main pi file and pi writes to it too (the default model, the packages, the changelog markers). Merge your keys into it rather than copying a whole file over it.

Do not write a `packages` entry for `@zharskiy/pinata` by hand, in `settings.json` or in a template. The installer writes the one entry it manages (`npm:@zharskiy/pinata@<version>`, or your `--extensions-source`) and removes other entries of this package, because two entries load every extension twice. A template that carries a `packages` array replaces that entry when copied after the install.

## Updates

### Moving to a new version

Run the same command with the new version. The bootstrap installs the new package, the packaged installer of that version moves the extensions pin in pi, updates the org config by the rules above, and restarts nothing that is running: when pi sessions are live and the version changes, it stops with 75 before it changes anything.

- `pi update` moves pi itself only.
- `pi update --extensions` does not move this package: the installer pins it to an exact version (`npm:@zharskiy/pinata@<version>`, or a `@v<version>` git tag), and pi never moves an exact pin.
- The launcher and the extensions move only through the installer.

Roll back the same way: run the installer with the older version and the org config that went with it.

### Checking a machine

The installer writes a receipt to `<agent dir>/pi-sandbox/state/install.json` on every run that is not a dry run:

```json
{
  "schemaVersion": 1,
  "installerApi": 1,
  "installedAt": "2026-12-01T09:30:00.000Z",
  "package": { "name": "@zharskiy/pinata", "version": "0.5.0", "spec": "@zharskiy/pinata@0.5.0", "mode": "global" },
  "bootstrap": { "api": 1, "version": "0.5.0" },
  "pi": { "version": "1.5.2" },
  "extensions": { "source": "npm:@zharskiy/pinata@0.5.0" },
  "config": { "from": "/path/org-config.json", "sha256": "…", "outcome": "created" },
  "smoke": "passed"
}
```

`bootstrap`, `extensions` and `config` are `null` when they do not apply, and so are `package.spec` (a run from a checkout), `bootstrap.version` (a bootstrap that did not say), `pi.version` (no version found) and `config.sha256` (no checksum recorded); `mode` is `global` or `checkout`; `config.from` is the `--config` path, or `--root` for a `config.json` the installer wrote from the roots alone; `smoke` is `passed`, `failed`, `skipped`, or `pending` in a receipt the installer wrote part way: it updates the receipt as soon as the extensions and the config steps succeed, so a run that fails later (Colima, the image, the smoke check) still records them, and `pending` says the run did not get to the smoke check. Readers ignore fields they do not know. `pi sandbox status` shows one install line, and `pi sandbox doctor` has an `install` check that warns when the launcher, the receipt and pi's `packages` disagree, or when a `config.proposed.json` waits; its hint is to run the organisation's install command again.

### Updating pi itself

pi's managed install updates itself with `pi update`, to the latest release on `pi.dev`. pi's installer cannot install a chosen version, so a company either accepts the latest pi, or mirrors pi's release metadata and points `PI_INSTALLER_API_BASE` at the mirror for pi's installer and `pi update`. The launcher follows host pi: the next launch after pi changes rebuilds the sandbox image with the same pi version.

To route `pi update` through your own script, set `selfUpdateCommand` in the user's `~/.pi/agent/settings.json`, an argv array:

```json
{ "selfUpdateCommand": ["/usr/local/libexec/example-corp/company-update.sh", "{version}"] }
```

- pi runs it only when `pi.dev` (or your mirror) reports a newer pi than the one installed, and replaces `{version}`, `{packageName}` and `{installSpec}` (`{packageName}@{version}`) in the arguments.
- It replaces the managed update completely, so the script must update pi itself. [launcher/examples/org/company-update.sh](launcher/examples/org/company-update.sh) runs pi's installer, then the company install command.
- `PI_SELF_UPDATE_COMMAND` does the same as a whitespace-split string and takes precedence over the setting.
- It is honoured only in the agent dir's `settings.json`. The launcher never copies it into the sandbox, so pi inside cannot change what runs on the host.

### Unattended updates

From MDM, a launchd agent or cron:

- Run as the user, never as root (root exits 69), with `HOME` set and a `PATH` that contains `node`, `npm` and `brew` (`/opt/homebrew/bin` on Apple silicon).
- Treat 75 as "try again later": the user has pi open, and nothing was changed.
- `PI_SKIP_VERSION_CHECK=1` stops pi from asking `pi.dev` for the latest version at every start, if your updates come only from your own schedule.

[launcher/examples/org/README.md](launcher/examples/org/README.md) shows a launchd agent.

### What users see after an update

pi shows a package's changelog by itself. When it starts a new interactive session (not a resumed one) and an installed package's `CHANGELOG.md` has entries newer than the version it last saw for that package, it shows them under "Extension Updates", headed with the package name. With pi's `collapseChangelog` setting it shows one line, `Updated @zharskiy/pinata to v<version>.`, instead. The first time pi sees a package it only records the version and shows nothing. `/changelog` shows pi's own changelog, not the packages'.

This package ships `CHANGELOG.md` at its root, the file pi reads. Release-please writes it from the commit history at every release; each version is a `## [x.y.z](…)` section, which is the heading pi looks for.

pi remembers the last version it showed per package source string, in `extensionChangelogVersions` of the user's `settings.json`. The installer pins the source to an exact version (`npm:@zharskiy/pinata@0.5.0`), so a new version is a new source string, which pi on its own would treat as a package it has never seen: it would record the version and show nothing. So when the installer's extensions step replaces an older source of this package, it moves pi's marker from the old source string to the new one in the host `settings.json`. The next new session then shows the entries between the two versions once; the sandbox writes the version pi records back to the host `settings.json`, so the notice does not repeat. This works for the default npm source. With a `git:` source the sandbox pins the package to a commit, which pi sees as yet another source string, so no notice appears there; point those users at [CHANGELOG.md](CHANGELOG.md) or the GitHub release notes. A first install shows nothing, since pi has no earlier version to compare with.

## Compatibility

What the installer promises, so that a company script written today keeps working:

- **Installer API 1** is the set of options, environment variables, exit codes and receipt fields in this guide. Within API 1 they are only ever added to: nothing is renamed, repurposed or removed.
- An option that loses its purpose stays accepted and does nothing, with a deprecation notice.
- A breaking change bumps the API number and is announced under BREAKING CHANGES in [CHANGELOG.md](CHANGELOG.md). Before 1.0, the packaged installer keeps accepting invocations of the previous API for at least the next two minor package releases after the change; from 1.0 on, for at least one further major version. There is no calendar promise.
- The bootstrap identifies itself to the packaged installer by its API, and the packaged installer supports the previous bootstrap API for the same window. A vendored bootstrap of an older release therefore keeps working against newer packages within that window.
- Exit codes may be added: a wrapper treats any non-zero code it does not know as a failure.
- The org config is validated by the version being installed, before anything is written.
- Tests freeze this: a corpus of API-1 invocations that must keep passing `--dry-run` (only ever appended to), the exit-code table, the receipt schema, and the bootstrap version matching the package version.

| bootstrap API | installer API | package versions |
| --- | --- | --- |
| 1 | 1 | 0.5.0 and later |

Package versions before 0.5.0 have no packaged installer the bootstrap can call; the bootstrap stops with 69 for them.

Deprecations are announced in [CHANGELOG.md](CHANGELOG.md) and printed as a notice by the installer when a script uses the old form, within the same window before anything is removed: at least two minor releases before 1.0, at least one major version from 1.0 on.

The package was first installed under its pre-release name `pi-extensions-mz` (from a checkout or git). Its global install has a `pi-sandbox` bin that would make `npm install -g @zharskiy/pinata` fail, so the bootstrap and the packaged installer uninstall a global `pi-extensions-mz` before they install, `uninstall.sh` removes it too, and the extensions step replaces a `npm:pi-extensions-mz` entry, or a local path to a copy of either package, in pi's `packages`. That old launcher cannot report live pi sessions, so this one-time migration does not check for them: ask users to quit pi first.

## Uninstall

Exit every pi session, then:

```bash
"$(npm root -g)/@zharskiy/pinata/launcher/uninstall.sh" --with-extensions
```

It deletes the `pi-sandbox` Colima profile, the launcher's state with the receipt, the `pi` link in `~/.local/bin`, the npm package and the `PATH` lines, and restores pi's managed link. `--with-extensions` also removes the extensions from pi (`pi remove <source from the receipt>`); without it, pi keeps loading them. pi itself, `~/.pi` with its sessions and settings, the launcher config and Colima stay. Remove pi with pi's own uninstall instructions.

## Troubleshooting

Every error is one line: `pinata bootstrap: <step>: …` from the bootstrap, `pi-sandbox install: <step>: …` from the packaged installer. Start with the exit code and the step.

| code | step | fix |
| --- | --- | --- |
| 64 | `options` | The message names the option and the installer's version. `unknown option` for an option this guide lists means the pinned package is older than the option: pin a newer version. |
| 69 | `preflight` | Install what it names (Node 22.19 or newer with npm, Homebrew, macOS 13 or newer), or run as the user, not root. |
| 69 | `pi` | `--skip-pi` was given and there is no managed pi: run pi's installer, or drop `--skip-pi`. |
| 69 | `installer` | The pinned package predates the one-step installer: pin 0.5.0 or newer. |
| 69 | `runtime` | Colima is older than 0.8.0: `brew upgrade colima`. |
| 70 | `pi` | pi's installer failed or left no managed pi. Run it by hand to see its error; check access to `pi.dev` or your mirror. |
| 70 | `package` or `launcher` | `npm install -g` failed: check npm's registry and auth, or the `--package` URL. |
| 70 | `extensions` | `pi install` could not fetch the extensions source: check the registry or git host, then run again. |
| 70 | `runtime` or `colima` | `brew install colima` or `colima start` failed; the output above says why. |
| 70 | `config` or `receipt` | A helper of the launcher failed; the output above says why. Run again; if it repeats, report it with the output. |
| 73 | `launcher` | `~/.local/bin/pi` is a file the installer did not create. Look at it, move it away, run again. |
| 75 | `package` or `launcher` | pi sessions are live. Quit pi everywhere, then run again. |
| 78 | `config` | The message names the key. With `--config-conflict fail` the user edited `config.json`: compare it with your config, then rerun with `keep` or `replace`. |
| 79 | `smoke` | Everything is installed, but `pi sandbox doctor` failed: run it in a repository and follow the failing check, as in the [launcher troubleshooting](launcher/README.md#troubleshooting). |
