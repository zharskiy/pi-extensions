# Removed defaults

The launcher used to ship network access that not every project needs, forwarded a variable that broke the sandbox's locale, built the sandbox's trust at container start, put the proxy's token in the sandbox, gave each folder its own proxy, network and grants, bundled the GitHub CLI with its credentials, let the sandbox VM share your whole home or several workspace roots, and guarded git one folder at a time. They are gone. This page lists what was removed and how to add each one back in your config file (`pi-sandbox/config.json` under pi's agent dir, see [CONFIGURATION.md](CONFIGURATION.md)).

## Egress presets

`egress.presets` is gone. `egress.allow` is empty by default. The old default was `npm`, `pypi` and `github`. The hosts of each preset were:

| Preset | Hosts |
| --- | --- |
| `npm` | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| `pypi` | `pypi.org`, `files.pythonhosted.org` |
| `github` | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| `maven` | `repo.maven.apache.org`, `repo1.maven.org` |
| `gradle` | `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`, `downloads.gradle.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `cargo` | `crates.io`, `index.crates.io`, `static.crates.io` |

List the hosts you need in `egress.allow`.

## `LANG` in `env.allow`

`LANG` is no longer in the default `env.allow` list. The image sets `LANG=C.UTF-8` instead, because a host value such as `en_US.UTF-8` names a locale the image does not have, and perl and other programs then print `Setting locale failed`. To keep your Mac's value, add `LANG` to `env.allow` and generate that locale with `image.dockerfile`, see [Variables passed into the sandbox](CONFIGURATION.md#variables-passed-into-the-sandbox).

## Trust built at container start

The sandbox CAs (the launcher's CA and `tls.extraCa`) are now part of the image layer, so these container-start pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| The bind of the bundle at `/etc/pi-sandbox/ca.pem`, from `<state>/vm/trust-<hash>-<id>.pem` | The CAs are files under `/usr/local/share/ca-certificates/pi-sandbox/` and in `/etc/ssl/certs/ca-certificates.crt`. Read that file where a tool wants a bundle. |
| `/tmp/pi-sandbox/ca-bundle.pem`, which the entrypoint wrote, and the CA variables pointing at it | `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `NODE_EXTRA_CA_CERTS` all point at `/etc/ssl/certs/ca-certificates.crt`, which holds the same certificates. |
| `/tmp/pi-sandbox/truststore.p12`, which the entrypoint built for the `java` on `PATH`, and the `javax.net.ssl.trustStore` flags in `JAVA_TOOL_OPTIONS` (set by the launcher and by `bash-env.sh`) | Every JDK in the image has the CAs in its own `cacerts`. A JDK installed with `image.dockerfile` is covered, because the layer's last step runs after it. For a JDK installed later, run `/usr/local/lib/pi-sandbox/trust-jdk.sh <its folder>` as its owner. |
| `PI_SANDBOX_TRUST_HASH` | Nothing to restore: each launch creates its container, so no container outlives a CA change. The name is no longer reserved in `env.allow` and `env.set`. |

The first launch after the update rebuilds the image once (`preparing pi sandbox, one time`): the base image and the layer, or only the layer when `image.digest` pins the base.

## The proxy token inside the sandbox

