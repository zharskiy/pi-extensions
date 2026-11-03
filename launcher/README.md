<div align="center">

# pi-sandbox launcher

**Runs pi in a per-repository Linux container, with every credential kept on the host.**

Part of [pi-extensions](../README.md) · [Install](#install) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Known limits](#known-limits)

</div>

## Why

An agent that runs shell commands on your machine can read your keys, your other repositories and your network. The launcher gives you the same `cd repo && pi`, but pi (with this package's extensions) runs inside a container made for that repository. The container sees the repository and its git dir at the same paths as on the host, a volume for pi's agent dir that belongs to that repository, and nothing else of your home. The launcher refuses to start in a directory that would mount more: your home itself (a dotfiles repository, for example), `~/.pi`, its own state or config dir, or `/`, and in a repository inside `~/.pi` or its own state or config dir (with `PI_SANDBOX_USER_CONFIG` set elsewhere, only that file is protected, not its directory). Your terminal variables (`TERM`, `TERM_PROGRAM` and the rest of `env.allow`) go to each pi run, not into the container, so launching from another terminal app reuses the running container.

There are no credentials inside the container. Its only network exit is an egress proxy on the host that allows a configured list of hosts and refuses everything else. Each policy gets its own proxy, and each proxy accepts only requests that carry its random token, which the launcher puts into the container's proxy URL. The token survives proxy restarts, so a restarted proxy does not recreate the container as long as its relay keeps its address (a stopped relay is started again, not recreated; a new relay may get a new address, which gives the next `pi` a fresh container); `pi sandbox reset` rotates it. When a model gateway is configured, the proxy is also the only place that knows the real credential: pi inside sends a placeholder, which must start with `pi-sandbox-`, and the proxy swaps it for the real header only on requests to that gateway.

The container runs on a free runtime: Colima's dockerd through the Docker Engine API (the default), or Apple `container` as an alternative.

## Install

macOS, from a checkout or a release:

```bash
launcher/install.sh [--profile solo|team|enterprise] [--cpu N] [--memory GiB] [--disk GiB] [--version X.Y.Z] [--bin-dir DIR] [--dry-run]
```

It prints one line per step and can be run again safely:

1. Preflight: macOS, the chip, Homebrew, Node 22.19 or newer.
2. `brew install colima docker` when they are missing (the Docker CLI only, no Docker Desktop).
3. Starts a Colima profile named `pi-sandbox` (vz, virtiofs, ssh agent forwarding, `$HOME` writable; 4 CPUs, 8 GiB memory and 60 GiB disk unless the flags say otherwise; Colima 0.8.0 or newer).
4. Installs the launcher: `npm install -g pi-extensions-mz@<version>` and a link `~/.local/bin/pi` to its `pi-sandbox` command, or, from a checkout, a wrapper that runs `node <checkout>/launcher/bin/pi-sandbox-dev.js`. It refuses to replace a `~/.local/bin/pi` that is not the launcher; pass `--bin-dir` to use another folder.
5. Adds `~/.local/bin` to `PATH` in `~/.zshrc`, and in `~/.bashrc` and `~/.bash_profile` when they exist, between `# pi-sandbox begin` and `# pi-sandbox end`; a block with other content is replaced. The checkout wrapper quotes the checkout path, so a path with spaces or quotes works.
6. Writes the user config `{ "profile": "<name>" }` when there is none: `enterprise` when a policy file exists, `solo` otherwise, or the `--profile` you passed.
7. Runs `pi sandbox doctor` as the smoke test, inside a temporary git repository under `~/.cache/` (Colima only sees your home), which builds the image and creates a container; it then resets that repository's container and volumes and deletes the directory. Without git it skips the smoke test and says so.

Nothing is started at login: the proxy starts on demand. When it is done:

```bash
cd <repo> && pi
```

## Everyday use

```
pi [args...]                        run pi in the sandbox for this repository
pi --no-sandbox [args...]           run host pi when the policy fallback allows it
pi sandbox status                   backend, container, proxy, image digest, gaps
pi sandbox config [--json]          effective config with the source layer of each key
pi sandbox config set <key> <json value> [--project]
pi sandbox gc                       remove stopped containers, idle relays and idle proxies
pi sandbox reset [--volumes]        stop and remove this repo's container and proxy
pi sandbox doctor                   preflight and smoke checks, one line each
pi sandbox migrate --to <backend>   move the volumes to another backend (colima, apple)
pi sandbox --version                print the launcher version
pi sandbox help                     show this help
```

- `pi` passes its arguments to pi inside, `--version` included. The first run in a repository prints `preparing pi sandbox, one time` while it builds the image and creates the container; later runs reuse the container. Pi's exit code is the launcher's exit code. SIGTERM and SIGHUP (and SIGINT when stdin is not a terminal; on a terminal Ctrl-C goes to pi) send SIGTERM to pi alone inside the container (through a per-launch pid file), so the container keeps running; the launcher waits up to five seconds, stops the container only if pi is still running, restore the terminal and exit with `128 + signal number`.
- `pi --no-sandbox` runs the first `pi` on `PATH` that is not the launcher, after a warning. It needs `fallback: host`; it is refused when `fallback` is `refuse`, and the message names the layer that set it.
- `pi sandbox status` prints one line per fact: the launcher version, the repository, the backend and its version, the container and its state, the container's digest and config hash (`current` when both its image digest and config hash match what the next `pi` would use, otherwise `stale`), a `gap:` line for each capability the backend lacks, one line per running proxy instance (`policy <hash> pid N port N`, marked `this repository` or `other policy`, or `proxy: stopped`) and the image.
- `pi sandbox config` prints the effective config as JSON, then `# key: layer` for every key. `config set` validates the whole updated file, refuses a change a higher layer locks and writes nothing in that case. It writes the user file, or the project file with `--project`.
- `pi sandbox gc` removes stopped containers this launcher created, relays that no running container uses (an old single `pi-sandbox-relay` included) and stops proxy instances that no running container uses. `reset` removes this repository's container and the proxy instance of its policy, whose token is then new on the next launch, unless a running container of another repository shares that policy (`kept proxy instance <hash>, in use by another repository`); `--volumes` also removes its agent volume (pi's sessions for this repository) and cache volumes.
- `pi sandbox doctor` prints `ok <check>: <detail>`, `fail <check>: <detail>` or `skip <check>: <reason>` for the runtime, the proxy and its health endpoint, the image, the same-path mount, a credential sweep inside the container (every string in pi's `auth.json` other than an entry's `type` must be the placeholder, and every environment variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` must be empty or the placeholder; a failure names the variable or JSON path, never the value. It cannot tell whether a value elsewhere equals a credential the host proxy holds) and a no-route check (a direct connection to the internet must fail). A check that cannot run after an earlier failure is a `skip` line, which does not count as a failure; it exits 1 when any check fails.
- `pi sandbox migrate --to colima|apple` exports the agent and cache volumes through the current backend, imports them through the target (each side runs its archive helper from its own sandbox image id: the recorded image when that backend has it, otherwise the image is pulled, a pinned digest included, or built there first), sets `backend` in the user config and removes the old container. It is refused when policy sets the backend, when the target is the current backend, or when the target is not available.

Failures are one line, `pi-sandbox: <message>`, often followed by `  hint: <what to do>`, with exit code 1.

## Configuration

Three layers, highest first:

- policy: `/Library/Application Support/pi-sandbox/policy.json` on macOS, `/etc/pi-sandbox/policy.json` on Linux, set by an administrator;
- user: `~/.config/pi-sandbox/config.json`;
- project: `<repo>/.pi/sandbox.json`.

Each file is validated against [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json). `profile` picks a set of defaults; the highest layer that names one wins, and a lower layer naming a different one is refused:

- `solo`: host credentials (pi's own `auth.json`), a small allowlist of package registries and code hosts, `fallback: host` (`--no-sandbox` allowed).
- `team`: `solo`, plus `fallback: refuse` and static credentials (an environment variable or a keychain item).
- `enterprise`: an empty allowlist, `fallback: refuse` and an SSO credential command the policy must set.

Security keys may only be tightened by a lower layer: `egress.allow`, `egress.mcpHosts`, `credentials`, `mounts.extraReadOnly`, `fallback`, `workspaceRoots`, `ssh.agent`, `image.digest` (and `image.reference` while a higher layer pins a digest), `gateway`, and `backend` when policy sets it. The project layer is locked by everything above it, the defaults and the profile included, so a cloned repository cannot add hosts, mounts, credentials, a gateway or a profile, nor turn on the ssh agent. A refused key reads `<layer>: <key> <problem>, locked by <who>`, with the hint to remove it.

A project file may not set `env.allow`, `image.reference` or `image.digest` at all: loading it fails with a message naming the file. In the policy and user layers, `env.allow` is the union of both; names containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `CREDENTIAL` are refused.

- `egress.allow` and `egress.mcpHosts` entries are `host`, `*.domain`, `host:port` or `*.domain:port` (port 443 when none is named).
- `fallback` is `refuse` or `host` (run host pi on `--no-sandbox`).
- `ssh.agent` (default `false`) forwards the host ssh agent into the container when the backend can; the user layer may turn it on unless policy keeps it off.
- Convenience keys are taken from the lowest layer that sets them: `image.reference` (above the project), `mounts.cacheVolumes`, and `resources.cpus` and `resources.memoryGiB` (merged per subkey).
- Removed keys, refused as unknown: `ports`, `resources.diskGiB`, `resources.idleMinutes`; `fallback: os-sandbox` is now `fallback: host`.

Environment overrides, mainly for tests: `PI_SANDBOX_STATE_DIR` (state dir), `PI_SANDBOX_USER_CONFIG` (user file) and `PI_SANDBOX_POLICY_FILE` (policy file, honoured only when the standard policy file does not exist).

## Files it writes

- `~/.config/pi-sandbox/config.json`: by the installer when absent, by `pi sandbox config set` and by `migrate`.
- `<repo>/.pi/sandbox.json`: only on `pi sandbox config set --project`; when that creates `.pi/`, also `.pi/.gitignore` with `*`.
- `~/.local/state/pi-sandbox/`: `image.json` (the image: reference, digest, id), `pack/` (the extensions tarball cache), `copies/` (read-only copies for runtimes without single-file mounts), `migrate/<time>/` (volume exports), `ca/` (the launcher CA), and per proxy instance `proxy/<policy hash>/` with `proxy.json` (pid, port and token, mode 600), `proxy-token` (the instance token, mode 600, kept until `reset`), `proxy-config.json`, `proxy.log`, `proxy-access.log` (one JSON line per proxy decision, never a credential or the token) and `lock`.
- Container runtime objects: containers `pi-sandbox-<repo hash>`, volumes `pi-sandbox-agent-<user hash>-<repo hash>` and `pi-sandbox-cache-<repo hash>-<path hash>`, one relay container `pi-sandbox-relay-<policy hash>` per proxy instance and the network `pi-sandbox`.

## Uninstall

```bash
launcher/uninstall.sh [--volumes] [--vm] [--bin-dir DIR] [--dry-run]
```

It removes the `pi` link or wrapper, the global package, the `PATH` snippet (only a block with both markers), the proxy processes (only a pid whose command is the launcher's proxy daemon), the launcher's containers, the relays and the `pi-sandbox` network. `--volumes` also removes the `pi-sandbox-*` volumes that carry the launcher's managed label, and `--vm` deletes the Colima profile. It never touches your repositories, `~/.pi`, `~/.config/pi-sandbox` or the state dir.

## Upgrading

Earlier versions used one proxy (`<state dir>/proxy.json`), one relay container `pi-sandbox-relay`, a shared agent volume `pi-sandbox-agent-<hash>`, and a `pi-sandbox` network without the launcher's managed label. After upgrading:

- run `pi sandbox gc` to remove the old relay; stop the old proxy with `kill <pid from proxy.json>` (or `uninstall.sh`, which checks the pid first);
- remove the old network once with `docker network rm pi-sandbox`; the launcher refuses an unmanaged network of that name and says so;
- the old shared agent volume is no longer mounted; each repository starts with a fresh agent volume, and `docker volume rm pi-sandbox-agent-<hash>` removes the old one;
- replace `fallback: os-sandbox` with `fallback: host`, and remove `ports`, `resources.diskGiB` and `resources.idleMinutes`, which are now refused;
- move `env.allow`, `image.reference` and `image.digest` out of any `.pi/sandbox.json` into the user config.

## Known limits

- The Apple `container` adapter is tested against a fake CLI only, not on a real macOS 26 host; its cleanup in `uninstall.sh` is unverified too, and so are the CLI assumptions `container stop --time`, `volume create --label`, `network create --label` with the `network inspect` fields in `backend/apple/cli.ts` (`APPLE_NETWORK_FIELDS`; a network whose output does not show it is internal is refused) and the `--ssh` socket path. Whether an Apple guest reaches the proxy, which listens on `127.0.0.1`, through the network gateway is unverified; the listen address is not widened for it.
- The relay was verified on Docker Desktop, not on Colima, where it reaches the host through `host.lima.internal`.
- The Colima VM mounts `$HOME` writable, which is what lets repositories under your home work; the VM itself sees all of your home, and only the container's mounts limit what pi sees.
- The allowlist works on host names, so a host that fronts many sites (a CDN) can carry traffic to sites behind it through domain fronting; allow such hosts deliberately.
- The launcher CA has no name constraints: it is trusted inside the container only, but it could sign a certificate for any name there.
- Inside the internal network, DNS resolves container names but nothing external, so tools that resolve names before using the proxy fail.
- On Linux, a host uid other than 1000 cannot write the agent volume, which is owned by uid 1000.
- Image pulls send no registry credentials, so a private registry does not work.
- The proxy speaks HTTP/1.1 to the gateway, without keep-alive.
- Two launchers creating the CA for the first time at the same moment are not serialised.
- An `sso` credential `command` is not checked when the config loads; an empty one fails only when the proxy first needs the credential.

## Development

`npm run check` covers the launcher: typecheck, Biome, knip and the unit tests in `launcher/tests/`. From a checkout, run `node launcher/bin/pi-sandbox-dev.js`. `npm run build:launcher` compiles `launcher/dist/` for `launcher/bin/pi-sandbox.js`, and `prepack` runs it. Tests against a real engine live in `launcher/tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), where things are in [STRUCTURE.md](STRUCTURE.md).
