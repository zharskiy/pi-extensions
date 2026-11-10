<div align="center">

# pi-sandbox launcher

**Runs pi in a per-repository Linux container, with every credential kept on the host.**

Part of [pi-extensions](../README.md) · [Install](#install) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [How it works](ARCHITECTURE.md) · [Threat model](THREAT-MODEL.md)

</div>

## Why

An agent that runs shell commands on your machine can read your keys, your other repositories and your network. The launcher keeps the same `cd repo && pi`, but pi runs inside a container made for that repository on a Colima VM. The container sees the repository and its git dir at their host paths (git hooks and config read-only), its own volumes, host pi's session directory for that repository, and nothing else of your home.

There are no credentials inside. Pi inside gets copies of your host `auth.json`, `models.json` and `mcp.json` in which every key and token is a placeholder. Its only network exit is a proxy on the host, one per repository, that allows a list of hosts, refuses private addresses, and swaps each placeholder for the real credential on the way out. Your providers, MCP servers, settings, packages, agents and skills follow the host, so pi inside feels like pi on the host. The container, its proxy and its network are removed when the last pi session of the repository exits.

Pi starts in a repository and in any folder that is not one, unless one of the cases below applies. Inside a repository the container gets that repository. A folder that is not a repository is a workspace: one container for the folder, with the git metadata of the repositories in it protected. A folder with no repository at all runs the same way. In a workspace:

- each repository found in the folder has its hooks, config and the other paths host git runs read-only;
- a bare repository in the folder is read-only as a whole: clone and fetch from it work, push does not;
- a checkout whose `.git` file leads outside the folder, or to a git dir that no longer exists outside it, is plain files: its `.git` file is read-only, nothing outside the folder is mounted for it, and git does not work there in the sandbox;
- a folder the launcher cannot read looks empty and read-only in the sandbox;
- `node_modules`, and build output an overlay hides (`.venv`, `target`, `.gradle`), are not searched for repositories.

Two kinds of repository are not protected: one inside a `node_modules` or `.pi` folder that no overlay hides, and a bare repository inside another repository's working tree. A notice names what the launcher found.

The launcher refuses to start:

- in your home, in `~/.pi`, in `~/.ssh` and similar directories, or in `/`, and under a home that is a dotfiles repository; it checks this before it searches anything;
- outside your `workspaceRoots`, when that setting refuses;
- in a folder it cannot read, in a bare repository or anything shaped like a git dir (`HEAD` with `commondir`, or with `objects` and `refs`), or inside a git dir;
- when the folder holds `.git` in another letter case (`.GIT`), which git opens as a repository on a case-insensitive volume;
- in a workspace with more than 50 000 directories to search, or more than 128 repositories and bare repositories;
- when a repository is broken in a way git would not leave it: a linked `.git`, a `.git` file git did not write, git choosing another git dir, a git dir reached through a link in the folder, or the cwd's own `.git` pointing at a git dir that no longer exists;
- when a `.git` file points at a missing git dir inside the folder, where the sandbox could create it (the pointer is followed through links the way git follows it);
- when a bare repository, a detached `.git` file or an unreadable folder changed between the search and the start;
- when a git config file or hooks path a repository reads lies in the folder outside every repository, or an include it names is missing;
- when git is not installed and the folder holds repositories;
- when a writable mount would lie inside, or re-expose, a folder the launcher did not search (build output it skipped or a folder it could not read).

Host git later runs the hooks and config it finds there. If the sandbox could write them, it could run code on your Mac.

## Install

macOS with Homebrew and Node 22.19 or newer. Run the script from a checkout, or from the npm package: after `npm install -g pi-extensions-mz` it is `$(npm root -g)/pi-extensions-mz/launcher/install.sh`.

```bash
launcher/install.sh [--org <absolute path>] [--cpu N] [--memory GiB] [--disk GiB] [--version X.Y.Z] [--bin-dir DIR] [--dry-run]
```

| flag | effect |
| --- | --- |
| `--org <absolute path>` | sets `org` in the user config to that organisation baseline file |
| `--cpu N`, `--memory GiB` | size of the Colima profile when install.sh starts it (a running profile keeps its size until you stop it); default this Mac's CPUs and half its memory, at most 8 CPUs and 10 GiB, at least 2 and 4; values you pass are used as given |
| `--disk GiB` | disk of the Colima profile when install.sh starts it, default 60 |
| `--version X.Y.Z` | the `pi-extensions-mz` version `npm install -g` installs, default the version of the package that holds the script, else the latest; ignored from a checkout, which runs its own sources |
| `--bin-dir DIR` | where the `pi` link goes, an absolute path, default `~/.local/bin` |
| `--dry-run` | prints each step without changing anything |

It prints each step before it runs it, with the output of Homebrew, Colima, npm and the smoke doctor indented below, and can be run again safely. It installs Colima 0.8.0 or newer when missing (no Docker Desktop and no `docker` CLI), starts a Colima profile named `pi-sandbox` without switching your docker context, installs the launcher (`npm install -g`, or from a checkout a wrapper that runs the sources) and links `~/.local/bin/pi` to it, adds `~/.local/bin` to `PATH` (a line `export PATH='<bin dir>':"$PATH"`) in `~/.zshrc` (created when missing) and an existing `~/.bashrc` or `~/.bash_profile`, between `# pi-sandbox begin` and `# pi-sandbox end` (an rc file whose markers do not pair up is left as it is, with a note), and runs `pi sandbox doctor` in a temporary repository as a smoke test. When `~/.local/bin/pi` is pi's own managed install, it records the link and replaces it; `uninstall.sh` puts it back. Any other `pi` there makes it stop; pass `--bin-dir`.

The launcher runs a host pi for host jobs (printing credentials for the proxy, MCP sign-in, the provider host table): pi's managed install in `~/.pi/agent`, else the pi installed next to the launcher. The sandbox image is built with that pi's version and rebuilt when it changes. A `pi` found on `PATH` is used only by `pi --no-sandbox`.

## First run

```bash
cd <repo> && pi
```

The first launch prints `preparing pi sandbox, one time` and the image build steps. The build runs in the VM, not through the sandbox proxy, so `egress.allow` does not apply to it: the VM's engine pulls `node:24-bookworm-slim` from Docker Hub, and the build downloads from deb.debian.org, gitlab.com (glab) and registry.npmjs.org (pi), plus the sources of `image.packages` and `image.npmGlobal`. A failed build shows the last 30 lines of its output; behind a proxy or CA that signs downloads, set `tls.extraCa` (or `image.digest` to a prebuilt image). Later launches reuse the image, and a second `pi` in the same repository joins the running container. A stopped VM (after a reboot or `pi sandbox stop`) is started by the next `pi`, which takes 15 to 40 seconds. A repository outside your home is shared with the VM at its first launch, which restarts the VM and is refused while other pi sessions run.

What is different inside:

- A blocked host gets a 403 page saying to run `pi sandbox egress allow <host>` on the host. When pi exits the launcher prints one line per blocked host with what to do: grant it (or, with grants off, ask your administrator to add it to `egress.allow`), add a host that resolves to a private address to `egress.privateHosts`, nothing for a host `egress.deny` names (denied by policy), use https instead of plain HTTP, or the reason it could not be reached.
- `NO_PROXY` holds `localhost,127.0.0.1,::1`, so tests reach servers you start inside without the proxy.
- `pi install|remove <source>` and `pi mcp add|remove|login|logout` run with host pi on the host; the sandbox picks the change up at the next launch. `install|remove` run from an empty folder, with a local source handed over as an absolute path. A source is remote only as a plain `npm:<name>[@version]`, an `http(s)://` or `ssh://` git URL with owner and repository, or `git:git@host:owner/repo` and `git:host.tld/owner/repo`; anything else is a local path, and `pi install` refuses one inside the repository. An `npm:` spec naming a path or another protocol (`npm:file:…`, `npm:link:…`, `npm:/…`) is refused, and so are hosted shorthands such as `git:user/repo` and npm aliases from inside the repository: use the full URL. `pi update` alone (or `pi update pi`, `self` or `--self`) updates host pi.
- Provider `/login` inside does not work; log in with host pi.
- Build output gets its own volume, so Linux builds never mix with the host's: `node_modules` beside an npm, pnpm, yarn or bun lockfile, `.venv` beside `uv.lock`, `poetry.lock` or `Pipfile.lock`, `target` beside `Cargo.lock`, `.gradle` beside `settings.gradle(.kts)`. Maven `target/` and Gradle `build/` are shared with the host. Run the install once inside. A build output folder inside a read-only mount or a git dir gets no volume, with a notice.
- `/home/pi` and `/tmp` live in memory: tool caches (npm, pip, uv, Maven, Gradle) count against the container's memory, are downloaded again by each new sandbox and vanish when the last session exits, unless `mounts.hostCaches` or `mounts.sharedCaches` keeps them.
- While a sandbox of the repository runs, `.git/commondir` holds `.`; the launcher pins it so the sandbox cannot point host git at another config, and removes it afterwards.
- Pi sessions live in host pi's own session directory for the repository, so `/resume` on the host lists them. The agent can read this repository's earlier sessions; `sessions.host: false` keeps them in the sandbox volume.
- Notices (overlays, workspace, host caches, MCP sign-in, private hosts, ignored config keys; the `render: <dir> looks like a secrets directory` notice for a `secrets` or `credentials` directory of your agents, skills, prompts, themes or extensions, which stays on the host) print once per repository until their text changes.

## Everyday use

| command | what it does |
| --- | --- |
| `pi [args...]` | run pi in the sandbox for this repository; pi's exit code is the launcher's |
| `pi --no-sandbox [args...]` | run host pi, when `fallback` is `host` |
| `pi install\|remove <source>` | with host pi on the host (`-l` passes through into the sandbox) |
| `pi mcp add\|remove\|login\|logout ...` | with host pi on the host |
| `pi update` | update host pi |
| `pi sandbox status` | runtime, container, proxy, image, launches, grants, overlays, shared caches |
| `pi sandbox config [--json]` | the effective config and the layer each key comes from |
| `pi sandbox egress allow <host[:port]> [--user]` | allow a host for this repository, or with `--user` for every repository, until revoked |
| `pi sandbox egress revoke <host[:port]> [--user]` | remove a grant |
| `pi sandbox egress list [--user] [--denied]` | grants, or the hosts the proxy blocked |
| `pi sandbox gc [--shared-caches]` | remove sandboxes no session uses, volumes of deleted repositories and unused images; `--shared-caches` also your unused shared cache volumes |
| `pi sandbox reset [--volumes]` | remove this repository's sandbox once none of its sessions runs; `--volumes` also its cache, overlay and agent volumes |
| `pi sandbox stop` | stop the sandbox VM when no pi session runs |
| `pi sandbox doctor` | prepare the sandbox like `pi` and print one `ok`, `warn`, `fail` or `skip` line per check |
| `pi sandbox --version`, `pi sandbox help` | version and usage |

`pi sandbox egress allow` refuses a host that `egress.deny` names, since a grant cannot override it. `pi sandbox reset --volumes` also removes this repository's agent volumes left under older names.

Failures are one line, `pi-sandbox: <message>`, often followed by `  hint: <what to do>`, with exit code 1 (70 for an unexpected error).

## Configuration

Four layers, highest first: the policy (`/Library/Application Support/pi-sandbox/policy.json`, set by an administrator), the org baseline (the file `org` names in the policy or user layer), the user config `~/.config/pi-sandbox/config.json`, and the project file `<repo>/.pi/sandbox.json`, which must be a regular file, not a link. `PI_SANDBOX_USER_CONFIG` and `PI_SANDBOX_STATE_DIR` move the user config and the state dir; `PI_SANDBOX_POLICY_FILE` names a policy file only while the standard one does not exist, so it never overrides an administrator's policy.

- List keys that add: `egress.allow`, `egress.deny`, `egress.privateHosts`, `image.packages`, `credentials.rules` and `env.allow` collect the entries of every layer, so your user config adds hosts, packages and rules to the org's and removes none. `egress.deny` wins over every allow, and a rule whose `id` a higher layer already uses is ignored.
- Every other key the policy or org sets is final, for example `egress.grants`, `fallback`, `egress.parentProxy`, `egress.presets`, `tls`, `sessions`, `credentials.derive`, `resources` and `mounts.hostCaches`. A lower layer that sets it too does not stop the launch: its value is ignored.
- A project file may set only `mounts.cacheVolumes`, `mounts.autoOverlays`, `resources.cpus` and `resources.memoryGiB`, so a cloned repository cannot add hosts, private hosts, mounts, packages or credentials. Any other key in it is ignored.
- Ignored keys print one warning naming each key and its layer, once per repository until the text changes; `pi sandbox config` lists them every time.
- An invalid value stops the launch with a message naming the key and, for paths, names and choices, the value (`mounts.cacheVolumes[0] ../out must be …`); host, credential, `org` and `npmGlobal` values are never shown, and unprintable characters appear escaped.

[examples/org-baseline.json](examples/org-baseline.json) is a starting point for an org baseline: it refuses `--no-sandbox`, turns grants off, names the internal gateway, registry and git hosts (also as private hosts, since they resolve to internal addresses), denies a paste site, adds the corporate CA and a gateway and registry credential, and keeps credential derivation on so `gh`, `glab`, npm, pip and Maven work as on the host. The keys are in [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json); `pi sandbox config` shows the result. The baseline binds only when the root-owned policy file sets `org` to it (with `fallback: "refuse"` to close `--no-sandbox`); `install.sh --org` writes `org` into the user config, which the user can edit or drop. The launcher neither fetches nor verifies the file, so ship it to a fixed local path by MDM or a package: it is read at every launch, and a missing file stops every launch, `--no-sandbox` included. A user config for a Java developer:

```json
{
  "egress": { "presets": ["npm", "pypi", "github", "maven", "gradle"], "allow": ["registry.corp.example"] },
  "mounts": { "hostCaches": ["maven", "gradle"] },
  "image": { "packages": ["openjdk-17-jdk-headless", "maven"] }
}
```

- `egress.presets` (default `npm`, `pypi`, `github`) adds package registry and download hosts: `npm`, `pypi`, `github`, `maven`, `gradle`, `go`, `cargo`; `[]` turns them off. `egress.allow` adds `host`, `*.corp.example` (exactly one label more, not `corp.example` itself) or `host:port` entries, and an entry without a port allows 443 only, and one for port 80 (`host:80`) never takes effect, since the proxy refuses every `CONNECT` to port 80 as plain HTTP; `egress.deny` always wins, a `host` entry denying the host and every name under it and `*.domain` every name under the domain, and `egress.privateHosts` names hosts that may resolve to private addresses (an internal gateway).
- `mounts.hostCaches` (default none) binds your own tool caches read-write, so a build reuses what you already downloaded: `maven` `~/.m2/repository`, `gradle` `~/.gradle/caches` and `~/.gradle/wrapper`, `npm` `~/.npm/_cacache`, `pip` `~/Library/Caches/pip`, `go` `~/go/pkg/mod`, `cargo` `~/.cargo/registry` and `~/.cargo/git`. Only cache folders, never a tool's config. Host builds then run what the sandbox writes there; see the [threat model](THREAT-MODEL.md#5-known-gaps).
- `mounts.autoOverlays` (default `true`) gives each build output folder its own volume; `false` lets the sandbox use the host's. `mounts.sharedCaches` lists `~/` folders that get one volume shared by all your sandboxes (never your host folder), and `mounts.cacheVolumes` per-repository cache volumes (relative directories, no `.`, `..`, `.git` in any letter case or empty segments, no entry twice or inside another).
- `mounts.extraReadOnly` binds more host paths read-only; protected paths such as `~/.ssh` are refused.
- `image.packages` (Debian packages), `image.npmGlobal` (`name@version`) and `image.dockerfile` (an absolute or `~/` path to a file of Dockerfile lines, run as root) add a layer to the image. A command the image lacks prints a hint naming `image.packages` and `image.npmGlobal`.
- `image.reference` with `image.digest` (`sha256:…`) pulls a prebuilt image instead of building one.
- `resources.cpus` and `resources.memoryGiB` limit the container (a project may set them); `workspaceRoots` (`{ "roots": [...], "outside": "refuse" }` or `"warn"`) refuses or warns about a launch outside those folders.
- `sessions.host` (default `true`), `fallback` (default `host`, which allows `pi --no-sandbox`; `refuse` turns it off), `egress.grants` (`false` turns grants off) and `env.allow` (terminal variables forwarded to each run; secret-looking names and the variables the launcher sets inside, the proxy and CA variables, `HOME`, `PATH` and `PWD` included, are refused).

### Corporate proxy and TLS inspection

- `egress.parentProxy: "env"` (the default) chains the launcher proxy to `HTTPS_PROXY` and `NO_PROXY` of the shell that runs `pi`, not to the macOS system proxy or a PAC file. An `HTTPS_PROXY` that is not an `http://` URL is not used: the launch warns and the proxy connects directly. NTLM or Kerberos proxies need a local relay such as `px` or `cntlm`.
- The image build gets the same `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, with a loopback relay rewritten to the host. A proxy URL with credentials is refused for builds, since they would be written into the build: use a proxy without them, or `image.reference` and `image.digest` to a prebuilt image.
- `tls.extraCa` (`[{ "file": "/path/corp-ca.pem" }]`, or `[{ "hostStore": true }]` for the macOS System keychain) is trusted by the launcher proxy upstream, inside the container and during the image build steps.
- `tls.extraCa` does not reach the VM's engine, so when the proxy inspects Docker Hub the base image pull fails with an x509 error (a [known gap](THREAT-MODEL.md#5-known-gaps)). Until it does, add a `provision` script with `mode: system` to `~/.colima/pi-sandbox/colima.yaml` that copies the CA into `/usr/local/share/ca-certificates/`, runs `update-ca-certificates` and restarts docker, then restart the profile; or pull a prebuilt image (`image.reference` and `image.digest`) from a registry the proxy does not inspect.

### Credentials

Rules come from your host files on every launch (`credentials.derive`, on by default): each provider in `auth.json` and each provider key in the environment, each `apiKey` and secret header of `models.json`, each HTTP server of `mcp.json`, the hosts of `gh` (2.17 or later) and `glab` with their tokens, the registry credentials of `~/.npmrc`, `pip.conf` and `~/.m2/settings.xml`, and your git `user.name` and `user.email`. Inside, the matching files (`auth.json`, gh `hosts.yml`, glab `config.yml`, `.npmrc`, `pip.conf`, Maven `settings.xml`, `~/.gitconfig` with the gh and glab credential helpers) hold placeholders only, so `gh`, `glab`, `git push`, npm, pip and Maven work as on the host while the proxy fetches the real value on the host (from host pi, `gh auth token`, `glab config get token`, the file or the environment). When `gh` or `glab` does not answer its token probe in time (a Keychain prompt during the launch, for example), that tool has no credentials in the sandbox until the next launch, with a notice. A stdio MCP server's env or flag value becomes a placeholder by its name (a secret segment such as token, secret, password, apikey or `key` at the end) or by its shape (`Bearer …`, a JWT, a URL with userinfo); a secret under an unusual name, or a purely numeric one, needs a clearer name or a `credentials.rules` entry. A derived gh or glab token reaches everything it can on its host; `credentials.derive.hosts` keeps only the hosts you list and `credentials.derive.enabled: false` turns derivation off. `credentials.rules` adds rules by hand, with a secret from `env`, a `file`, a `command` (a keychain or password manager CLI), `piAuth` or `mcpOAuth`; the schema documents each field. MCP servers sign in on the host: host pi keeps the token in `~/.pi/agent/mcp-auth.json` and the proxy injects it. When it is missing or expired and cannot be refreshed, a launch from a terminal runs `pi mcp login <name>` on the host first (`pi sandbox doctor` never does; it names the command); after a failed or cancelled sign-in this is skipped for a day and the launch prints `run pi mcp login <name>`. Mid-session the proxy opens the sign-in in your browser (at most once per server per minute, none for 10 minutes after a failure) and pi inside gets a message to retry. An MCP server defined only in the project's `.pi/mcp.json` gets no token; add it with `pi mcp add`.

### Databases and other services

The sandbox has no engine socket and cannot reach your `localhost`, so `docker compose` and Testcontainers do not work inside. Until sidecar services exist ([future-plans/sandbox-services](../future-plans/sandbox-services/README.md)), run the server inside the sandbox: add it to `image.packages` in the user config (for example `postgresql` and `redis-server`), start it as the `pi` user with its data under `/tmp`, and point the tests at `127.0.0.1`:

```bash
PATH=/usr/lib/postgresql/15/bin:$PATH        # Debian bookworm's PostgreSQL
initdb -D /tmp/pg --no-locale -E UTF8 -U postgres && pg_ctl -D /tmp/pg -o "-k /tmp" -l /tmp/pg.log start
redis-server --dir /tmp --daemonize yes
```

`/tmp` is a memory-backed tmpfs: the data counts against the container's memory and is gone when the container is removed.

## Uninstall

```bash
launcher/uninstall.sh [--keep-vm] [--volumes] [--bin-dir DIR] [--dry-run]
```

It refuses while a pi session runs in the sandbox. Otherwise it removes the `commondir` pins and empty folders the launcher left in your repositories, stops the proxies and sign-ins it started, removes its containers, relays and networks, deletes the Colima profile `pi-sandbox` with its images and volumes, removes the `pi` link (restoring pi's managed link when `install.sh` replaced it), the state dir `~/.local/state/pi-sandbox/`, the global package and the `PATH` snippet. `--keep-vm` keeps the profile and, unless `--volumes` is given too, the sandbox volumes. Without `--keep-vm` the containers, volumes and images go with the profile; if `colima delete` fails, the containers are removed through the engine and uninstall exits 1 naming the command to run. `--bin-dir` names the folder `install.sh` used, by default the one in the `PATH` snippet, and `--dry-run` only prints. Your sessions in `~/.pi/agent/sessions`, `~/.pi`, `~/.config/pi-sandbox` and the host cache folders stay.

## Troubleshooting

Start with `pi sandbox doctor`: it names the stage or check that fails.

1. **`<host> was blocked; <hint>`.** Follow the hint: for a host that is not allowed, run `pi sandbox egress allow <host>` on the host (`--user` for every repository) or add the host or a preset to the user config.
2. **`the sandbox VM engine is unreachable`.** Run `colima start --profile pi-sandbox --activate=false`, or `launcher/install.sh` when the profile is missing. `pi sandbox gc` and `pi sandbox reset` still clean the host side while the VM is stopped and say the engine step was skipped.
3. **`<repo> is not shared with the sandbox VM`.** Sharing a folder outside your home restarts the VM; exit the other pi sessions and run `pi` again, or run the `colima` command the hint names.
4. **`upstream request failed: ... certificate ...`** (an HTTP 502, also a failed `rule` line in `pi sandbox doctor`). A proxy or CA on your network signs the host; set `tls.extraCa`.
5. **`<cmd> is not in the sandbox image`.** Add the Debian package to `image.packages` (or an npm tool to `image.npmGlobal`) in the user config; the next launch builds the layer.
6. **`the sandbox config changed (<what>); it applies after every session in this repository exits`.** `<what>` names the parts that differ from the running sandbox: config, image, credentials, overlays or mounts. Exit the other sessions of the repository; the next `pi` builds the new sandbox. `pi sandbox reset` refuses while any of them runs and says how many do. A launcher killed with `kill -9` leaves its sandbox until the next `pi` in any repository or `pi sandbox gc`.

## More

How it works: [ARCHITECTURE.md](ARCHITECTURE.md), with every file it writes in [Files written](ARCHITECTURE.md#files-written). What each feature weakens and the known gaps: [THREAT-MODEL.md](THREAT-MODEL.md). Where things are: [STRUCTURE.md](STRUCTURE.md). Development: `npm run check` covers the launcher; from a checkout run `node launcher/bin/pi-sandbox-dev.js`; tests against a real Colima engine are in `tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`.