The proxy's token no longer enters the sandbox container. The relay holds it and sends it ahead of every connection, so the proxy is `http://pi-sandbox-proxy:3128` inside, with no user or password. These pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| The token as the password in `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their lowercase forms | They are `http://pi-sandbox-proxy:3128`. Nothing to restore: the proxy ignores a `Proxy-Authorization` header and never forwards it. |
| `PI_SANDBOX_PROXY_HOST`, `PI_SANDBOX_PROXY_PORT`, `PI_SANDBOX_PROXY_TOKEN` | The proxy is always `pi-sandbox-proxy` port `3128`. A script that read them can use those values, or set them with `env.set`: `"PI_SANDBOX_PROXY_HOST": "pi-sandbox-proxy", "PI_SANDBOX_PROXY_PORT": "3128"`. The token has no replacement. |
| `JAVA_TOOL_OPTIONS` with the proxy host, port, user and password and the `jdk.http.auth.*.disabledSchemes` flags | Every JDK in the image, one from `image.dockerfile` included, has the proxy in its own `net.properties`, and no JVM prints `Picked up JAVA_TOOL_OPTIONS` any more. For a JDK installed later, run `/usr/local/lib/pi-sandbox/trust-jdk.sh <its folder>` as its owner, which writes the proxy and the CAs into that JDK, from `setup` when the JDK lives in a volume ([a JDK in a volume](CONFIGURATION.md#a-jdk-in-a-volume)). The name is no longer reserved in `env.allow` and `env.set`. |
| The Maven proxy's `<username>` and `<password>`, and the entrypoint step that wrote the proxy port into `~/.m2/settings.xml` | The rendered settings name `pi-sandbox-proxy` port `3128` and are linked as they are. Nothing to restore. |
| `entrypoint.sh` and `bash-env.sh` in the base image | They are copied by the layer, so a base pinned with `image.digest` still gets this launcher's scripts. Nothing to restore. |

## One proxy, network and grant list per folder

Each folder used to get its own proxy, token, relay, internal network and grants. There is now one of each per state dir, shared by every session in every folder (see [THREAT-MODEL.md](THREAT-MODEL.md#5-known-gaps), "Sessions share one network" and "Sessions share one proxy"). These pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| A proxy, token and relay per folder (`pi-sandbox-relay-<id>`) | One proxy and token under the state dir and one relay, `pi-sandbox-relay-<install id>`, where the install id is a short hash of the state dir. The latest launch sets the egress rules for every session, with a notice when other sessions run. Two folders cannot run with different `egress` lists at the same time. |
| An internal network per folder (`pi-sandbox-<id>`) | One internal network, `pi-sandbox-network-<install id>`, for every session's container of the state dir, its relay and its services pod. It is created so that the VM has no address on it, which needs Docker Engine 28 or later in the VM; with an older engine the launch says to update colima and recreate the VM. An existing network of that name is used as it is when it carries the launcher's managed label (`pi-sandbox.managed`); one without it fails the launch. Old per-folder networks and relays are not removed by the launcher (see below). |
| Grants per folder, and `pi sandbox egress allow --user` for every folder | Every grant is for every folder and every session. `--user` is refused as an unknown option. Old per-folder grants in `grants.json` are not read: allow those hosts again. |

## The GitHub CLI

The image no longer has `gh`, and the launcher no longer reads gh's config. These pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| The `gh` package in the base image (Debian bookworm's own package, from the default Debian sources) | Add `"gh"` to `image.packages`. It is the same package from the same sources. |
| Reading the hosts in gh's `hosts.yml` on your Mac (from `GH_CONFIG_DIR`, else `XDG_CONFIG_HOME`, else `~/.config/gh`), and a `derived:gh:<host>:token` rule for each, whose secret was `gh auth token --hostname <host>` | Write the rules yourself in `credentials.rules`, one per host, as below. `credentials.derive.hosts` and `credentials.derive.enabled` no longer cover gh. |
| The rule hosts: `github.com`, `api.github.com` and `uploads.github.com` for github.com, `<host>` and `api.<host>` for a `.ghe.com` host, the host alone for another server | One rule per host, all sharing one placeholder. A rule also makes its host reachable. |
| `GH_TOKEN` set to the github.com placeholder | Set it with `env.set`. The name is no longer reserved. |
| `tools/gh-hosts.yml`, linked at `~/.config/gh/hosts.yml`, with a placeholder per host | Nothing for github.com: `GH_TOKEN` is enough. For other hosts, see below. |
| In the rendered git config, `credential.https://<host>.helper = !gh auth git-credential` and the rewrites of `git@<host>:` and `ssh://git@<host>/` to HTTPS, for every gh host | Set them with `git config --global` from `setup`. |
| `GH_CONFIG_DIR` passed to the host commands that print secrets | Put it in the rule's command, as `["/usr/bin/env", "GH_CONFIG_DIR=<folder>", "<gh>", …]`. |

Without these, plain git over HTTPS to github.com has no credential in the sandbox: a clone of a public repository works once `github.com` is reachable, a push or a private clone fails, since `GIT_TERMINAL_PROMPT` is `0` and git cannot ask. An SSH remote fails too, since the sandbox has no SSH keys.

This config gives back gh and git over HTTPS for github.com. Use your own placeholder: `pi-sandbox-` and 24 lowercase hex digits, such as `pi-sandbox-` followed by the output of `openssl rand -hex 12`. `pi sandbox doctor` reports a `GH_TOKEN` of any other shape as a value that is not a placeholder. Replace `/opt/homebrew/bin/gh` with what `command -v gh` prints on your Mac. The command runs on your Mac with a short list of variables, so give an absolute path.

```json
{
  "image": { "packages": ["gh"] },
  "env": { "set": { "GH_TOKEN": "pi-sandbox-6a1f0c2e9b7d4a3851e0f2c4" } },
  "credentials": {
    "rules": [
      { "id": "github", "host": "github.com", "placeholder": "pi-sandbox-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } },
      { "id": "github-api", "host": "api.github.com", "placeholder": "pi-sandbox-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } },
      { "id": "github-uploads", "host": "uploads.github.com", "placeholder": "pi-sandbox-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } }
    ]
  },
  "setup": [
    ["git", "config", "--global", "credential.https://github.com.helper", "!gh auth git-credential"],
    ["git", "config", "--global", "--add", "url.https://github.com/.insteadOf", "git@github.com:"],
    ["git", "config", "--global", "--add", "url.https://github.com/.insteadOf", "ssh://git@github.com/"]
  ]
}
```

- `gh` reads `GH_TOKEN` inside and sends the placeholder; `gh auth git-credential` gives git the user `x-access-token` and the same placeholder; the proxy puts the real token in its place on the hosts the rules name.
- `setup` runs at every launch, after the home is in place, so the lines land in that launch's `~/.gitconfig`. It replaces nothing the rendered config sets.
- For git alone, without `gh` in the image, use the helper `!f() { echo username=x-access-token; echo password=pi-sandbox-6a1f0c2e9b7d4a3851e0f2c4; }; f` instead, and leave out `image.packages` and `GH_TOKEN`.
- Archives and release downloads go through other hosts, such as `codeload.github.com` and `objects.githubusercontent.com`; list them in `egress.allow` if you need them.
- For a GitHub Enterprise host, add rules for it (and for `api.<host>` on `.ghe.com`) with its own placeholder and `--hostname <host>`, the `setup` lines with its name, and `GH_HOST` or `GH_ENTERPRISE_TOKEN` in `env.set`. `GH_ENTERPRISE_TOKEN` is one value for every enterprise host, so two enterprise hosts with different tokens need a `hosts.yml` inside, written from `setup` (`sh -c` with a `printf` into `~/.config/gh/hosts.yml`), with each host's placeholder.

What the config cannot do as the derivation did: it does not find your gh hosts or your gh binary by itself, so you write the host list and the path, and a config shared by a team needs gh at the same path on every Mac. The launcher also no longer refuses to run a gh that lies inside a folder a sandbox can write; an absolute path outside your projects keeps that guarantee in your hands.

## Several workspace roots and the home share

`workspaceRoots: { "roots": [...] }` is replaced by `workspaceRoot`, one folder. A config that still sets `workspaceRoots` is refused like any unknown key (`config: workspaceRoots is not a known key`), with a hint that names `workspaceRoot` as its replacement; nothing is migrated. The sandbox VM no longer shares your home: without `workspaceRoot`, a sandboxed launch does not start (`--no-sandbox` still runs, as no VM is involved).

| Removed | Now, and how to get it back |
| --- | --- |
| `workspaceRoots: { "roots": ["~/work", "/Volumes/code"] }` | `"workspaceRoot": "~/work"`, one folder. Replace the key by hand, or remove it and run `pi sandbox init`. With the old key still in the file, `pi sandbox init` (with or without `--yes`) changes nothing and exits 1 with `<config file> has a problem this setup does not fix: config: workspaceRoots is not a known key` and the same hint; without the key it asks for the folder. Projects kept in several places go under one folder that holds them all, such as `~/Projects`, or are reached with a [read-only bind](CONFIGURATION.md#read-only-binds). |
| No `workspaceRoots`: pi started anywhere and the VM shared your whole home, writable | Gone. A sandboxed launch without `workspaceRoot` stops with `config: workspaceRoot is not set, so pi has no folder it may start in`; set it to the folder that holds your projects. Your home, or a folder that holds it, is refused as the root. |
| The setup's choice to share the whole home, and its several-folder list | `pi sandbox init` asks for one folder: a detected one, or one you type. |
| `PI_SANDBOX_ROOTS`, folders separated by `:` | `PI_SANDBOX_ROOT`, one folder. `pi sandbox init --yes` (and `pinata install`) now refuses when neither the config nor `PI_SANDBOX_ROOT` names a folder. |

At the first launch after the change, the VM restarts once to drop the home share and share only the root, `<agent dir>/sessions`, `<state>/vm` and the bind sources outside the root.

Mounts added to `colima.yaml` by hand are no longer refused: at the next launch with no other pi session running, the VM restarts and the planned list replaces them.

## Git protections and workspace mode

The sandbox now mounts the whole workspace root read-write, wherever pi starts in it, and the git checks that guarded one folder at a time are gone. No config key changes.

| Removed | Now |
| --- | --- |
| The container saw only the repository, or plain folder, pi started in | It sees the whole workspace root, read-write. Keep only your own projects there. |
| `.git/hooks` read-only inside | Writable, like every other file under the root. |
| The git report when the last session ends (`git: <path> changed while the sandbox ran; review it before running git there`) and the record of git files behind it | Gone; nothing is recorded or reported. |
| The launcher's own git calls (`git rev-parse`) and its refusals of git files git did not write, links at `.git`, letter-case variants of `.git` and unreadable folders | The git dir and common dir are read from the files; a launch is refused only when one lies outside the root. |
| Workspace mode: in a folder outside git, a search for nested repositories, each checked and protected, with at most 128 repositories and 50,000 directories | A folder outside git launches like any other, with no search and a notice; with `mounts.autoOverlays` on (the default) it gets no overlays. Overlays cover only the repository pi starts in. |
| `pi install` refused a local source in a git working tree | A local source in the workspace root or in a folder a sandbox has run in is installed with a notice. |

Files an older launcher left in its state dir (`<state>/empty`, `<state>/repos/<h>/git/baseline.json`) are not read and can be removed.

## Notices about the old config folder and the policy file

Launches and `pi sandbox doctor` used to name a config left in `~/.config/pi-sandbox/` and an administrator policy file that still existed. Neither is read, nothing says so any more, and the launcher never touches `~/.config/pi-sandbox/`. Move your settings into `pi-sandbox/config.json` under pi's agent dir yourself.

## Removed config keys

A config that still sets one of these keys is refused: the key `is not a known key`. The table says what replaces it.

| Key | Now |
| --- | --- |
| `fallback` | Always `"host"`: `--no-sandbox` is always allowed. |
| `egress.grants` | Always on. |
| `egress.parentProxy` | Always follows the proxy environment variables. |
| `egress.presets` | Gone. Use `egress.allow`. |
| `mounts.sharedCaches` | Renamed. List the folders in `mounts.volumes`. |
| `workspaceRoots` | Replaced by `workspaceRoot`, one folder ([above](#several-workspace-roots-and-the-home-share)). |
| Administrator policy file | Gone. There is one config file: built-in defaults plus yours. A policy file that still exists is not read, and nothing says so. |

A `tls.extraCa` entry `{ "hostStore": true }`, which read the CAs of the macOS System keychain, is refused with `must set one of sha256, file`. Name each CA with `{ "sha256": … }` or `{ "file": … }` ([corporate proxy and TLS inspection](CONFIGURATION.md#corporate-proxy-and-tls-inspection)).

## Objects left by an older launcher

This launcher does not see the sessions of an earlier launcher build: it keeps its launches in a different place, and lists and changes only engine objects that carry its install label, which an older launcher did not set. Update the launcher with no pi session running.

The daily collection removes what an older build left in the sandbox VM: every stopped container, volume and network whose name starts with `pi-sandbox-`, that carries the `pi-sandbox.managed=true` label and that has no install label at all (the networks `pi-sandbox-machine` and `pi-sandbox-<id>`, the relays, the pod, the services, and the agent and cache volumes). It tries each volume and network and the engine refuses the ones still in use, so a container that still runs stays, with its volumes and network, until a later day's collection after it stops. Objects labelled by another install, and objects without the managed label, are never touched. An old agent volume holds the in-sandbox settings of that build, and they go with it.

Shared volumes (`pi-sandbox-shared-*`) of an older build are never removed by the daily collection, nor by `pi sandbox restart` or the uninstall, which remove only volumes with this install's label. Remove them with the engine's own tools, or delete and recreate the sandbox VM.

An old shared volume can have the same name as a new `mounts.volumes` entry, since the name is built from the same state dir hash. The launcher then mounts and reuses it, with its content, but never lists or removes it.

## One pi folder for every folder

Earlier launchers gave each folder its own pi folder inside the sandbox: an agent volume `pi-sandbox-agent-<install id>-<12 hex>`, a render folder `vm/render/<12 hex>/` and sync records under `repos/<hash>/sync/` in the state folder. Now one agent volume, `pi-sandbox-agent-<install id>`, serves every folder, so pi's packages, its in-sandbox settings and, with `sessions.host` off, its sessions are the same in every folder. The new volume starts empty: the launcher has pi install its packages again at the first launch, and in-sandbox settings and sessions of the old per-folder volumes stay where they were. The launcher removes an old one on its own only once its folder no longer exists: the daily collection removes the unused per-folder agent volume, and with `sessions.host` off the sessions kept in it go with it, and the sweep that forgets the folder removes its render folder and sync records. Until then `pi sandbox status` lists them as `leftover:` lines, and `pi sandbox restart` removes them together with the shared one once no pi session runs. Copy anything you want to keep out of an old volume first, with the engine's own tools.

## Files left in the state folder

The launcher does not remove the files earlier versions left in its state folder: the CA bundles `ca/trust.pem`, `vm/trust.pem` and `vm/trust-*.pem` and the per-folder render dirs `vm/render/<h>/`, render locks `repos/<h>/render.lock` and sync records `repos/<h>/sync/`. Nothing reads them. With no sandbox running, remove them from the state folder (`~/.pi/agent/pi-sandbox/state` by default): `rm -f ca/trust.pem vm/trust*.pem` and `rm -rf vm/render repos/*/render.lock repos/*/sync`.

## Getting the old defaults back

This config restores the old default hosts.

```json
{
  "egress": {
    "allow": [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "repo.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "release-assets.githubusercontent.com"
    ]
  }
}
```

## Tip: shared package caches

Your sandbox home lives in memory, so package caches are lost when pi exits. Listing them in `mounts.volumes` keeps them in volumes that all your sandboxes share, which makes installs in each repository cheaper:

```json
{ "mounts": { "volumes": ["~/.npm", "~/.cache/pip"] } }
```

The volumes start empty and never use your Mac's folders. Every sandbox can write to them, so keep them to package caches. See [Volumes](CONFIGURATION.md#volumes).
