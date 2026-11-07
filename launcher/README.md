<div align="center">

# pi-sandbox launcher

**Runs pi in a per-repository Linux container, with every credential kept on the host.**

Part of [pi-extensions](../README.md) · [What changes for you](#what-changes-for-you) · [Install](#install) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Known gaps](#known-gaps) · [Threat model](THREAT-MODEL.md)

</div>

## Why

An agent that runs shell commands on your machine can read your keys, your other repositories and your network. The launcher gives you the same `cd repo && pi`, but pi (with this package's extensions) runs inside a container made for that repository. The container sees the repository and its git dir at the same paths as on the host, a volume for pi's agent dir that belongs to that repository, host pi's session directory for that repository only (`~/.pi/agent/sessions/<slug>/`, see below), and nothing else of your home. The launcher refuses to start in a directory that would mount more: your home itself (a dotfiles repository, for example), `~/.pi`, its own state or config dir, or `/`, and in a repository inside `~/.pi` or its own state or config dir (with `PI_SANDBOX_USER_CONFIG` set elsewhere, only that file is protected, not its directory). Your terminal variables (`TERM`, `TERM_PROGRAM` and the rest of `env.allow`) go to each pi run, not into the container, so launching from another terminal app reuses the running container.

There are no credentials inside the container. Its only network exit is an egress proxy on the host that allows a configured list of hosts and refuses everything else. Each policy gets its own proxy, and each repository gets its own random token for it, which the launcher puts into the container's proxy URL; the token survives proxy restarts, and `pi sandbox reset` rotates it. The proxy is also the only place that knows the real credentials: the launcher reads your host pi files (`~/.pi/agent/auth.json`, `models.json`, `mcp.json`) on every launch, gives pi inside copies in which every key, token and secret header is a placeholder (`pi-sandbox-` and 24 hex digits), and tells the proxy which host each placeholder belongs to. The proxy terminates TLS for those hosts only, swaps the placeholder for the real value in auth headers, and fetches that value on the host when it needs it (through the pi next to the launcher, an environment variable, a file, or a command such as your keychain). Your settings, agents, prompts, skills, themes and extensions follow the host too, so pi inside feels like pi on the host.

The container runs on a free runtime: Colima's dockerd through the Docker Engine API (the default), or Apple `container` as an alternative.

## What changes for you

Nothing in the common case: `cd repo && pi` runs the same pi with the same providers, MCP servers, settings and packages, and `pi install`, `pi remove`, `pi mcp add|remove|login|logout` and `pi update --extensions` work as with local pi. What is left visible, by design or as a known gap:

- A blocked host fails with `pi-sandbox: <host> is not allowed; run pi sandbox egress allow <host>`: an HTTPS request to it gets a 403 page carrying that line, which the fetch tool shows to the model and to you, and when pi exits the launcher prints one line per blocked host. Granting it is `pi sandbox egress allow <host>`; the container cannot grant itself. A host outside an allowlist the policy or org baseline sets cannot be granted, so for it the exit line reads `pi-sandbox: <host> was blocked; it is outside the allowlist set by <policy|org>` instead.
- The first launch after an image change prints `preparing pi sandbox, one time`.
- The `/mcp` sign-in inside the interface works for an HTTP server in `~/.pi/agent/mcp.json` without an `Authorization` header, a URL password, `auth` or `oauth.clientSecret`: the sign-in page opens in your host browser, and after you approve, pi inside is signed in. The real tokens stay on the host; pi inside holds placeholders. `pi mcp login <name>` in the shell works too and runs on the host. A launch notice `mcp <name>: sign in from /mcp in pi, or with pi mcp login <name> in the shell` names each such server without a sign-in, and `mcp <name>: sign-in discovery failed (<error>); this launch uses the host sign-in instead` names one whose authorization server could not be found at launch, which then needs `pi mcp login <name>` in the shell for that launch.
- Provider `/login` inside the interface does not work; log in with host pi.
- A stdio MCP server whose `env` holds a secret gets a placeholder; the launch notice says so, and a `credentials.rules` entry for the host that server calls binds it.
- A model server on `localhost` or plain `http` is not reachable from the sandbox; a launch notice says so.
- A package in `settings.json` whose URL carries a credential (`git:https://user:token@host/...`) is installed inside without it, with the notice `settings.json package <host> carried a credential in its URL; it was removed inside the sandbox`.
- An MCP server whose URL carries a secret-like query parameter is left out of the sandbox `mcp.json`, with `mcp <name>: the url carries a credential in its query string; add a header rule instead`.
- A rule host that resolves to a private address needs `egress.privateHosts`; a launch notice names it.
- `pi update` with no target prints `pi follows the launcher; update it with npm install -g pi-extensions-mz`.
- `pi config` changes made inside stay in the sandbox; a key you change on the host wins at the next launch.
- While a sandbox of the repository runs, `.git/commondir` exists with the content `.` (and in each `.git/modules/<name>/` submodule git dir): the launcher pins it so the sandbox cannot point host git at another config, and removes it after the last session (not while a sandbox of a linked worktree or submodule that shares the git dir is created or runs). Git reads it as the git dir itself, so `git status`, commits and worktrees behave as before, but a script that tells a linked worktree by comparing the strings of `git rev-parse --git-dir` and `--git-common-dir` sees `.git` against an absolute path and may take the repository for a worktree during a session; compare the real paths instead.
- The launch refuses a repository whose `.git`, `commondir`, `gitdir`, git config, `config.worktree` or hooks dir is a symbolic link or points somewhere git would not have put it, with `pi-sandbox: git: <path> ...`; check the file and remove it if you did not create it. A hook in a protected hooks dir that is a symbolic link also refuses the launch, since symlinked hooks are not supported inside the sandbox; copy the script into the hooks dir instead. After the last session the launcher prints `pi-sandbox: git: the sandbox created <path>; review it before running host git tools in this repository` for every nested `.git` or gitlink the sandbox added.
- A parent proxy that needs NTLM or Kerberos needs a local relay such as `px` or `cntlm`.
- An MCP server defined only in the repository's `.pi/mcp.json` asks y/N before `pi mcp login` signs in to it, and inside the sandbox it gets no OAuth token (move it to `~/.pi/agent/mcp.json`, or give it a placeholder `Authorization` header and a rule).
- Pi sessions of the repository are host pi's own: the sandbox writes them to `~/.pi/agent/sessions/<slug>/`, the directory host pi uses for that repository (the slug is pi's: `--` and the repository's real path with the leading `/` dropped and `/`, `\` and `:` turned into `-`, then `--`), so `/resume` and `pi --no-sandbox -r` list sandboxed and host sessions alike. The container gets only that one directory, bound at its host path, and `PI_CODING_AGENT_SESSION_DIR` points pi inside at it. In return the agent can read this repository's earlier host sessions, which may hold secrets a tool once printed; `sessions.host: false` in the user config keeps sessions in the sandbox volume instead. When host pi uses a custom session dir (`PI_CODING_AGENT_SESSION_DIR` on the host, or `sessionDir` in the host `settings.json`), which is one flat directory for every repository, the launcher keeps sessions in the volume and says `pi-sandbox: sessions: host pi uses a custom session dir, so sandbox sessions stay in the sandbox volume`; the same happens, with its own reason, on a Linux host whose agent dir is the sandbox's own `/home/pi/.pi/agent` (a host user named `pi`).

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
7. Runs `pi sandbox doctor` as the smoke test, inside a temporary git repository under `~/.cache/` (Colima only sees your home), which builds the image and creates a container; it runs with `PI_SANDBOX_SESSIONS_HOST=off`, so the temporary repository gets no host session directory (an empty one left behind is removed). It then resets that repository's container and volumes and deletes the directory. Without git it skips the smoke test and says so.

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
pi sandbox reset [--volumes]        stop and remove this repo's container (--volumes: caches, older sandbox-only sessions)
pi sandbox doctor                   preflight and smoke checks, one line each
pi sandbox migrate --to <backend>   move the volumes to another backend (colima, apple)
pi sandbox --version                print the launcher version
pi sandbox help                     show this help
```

- `pi` passes its arguments to pi inside, `--version` included. The first run in a repository prints `preparing pi sandbox, one time` while it builds the image and creates the container; later runs reuse the container. Pi's exit code is the launcher's exit code. SIGTERM and SIGHUP (and SIGINT when stdin is not a terminal; on a terminal Ctrl-C goes to pi) send SIGTERM to pi alone inside the container (through a per-launch pid file), so the container keeps running; the launcher waits up to five seconds, kills that pi (SIGKILL, again only that process) if it is still running, restores the terminal and exits with `128 + signal number`. The shared container is never stopped for one session. The same signals while the sandbox is still being prepared (image build, container start) let the step in progress finish, skip the steps after it, then end the session as a normal exit would, stopping the container when no other session is live, and exit `128 + signal number`; a second signal while that step finishes ends the launcher at once.
- The container keeps running while any pi session of the repository runs, and is stopped (not removed) when the last one exits; the next `pi` starts it again. When the config (or the image, or anything else in the container spec) changed while other sessions of the repository run, the new launch joins the running container and prints `pi-sandbox: the sandbox config changed; it applies after every session in this repository exits`; the first launch after they have all exited recreates it. Two first launches at once create one container. Sessions are counted on the host under the state dir, and a session whose launcher process is gone does not count.
- `pi install <source>` and `pi remove <source>` (without `-l`) run inside the sandbox; when pi exits 0, the launcher adds or removes only that entry in the `packages` key of the host `~/.pi/agent/settings.json`, writing the source exactly as you typed it, so the host and every other repository see it on their next launch. If the sandbox recorded a different entry for the package (another version or URL), nothing is written and the launcher prints both. A local path that exists only inside the sandbox, or one inside the repository (which the sandbox can rewrite), is not written back, and says so. With `-l` (the project's `.pi/settings.json`, which is in the repository) it is a plain pass-through.
- `pi mcp add` and `pi mcp remove` run on the host with the pi next to the launcher, against your host agent dir. `pi mcp login <name>` (with `--timeout <seconds>` if you want) and `pi mcp logout <name>` also run on the host (the browser opens there), against a helper agent dir `<state dir>/mcp-auth/` that holds only that server's URL and plain `oauth` fields; the proxy then injects the token and refreshes it with `pi mcp list` in that dir. When this repository's container is running, the new sign-in or sign-out reaches the running pi right away. A token you already have in host pi's `mcp-auth.json` is copied there on first use, so you are not asked again (it then lives in two places).
- `pi update` with no target prints that pi follows the launcher; `pi update <target>` and `pi update --extensions` run inside.
- `pi --no-sandbox` runs the first `pi` on `PATH` that is not the launcher, after a warning. It needs `fallback: host`; it is refused when `fallback` is `refuse`, and the message names the layer that set it. It never touches the network: an HTTPS org baseline is read from its cached copy whatever its age, and without a cached copy the org layer is skipped with a notice.
- `pi sandbox status` prints one line per fact: the launcher version, the repository, the backend and its version, the container and its state, the container's digest and config hash (`current` when its image digest, config hash and spec hash match what the last launch asked for and the next `pi` would use, otherwise `stale`), a `gap:` line for each capability the backend lacks, one line per running proxy instance (`policy <hash> pid N port N`, marked `this repository` or `other policy`, or `proxy: stopped`), the session dir the container was created with (`session dir: <path>`, or `session dir: sandbox volume (<reason>)`, read from the container's label, not from the config), the image, the live sessions of the repository (`session: <launch id> pid N since <time>`) and the active grants (`grant: <host> for this repository|every repository until <time>|permanently`).
- `pi sandbox egress allow <host[:port]>` grants a host for the current session (the default, `--session`: inside a sandbox session, the session named by `PI_SANDBOX_LAUNCH_ID`; run in a host shell, every running pi session of the repository, one grant each, and it says so; it ends with that session and after 12 hours or `egress.grants.maxHours`, whichever is less), for `--hours N`, or `--permanent`, to this repository or, with `--user`, to every repository. `egress.grants` sets the limits: `enabled`, `maxHours` (default 168) and `permanent`. `revoke <host[:port]>` removes this repository's grants for the host (all ports unless one is named; `--user` for user grants), and `list` prints the active ones; `list --denied` prints what the running proxy blocked for this repository. Grants still pass the private-range check and `egress.deny`, and an `egress.allow` set by the policy or org layer caps them unless that layer sets `egress.grants.enabled: true`: `allow` refuses a host outside that cap with `pi-sandbox: <host> is outside the allowlist set by <policy|org>; grants cannot add it` and exit 1.
- `pi sandbox config` prints the effective config as JSON, then `# key: layer` for every key. `config set` validates the whole updated file, refuses a change a higher layer locks and writes nothing in that case. Two `config set` runs at once both land (a lock in the state dir). It writes the user file, or the project file with `--project`.
- `pi sandbox gc` removes stopped containers this launcher created (idle repositories included, their volumes stay), relays that no running container uses (an old single `pi-sandbox-relay` included), stops proxy instances that no running container uses and no repository with a live (perhaps still preparing) session uses, keeps the containers of such repositories, removes the launcher's internal networks (the old shared `pi-sandbox` and each `pi-sandbox-<repo hash>`) of repositories with no container or live session left, printing `removed network <name>`, and drops grants that expired or whose session ended. `reset` removes this repository's container and the proxy instance of its policy, whose token is then new on the next launch, unless a running container of another repository shares that policy (`kept proxy instance <hash>, in use by another repository`); `--volumes` also removes its agent volume (older sandbox-only sessions of this repository, from before host sessions or with `sessions.host: false`; never the host session directory) and cache volumes, and the last synced copy of the host `settings.json` and `mcp.json` for it.
- `pi sandbox doctor` prints `ok <check>: <detail>`, `fail <check>: <detail>` or `skip <check>: <reason>` for:
  - the runtime, the proxy and its health endpoint (through this repository's token), the image;
  - inside the container: the same-path mount; a credential sweep (every key, `access` and `refresh` value and secret-named field in pi's `auth.json`, every auth-like header value of an HTTP server and every secret-named `env` value of a stdio server in `mcp.json`, and every environment variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` must be empty or a placeholder; a failure names the variable or JSON path, never the value, and it cannot tell whether a value elsewhere equals a credential the host proxy holds); a no-route check (a direct connection to the internet must fail); `PI_OFFLINE` unset; `pi mcp list` (a failure shows its last line); an `mcp-auth sweep` (every `access_token`, `refresh_token` and `id_token` in pi's `mcp-auth.json` must be a placeholder; a failure names the key); a `settings sweep` (no `settings.json` package may carry a credential in its URL; a failure names the host, never the credential); `browser` (`xdg-open --pi-sandbox-check` must reach the proxy's `/healthz`); `sessions share` (`ok sessions share: writable at the host path` when the doctor's container has `PI_CODING_AGENT_SESSION_DIR` equal to the host path, sees a marker file written on the host and can create and delete its own file there, `skip` when the container keeps sessions in its volume); `trust` (an HTTPS request to a credential rule host verifies the chain); and one `rule <id>` line per credential rule host, which must not answer 401 or 403 to a request carrying the placeholder;
  - on the host: the pi next to the launcher and whether its version equals the image's, the provider host table, whether the parent proxy accepts connections, the org baseline's age and sha256, the active grants, `sessions` (`ok sessions: <dir> (host pi lists them)`, `skip sessions: in the sandbox volume (<reason>)`, or `fail` when the directory is a symlink, not a directory or not writable), and one `mcp <name>` line per vault server: `vault ready (authorization server <host>)` with `signed in`, `signed in, token expires in <duration>` or `not signed in`, or `fail mcp <name>: vault discovery failed: <error>`.

  A check that cannot run after an earlier failure is a `skip` line, which does not count as a failure; it exits 1 when any check fails. When the doctor had to create the container, it removes it again afterwards, unless another pi session of the repository is running by then.
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

A project file may not set `env.allow`, `image.reference`, `image.digest` or `sessions.host` at all: loading it fails with a message naming the file. Nor may it set `backend`, `credentials.rules`, `credentials.derive`, `credentials.vault`, `egress.deny`, `egress.privateHosts`, `egress.parentProxy`, `egress.grants`, `tls`, `image.packages`, `image.npmGlobal`, `image.dockerfile` or `org`; `org` is accepted only in the policy and user layers. Below a locking layer, `credentials.rules` may only lose rules, `credentials.derive.enabled`, `credentials.vault.enabled`, `egress.grants.enabled` and `egress.grants.permanent` may only turn off, `egress.grants.maxHours` may only shrink, `credentials.derive.hosts`, `egress.privateHosts` and `tls.extraCa` may only lose entries, and `egress.parentProxy` and `org` cannot change. In the policy and user layers, `env.allow` is the union of both; names containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `CREDENTIAL` are refused, and so are `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, which the launcher sets (a forwarded value would point pi inside elsewhere); they are never forwarded.

- `egress.allow` and `egress.mcpHosts` entries are `host`, `*.domain`, `host:port` or `*.domain:port` (port 443 when none is named).
- `fallback` is `refuse` or `host` (run host pi on `--no-sandbox`).
- `mounts.extraReadOnly` entries must exist (a file or a directory, `~/` expanded) and are mounted read-only at that path from their real path. Refused, with `pi-sandbox: mounts.extraReadOnly: <path> is not allowed (<reason>)`: the home dir or anything containing it, and anything that is, contains or lies under `~/.pi`, the agent dir, the state dir, the user config, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.colima`, `~/.kube`, `/var/run`, `/run`, `/etc`, `/proc`, `/sys`, `/dev`, a `.git` dir or the engine socket.
- `ssh.agent` (default `false`) forwards the host ssh agent into the container when the backend can; the user layer may turn it on unless policy keeps it off.
- `sessions.host` (default `true`) keeps the repository's pi sessions in host pi's session directory (see [What changes for you](#what-changes-for-you)). Any layer above the project may turn it off; once the policy or org layer sets `false`, a lower layer cannot turn it back on. A project file may not set it at all. The host environment variable `PI_SANDBOX_SESSIONS_HOST=off` turns it off for one command (the installer's smoke test uses it); any other value prints `pi-sandbox: sessions: PI_SANDBOX_SESSIONS_HOST=<value> is not "off" and is ignored`. A custom session dir counts as set when the host variable or `sessionDir` is a non-empty string, as pi reads them, and a `file://` `PI_CODING_AGENT_DIR` is read as a path, as pi does. Switching it, or a change on the host that switches it (a custom session dir set or removed), recreates the container at the next launch that is alone in the repository.
- Convenience keys are taken from the lowest layer that sets them: `image.reference` (above the project), `mounts.cacheVolumes`, and `resources.cpus` and `resources.memoryGiB` (merged per subkey).
- Removed keys, refused as unknown: `ports`, `resources.diskGiB`, `resources.idleMinutes`; `fallback: os-sandbox` is now `fallback: host`.

### Org baseline

`org: { "source": "https://…" | "/absolute/path.json" | "~/path.json", "sha256"?: "<64 hex>", "refreshHours"?: 24 }`, set in the policy or user layer (`install.sh --org` writes it), names a JSON file in the config format that becomes the `org` layer, between policy and user. The launcher caches it in `<state dir>/org/`, refetches it when it is older than `refreshHours` (three-second timeout), and keeps using the cached copy, with one notice, when the fetch fails; after a failure it tries again an hour later at the earliest, so an offline launch neither waits nor repeats the notice. A response larger than 1 MiB is refused (`org: response larger than 1 MiB`). With `sha256`, a copy with another hash is refused: the cached copy is used when there is one, otherwise the launch stops. The org layer locks the user and project layers like policy does, and policy locks it. [examples/org-baseline.team.json](examples/org-baseline.team.json) and [examples/org-baseline.enterprise.json](examples/org-baseline.enterprise.json) are starting points.

### Credentials

Rules come from your host pi files automatically (`credentials.derive`, on by default): each provider in `auth.json` (an API key, or an OAuth entry whose access token is kept JWT-shaped when it is a JWT), each provider key in an environment variable the provider host table names, each `apiKey` and secret header of `models.json`, and each HTTP server of `mcp.json` (its secret headers, or a bearer token from `pi mcp login`). `credentials.derive.enabled: false` turns that off; `credentials.derive.hosts` keeps only the hosts it matches. The hosts of built-in providers come from the pi next to the launcher, which must be the same version as the image's pi, otherwise built-in providers get no rule and a notice says so.

`credentials.vault.enabled` (default `true`, effective only while `credentials.derive.enabled` is on) is the MCP token vault behind the in-sandbox `/mcp` sign-in. At each launch the launcher looks up each qualifying server's authorization server on the host, and the proxy then handles the sign-in: the sandbox's `xdg-open` asks the proxy to open the page in your host browser, the proxy relays the callback to pi inside with a one-time code placeholder, swaps the real code in only at the authorization server's token endpoint, keeps the issued tokens in `<state dir>/mcp-auth/` and gives pi placeholders. `false` keeps every server on `pi mcp login` in the shell. Below a locking layer it may only turn off, and a project file may not set it.

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

`host` (a plain name), `port` (443 when absent) and `pathPrefix` choose the requests. With `placeholder` (which must start with `pi-sandbox-`), the proxy replaces it in the rule's `header` when it names one, otherwise in auth-like request headers (`authorization` and names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`), and strips it from every other header. `pathPrefix` is matched on the decoded path, and a path with dot segments gets `400`. With `header`, it sets that header to `template` (with `{secret}` replaced) when the header is absent or still carries the placeholder, which suits git and npm clients that cannot be told to send a placeholder. A rule needs `placeholder` or `header`.

Secret sources (`secret`), resolved on the host and kept in the proxy's memory only:

| source | value |
| --- | --- |
| `{ "env": "NAME" }` | the launcher's environment variable, handed to the proxy over its control channel at each launch (the proxy process itself starts with a minimal environment); a value with a line break stops the launch with `pi-sandbox: NAME contains a line break and cannot be used as a credential` |
| `{ "file": "~/path.json", "pointer": "/a/b" }` | a JSON pointer into a host file |
| `{ "command": ["argv", "..."], "ttlSeconds": 300 }` | the command's stdout, trimmed, or JSON `{ "token", "expiresAt" }`; cached for `ttlSeconds` (300 by default) |
| `{ "piAuth": "<provider>", "bearer": true }` | `pi auth print-api-key` (or `print-bearer-token --min-expiry 5m`) of the pi next to the launcher, so OAuth providers refresh on the host |
| `{ "mcpOAuth": { "server": "<name>", "url": "https://…" } }` | the token `pi mcp login <name>` stored in `<state dir>/mcp-auth/`, refreshed there |

`command` examples: the macOS keychain `["security", "find-generic-password", "-s", "corp-gateway", "-w"]`, pass `["pass", "show", "corp/gateway-token"]`, 1Password `["op", "read", "op://Team/Gateway/token"]`, or any vault CLI that prints a token.

The legacy `credentials.kind` (`static`, `host-pi-auth`, `sso`) and `gateway` keys still work: they become one rule for the gateway host, and the gateway's providers are written into the sandbox `models.json` and `auth.json` with the placeholder.

### Egress

- `egress.deny`: hosts that are never allowed, whatever allows them; the union of all layers.
- `egress.privateHosts`: names that may resolve to private addresses (an internal gateway); host names or `*.domain`, never IP literals or `localhost`. A lower layer may only drop entries.
- `egress.parentProxy`: `"env"` (the default: the launcher's `HTTPS_PROXY` and `NO_PROXY`; Basic credentials in that URL are handed to the proxy over its control socket on every launch, never through the proxy's environment), `"none"`, or `{ "url": "http://proxy:8080", "noProxy": [".corp.example"], "auth": <secret source> }` whose secret is `user:password` for Basic auth; an IPv6 parent is written `http://[::1]:3128`. Policy keeps it unchanged below. Image builds use it too when it has no credentials; with credentials a build is refused with a hint to use a prebuilt image.
- `egress.grants`: see `pi sandbox egress` above.
- When the policy or org layer sets `egress.allow`, it caps derived hosts, `credentials.rules` from lower layers (a rule outside it is dropped with a notice; the policy's own rules are exempt) and grants, unless that same layer sets `credentials.derive.enabled: true` (hosts and rules) or `egress.grants.enabled: true` (grants) (D3).

### TLS

`tls.extraCa: [{ "file": "/path/ca.pem" }, { "hostStore": true }]` adds CA certificates (a corporate TLS-inspecting proxy, for example) to the proxy's upstream trust, to the container's trust (`/etc/pi-sandbox/ca.pem`, `NODE_EXTRA_CA_CERTS`, and the CA bundle of git, curl and Python) and to image builds. `hostStore` reads the macOS System keychain; elsewhere it is skipped with a launch notice. The container trusts the launcher CA as well, which signs the certificates for credential rule hosts.

### Image extensions

`image.packages` (Debian package names, optionally `=version`), `image.npmGlobal` (`name@version`) and `image.dockerfile` (an absolute path to Dockerfile lines, run as root; `FROM`, `COPY --from`, `ADD --from`, `ENTRYPOINT`, `CMD`, `USER`, `HEALTHCHECK`, `ONBUILD`, `SHELL`, `STOPSIGNAL`, `VOLUME`, and `ENV` or `ARG` of the proxy, CA, `NODE_OPTIONS`, `PATH`, `HOME` and `PI_*` variables are refused; heredoc bodies of `RUN`, `COPY` and `ADD`, such as `RUN <<EOF` … `EOF`, are file or script contents and are not checked as instructions) add a layer on top of the sandbox image, built once and reused while those inputs stay the same. A stdio MCP server that needs a runtime, for example:

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
- `~/.pi/agent/settings.json` on the host: only its `packages` key, only on `pi install|remove <source>` typed in the shell when pi exits 0, written through its real path so a symlinked (dotfiles) `settings.json` keeps its link.
- `<repo>/.pi/sandbox.json`: only on `pi sandbox config set --project`; when that creates `.pi/`, also `.pi/.gitignore` with `*`.
- The repository's git dir: `commondir` with the content `.` in the common dir and each submodule git dir before every container start, removed after the last session; an empty hooks dir (`.git/hooks`, a `core.hooksPath` inside the repository, submodule `hooks`) created when missing.
- `~/.pi/agent/sessions/<slug>/` on the host (under `PI_CODING_AGENT_DIR` when set):
  - while `sessions.host` is on, the launcher creates `~/.pi/agent/`, `~/.pi/agent/sessions/` and `~/.pi/agent/sessions/<slug>/` with mode 0700, only those that are missing, before any container exists, and never changes the mode of an existing one;
  - pi inside the sandbox writes its session files there, `<time>_<id>.jsonl` and the subagent runs under `<time>_<id>/agents/`, as host pi would;
  - when a container is created, and on every `pi sandbox doctor` run, the launcher writes an empty marker `.pi-sandbox-probe-<random>` there for the share check, the container creates and deletes `<marker>.guest` next to it, and the launcher deletes both right after;
  - the installer's smoke test removes the slug directory of its temporary repository with `rmdir` when it is empty;
  - the sweep runs before each launch, after pi exits and before `pi --no-sandbox` runs host pi, on this directory whenever it exists as a real directory, also with `sessions.host` off (it never creates it then). It deletes symlinks, fifos, sockets and device files among the directory's entries, and anywhere under it (the `agents/` trees included) only while no other session of the repository is registered and its container is not running, decided under the launcher's session lock. It finds each top-level `*.jsonl`'s header the way pi does (the first non-blank line that parses, read in 64 KiB chunks), and renames the file to `<name>.jsonl.rejected-<random>` when that header is a session whose `cwd` is not inside the repository, when no such line turns up within 1 MiB, or when the file cannot be read, printing `pi-sandbox: sessions: <file> <reason>; renamed to <new name>`; if the rename fails it deletes the file instead. A bare carriage return (`\r` not followed by `\n`) before the header also rejects the file, since pi's listing and opening would read different headers. Before acting in the directory or one of its subdirectories that you own, it restores `u+rwx` on it when the sandbox removed it. An entry that still can be neither renamed nor deleted stops the launch, and `pi --no-sandbox`, with `pi-sandbox: sessions: <file> is <what> and could be neither renamed nor deleted, in <dir>; refusing to run pi while host pi could read it`; after pi exits it is a warning, and the next launch refuses. It warns about a top-level file over 256 MiB without touching it, prints one line with the count of what it deleted, never follows a link and never touches the link's target.
- `~/.local/state/pi-sandbox/`: `image.json` (the image and its layer: reference, digest, id), `pack/` (the extensions tarball cache), `git/<repo hash>/snapshots/` (the read-only copies of git config, hooks and pointer files bound into the container, rewritten before every container start), `git/<repo hash>/baseline.json` (the nested `.git` entries and gitlinks at the container start), `git/pins/` (short-lived locks per git common dir around the `commondir` pin), `copies/` (read-only copies for runtimes without single-file mounts, bound as directories, with `<repo>.lock` and `<repo>.wanted.json`, the identity the last launch asked for), `locks/` (short-lived `config set` locks), `migrate/<time>/` (volume exports), `ca/` (the launcher CA, `trust.pem` with the extra CAs, `extra.pem`), `salt` (mode 600, makes placeholders unguessable), `grants.json` (mode 600), `sessions/<repo hash>/` (one file per running pi), `render/<repo hash>/` (the sandbox `auth.json`, `models.json` and the copied agents, prompts, skills, themes, extensions, `AGENTS.md`, `SYSTEM.md`, `keybindings.json`, mounted read-only), `sync/<repo hash>/` (the last synced host `settings.json` and `mcp.json` (mode 600), and the last `mcp-auth.json` written into the sandbox, placeholders only; `sync.lock` while a sync runs), `mcp-auth/` (MCP OAuth tokens, the recorded servers in `servers/` and the authorization server lookups in `discovery/`, mode 600), `provider-hosts/<pi version>.json`, `org/` (the cached baseline, with the time of the last failed refresh), and per proxy instance `proxy/<policy hash>/` with `proxy.json` (pid, port and token, mode 600), `proxy-token` (the instance control token, host only), `proxy-port` (the port it reuses on the next start), `tokens/<repo hash>` (each repository's token, mode 600), `dynamic.json` (derived rules and hosts, a shared section and one per repository token, re-read without a restart, mode 600), `proxy-config.json`, `proxy.log`, `proxy-access.log` (one JSON line per proxy decision, never a credential or a token) and `lock`.
- Container runtime objects: containers `pi-sandbox-<repo hash>`, volumes `pi-sandbox-agent-<user hash>-<repo hash>` and `pi-sandbox-cache-<repo hash>-<path hash>`, one relay container `pi-sandbox-relay-<policy hash>` per proxy instance and one internal network `pi-sandbox-<repo hash>` per repository (removed with the repository's last container; earlier versions used one shared `pi-sandbox`).

## Uninstall

```bash
launcher/uninstall.sh [--volumes] [--vm] [--bin-dir DIR] [--dry-run]
```

It removes the `pi` link or wrapper, the global package, the `PATH` snippet (only a block with both markers), the proxy processes (only a pid whose command is the launcher's proxy daemon), the launcher's containers, the relays and the `pi-sandbox` networks that carry its managed label (the old shared one and the per-repository ones; on Apple each candidate is inspected for the label first). `--volumes` also removes the `pi-sandbox-*` volumes that carry the launcher's managed label, and `--vm` deletes the Colima profile. It removes `sessions/`, `render/`, `sync/`, `mcp-auth/` (your MCP sign-ins), `provider-hosts/`, `org/` and `grants.json` from the state dir, and keeps the rest of it (image record, CA, salt, proxy instances). It removes the state dir's `sessions/` as launch records; your pi sessions stay in `~/.pi/agent/sessions`. It never touches your repositories, `~/.pi` or `~/.config/pi-sandbox`. `--volumes` deletes older sandbox-only sessions that live in the agent volumes.

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
- No in-interface prompt for blocked hosts: the 403 page says `pi-sandbox: <host> is not allowed; run pi sandbox egress allow <host>` (beyond 30 new denied names a minute, the CONNECT itself gets that 403), and the launcher prints one line per blocked host when pi exits.
- `tls.extraCa` `hostStore` is macOS only; on Linux list the CA file.
- The org baseline carries config only, not pi files (agents, settings).
- Project-level OAuth MCP servers get no token inside the container and no `/mcp` sign-in; move the server to the user `mcp.json`, or give it a placeholder `Authorization` header and a rule. A server with `oauth.clientSecret` keeps `pi mcp login <name>` in the shell; a sign-in for it or for a project server done inside the sandbox anyway keeps a real token there until the next launch removes it.
- Host sessions started in a subdirectory of the repository are invisible inside: the container's mounts cannot change per run, so pi inside always uses the repository root's slug, while host pi in a subdirectory writes to that subdirectory's slug. Sandboxed sessions started in a subdirectory land in the root's slug with the subdirectory as `cwd`; inside, `/resume` shows them for that subdirectory, and host pi lists them when started at the root (or under "all" when started in the subdirectory).
- Host `pi -c` at the repository root may continue a sandboxed session that was started in a subdirectory, since both share the root's directory.
- Host `pi --session <id>` run in a subdirectory does not find a sandboxed session there, goes through pi's global search and asks to fork it.
- Pi's exit hint inside the sandbox shows `--session-dir <host path>`; pasted into a host shell it works, since the path is the host's.
- Handoff documents of sandboxed sessions live in the container's `/tmp` and are missing when the session is resumed on the host.
- Only host pi prunes old subagent runs of sandboxed sessions; the launcher does not.
- A project `.pi/settings.json` `sessionDir` and a `--session-dir` you pass are not considered: inside, the launcher's `PI_CODING_AGENT_SESSION_DIR` wins over the former, and the latter points pi inside at a path that exists only in the container.
- A slug collision (pi gives `/a/b-c` and `/a/b/c` the same slug) puts two repositories' host sessions in one directory: the sandbox of one sees the other's, and its sweep renames the other's sessions to `.rejected-<random>`, which hides them from host pi.
- Sessions written before host sessions, or with `sessions.host: false`, stay in the sandbox volume and are not copied. Inside the sandbox `pi --session-dir /home/pi/.pi/agent/sessions/<slug> -r` still opens them, and `pi sandbox reset --volumes` deletes them.
- Provider `/login` inside the interface; it needs per-provider knowledge the launcher does not carry. Log in with host pi.
- The `/mcp` sign-in needs this machine's browser: pasting the redirect URL into pi instead (a remote browser, or a callback port in use on the host) puts the real authorization code inside the sandbox, and the proxy then refuses the token response, so sign in again with the host browser or `pi mcp login <name>`.
- A sign-out from `/mcp` inside the sandbox lasts until the next launch, which restores the host sign-in; sign out with `pi mcp logout <name>` in the shell, which runs on the host.
- Providers whose client derives the API host from the token itself may refuse a placeholder token (D5); `pi sandbox doctor` shows a 401 or 403 on that rule.

The full list of what each feature weakens is in [THREAT-MODEL.md](THREAT-MODEL.md).

## Known limits

- The Apple `container` adapter is tested against a fake CLI only, not on a real macOS 26 host; whether the guest, as uid 1000, owns and can write the bound host session directory (as it does for the repository) is unverified as well, and the share check at container creation stops the launch with `pi-sandbox: sessions: <dir> is not writable from the sandbox; set sessions.host: false or share it with the VM` if not; its cleanup in `uninstall.sh` is unverified too, and so are the CLI assumptions `container stop --time`, `volume create --label`, `network create --label` with the `network inspect` fields in `backend/apple/cli.ts` (`APPLE_NETWORK_FIELDS`; a network whose output does not show it is internal is refused) and the `--ssh` socket path. Whether an Apple guest reaches the proxy, which listens on `127.0.0.1`, through the network gateway is unverified; the listen address is not widened for it.
- The relay was verified on Docker Desktop, not on Colima, where it reaches the host through `host.lima.internal`. On a native Linux Docker Engine the proxy also listens on the `docker0` bridge gateway (still asking every client for its token), because the relay cannot reach the host's `127.0.0.1` there; this is tested against a fake engine only, not on a real Linux host, and a firewall that drops traffic from `docker0` to the host blocks it. A rootless engine is not handled.
- When the egress proxy of a policy has to come back on a different port while sandboxes of other repositories still use its relay, the relay is kept for them with a notice, and egress through it fails until they exit; the proxy reuses its last port whenever it is free, so this needs the port to have been taken by something else.
- The Colima VM mounts `$HOME` writable, which is what lets repositories under your home work, and the host session directory too: an agent dir outside `$HOME` (through `PI_CODING_AGENT_DIR`) is not shared with the VM, and the launch stops with the share-check message above; the VM itself sees all of your home, and only the container's mounts limit what pi sees.
- The allowlist works on host names, so a host that fronts many sites (a CDN) can carry traffic to sites behind it through domain fronting; allow such hosts deliberately.
- The launcher CA has no name constraints: it is trusted inside the container only, but it could sign a certificate for any name there.
- Inside the internal network, DNS resolves container names but nothing external, so tools that resolve names before using the proxy fail.
- On Linux, a host uid other than 1000 cannot write the agent volume, which is owned by uid 1000. A host user named `pi`, whose agent dir is the sandbox's own `/home/pi/.pi/agent`, keeps sessions in the volume, with a notice.
- The proxy speaks HTTP/1.1 to credential rule hosts, without keep-alive. Response bodies are not scrubbed, so a rule host that echoes request headers into a body reflects the secret.
- Plain HTTP is refused, and so are model servers on `localhost`.
- The layer build `FROM <image id>` is unverified on a real Docker engine's classic build endpoint and on Apple `container`.
- Two launchers creating the CA for the first time at the same moment are not serialised.
- An `sso` credential `command` is not checked when the config loads; an empty one fails only when the proxy first needs the credential. The same holds for every `command` secret source.

## Development

`npm run check` covers the launcher: typecheck, Biome, knip and the unit tests in `launcher/tests/`. From a checkout, run `node launcher/bin/pi-sandbox-dev.js`. `npm run build:launcher` compiles `launcher/dist/` for `launcher/bin/pi-sandbox.js`, and `prepack` runs it. Tests against a real engine live in `launcher/tests/live/` and run with `PI_SANDBOX_LIVE=1 npm run test:live`. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md), where things are in [STRUCTURE.md](STRUCTURE.md).
