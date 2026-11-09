<div align="center">

# pi-sandbox launcher

**Runs pi in a per-repository Linux container, with every credential kept on the host.**

Part of [pi-extensions](../README.md) · [Install](#install) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [How it works](ARCHITECTURE.md) · [Threat model](THREAT-MODEL.md)

</div>

## Why

An agent that runs shell commands on your machine can read your keys, your other repositories and your network. The launcher keeps the same `cd repo && pi`, but pi runs inside a container made for that repository on a Colima VM. The container sees the repository and its git dir at their host paths (git hooks and config read-only), its own volumes, host pi's session directory for that repository, and nothing else of your home.

There are no credentials inside. Pi inside gets copies of your host `auth.json`, `models.json` and `mcp.json` in which every key and token is a placeholder. Its only network exit is a proxy on the host, one per repository, that allows a list of hosts, refuses private addresses, and swaps each placeholder for the real credential on the way out. Your providers, MCP servers, settings, packages, agents and skills follow the host, so pi inside feels like pi on the host. The container, its proxy and its network are removed when the last pi session of the repository exits.

Started in a folder that is not a repository but holds repositories, pi treats the folder as a workspace: one container for the folder, with the git metadata of every repository in it protected. The launcher refuses to start in your home, in `~/.pi`, in `~/.ssh` and similar directories, or in `/`.

## Install

macOS with Homebrew and Node 22.19 or newer, from a checkout or a release:

```bash
launcher/install.sh [--org <absolute path>] [--cpu N] [--memory GiB] [--disk GiB] [--version X.Y.Z] [--bin-dir DIR] [--dry-run]
```

| flag | effect |
| --- | --- |
| `--org <absolute path>` | sets `org` in the user config to that organisation baseline file |
| `--cpu N`, `--memory GiB` | size of a new Colima profile; default this Mac's CPUs and half its memory, at most 8 CPUs and 10 GiB, at least 2 and 4 |
| `--disk GiB` | disk of a new Colima profile, default 60 |
| `--version X.Y.Z` | the `pi-extensions-mz` version to install, default the checkout's version, else the latest |
| `--bin-dir DIR` | where the `pi` link goes, default `~/.local/bin` |
| `--dry-run` | prints each step without changing anything |

It prints one line per step and can be run again safely. It installs Colima 0.8.0 or newer when missing (no Docker Desktop and no `docker` CLI), starts a Colima profile named `pi-sandbox` without switching your docker context, installs the launcher (`npm install -g`, or from a checkout a wrapper that runs the sources) and links `~/.local/bin/pi` to it, adds `~/.local/bin` to `PATH` in your shell rc files between `# pi-sandbox begin` and `# pi-sandbox end`, and runs `pi sandbox doctor` in a temporary repository as a smoke test. When `~/.local/bin/pi` is pi's own managed install, it records the link and replaces it; `uninstall.sh` puts it back. Any other `pi` there makes it stop; pass `--bin-dir`.

The launcher runs a host pi for host jobs (printing credentials for the proxy, MCP sign-in, the provider host table): pi's managed install in `~/.pi/agent`, else the pi installed next to the launcher. The sandbox image is built with that pi's version and rebuilt when it changes. A `pi` found on `PATH` is used only by `pi --no-sandbox`.

## First run

```bash
cd <repo> && pi
```

The first launch prints `preparing pi sandbox, one time` and the image build steps. Later launches reuse the image, and a second `pi` in the same repository joins the running container. A stopped VM (after a reboot or `pi sandbox stop`) is started by the next `pi`, which takes 15 to 40 seconds. A repository outside your home is shared with the VM at its first launch, which restarts the VM and is refused while other pi sessions run.

What is different inside:

- A blocked host gets a 403 page saying to run `pi sandbox egress allow <host>` on the host, and the launcher prints the same hint for each blocked host when pi exits.
- `pi install|remove <source>` and `pi mcp add|remove|login|logout` run with host pi on the host; the sandbox picks the change up at the next launch. A bare `pi update` updates host pi.
- Provider `/login` inside does not work; log in with host pi.
- Build output (`node_modules`, `.venv`, `target`, `.gradle` beside their lockfiles) gets its own volume, so Linux builds never mix with the host's. Run the install once inside.
- While a sandbox of the repository runs, `.git/commondir` holds `.`; the launcher pins it so the sandbox cannot point host git at another config, and removes it afterwards.
- Pi sessions live in host pi's own session directory for the repository, so `/resume` on the host lists them. The agent can read this repository's earlier sessions; `sessions.host: false` keeps them in the sandbox volume.
- Notices (overlays, workspace, host caches, MCP sign-in) print once per repository until their text changes.

## Everyday use

| command | what it does |
| --- | --- |
| `pi [args...]` | run pi in the sandbox for this repository; pi's exit code is the launcher's |
| `pi --no-sandbox [args...]` | run host pi, when `fallback` is `host` |
| `pi install\|remove <source>` | with host pi on the host (`-l` passes through into the sandbox) |
| `pi mcp add\|remove\|login\|logout ...` | with host pi on the host |
| `pi sandbox status` | runtime, container, proxy, image, launches, grants, overlays, shared caches |
| `pi sandbox config [--json]` | the effective config and the layer each key comes from |
| `pi sandbox egress allow <host[:port]> [--user]` | allow a host for this repository, or with `--user` for every repository, until revoked |
| `pi sandbox egress revoke <host[:port]> [--user]` | remove a grant |
| `pi sandbox egress list [--user] [--denied]` | grants, or the hosts the proxy blocked |
| `pi sandbox gc [--shared-caches]` | remove sandboxes no session uses, volumes of deleted repositories and unused images |
| `pi sandbox reset [--volumes]` | remove this repository's sandbox once none of its sessions runs; `--volumes` also its cache, overlay and agent volumes |
| `pi sandbox stop` | stop the sandbox VM when no pi session runs |
| `pi sandbox doctor` | prepare the sandbox like `pi` and print one `ok`, `warn`, `fail` or `skip` line per check |
| `pi sandbox --version`, `pi sandbox help` | version and usage |

Failures are one line, `pi-sandbox: <message>`, often followed by `  hint: <what to do>`, with exit code 1.

## Configuration

Four layers, highest first: the policy (`/Library/Application Support/pi-sandbox/policy.json`, set by an administrator), the org baseline (the file `org` names in the policy or user layer; [examples/org-baseline.json](examples/org-baseline.json) is a starting point), the user config `~/.config/pi-sandbox/config.json`, and the project file `<repo>/.pi/sandbox.json`. A key the policy or org sets is final. A project file may set only `mounts.cacheVolumes`, `mounts.autoOverlays`, `resources.cpus` and `resources.memoryGiB`, so a cloned repository cannot add hosts, mounts or credentials. The keys are in [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json); `pi sandbox config` shows the result. A user config for a Java developer:

```json
{
  "egress": { "presets": ["npm", "pypi", "github", "maven", "gradle"], "allow": ["registry.corp.example"] },
  "mounts": { "hostCaches": ["maven", "gradle"] },
  "image": { "packages": ["openjdk-17-jdk-headless", "maven"] }
}
```

- `egress.presets` (default `npm`, `pypi`, `github`) adds package registry and download hosts: `npm`, `pypi`, `github`, `maven`, `gradle`, `go`, `cargo`; `[]` turns them off. `egress.allow` adds `host`, `*.domain` or `host:port` entries, `egress.deny` always wins, and `egress.privateHosts` names hosts that may resolve to private addresses (an internal gateway).
- `mounts.hostCaches` (default none) binds your own tool caches read-write, so a build reuses what you already downloaded: `maven` `~/.m2/repository`, `gradle` `~/.gradle/caches` and `~/.gradle/wrapper`, `npm` `~/.npm/_cacache`, `pip` `~/Library/Caches/pip`, `go` `~/go/pkg/mod`, `cargo` `~/.cargo/registry` and `~/.cargo/git`. Only cache folders, never a tool's config. Host builds then run what the sandbox writes there; see the [threat model](THREAT-MODEL.md#5-known-gaps).
- `mounts.autoOverlays` (default `true`) gives each build output folder its own volume; `false` lets the sandbox use the host's. `mounts.sharedCaches` lists `~/` folders that get one volume shared by all your sandboxes (never your host folder), and `mounts.cacheVolumes` per-repository cache volumes.
- `mounts.extraReadOnly` binds more host paths read-only; protected paths such as `~/.ssh` are refused.
- `image.packages` (Debian packages), `image.npmGlobal` (`name@version`) and `image.dockerfile` (an absolute path to Dockerfile lines, run as root) add a layer to the image. A command the image lacks prints a hint naming these keys.
- `sessions.host` (default `true`), `fallback` (`refuse` or `host`), `tls.extraCa` (a corporate CA file, or `{ "hostStore": true }`), `egress.parentProxy` (`env` uses your `HTTPS_PROXY`), `egress.grants` (`false` turns grants off) and `env.allow` (terminal variables forwarded to each run).

### Credentials

Rules come from your host files on every launch (`credentials.derive`, on by default): each provider in `auth.json` and each provider key in the environment, each `apiKey` and secret header of `models.json`, each HTTP server of `mcp.json`, the hosts of `gh` (2.17 or later) and `glab` with their tokens, the registry credentials of `~/.npmrc`, `pip.conf` and `~/.m2/settings.xml`, and your git `user.name` and `user.email`. Inside, the matching files (`auth.json`, gh `hosts.yml`, glab `config.yml`, `.npmrc`, `pip.conf`, Maven `settings.xml`, `~/.gitconfig` with the gh and glab credential helpers) hold placeholders only, so `gh`, `glab`, `git push`, npm, pip and Maven work as on the host while the proxy fetches the real value on the host (from host pi, `gh auth token`, `glab config get token`, the file or the environment). A derived gh or glab token reaches everything it can on its host; `credentials.derive.hosts` keeps only the hosts you list and `credentials.derive.enabled: false` turns derivation off. `credentials.rules` adds rules by hand, with a secret from `env`, a `file`, a `command` (a keychain or password manager CLI), `piAuth` or `mcpOAuth`; the schema documents each field. MCP servers sign in on the host: host pi keeps the token in `~/.pi/agent/mcp-auth.json` and the proxy injects it. When it is missing or expired, a launch from a terminal runs `pi mcp login <name>` on the host first, and mid-session the proxy opens the sign-in in your browser (at most once per server per minute) and pi inside gets a message to retry. An MCP server defined only in the project's `.pi/mcp.json` gets no token; add it with `pi mcp add`.

### Databases and other services

The sandbox has no engine socket and cannot reach your `localhost`, so `docker compose` and Testcontainers do not work inside. Until sidecar services exist ([future-plans/sandbox-services](../future-plans/sandbox-services/README.md)), run the server inside the sandbox: add it to `image.packages` in the user config (for example `postgresql` and `redis-server`), start it as the `pi` user with its data under `/tmp`, and point the tests at `127.0.0.1`:

```bash
PATH=/usr/lib/postgresql/15/bin:$PATH        # Debian bookworm's PostgreSQL
initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o "-k /tmp" -l /tmp/pg.log start
redis-server --dir /tmp --daemonize yes
```

`/tmp` is a memory-backed tmpfs: the data counts against the container's memory and is gone when the container is removed.

## Uninstall

```bash
launcher/uninstall.sh [--keep-vm] [--volumes] [--bin-dir DIR] [--dry-run]
```

It refuses while a pi session runs in the sandbox. Otherwise it removes the `commondir` pins and empty folders the launcher left in your repositories, stops the proxies and sign-ins it started, removes its containers, relays and networks, deletes the Colima profile `pi-sandbox` with its images and volumes, removes the `pi` link (restoring pi's managed link when `install.sh` replaced it), the state dir `~/.local/state/pi-sandbox/`, the global package and the `PATH` snippet. `--keep-vm` keeps the profile and, unless `--volumes` is given too, the sandbox volumes. `--bin-dir` names the folder `install.sh` used, and `--dry-run` only prints. Your sessions in `~/.pi/agent/sessions`, `~/.pi`, `~/.config/pi-sandbox` and the host cache folders stay.

## Troubleshooting

Start with `pi sandbox doctor`: it names the stage or check that fails.

1. **`<host> was blocked`.** Run `pi sandbox egress allow <host>` on the host (`--user` for every repository), or add the host or a preset to the user config.
2. **`the sandbox VM engine is unreachable`.** Run `colima start --profile pi-sandbox --activate=false`, or `launcher/install.sh` when the profile is missing.
3. **`<repo> is not shared with the sandbox VM`.** Sharing a folder outside your home restarts the VM; exit the other pi sessions and run `pi` again, or run the `colima` command the hint names.
4. **`<cmd> is not in the sandbox image`.** Add the Debian package to `image.packages` (or an npm tool to `image.npmGlobal`) in the user config; the next launch builds the layer.
5. **`the sandbox config changed; it applies after every session in this repository exits`.** Exit the other sessions of the repository; the next `pi` builds the new sandbox. `pi sandbox reset` refuses while any of them runs and says how many do. A launcher killed with `kill -9` leaves its sandbox until the next `pi` in any repository or `pi sandbox gc`.

## More

How it works: [ARCHITECTURE.md](ARCHITECTURE.md), with every file it writes in [Files written](ARCHITECTURE.md#files-written). What each feature weakens and the known gaps: [THREAT-MODEL.md](THREAT-MODEL.md). Where things are: [STRUCTURE.md](STRUCTURE.md). Development: `npm run check` covers the launcher; from a checkout run `node launcher/bin/pi-sandbox-dev.js`; tests against a real Colima engine are in `tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`.
