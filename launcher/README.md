<div align="center">

# pi-sandbox launcher

**Runs pi in a per-repository Linux container, with every credential kept on the host.**

Part of [pi-extensions](../README.md) · [What changes for you](#what-changes-for-you) · [Install](#install) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Known gaps](#known-gaps) · [Threat model](THREAT-MODEL.md)

</div>

## Why

An agent that runs shell commands on your machine can read your keys, your other repositories and your network. The launcher gives you the same `cd repo && pi`, but pi (with this package's extensions) runs inside a container made for that repository. The container sees the repository and its git dir at the same paths as on the host, a volume for pi's agent dir that belongs to that repository, and nothing else of your home. The launcher refuses to start in a directory that would mount more: your home itself (a dotfiles repository, for example), `~/.pi`, its own state or config dir, or `/`, and in a repository inside `~/.pi` or its own state or config dir (with `PI_SANDBOX_USER_CONFIG` set elsewhere, only that file is protected, not its directory). Your terminal variables (`TERM`, `TERM_PROGRAM` and the rest of `env.allow`) go to each pi run, not into the container, so launching from another terminal app reuses the running container.

There are no credentials inside the container. Its only network exit is an egress proxy on the host that allows a configured list of hosts and refuses everything else. Each policy gets its own proxy, and each repository gets its own random token for it, which the launcher puts into the container's proxy URL; the token survives proxy restarts, and `pi sandbox reset` rotates it. The proxy is also the only place that knows the real credentials: the launcher reads your host pi files (`~/.pi/agent/auth.json`, `models.json`, `mcp.json`) on every launch, gives pi inside copies in which every key, token and secret header is a placeholder (`pi-sandbox-` and 24 hex digits), and tells the proxy which host each placeholder belongs to. The proxy terminates TLS for those hosts only, swaps the placeholder for the real value in auth headers, and fetches that value on the host when it needs it (through the pi next to the launcher, an environment variable, a file, or a command such as your keychain). Your settings, agents, prompts, skills, themes and extensions follow the host too, so pi inside feels like pi on the host.

The container runs on a free runtime: Colima's dockerd through the Docker Engine API (the default), or Apple `container` as an alternative.

## What changes for you

Nothing in the common case: `cd repo && pi` runs the same pi with the same providers, MCP servers, settings and packages, and `pi install`, `pi remove`, `pi mcp add|remove|login|logout` and `pi update --extensions` work as with local pi. What is left visible, by design or as a known gap:

- A blocked host fails with `pi-sandbox: <host> is not allowed; run pi sandbox egress allow <host>` (the fetch tool shows it to the model and to you), and when pi exits the launcher prints one line per blocked host. Granting it is `pi sandbox egress allow <host>`; the container cannot grant itself.
- The first launch after an image change prints `preparing pi sandbox, one time`.
- `/login` and the `/mcp` sign-in inside the interface do not work. Log in with host pi, and sign MCP servers in with `pi mcp login <name>` in the shell, which runs on the host; a launch notice names each server that still needs it.
- A stdio MCP server whose `env` holds a secret gets a placeholder; the launch notice says so, and a `credentials.rules` entry for the host that server calls binds it.
- A model server on `localhost` or plain `http` is not reachable from the sandbox; a launch notice says so.
- A rule host that resolves to a private address needs `egress.privateHosts`; a launch notice names it.
- `pi update` with no target prints `pi follows the launcher; update it with npm install -g pi-extensions-mz`.
- `pi config` changes made inside stay in the sandbox; a key you change on the host wins at the next launch.
- A parent proxy that needs NTLM or Kerberos needs a local relay such as `px` or `cntlm`.
- An MCP server defined only in the repository's `.pi/mcp.json` asks y/N before `pi mcp login` signs in to it, and inside the sandbox it gets no OAuth token (move it to `~/.pi/agent/mcp.json`, or give it a placeholder `Authorization` header and a rule).
- Pi sessions live in the repository's sandbox volume, not in host pi's session list.

## Install

macOS, from a checkout or a release:

```bash
launcher/install.sh [--profile solo|team|enterprise] [--org <https url or absolute path> [--org-sha256 <hex>]] [--cpu N] [--memory GiB] [--disk GiB] [--version X.Y.Z] [--bin-dir DIR] [--dry-run]
```

It prints one line per step and can be run again safely:

1. Preflight: macOS, the chip, Homebrew, Node 22.19 or newer.
2. `brew install colima docker` when they are missing (the Docker CLI only, no Docker Desktop).
3. Starts a Colima profile named `pi-sandbox` (vz, virtiofs, ssh agent forwarding, `$HOME` writable; 4 CPUs, 8 GiB memory and 60 GiB disk unless the flags say otherwise; Colima 0.8.0 or newer).
4. Installs the launcher: `npm install -g --legacy-peer-deps=false pi-extensions-mz@<version>` and a link `~/.local/bin/pi` to its `pi-sandbox` command, or, from a checkout, a wrapper that runs `node <checkout>/launcher/bin/pi-sandbox-dev.js`. It refuses to replace a `~/.local/bin/pi` that is not the launcher; pass `--bin-dir` to use another folder. It then checks that pi (a peer dependency) was installed next to the launcher, since the launcher uses that pi on the host to print credentials, sign in to MCP servers and read the provider host table, and stops with a hint when npm skipped it.
5. Adds `~/.local/bin` to `PATH` in `~/.zshrc`, and in `~/.bashrc` and `~/.bash_profile` when they exist, between `# pi-sandbox begin` and `# pi-sandbox end`; a block with other content is replaced. The checkout wrapper quotes the checkout path, so a path with spaces or quotes works.
6. Writes the user config `{ "profile": "<name>" }` when there is none: `enterprise` when a policy file exists, `solo` otherwise, or the `--profile` you passed. With `--org`, it sets `org` in the user config to that source (and `sha256` with `--org-sha256`), keeping the other keys; after that the baseline refreshes silently.
7. Runs `pi sandbox doctor` as the smoke test, inside a temporary git repository under `~/.cache/` (Colima only sees your home), which builds the image and creates a container; it then resets that repository's container and volumes and deletes the directory. Without git it skips the smoke test and says so.

Nothing is started at login: the proxy starts on demand. When it is done:

```bash
cd <repo> && pi
```

## Everyday use

```
pi [args...]                        run pi in the sandbox for this repository
pi --no-sandbox [args...]           run host pi when the policy fallback allows it
pi install|remove <source>          inside the sandbox, then written to the host settings.json
pi mcp add|remove|login|logout ...  run on the host
pi sandbox status                   backend, container, proxy, image, sessions, grants, gaps
pi sandbox config [--json]          effective config with the source layer of each key
pi sandbox config set <key> <json value> [--project]
pi sandbox egress allow <host[:port]> [--session | --hours N | --permanent] [--user]
pi sandbox egress revoke <host[:port]> [--user]
pi sandbox egress list [--denied]   active grants, or the hosts the proxy blocked
pi sandbox gc                       remove stopped containers, idle relays and idle proxies
pi sandbox reset [--volumes]        stop and remove this repo's container and proxy
pi sandbox doctor                   preflight and smoke checks, one line each
pi sandbox migrate --to <backend>   move the volumes to another backend (colima, apple)
pi sandbox --version                print the launcher version
pi sandbox help                     show this help
```

- `pi` passes its arguments to pi inside, `--version` included. The first run in a repository prints `preparing pi sandbox, one time` while it builds the image and creates the container; later runs reuse the container. Pi's exit code is the launcher's exit code. SIGTERM and SIGHUP (and SIGINT when stdin is not a terminal; on a terminal Ctrl-C goes to pi) send SIGTERM to pi alone inside the container (through a per-launch pid file), so the container keeps running; the launcher waits up to five seconds, stops the container only if pi is still running, restore the terminal and exit with `128 + signal number`.
- The container keeps running while any pi session of the repository runs, and is stopped (not removed) when the last one exits; the next `pi` starts it again. Sessions are counted on the host under the state dir, and a session whose launcher process is gone does not count.
- `pi install <source>` and `pi remove <source>` (without `-l`) run inside the sandbox; when pi exits 0, the launcher adds or removes only that entry in the `packages` key of the host `~/.pi/agent/settings.json`, so the host and every other repository see it on their next launch. A local path that exists only inside the sandbox is not written back, and says so. With `-l` (the project's `.pi/settings.json`, which is in the repository) it is a plain pass-through.
- `pi mcp add` and `pi mcp remove` run on the host with the pi next to the launcher, against your host agent dir. `pi mcp login <name>` (with `--timeout <seconds>` if you want) and `pi mcp logout <name>` also run on the host (the browser opens there), against a helper agent dir `<state dir>/mcp-auth/` that holds only that server's URL and plain `oauth` fields; the proxy then injects the token and refreshes it with `pi mcp list` in that dir. A token you already have in host pi's `mcp-auth.json` is copied there on first use, so you are not asked again (it then lives in two places).
- `pi update` with no target prints that pi follows the launcher; `pi update <target>` and `pi update --extensions` run inside.
- `pi --no-sandbox` runs the first `pi` on `PATH` that is not the launcher, after a warning. It needs `fallback: host`; it is refused when `fallback` is `refuse`, and the message names the layer that set it.
- `pi sandbox status` prints one line per fact: the launcher version, the repository, the backend and its version, the container and its state, the container's digest and config hash (`current` when both its image digest and config hash match what the next `pi` would use, otherwise `stale`), a `gap:` line for each capability the backend lacks, one line per running proxy instance (`policy <hash> pid N port N`, marked `this repository` or `other policy`, or `proxy: stopped`), the image, the live sessions of the repository (`session: <launch id> pid N since <time>`) and the active grants (`grant: <host> for this repository|every repository until <time>|permanently`).
- `pi sandbox egress allow <host[:port]>` grants a host for the current session (the default, `--session`: the session named by `PI_SANDBOX_LAUNCH_ID` when set, otherwise the newest running pi session of the repository; it ends with that session and after 12 hours at most), for `--hours N`, or `--permanent`, to this repository or, with `--user`, to every repository. `egress.grants` sets the limits: `enabled`, `maxHours` (default 168) and `permanent`. `revoke <host[:port]>` removes this repository's grants for the host (all ports unless one is named; `--user` for user grants), and `list` prints the active ones; `list --denied` prints what the running proxy blocked for this repository. Grants still pass the private-range check and `egress.deny`, and an `egress.allow` set by the policy or org layer caps them unless that layer sets `egress.grants.enabled: true`.
- `pi sandbox config` prints the effective config as JSON, then `# key: layer` for every key. `config set` validates the whole updated file, refuses a change a higher layer locks and writes nothing in that case. It writes the user file, or the project file with `--project`.
- `pi sandbox gc` removes stopped containers this launcher created (idle repositories included, their volumes stay), relays that no running container uses (an old single `pi-sandbox-relay` included), stops proxy instances that no running container uses and drops grants that expired or whose session ended. `reset` removes this repository's container and the proxy instance of its policy, whose token is then new on the next launch, unless a running container of another repository shares that policy (`kept proxy instance <hash>, in use by another repository`); `--volumes` also removes its agent volume (pi's sessions for this repository) and cache volumes, and the last synced copy of the host `settings.json` and `mcp.json` for it.
- `pi sandbox doctor` prints `ok <check>: <detail>`, `fail <check>: <detail>` or `skip <check>: <reason>` for:
  - the runtime, the proxy and its health endpoint (through this repository's token), the image;
  - inside the container: the same-path mount; a credential sweep (every key, `access` and `refresh` value and secret-named field in pi's `auth.json`, every auth-like header value of an HTTP server and every secret-named `env` value of a stdio server in `mcp.json`, and every environment variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` must be empty or a placeholder; a failure names the variable or JSON path, never the value, and it cannot tell whether a value elsewhere equals a credential the host proxy holds); a no-route check (a direct connection to the internet must fail); `PI_OFFLINE` unset; `pi mcp list` (a failure shows its last line); `trust` (an HTTPS request to a credential rule host verifies the chain); and one `rule <id>` line per credential rule host, which must not answer 401 or 403 to a request carrying the placeholder;
  - on the host: the pi next to the launcher and whether its version equals the image's, the provider host table, whether the parent proxy accepts connections, the org baseline's age and sha256, and the active grants.

  A check that cannot run after an earlier failure is a `skip` line, which does not count as a failure; it exits 1 when any check fails. When the doctor had to create the container, it removes it again afterwards.
- `pi sandbox migrate --to colima|apple` exports the agent and cache volumes through the current backend, imports them through the target (each side runs its archive helper from its own sandbox image id: the recorded image when that backend has it, otherwise the image is pulled, a pinned digest included, or built there first), sets `backend` in the user config and removes the old container. It is refused when policy sets the backend, when the target is the current backend, or when the target is not available.

Failures are one line, `pi-sandbox: <message>`, often followed by `  hint: <what to do>`, with exit code 1.

## Configuration

Four layers, highest first:

- policy: `/Library/Application Support/pi-sandbox/policy.json` on macOS, `/etc/pi-sandbox/policy.json` on Linux, set by an administrator;
- org: the organisation baseline named by `org` in the policy or user layer (see [Org baseline](#org-baseline));
- user: `~/.config/pi-sandbox/config.json`;
- project: `<repo>/.pi/sandbox.json`.

Each file is validated against [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json). `profile` picks a set of defaults; the highest layer that names one wins, and a lower layer naming a different one is refused:

- `solo`: host credentials (pi's own `auth.json`), a small allowlist of package registries and code hosts, `fallback: host` (`--no-sandbox` allowed).
- `team`: `solo`, plus `fallback: refuse` and static credentials (an environment variable or a keychain item).
- `enterprise`: an empty allowlist, `fallback: refuse` and an SSO credential command the policy must set.

Security keys may only be tightened by a lower layer: `egress.allow`, `egress.mcpHosts`, `credentials`, `mounts.extraReadOnly`, `fallback`, `workspaceRoots`, `ssh.agent`, `image.digest` (and `image.reference` while a higher layer pins a digest), `gateway`, and `backend` when policy sets it. The project layer is locked by everything above it, the defaults and the profile included, so a cloned repository cannot add hosts, mounts, credentials, a gateway or a profile, nor turn on the ssh agent. A refused key reads `<layer>: <key> <problem>, locked by <who>`, with the hint to remove it.

A project file may not set `env.allow`, `image.reference` or `image.digest` at all: loading it fails with a message naming the file. Nor may it set `credentials.rules`, `credentials.derive`, `egress.deny`, `egress.privateHosts`, `egress.parentProxy`, `egress.grants`, `tls`, `image.packages`, `image.npmGlobal`, `image.dockerfile` or `org`; `org` is accepted only in the policy and user layers. Below a locking layer, `credentials.rules` may only lose rules, `credentials.derive.enabled`, `egress.grants.enabled` and `egress.grants.permanent` may only turn off, `egress.grants.maxHours` may only shrink, `credentials.derive.hosts`, `egress.privateHosts` and `tls.extraCa` may only lose entries, and `egress.parentProxy` and `org` cannot change. In the policy and user layers, `env.allow` is the union of both; names containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `CREDENTIAL` are refused.

- `egress.allow` and `egress.mcpHosts` entries are `host`, `*.domain`, `host:port` or `*.domain:port` (port 443 when none is named).
- `fallback` is `refuse` or `host` (run host pi on `--no-sandbox`).
- `ssh.agent` (default `false`) forwards the host ssh agent into the container when the backend can; the user layer may turn it on unless policy keeps it off.
- Convenience keys are taken from the lowest layer that sets them: `image.reference` (above the project), `mounts.cacheVolumes`, and `resources.cpus` and `resources.memoryGiB` (merged per subkey).
- Removed keys, refused as unknown: `ports`, `resources.diskGiB`, `resources.idleMinutes`; `fallback: os-sandbox` is now `fallback: host`.

### Org baseline

`org: { "source": "https://…" | "/absolute/path.json", "sha256"?: "<64 hex>", "refreshHours"?: 24 }`, set in the policy or user layer (`install.sh --org` writes it), names a JSON file in the config format that becomes the `org` layer, between policy and user. The launcher caches it in `<state dir>/org/`, refetches it when it is older than `refreshHours` (three-second timeout), and keeps using the cached copy, with one notice, when the fetch fails. With `sha256`, a copy with another hash is refused: the cached copy is used when there is one, otherwise the launch stops. The org layer locks the user and project layers like policy does, and policy locks it. [examples/org-baseline.team.json](examples/org-baseline.team.json) and [examples/org-baseline.enterprise.json](examples/org-baseline.enterprise.json) are starting points.

### Credentials

Rules come from your host pi files automatically (`credentials.derive`, on by default): each provider in `auth.json` (an API key, or an OAuth entry whose access token is kept JWT-shaped when it is a JWT), each provider key in an environment variable the provider host table names, each `apiKey` and secret header of `models.json`, and each HTTP server of `mcp.json` (its secret headers, or a bearer token from `pi mcp login`). `credentials.derive.enabled: false` turns that off; `credentials.derive.hosts` keeps only the hosts it matches. The hosts of built-in providers come from the pi next to the launcher, which must be the same version as the image's pi, otherwise built-in providers get no rule and a notice says so.

`credentials.rules` adds rules by hand, in the policy or user layer only (a lower layer may drop rules, not add or change them):

```json
{
  "credentials": {
    "rules": [
      {
        "id": "corp-gateway",
        "host": "gateway.corp.example",
        "placeholder": "pi-sandbox-corp-gateway",
        "header": "authorization",
        "template": "Bearer {secret}",
        "secret": { "command": ["security", "find-generic-password", "-s", "corp-gateway", "-w"] }
      }
    ]
  }
}
```

`host` (a plain name), `port` (443 when absent) and `pathPrefix` choose the requests. With `placeholder` (which must start with `pi-sandbox-`), the proxy replaces it in auth-like request headers (`authorization` and names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`). With `header`, it sets that header to `template` (with `{secret}` replaced) when the header is absent or still carries the placeholder, which suits git and npm clients that cannot be told to send a placeholder. A rule needs `placeholder` or `header`.

Secret sources (`secret`), resolved on the host and kept in the proxy's memory only:

| source | value |
| --- | --- |
| `{ "env": "NAME" }` | the launcher's environment variable, handed to the proxy at each launch |
| `{ "file": "~/path.json", "pointer": "/a/b" }` | a JSON pointer into a host file |
| `{ "command": ["argv", "..."], "ttlSeconds": 300 }` | the command's stdout, trimmed, or JSON `{ "token", "expiresAt" }`; cached for `ttlSeconds` (300 by default) |
| `{ "piAuth": "<provider>", "bearer": true }` | `pi auth print-api-key` (or `print-bearer-token --min-expiry 5m`) of the pi next to the launcher, so OAuth providers refresh on the host |
| `{ "mcpOAuth": { "server": "<name>", "url": "https://…" } }` | the token `pi mcp login <name>` stored in `<state dir>/mcp-auth/`, refreshed there |

`command` examples: the macOS keychain `["security", "find-generic-password", "-s", "corp-gateway", "-w"]`, pass `["pass", "show", "corp/gateway-token"]`, 1Password `["op", "read", "op://Team/Gateway/token"]`, or any vault CLI that prints a token.

The legacy `credentials.kind` (`static`, `host-pi-auth`, `sso`) and `gateway` keys still work: they become one rule for the gateway host, and the gateway's providers are written into the sandbox `models.json` and `auth.json` with the placeholder.

### Egress

- `egress.deny`: hosts that are never allowed, whatever allows them; the union of all layers.
- `egress.privateHosts`: names that may resolve to private addresses (an internal gateway); host names or `*.domain`, never IP literals or `localhost`. A lower layer may only drop entries.
- `egress.parentProxy`: `"env"` (the default: the launcher's `HTTPS_PROXY` and `NO_PROXY`; Basic credentials in that URL are handed to the proxy over its control socket on every launch, never through the proxy's environment), `"none"`, or `{ "url": "http://proxy:8080", "noProxy": [".corp.example"], "auth": <secret source> }` whose secret is `user:password` for Basic auth. Policy keeps it unchanged below. Image builds use it too when it has no credentials; with credentials a build is refused with a hint to use a prebuilt image.
- `egress.grants`: see `pi sandbox egress` above.
- When the policy or org layer sets `egress.allow`, it caps derived hosts, `credentials.rules` from lower layers (a rule outside it is dropped with a notice; the policy's own rules are exempt) and grants, unless that same layer sets `credentials.derive.enabled: true` (hosts and rules) or `egress.grants.enabled: true` (grants) (D3).

### TLS

`tls.extraCa: [{ "file": "/path/ca.pem" }, { "hostStore": true }]` adds CA certificates (a corporate TLS-inspecting proxy, for example) to the proxy's upstream trust, to the container's trust (`/etc/pi-sandbox/ca.pem`, `NODE_EXTRA_CA_CERTS`, and the CA bundle of git, curl and Python) and to image builds. `hostStore` reads the macOS System keychain; elsewhere it is skipped with a launch notice. The container trusts the launcher CA as well, which signs the certificates for credential rule hosts.

### Image extensions

`image.packages` (Debian package names, optionally `=version`), `image.npmGlobal` (`name@version`) and `image.dockerfile` (an absolute path to Dockerfile lines without `FROM`, run as root) add a layer on top of the sandbox image, built once and reused while those inputs stay the same. A stdio MCP server that needs a runtime, for example:

```json
{
  "image": {
    "packages": ["sqlite3"],
    "npmGlobal": ["example-sqlite-mcp@1.4.2"]
  }
}
```

and in `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "db": { "command": "example-sqlite-mcp", "args": ["--db", "./data/app.db"] } } }
```

The server runs inside the container with the same allowlist; it reaches the network only through the proxy (`HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` are set). Secret `env` values become placeholders; bind them with a `credentials.rules` entry for the host the server calls.

Environment overrides, mainly for tests: `PI_SANDBOX_STATE_DIR` (state dir), `PI_SANDBOX_USER_CONFIG` (user file) and `PI_SANDBOX_POLICY_FILE` (policy file, honoured only when the standard policy file does not exist).

## Files it writes

- `~/.config/pi-sandbox/config.json`: by the installer when absent (and its `org` key with `--org`), by `pi sandbox config set` and by `migrate`.
- `~/.pi/agent/settings.json` on the host: only its `packages` key, only on `pi install|remove <source>` typed in the shell when pi exits 0.
- `<repo>/.pi/sandbox.json`: only on `pi sandbox config set --project`; when that creates `.pi/`, also `.pi/.gitignore` with `*`.
- `~/.local/state/pi-sandbox/`: `image.json` (the image and its layer: reference, digest, id), `pack/` (the extensions tarball cache), `copies/` (read-only copies for runtimes without single-file mounts), `migrate/<time>/` (volume exports), `ca/` (the launcher CA, `trust.pem` with the extra CAs, `extra.pem`), `salt` (mode 600, makes placeholders unguessable), `grants.json` (mode 600), `sessions/<repo hash>/` (one file per running pi), `render/<repo hash>/` (the sandbox `auth.json`, `models.json` and the copied agents, prompts, skills, themes, extensions, `AGENTS.md`, `SYSTEM.md`, `keybindings.json`, mounted read-only), `sync/<repo hash>/` (the last synced host `settings.json` and `mcp.json`), `mcp-auth/` (MCP OAuth tokens and the recorded servers, mode 600), `provider-hosts/<pi version>.json`, `org/` (the cached baseline), and per proxy instance `proxy/<policy hash>/` with `proxy.json` (pid, port and token, mode 600), `proxy-token` (the instance control token, host only), `tokens/<repo hash>` (each repository's token, mode 600), `dynamic.json` (derived rules and hosts, re-read without a restart, mode 600), `proxy-config.json`, `proxy.log`, `proxy-access.log` (one JSON line per proxy decision, never a credential or a token) and `lock`.
- Container runtime objects: containers `pi-sandbox-<repo hash>`, volumes `pi-sandbox-agent-<user hash>-<repo hash>` and `pi-sandbox-cache-<repo hash>-<path hash>`, one relay container `pi-sandbox-relay-<policy hash>` per proxy instance and the network `pi-sandbox`.

## Uninstall

```bash
launcher/uninstall.sh [--volumes] [--vm] [--bin-dir DIR] [--dry-run]
```

It removes the `pi` link or wrapper, the global package, the `PATH` snippet (only a block with both markers), the proxy processes (only a pid whose command is the launcher's proxy daemon), the launcher's containers, the relays and the `pi-sandbox` network. `--volumes` also removes the `pi-sandbox-*` volumes that carry the launcher's managed label, and `--vm` deletes the Colima profile. It removes `sessions/`, `render/`, `sync/`, `mcp-auth/` (your MCP sign-ins), `provider-hosts/`, `org/` and `grants.json` from the state dir, and keeps the rest of it (image record, CA, salt, proxy instances). It never touches your repositories, `~/.pi` or `~/.config/pi-sandbox`.

## Upgrading

Earlier versions used one proxy (`<state dir>/proxy.json`), one relay container `pi-sandbox-relay`, a shared agent volume `pi-sandbox-agent-<hash>`, and a `pi-sandbox` network without the launcher's managed label. After upgrading:

- run `pi sandbox gc` to remove the old relay; stop the old proxy with `kill <pid from proxy.json>` (or `uninstall.sh`, which checks the pid first);
- remove the old network once with `docker network rm pi-sandbox`; the launcher refuses an unmanaged network of that name and says so;
- the old shared agent volume is no longer mounted; each repository starts with a fresh agent volume, and `docker volume rm pi-sandbox-agent-<hash>` removes the old one;
- replace `fallback: os-sandbox` with `fallback: host`, and remove `ports`, `resources.diskGiB` and `resources.idleMinutes`, which are now refused;
- move `env.allow`, `image.reference` and `image.digest` out of any `.pi/sandbox.json` into the user config;
- the image no longer bakes `models.json` and `auth.json`, and every repository gets its own proxy token, so the first launch after upgrading builds the image again and recreates each repository's container.

## Known gaps

Deferred on purpose, each a follow-up:

- Org baselines have no signature and no ETag; pin them with `sha256`.
- Private image registries: pulls send no registry credentials, so use a public or pre-pulled image.
- No headless-browser example and no in-container unauthenticated proxy shim: tools that cannot send proxy credentials (Chromium) have no network.
- No in-interface prompt for blocked hosts: the 403 body and the CONNECT failure say `pi-sandbox: <host> is not allowed; run pi sandbox egress allow <host>`, and the launcher prints one line per blocked host when pi exits.
- `tls.extraCa` `hostStore` is macOS only; on Linux list the CA file.
- The org baseline carries config only, not pi files (agents, settings).
- Project-level OAuth MCP servers get no token inside the container; move the server to the user `mcp.json`, or give it a placeholder `Authorization` header and a rule.
- Sessions are per sandbox and not shared with host pi.
- `/login` and the `/mcp` sign-in inside the interface; a proxy token vault would make them work.
- Providers whose client derives the API host from the token itself may refuse a placeholder token (D5); `pi sandbox doctor` shows a 401 or 403 on that rule.

The full list of what each feature weakens is in [THREAT-MODEL.md](THREAT-MODEL.md).

## Known limits

- The Apple `container` adapter is tested against a fake CLI only, not on a real macOS 26 host; its cleanup in `uninstall.sh` is unverified too, and so are the CLI assumptions `container stop --time`, `volume create --label`, `network create --label` with the `network inspect` fields in `backend/apple/cli.ts` (`APPLE_NETWORK_FIELDS`; a network whose output does not show it is internal is refused) and the `--ssh` socket path. Whether an Apple guest reaches the proxy, which listens on `127.0.0.1`, through the network gateway is unverified; the listen address is not widened for it.
- The relay was verified on Docker Desktop, not on Colima, where it reaches the host through `host.lima.internal`.
- The Colima VM mounts `$HOME` writable, which is what lets repositories under your home work; the VM itself sees all of your home, and only the container's mounts limit what pi sees.
- The allowlist works on host names, so a host that fronts many sites (a CDN) can carry traffic to sites behind it through domain fronting; allow such hosts deliberately.
- The launcher CA has no name constraints: it is trusted inside the container only, but it could sign a certificate for any name there.
- Inside the internal network, DNS resolves container names but nothing external, so tools that resolve names before using the proxy fail.
- On Linux, a host uid other than 1000 cannot write the agent volume, which is owned by uid 1000.
- The proxy speaks HTTP/1.1 to credential rule hosts, without keep-alive. Response bodies are not scrubbed, so a rule host that echoes request headers into a body reflects the secret.
- Plain HTTP is refused, and so are model servers on `localhost`.
- The layer build `FROM <image id>` is unverified on a real Docker engine's classic build endpoint and on Apple `container`.
- Two launchers creating the CA for the first time at the same moment are not serialised.
- An `sso` credential `command` is not checked when the config loads; an empty one fails only when the proxy first needs the credential. The same holds for every `command` secret source.

## Development

`npm run check` covers the launcher: typecheck, Biome, knip and the unit tests in `launcher/tests/`. From a checkout, run `node launcher/bin/pi-sandbox-dev.js`. `npm run build:launcher` compiles `launcher/dist/` for `launcher/bin/pi-sandbox.js`, and `prepack` runs it. Tests against a real engine live in `launcher/tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), where things are in [STRUCTURE.md](STRUCTURE.md).
