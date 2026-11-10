<div align="center">

# pi-sandbox launcher

**Run pi on your Mac as you always do, with the agent kept in a box.**

Part of [pi-extensions](../README.md) · [Install](#install) · [Run](#run) · [What is protected](#what-is-protected-and-what-is-not) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [For administrators](#for-administrators) · [Troubleshooting](#troubleshooting) · [How it works](ARCHITECTURE.md) · [Threat model](THREAT-MODEL.md)

</div>

## What it is

`pi-sandbox` is installed as `pi`. You keep typing `cd <folder> && pi`; your providers, MCP servers, settings, packages, agents and skills work as they do on the host. Pi runs in a sandbox that sees the folder you started it in and nothing else of your home, reaches only the hosts on an allow-list, and never holds your credentials: the launcher adds them on the way out. An administrator can pin the limits in a policy file.

## Install

macOS 13 or newer with Homebrew and Node 22.19 or newer. Run the script from a checkout, or from the npm package: after `npm install -g pi-extensions-mz` it is `$(npm root -g)/pi-extensions-mz/launcher/install.sh`.

```bash
launcher/install.sh [--cpu N] [--memory GiB] [--disk GiB]
```

`--cpu` and `--memory` size the Colima VM when the script starts it. They default to this Mac's CPUs and half its memory, between 2 and 8 CPUs and 4 and 10 GiB; values you pass are used as given. `--disk` defaults to 60 GiB. A VM that is already running keeps its size until you stop it.

The script prints each step and can be run again. It refuses to run as root. It installs Colima 0.8.0 or newer when missing (no Docker Desktop needed), starts a Colima profile named `pi-sandbox`, installs the launcher, links `~/.local/bin/pi` to it and puts `~/.local/bin` first on `PATH` in `~/.zshrc`, an existing `~/.bashrc` or `~/.bash_profile`, and for fish in `~/.config/fish/conf.d/pi-sandbox.fish`. It ends with `pi sandbox doctor` in a temporary repository. When `~/.local/bin/pi` is pi's own managed install, the script records the link and replaces it, and `uninstall.sh` puts it back; any other `pi` there stops the install. The launcher always uses the profile at `~/.colima/pi-sandbox`; `COLIMA_HOME` is ignored.

## Run

```bash
cd <folder> && pi
```

The first launch prints `preparing pi sandbox, one time` and builds the sandbox image, which takes a few minutes. Later launches start in seconds. Each `pi` gets its own sandbox, removed when that pi exits; two `pi` in one folder share its volumes, its network exit and its session directory. After a reboot or `pi sandbox stop`, the next `pi` starts the VM again. A folder outside your home is shared with the VM at its first launch, which restarts the VM, so it waits until no other pi session runs.

Pi starts in a repository or in a plain folder. In a folder that holds several repositories, the sandbox gets the whole folder and treats each repository found in it the same way.

## What is protected and what is not

Protected:

- Pi sees the folder you started it in, its git dir, host pi's session directory for that folder and its own volumes. The rest of your home, your other repositories, `~/.ssh` and `~/.pi` are not mounted.
- No credential bytes enter the sandbox. Pi inside gets copies of your `auth.json`, `models.json` and `mcp.json`, and of the gh, glab, npm, pip, Maven and git configs, in which every key and token is a placeholder. The launcher's proxy on the host swaps a placeholder for the real value on the way out, only toward the host the credential belongs to.
- The network exit is that proxy. It allows a list of hosts, refuses private and loopback addresses, and checks that each TLS connection goes to the host it named.
- `.git/hooks` is read-only inside, so the agent cannot plant a hook there.
- Pi runs as an unprivileged user with Linux capabilities dropped, no privilege gain through setuid, a read-only system and a process limit.

Not protected:

- The agent can use your credentials. It cannot read them, but it can make any request to the hosts they belong to: push with your gh token, call your model provider, publish to your registry.
- The agent can read and change every file in the folder, the rest of `.git` included (config, `core.hooksPath`, aliases). When the last pi of the folder exits, the launcher names the git files that changed; it does not prevent the change. Review them before you run git there on the host.
- Data can leave through any allowed host.
- Host pi's sessions of this folder are readable inside. They may hold secrets a tool printed outside the sandbox.

The full list is in the [threat model](THREAT-MODEL.md#5-known-gaps).

### Where pi can start

The launcher refuses to start:

- in your home, `/`, `~/.pi`, `~/.ssh` and similar credential folders, the launcher's own state and config folders, system folders such as `/etc`, or a folder that is or contains an image folder such as `/usr/local` or `/opt`; under a home that is itself a git repository; it checks this before it reads the folder;
- outside the administrator's `workspaceRoots`, when they are set;
- in a folder it cannot read, or in a folder that holds a folder of yours it cannot read;
- in a git dir: a bare repository, anything shaped like a git dir (`HEAD` with `commondir`, or with `objects` and `refs`), or a folder inside one;
- when a folder with several repositories, or a repository root, holds `.git` in another letter case (`.GIT`), which git opens as a repository on a case-insensitive volume;
- in a folder with more than 50 000 directories to search, or more than 128 repositories and bare repositories;
- when a repository's git files are not as git writes them: a linked `.git`, a `.git` file git did not write, git choosing another git dir, a `commondir` git did not write, or the folder's own `.git` pointing at a git dir that does not exist;
- when git is not installed and the folder holds repositories;
- when a bare repository changed between the search and the start;
- when a writable mount would lie inside, or re-expose, build output that the search skipped.

In a folder with several repositories:

- a bare repository is read-only as a whole: clone and fetch from it work, push does not;
- a checkout whose `.git` file leads outside the folder, or to a git dir that does not exist, is plain files and git does not work there;
- `node_modules`, `.pi` and build output that gets its own volume (`.venv`, `target`, `.gradle`) are not searched for repositories.

## Everyday use

| command | what it does |
| --- | --- |
| `pi [args...]` | run pi in the sandbox for this repository; pi's exit code is the launcher's |
| `pi --no-sandbox [args...]` | run host pi, when fallback is host |
| `pi install\|remove <source>` | with host pi on the host (-l passes through into the sandbox) |
| `pi mcp add\|remove\|login\|logout ...` | with host pi on the host |
| `pi update` | update host pi |
| `pi sandbox status` | runtime, container, proxy, image, launches, grants, overlays, shared caches |
| `pi sandbox config [--json]` | the effective config and the layer each key comes from |
| `pi sandbox egress allow <host[:port]> [--user]` | allow a host for this repository, or with --user for every repository, until revoked |
| `pi sandbox egress revoke <host[:port]> [--user]` | remove a grant |
| `pi sandbox egress list [--denied]` | grants with their scope, or the hosts the proxy blocked |
| `pi sandbox reset` | remove this folder's sandbox with its overlay and agent volumes once none of its sessions runs |
| `pi sandbox stop` | stop the sandbox VM when no pi session runs |
| `pi sandbox doctor` | prepare the sandbox like pi and print one ok, warn, fail or skip line per check |
| `pi sandbox --version`, `pi sandbox help` | version and usage |

`pi sandbox <command> --help` prints the usage of one command. `egress allow` prints the folder the grant is for, and refuses a host that `egress.deny` names. `reset` keeps a volume a container still mounts and says so; with the VM stopped it cleans the host side and names the `colima start` command to run before you reset again. Volumes of deleted folders are removed by a daily collection.

Failures print `pi-sandbox: <message>`, often followed by `  hint: <what to do>`, and exit 1 (70 for an unexpected error).

### What is different inside

- A blocked host gets a 403 page that says what to do. When pi exits, the launcher prints one line per blocked host, `<host> was blocked in this folder's sandbox; <hint>`: grant it with `pi sandbox egress allow`, or with grants off ask your administrator; add a host that resolves to a private, loopback, link-local or reserved address to `egress.privateHosts`; nothing for a host `egress.deny` names; use https instead of plain HTTP; or the reason the host could not be reached or a credential could not be supplied.
- `NO_PROXY` holds `localhost,127.0.0.1,::1`, so tests reach servers you start inside without the proxy.
- `pi install`, `uninstall` and `remove <source>`, `pi mcp add|remove|login|logout` and a bare `pi update` run with host pi on the host; the sandbox picks the change up at the next launch. A package source is remote only as a plain `npm:<name>[@version]`, an `http(s)://`, `ssh://` or `git://` git URL with owner and repository, or `git:git@host:owner/repo` and `git:host.tld/owner/repo`; anything else is a local path, and `pi install` refuses a local path inside a git working tree or a folder a sandbox has run in. These commands run before the config is read, so `fallback`, `workspaceRoots` and a missing policy file do not stop them.
- Provider `/login` inside does not work; log in with host pi.
- Build output gets its own volume, so Linux builds never mix with the host's: `node_modules` beside an npm, pnpm, yarn or bun lockfile, `.venv` beside `uv.lock`, `poetry.lock` or `Pipfile.lock`, `target` beside `Cargo.lock`, `.gradle` beside `settings.gradle(.kts)`. Maven `target/` and Gradle `build/` are shared with the host. Run the install once inside. In a folder too large to search, or with more than 512 such folders, nothing is overlaid and a notice says so.
- `/home/pi` and `/tmp` live in memory: tool caches count against the container's memory and vanish when pi exits, unless `mounts.sharedCaches` keeps them.
- Pi sessions live in host pi's own session directory for the folder, so `/resume` on the host lists them. `sessions.host: false` keeps them in the sandbox volume.
- A pi flag that names a host file outside the folder (`--system-prompt`, `-e`, `@file`) prints a notice: the file is not visible inside.
- Notices about overlays, workspaces, skipped secret files and ignored config keys print once per folder until their text changes.

## Configuration

Your settings go in `~/.config/pi-sandbox/config.json` (`PI_SANDBOX_USER_CONFIG` moves it; `PI_SANDBOX_STATE_DIR` moves the state dir). Nothing in the folder you start pi in configures the sandbox. The keys are in [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json); `pi sandbox config` shows the result and where each key comes from. A user config for a Java developer:

```json
{
  "egress": { "presets": ["npm", "pypi", "github", "maven", "gradle"], "allow": ["registry.corp.example"] },
  "image": { "packages": ["openjdk-17-jdk-headless", "maven"] }
}
```

- `egress.presets` (default `npm`, `pypi`, `github`) adds package registry and download hosts: `npm`, `pypi`, `github`, `maven`, `gradle`, `go`, `cargo`; `[]` turns them off.
- `egress.allow` adds `host`, `*.corp.example` (exactly one label more, not `corp.example` itself) or `host:port` entries; an entry without a port allows 443 only. Names may hold `_`; IP addresses, `localhost` and port 80 are refused. `egress.deny` always wins: `host` denies the host and every name under it, `*.domain` every name under the domain. `egress.privateHosts` names hosts that may resolve to private addresses, such as an internal gateway.
- `mounts.autoOverlays` (default `true`) gives each build output folder its own volume; `false` lets the sandbox use the host's. `mounts.sharedCaches` lists `~/` folders that get one volume shared by all your sandboxes (never your host folder); no entry twice or inside another.
- `image.packages` (Debian packages), `image.npmGlobal` (`name@version`) and `image.dockerfile` (an absolute or `~/` path to a file of Dockerfile lines, run as root) add a layer to the image. A command the image lacks prints a hint naming `image.packages` and `image.npmGlobal`.
- `image.reference` and `image.digest` (`sha256:…`) go together: with both, the launcher pulls that prebuilt image instead of building one; the registry must allow anonymous pulls. The image layer above still builds.
- `resources.cpus` and `resources.memoryGiB` limit the container.
- `sessions.host` (default `true`), `fallback` (default `host`, which allows `pi --no-sandbox`; `refuse` turns it off), `egress.grants` (`false` turns grants off) and `env.allow` (terminal variables forwarded to each run; secret-looking names, the proxy variables and the variables the launcher sets inside are refused, and a value shaped like a credential stays on the host with a notice).

An invalid value stops the launch with a message naming the key and, for paths, names and choices, the value; host, credential and `npmGlobal` values are never shown.

### Corporate proxy and TLS inspection

- `egress.parentProxy: "env"` (the default) chains the launcher proxy to `HTTPS_PROXY` (else `https_proxy`) and `NO_PROXY` of the shell that runs `pi`, not to the macOS system proxy or a PAC file. Only an `http://` proxy URL is used; for anything else the launch warns and the proxy connects directly. NTLM or Kerberos proxies need a local relay such as `px` or `cntlm`.
- The image build uses the same proxy, with a loopback address pointed at the host. A proxy URL with credentials is refused for builds, since they would be written into the image: use a proxy without them, or a prebuilt image with no image layer.
- `tls.extraCa` (`[{ "file": "/path/corp-ca.pem" }]`, or `[{ "hostStore": true }]` for the macOS System keychain) is trusted by the launcher proxy, inside the container and during the image build steps.
- `tls.extraCa` does not reach the VM's engine, so when the proxy inspects Docker Hub the base image pull fails with an x509 error, and the error says so. Add a `provision` script with `mode: system` to `~/.colima/pi-sandbox/colima.yaml` that copies the CA into `/usr/local/share/ca-certificates/`, runs `update-ca-certificates` and restarts docker, then restart the profile; or pull a prebuilt image from a registry the proxy does not inspect.

### Credentials

The launcher reads your host files at every launch (`credentials.derive`, on by default): each provider in `auth.json` and each provider key in the environment (read by the proxy from that variable, never copied inside), each `apiKey` and secret header of `models.json`, each enabled HTTP server of `mcp.json`, the hosts of `gh` and `glab` with their tokens, the registry credentials of `~/.npmrc`, `pip.conf` (`~/.config/pip`, `~/Library/Application Support/pip`, `~/.pip`) and `~/.m2/settings.xml`, and your git `user.name` and `user.email`. Inside, the matching files hold placeholders only, so `gh`, `glab`, `git push`, npm, pip and Maven work as on the host while the proxy fetches the real value on the host. A registry, mirror or index without credentials and without an `egress.allow` entry prints a notice naming the entry to add.

- A derived gh or glab token reaches everything it can on its host; `credentials.derive.hosts` keeps only the hosts you list, and `credentials.derive.enabled: false` turns derivation off.
- `credentials.rules` adds rules by hand, with a secret from `env`, a `file`, a `command` (a keychain or password manager CLI, cached 300 s or until the `expiresAt` of its JSON output less 30 s), `piAuth` or `mcpOAuth`.
- A stdio MCP server's env or flag value becomes a placeholder by its name (a secret word such as token, secret, password, apikey, or `key` at the end) or by its shape (`Bearer …`, a JWT, a URL with userinfo); a secret under another name, or a purely numeric one, needs a clearer name or a `credentials.rules` entry.
- MCP servers sign in on the host: host pi keeps the token in `~/.pi/agent/mcp-auth.json` and the proxy adds it. When it is missing or expired and cannot be refreshed, a launch whose input and output are both a terminal runs `pi mcp login <name>` on the host first; after a failed sign-in this is skipped for a day. Mid-session, when a token expires or is rejected, the proxy opens the sign-in in your browser (at most once per server per minute) and pi inside gets a message to retry. A server you never signed in to gets requests without a token, so servers that need no sign-in work. An MCP server defined only in a project's `.pi/mcp.json` gets no token; add it with `pi mcp add`.

### Databases and other services

The sandbox has no engine socket and cannot reach your `localhost`, so `docker compose` and Testcontainers do not work inside. Run the server inside the sandbox: add it to `image.packages` in the user config (for example `postgresql` and `redis-server`), start it with its data under `/tmp`, and point the tests at `127.0.0.1`:

```bash
PATH=/usr/lib/postgresql/15/bin:$PATH        # Debian bookworm's PostgreSQL
initdb -D /tmp/pg --no-locale -E UTF8 -U postgres && pg_ctl -D /tmp/pg -o "-k /tmp" -l /tmp/pg.log start
redis-server --dir /tmp --daemonize yes
```

`/tmp` is in memory: the data counts against the container's memory and is gone when pi exits.

## For administrators

The policy file is `/Library/Application Support/pi-sandbox/policy.json` (`/etc/pi-sandbox/policy.json` on Linux). It uses the same keys as the user config. Make it writable by root only; the launcher reads it at every launch and does not check its owner. `PI_SANDBOX_POLICY_FILE` names a policy file only while that file does not exist, so it never overrides yours.

- A key the policy sets is final: the user's value is ignored with a warning, and `pi sandbox config` lists it.
- List keys add up: `egress.allow`, `egress.deny`, `egress.privateHosts`, `image.packages`, `image.npmGlobal`, `credentials.rules` and `env.allow` collect the entries of both files, so the user adds to yours and removes none. `egress.deny` wins over every allow, and a user rule whose `id` the policy uses is ignored.
- `egress.grants: false` locks egress: `pi sandbox egress allow` is refused, and the user's `egress.allow` and `egress.privateHosts` entries are ignored. Hosts of `credentials.rules` from either file still become reachable.
- `fallback: "refuse"` turns `pi --no-sandbox` off. `workspaceRoots` (`{ "roots": [...] }`) refuses a launch outside those folders.
- `credentials.derive`, `tls`, `sessions`, `resources`, `egress.presets`, `egress.parentProxy` and `mounts.sharedCaches` can be pinned like any other key. Finality is per key: pin `resources.cpus` and `resources.memoryGiB` each if both matter.

[examples/policy.json](examples/policy.json) is a starting point: it refuses `--no-sandbox`, turns grants off (which locks egress to its own hosts), names the internal gateway, registry and git hosts (also as private hosts, since they resolve to internal addresses), denies a paste site, adds the corporate CA and a gateway and registry credential, and keeps credential derivation on so `gh`, `glab`, npm, pip and Maven work as on the host. Under that policy the Java user config above loses its `egress.allow` entry.

`pi install`, `pi mcp …` and `pi update` run host pi on the host whatever the policy says.

## Uninstall

```bash
launcher/uninstall.sh
```

It refuses while a pi session runs in the sandbox. Otherwise the launcher removes its containers, networks, volumes and images, the folders it created in your repositories and its proxies; then the script deletes the Colima profile `pi-sandbox`, removes the `pi` link (restoring pi's managed link when `install.sh` replaced it, or naming it when that path is taken), the state dir, the global package and the `PATH` blocks. If the launcher is missing or broken, the profile and the host files still go. A failed `colima delete` exits 1 naming the command to run. Your sessions in `~/.pi/agent/sessions`, `~/.pi` and `~/.config/pi-sandbox` stay.

## Troubleshooting

Start with `pi sandbox doctor`: it names the stage or check that fails. When the VM lacks a folder this one needs, it prints `skip sandbox: run pi once here to share …` and only the host checks.

1. **`<host> was blocked in this folder's sandbox; <hint>`.** Follow the hint: run `pi sandbox egress allow <host>` on the host (`--user` for every repository) or add the host or a preset to the user config; with grants off, ask your administrator to add it to `egress.allow`.
2. **`the sandbox VM engine is unreachable`.** Run `colima start --profile pi-sandbox --activate=false`, or `install.sh` when the profile is missing. When the message says the VM is running but its engine does not answer, run `colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false`. `pi sandbox reset` still cleans the host side while the VM is stopped.
3. **`<folder> is not shared with the sandbox VM`.** Sharing a folder outside your home restarts the VM; exit the other pi sessions and run `pi` again, or run the `colima` command the hint names.
4. **`upstream request failed: ... certificate ...`** (an HTTP 502, also a failed `rule` line in `pi sandbox doctor`). A proxy or CA on your network signs the host; set `tls.extraCa`.
5. **`<cmd> is not in the sandbox image`.** Add its Debian package to `image.packages` or its npm package to `image.npmGlobal` in the user config; the next launch builds the layer.
6. **`the host pi is version X, which the npm registry does not have`.** The image installs the host pi's version from npm, so an unreleased pi cannot be built; install a published pi on the host.
7. **`the egress settings or environment secrets changed; they apply after every session in this repository exits`.** The folder's proxy keeps its hosts and rules while another pi of the folder runs; exit them all. Other config changes apply at the next `pi`.
8. A launcher killed with `kill -9` leaves its sandbox until the next `pi` in any folder.

## More

How it works: [ARCHITECTURE.md](ARCHITECTURE.md), with every file it writes in [Files written](ARCHITECTURE.md#files-written). What each feature weakens and the known gaps: [THREAT-MODEL.md](THREAT-MODEL.md). Where things are: [STRUCTURE.md](STRUCTURE.md). Development: `npm run check` covers the launcher; from a checkout run `node launcher/bin/pi-sandbox-dev.js`; tests against a real Colima engine are in `tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`.
