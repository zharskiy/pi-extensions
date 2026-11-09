# launcher architecture

The launcher is a standalone host-side layer. It provides the `pi-sandbox` command (installed as `pi`), which runs pi inside a per-repository container on a Colima VM and keeps credentials and network access on the host. What it does for the user is in [README.md](README.md), where things are in [STRUCTURE.md](STRUCTURE.md), what each feature weakens and the known gaps are in [THREAT-MODEL.md](THREAT-MODEL.md).

## Layer rules

- No pi imports (`@earendil-works/*`, `typebox`) and no imports from `platform/`, `extensions/` or `test/`. Only `node:*` built-ins and files inside `launcher/`; `launcher/tests/` may also import `vitest`. No npm dependencies: validation, HTTP, TLS and process control are hand-rolled over Node. The one exception is `hostpi/*.mjs` (only files directly in `hostpi/`): `hostpi/provider-hosts.mjs` runs as a separate Node process against the host pi of host jobs and loads its packages; nothing imports it.
- Each folder exposes what other folders use through its `index.ts`, and nothing more. Another folder imports only `../<folder>/index.ts`, never an inner file. `bin/` is the exception: it imports `cli/main.ts` (or `dist/cli/main.js`) and nothing else.
- The folder graph is exact, and `test/architecture.test.ts` asserts it edge for edge:

  | folder | imports |
  | --- | --- |
  | `shared` | nothing |
  | `config` | `shared` |
  | `workspace` | `config`, `shared` |
  | `backend` | `shared` |
  | `grants` | `shared` |
  | `hostpi` | `config`, `shared` |
  | `proxy` | `config`, `grants`, `shared` |
  | `container` | `backend`, `config`, `workspace`, `shared` |
  | `image` | `backend`, `config`, `shared` |
  | `provision` | `backend`, `config`, `hostpi`, `shared` |
  | `cli` | `backend`, `config`, `container`, `grants`, `hostpi`, `image`, `provision`, `proxy`, `shared`, `workspace` |
  | `bin` | `cli` |

  Nothing imports `cli` except `bin/`, there are no cycles, and shipped code never imports `launcher/tests/`.
- Tests: a file under `launcher/tests/<folder>/` may import inner modules of `launcher/<folder>/` and reaches every other folder through its `index.ts`. `launcher/tests/support/` reaches every folder through its `index.ts` only. Any test may import `tests/support/`.
- `cli/` is the only folder that writes to the terminal; the proxy daemon writes only its own log files. Every expected failure is a `LauncherError` (`message` and optional `hint`), printed as `pi-sandbox: <message>` and `  hint: <hint>` with exit code 1. Any other error exits 70.
- External processes (git, gh, glab, openssl, `security`, `ps`, colima, secret commands, the host pi) run through the `CommandRunner` interface, so tests replace them with a scripted fake.

## Dev and dist entry

The sources run directly under Node 22.19 or newer through type stripping, so they follow its rules: no enums, no parameter properties, no namespaces, `import type` for types, `.ts` extensions in relative imports. `bin/pi-sandbox-dev.js` imports `../cli/main.ts` and is what a checkout install runs. Node refuses to strip types under `node_modules`, so the published `bin/pi-sandbox.js` imports `../dist/cli/main.js`, which `tsconfig.build.json` emits (`npm run build:launcher`, run by `prepack`). Assets that are not TypeScript (Dockerfile, entrypoint, `hostpi/provider-hosts.mjs`, examples, schema, install scripts) stay in `launcher/`, and code finds them through `launcherRoot()`.

## The pipeline

`pi [args]` runs these steps (`cli/launch.ts`, around a `LaunchContext` of workspace, effective config and state dir). The other commands reuse them; `pi sandbox doctor` runs the same preparation and prints each stage.

1. **Discover the workspace** (`workspace/discover.ts`, `workspace/git/layout.ts`). Walk up from the real cwd to the nearest `.git` without following links, derive the git dir and common dir from the files alone (a real `.git` dir, a separate git dir, a submodule git dir or a linked worktree), refuse any link or pointer git would not have written, then require `git rev-parse` to agree. Without a `.git` above the cwd the folder is a workspace: one walk finds every nested repository, each checked like a single repository, and fails closed when one cannot be protected, lies outside the folder, or when a git config file the folder reads lies inside it outside every repository. The same walk collects the build output folders beside their marker files (`workspace/overlay-markers.ts`). Admin commands and `--no-sandbox` use a lenient walk without git calls or refusals.
2. **Load the config** from the policy, org, user and project layers, and check `workspaceRoots`.
3. **Intercepted commands** (`cli/intercept.ts`): `install|remove <source>` without `-l`, `mcp add|remove|login|logout` and a bare `update` run on the host and stop here.
4. **`--no-sandbox`** is refused under `fallback: refuse`; otherwise it sweeps the host session directory and execs host pi, mounting nothing.
5. **Guard** (`workspace/guard.ts`): refuse a repository or git dir that is, contains or lies inside a protected path (`workspace/mounts.ts` holds the one table: the home, `~/.pi`, the host agent dir, the state and config dirs, `~/.ssh` and the other credential dirs, system dirs).
6. **Open the engine and the VM** (`backend/colima/`). Start the stopped `pi-sandbox` profile when its `colima.yaml` exists; share with the VM any needed path it lacks (repository, git dirs, state dir, extra mounts, host session dir, host caches), restarting the profile only when no pi session of any repository is live.
7. **Host side** (`cli/derive.ts`): read the host pi files and the provider host table, derive the sandbox files and the credential rules (`hostpi/`), build the trust bundle, and sign in to MCP servers that need it (`cli/mcp-sign-in.ts`, terminal only, never from `pi sandbox doctor`, which reports `pi mcp login <server>` instead).
8. **Register the launch** (`cli/launches.ts`, `grants/launches.ts`) under the repository launch lock. From here a signal ends the launch like a normal exit, after the step in flight finishes.
9. **Proxy and image, in parallel.** `ensureRepoProxy` starts or reuses the repository's proxy under the launch lock (see Network). `ensureSandboxImage` reuses the recorded image when a running container uses it, else pulls a pinned digest or builds the image with the host pi's version, then adds the `image.packages`, `image.npmGlobal` and `image.dockerfile` layer.
10. **Container.** Render the agent dir, plan the git overlay, prepare the host session directory, then `ensureContainer` under the container lock: reuse a running container whose identity matches, or, right before a create, pin `commondir`, re-check every protected git path, copy the git config files, create missing mount points and record the nested-repository baseline. After a create, chown the volume mount points and probe the session share. Then sync `settings.json` into the volume.
11. **Run pi** through exec with the host cwd as workdir and the `env.allow` variables; pi's exit code is the launcher's. Signals go to pi alone through a per-launch pid file (`container/run-pi.ts`), never to the shared container.
12. **End the launch.** Print one line per blocked host from the proxy's denial list, with a hint for its kind: not allowed (`pi sandbox egress allow <host>`, or with grants off, ask the administrator to add it to `egress.allow`), a private address (`egress.privateHosts`), `egress.deny` (denied by policy), plain HTTP (use https), an upstream failure or any other refusal (its reason); remove the launch entry and, when it was the last live launch, run `removeRepoSandbox`, then the git end-of-session notices. `sweepOrphans` runs after either way (see Lifecycle).

### Intercepted commands and host pi

`pi install|remove`, `pi mcp add|remove|login|logout` and a bare `pi update` run the host pi on the host against the host agent dir; `mcp login|logout` run in an empty `<state>/mcp-login-<random>/` folder so no project `mcp.json` loads. A local install source inside the repository or workspace is refused, since host pi would load code the sandbox can rewrite.

`cli/host-pi.ts` resolves the host pi in two orders. Host jobs (the proxy's pi command, the provider host table, MCP sign-in, the image's pi version) use pi's managed install in the host agent dir, else the pi installed next to the launcher; never a `PATH` pi. `--no-sandbox`, `pi update` and the doctor line add the first `PATH` pi outside the repository, its git dir and `mounts.extraReadOnly` before the bundled one. Nothing records which pi was picked, only what it was used for (the image record's pi version, the proxy input's pi command), so a host pi update rebuilds the image and restarts the proxy at the next launch that is alone in the repository.

## Config

`SandboxConfig` is the merge of the defaults and the policy, org, user and project layers (`config/`). Each layer is validated by a hand-written key spec; `schema/sandbox-config.schema.json` documents the same keys and a test keeps the two key sets equal. Two kinds of keys (`config/merge.ts`). Union keys (`egress.allow`, `egress.deny`, `egress.privateHosts`, `image.packages`, `credentials.rules` and `env.allow`) collect the entries of every layer that may set them, so a lower layer adds entries and none removes one; a rule whose id a higher layer already uses is ignored, and `egress.deny` still wins over every allow. Every other key is final once the policy or org layer sets it (`fallback`, `egress.grants`, `egress.parentProxy`, `egress.presets`, `tls`, `sessions`, `credentials.derive`, `resources`, `mounts.hostCaches` and the rest). A project layer may set only `mounts.cacheVolumes`, `mounts.autoOverlays`, `resources.cpus` and `resources.memoryGiB` (an allowlist), so it adds no rule, host, private host or package. A key a project may not set, or a final key a lower layer sets, is ignored rather than fatal: the merge keeps the higher value and the launch prints one warning naming every ignored key with its layer, once per repository and text (the notice store), and `pi sandbox config` lists them each time. `org` names a local file read at every launch as the `org` layer. `egress.presets` expands to registry hosts ahead of `egress.allow` (`config/egress-presets.ts`). The `pi-sandbox` command never writes a config layer; `install.sh --org` writes the user layer's `org` key.

## Backend

Colima is the only engine. A `Backend` (`backend/types.ts`) is the only thing that talks to it, and the seam tests replace with a fake. `backend/colima/` speaks the engine HTTP API over `~/.colima/pi-sandbox/docker.sock` with `node:http`, and owns the VM as `Backend.vm` (start, shares, size, stop). It pulls by digest, builds through the classic build endpoint, creates containers with `AutoRemove` and typed mounts (a missing bind source fails the create), runs execs over a hijacked stream with backpressure, manages labelled volumes, networks and relays, and imports only `shared`. A conformance suite runs the same tests against the adapter on an in-process engine, against the fake backend, and against the real engine in the live tests.

## Network

- **Per-repository proxy.** One proxy process per repository, `proxy/daemon.ts` (`dist/proxy/daemon.js` in a published install), on `127.0.0.1` of the host. It reads its `RepoProxyInput` (allow and deny lists, rules, derived hosts, `env` secret values, parent proxy and its credentials) from stdin only, and records `{ pid, boot, start, port, inputHash }` in `repos/<hash>/proxy/proxy.json`. A live proxy with the same input hash is reused; one with another hash is replaced only when no other launch of the repository is live.
- **Token.** The guest proxy URL is `http://pi-sandbox:<token>@pi-sandbox-proxy:3128`. The token (`repos/<hash>/proxy/token`, 32 random bytes) identifies the repository to its proxy, which answers `407` to anything else. It survives proxy restarts and is deleted with the container. The container carries a hash of it, so a new token gives a new container.
- **Relay and alias.** Agent containers join only their repository's internal network `pi-sandbox-<h12>` (the first 12 hex of the repository hash) and have no route out. One relay container per repository, `pi-sandbox-relay-<h12>`, sits on that network with the alias `pi-sandbox-proxy` and on the default bridge, and forwards with socat to the proxy port on `host.lima.internal`. It is recreated under the same name and alias when the proxy port changes, so a running container keeps reaching its proxy by name.
- **Decisions.** A CONNECT is allowed for allowlisted, rule, derived and granted hosts on their ports; `egress.deny` wins. IP literals, loopback, private and reserved ranges, the metadata address and names that resolve only to such addresses are refused unless named in `egress.privateHosts`. A tunnel that is not terminated must present a ClientHello whose SNI equals the CONNECT host before the proxy dials. A denied host gets a 403 page over TLS with a launcher-CA certificate for its name, carrying the grant hint. A terminated request whose upstream fails answers `502` with the reason; a certificate failure adds a pointer to `tls.extraCa`, and the doctor counts a `502` as failed. Grants are read live from `grants.json`. Every decision is a JSON line in `access.log`, never a credential or a token.
- **Termination.** TLS is terminated only for rule hosts, with per-host leaves signed by the launcher CA and kept in memory. Upstream connections are pooled per repository and host, never shared between repositories. A parent proxy (`egress.parentProxy`) is chained for upstream dials.

## Placeholders and secret sources

A placeholder is `pi-sandbox-` plus the first 24 hex of `sha256(salt + identity)`, where the identity names the source (`auth:<id>:key`, `models:<id>:header:<name>`, `mcp:<server>:oauth`, ...) and the salt is `<state>/salt`; so placeholders are stable across launches and unguessable. A JWT access token is replaced with a JWT-shaped placeholder. On a terminated host, the proxy replaces the placeholder of the matching rule (host, port, decoded path prefix compared with the decoded path, which carries no query, so an encoded `?` cannot widen it) only in the rule's header, or in auth-like request headers for a rule without one, and strips stray placeholders from every other header; never in a query or body. A `Basic` value is decoded, substituted and re-encoded, which is how git, npm, pip and Maven send passwords. Response headers are scrubbed of the secret and of the exact base64 the proxy sent. A dot-segment path or a cross-origin absolute target gets `400`.

The secret comes from a source resolved on the host and kept in the proxy's memory only (`proxy/secrets/`): `env` (from the stdin input), `file` (a JSON pointer, or a key of an npmrc, ini or Maven settings file), `command` (stdout or `{ token, expiresAt }`, cached), `piAuth` (the host pi's `auth print-api-key` or `print-bearer-token`) and `mcpOAuth` (below). An upstream `401` invalidates a cached secret once.

Derivation (`hostpi/`) is pure: it turns the host `auth.json`, `models.json` and `mcp.json` into sandbox copies with placeholders and rules, and `hostpi/derive-tools.ts` adds the gh, glab, npm, pip, Maven and git derivers (`hostpi/tools/`), which read host files and run host commands and render placeholder-only tool files. A URL with userinfo in `.npmrc` (`registry`, `@scope:registry`) or `pip.conf` (`index-url`, `extra-index-url`, `PIP_INDEX_URL`) is rendered with a placeholder in place of the password, or of the user name when the token is the user name, and gets a rule on that host (for npm also the URL path) whose secret reads that part of the URL back from the host file or variable (`urlPassword`, `urlUsername`). Other values with URL userinfo, npm and pip proxy settings, and values that reach userinfo through `${VAR}` stay on the host; Maven mirror URLs lose their userinfo. The Maven settings keep `profiles`, `activeProfiles`, `pluginGroups` and the mirrors, with secret-looking profile properties and URL userinfo removed and `localRepository` dropped with a notice; a server's password and its `httpHeaders` values become placeholders bound to the server's repository hosts (a header rule injects only in that header), a server with no credential field is copied unchanged, and one with only a private key stays on the host. The pip config is the first of `PIP_CONFIG_FILE`, `~/.config/pip/pip.conf`, `~/Library/Application Support/pip/pip.conf` and `~/.pip/pip.conf`. A `models.json` provider or model whose `baseUrl` has a secret-looking query parameter is dropped, as an MCP server is. Manual `credentials.rules` win over derived rules for the same host; `credentials.derive` filters or disables derived ones.

## MCP sign-in

MCP OAuth tokens stay in host pi's `<agent dir>/mcp-auth.json`, which the launcher only reads (`shared/mcp-auth-key.ts` is the one parser). The sandbox `mcp.json` has no `oauth` block, and an HTTP server without its own `Authorization` gets a placeholder bearer with an `mcpOAuth` rule. Two triggers start `pi mcp login <name>` with the host pi of host jobs, in an empty folder against the host agent dir:

- at launch start, from a terminal, for each derived server whose token is missing or expired and has no refresh token (`cli/mcp-sign-in.ts`), interactively;
- in the proxy (`proxy/sign-in.ts`), when the token it would inject is missing, expired, or answered `401` upstream; a `401` to a request with the container's own `Authorization` starts nothing. The login runs in its own process group, which the proxy kills when it stops; the request gets a local `503` telling the user to finish the sign-in in the browser.

Both take one lock per server and record starts and failures in `<state>/mcp-login.json`. The proxy starts at most one sign-in per server per minute host-wide and none for 10 minutes after a failure; a start caused by a `401` to a token the proxy injected and that has not expired runs at most once per server per 10 minutes whatever its exit code (`rejectedStart`). The launch-start sign-in runs once per launch and is skipped for 24 hours after a failed sign-in by either path, printing `not signed in; run pi mcp login <name>`. Host pi's login refreshes a stored token silently when it can.

## Provisioning

`renderAgentDir` (`provision/render.ts`) writes `repos/<hash>/render/` on every launch: the derived `auth.json`, `models.json` and `mcp.json`, filtered copies of the host agents, prompts, skills, themes, extensions and instruction files (secret-looking files left out, no link followed), and `tools/` (the Maven settings with the sandbox proxy and derived servers, and when derived the gh, glab, npm, pip and git configs). It is mounted read-only; the entrypoint links each entry into the agent dir and the tool files into the home, copying the ones the tools must write. `syncSettingsFile` (`provision/sync.ts`) writes the host `settings.json` keys over the volume copy, dropping package URL credentials and the host `httpProxy` (the sandbox uses the launcher proxy) and keeping host-owned keys from the host. Nothing from the volume is written back to the host.

## Host sessions

With `sessions.host` on, the container binds host pi's session directory of the repository at its host path and `PI_CODING_AGENT_SESSION_DIR` points pi at it. The slug is pi's formula, copied since the launcher may not import pi. `assertHostSessionsDir` (`workspace/guard.ts`) is the one exception to never mounting under `~/.pi`: the directory must be exactly one level under `<agent dir>/sessions`, a real directory, and overlap no other agent dir entry. `provision/host-sessions.ts` creates missing directories 0700, probes the share from inside, and sweeps the directory before each launch, after pi exits and before `--no-sandbox`: it deletes links and special files and renames session files whose header `cwd` lies outside the repository (or cannot be read) to `.rejected-<random>`, reading headers as pi does. The whole tree is swept only while no container of the repository runs, under the launch lock.

## Container

A container belongs to one repository (in workspace mode, the workspace root): name `pi-sandbox-<h12>`, labels with the repository, image digest, proxy token hash, git common dirs, the spec hash and one hash per spec section (config, image, credentials for the environment and token, overlays for the volumes, mounts for the binds). `ensureContainer` reuses a running container whose image digest, spec hash and proxy token hash match; one that differs is replaced only when no other session of the repository is live, else reused with a notice that names the sections whose hash differs from the running container's. Containers run with `AutoRemove`, so none is ever stopped and kept.

The spec mounts the repository and git common dir read-write at their host paths, binds onto themselves the git dir and every directory between the root and a read-only path (so none can be renamed away from its mounts), then the read-only git paths (hooks dirs, `commondir`, `gitdir`, a `.git` file, worktree pointers) directly from the host after the `ready()` checks, and `config` and `config.worktree` from private copies. It adds `mounts.extraReadOnly`, the agent volume, cache and overlay volumes, shared cache volumes, host caches (cache subfolders of the home only, bound read-write after the same protected-path checks and a refusal of top-level credential files), the render dir and the trust bundle. The root is read-only with tmpfs `/tmp` and `/home/pi`, under an init process, as the image's `pi` user. The environment holds the proxy variables with the token, the JVM proxy flags (`JAVA_TOOL_OPTIONS`) and Maven proxy variables, the CA bundle paths, the derived tool variables (`GH_TOKEN`, `GITLAB_TOKEN` placeholders), `GIT_TERMINAL_PROMPT=0` and `PI_SANDBOX=1`, with `NO_PROXY` and `no_proxy` set to `localhost,127.0.0.1,::1` so a client reaches the container's own servers directly; no host variable is in the spec, so the terminal does not change its hash.

## Image

`image/Dockerfile` builds on a slim Node image with git, search tools, socat, curl, jq, python3, gh and a pinned, checksum-checked glab, a `pi` user and pi pinned to the host pi's version. It bakes no pi config, package or credential. The launcher CA goes into the system store for good; extra CAs are trusted during the build only. `BASH_ENV` and the first line of `/etc/bash.bashrc` source `bash-env.sh`, which prints the missing-command hint and adds the JVM truststore flags. The entrypoint re-creates the render links, builds the CA bundle and, when `java` is present, a JVM truststore, then idles under tini. A failed build's error keeps the last 30 lines of the build output, and a certificate error in them adds the hint to set `tls.extraCa` or `image.digest`. The host's `HTTP_PROXY` and `HTTPS_PROXY` reach the build as build args, with a loopback host (`127.0.0.1`, `localhost`, `::1`) rewritten to `host.lima.internal`. `image.dockerfile` may start with `~/`. `ensureSandboxImage` runs under `<state>/locks/build.lock`, so two launches never build at once; the second says it waits. Build contexts and their archives live under `<state>/build/` and are removed after the build; the sweep clears what a killed build left while no build holds the lock. `ensureSandboxImage` records the base image in `<state>/image.json`; layer images are tagged `pi-sandbox-layer:<hash of the layer Dockerfile>` and reused while the inputs stay the same, and each repository records the tag it wants. After a build the unreferenced layer tags and the previous base are removed; the daily collection removes unreferenced layers and untagged managed images older than an hour.

## Locks and liveness

`shared/file-lock.ts` is the one lock primitive: the repository launch lock (launch registry, proxy start and idle exit, sweep), the container lock, the grants, the CA, the settings sync, the per-git-common-dir pin lock and the per-server MCP sign-in lock. A lock file holds `<pid> <boot time> <process start> <nonce>`. The liveness rule (`shared/liveness.ts`) applies to locks, launch entries and `proxy.json`, and it is process identity, never a timer: a holder is live when its pid exists, the boot time matches and the process start time (`ps -o lstart=` on macOS, field 22 of `/proc/<pid>/stat` on Linux, read by `shared/process-start.ts`) is the recorded one. A sleeping Mac or a stopped launcher therefore keeps its sandbox, and a pid reused by another process after a reboot or an exit does not count. A lock that is not live is taken over, one taker at a time, with a check that it did not change in between. A live holder is waited for: the repository launch lock, the container lock and the pin lock wait up to 120 s, then the waiter fails and asks to run the command again; there is no "delete the lock" advice, since a dead holder's lock is taken over anyway. The VM lock is an `mkdir` lock judged by age, so a share restart, a VM start and `pi sandbox stop` never interleave.

## Lifecycle and sweep

- A launch registers an entry (`pid`, boot time, process start) under `repos/<hash>/launches/`. Every removal path runs under the repository launch lock and re-checks the live launches first; an entry is deleted only when its process is gone. `pi sandbox reset` refuses while a session of the repository runs and names how many.
- **Records first.** Each `commondir` pin goes into `pins.json` and each folder the launcher makes in the repository (hook dirs, mount points) into `created.json` right after it is written, before the next check can refuse, so a refused launch leaves nothing the sweep does not know. The session-share probe runs under the container lock right after the create and discards only the container it just made.
- **Last session.** `removeRepoSandbox` (`cli/sweep.ts`) removes, in order: the container (waiting for the engine's auto-removal), the relay and the repository network, the proxy and the token, the recorded `commondir` pins (only while they read `.` and no other sandbox shares the git dir; a pin is kept while the engine does not answer, except under `pi sandbox stop`), the recorded created folders (deepest first, only empty real directories), the git config copies, then sweeps the whole host session directory. When the engine is unreachable the engine steps are skipped and the rest still runs. The git checks after the last session run after the lock is released, since they write nothing.
- **Proxy idle exit.** The proxy checks the live launches under the launch lock and exits after two empty checks, stopping any sign-in it started.
- **Sweep.** `sweepOrphans` runs at every launch start and end, at `pi sandbox gc` and, without the engine, at `pi sandbox stop` (and at `gc` or `reset` while the VM is stopped, which then say the engine step was skipped): it runs `removeRepoSandbox` for each repository with leftovers and no live launch, and forgets a repository whose folder is gone. A folder counts as gone only when its parent directory exists and the folder does not; when the parent is missing too (a disk that is not mounted), the repository's state, pins, container and volumes are all kept. Once a day (`gc.json`, written only when the engine answered) it also removes volumes of deleted repositories and unused images.
- **kill -9.** A killed launcher's entry stops counting at once, since its pid is gone, and its proxy idles out within a minute; its container, relay, network, token, pins and created folders stay until the next launch of any repository, `pi sandbox gc`, `pi sandbox stop` or the uninstall. A VM restart removes containers and relays.
- **Uninstall.** `bin/uninstall-engine.mjs --host-side` refuses while a launch is live, else releases every repository's pins, created folders, live proxy and sign-in groups, before the engine objects, the Colima profile and the state dir go.

## Invariants

- No real secret in the container's filesystem, environment or volumes; derivers and renderers take placeholders only, and `tests/support/expect-no-leak.ts` checks specs, exec argv, env, stdin and render files.
- The container's only network path is its repository's proxy; SNI check and private-range deny are always on.
- Nothing is mounted from a protected path; the git code host git runs is read-only inside.
- A project file cannot add hosts, mounts, credentials or images.
- Every removal re-checks liveness under the repository launch lock, so a live sandbox is never removed.
- Every file the launcher writes is listed below and removed when no longer needed, except the user's caches and sessions.

## Files written

This is the one list; the root docs and `AGENTS.md` link here. `<state>` is `~/.local/state/pi-sandbox/` (or `PI_SANDBOX_STATE_DIR`), `<h>` a repository hash and `<h12>` its first 12 hex. Atomic writes go through a sibling `<file>.<pid>.<hex>.tmp`, and a lock through `<lock>.draft.<pid>.<hex>` (and `<lock>.stale.<pid>.<hex>` on a takeover), each renamed or removed at once.

| Path | Written when |
| --- | --- |
| `<state>/repos/<h>/repo.json` (`{ root }`) | every launch |
| `<state>/repos/<h>/launches/<id>.json` (pid, boot time, process start), `lock`, `container.lock` | launch start; entry removed at the end |
| `<state>/repos/<h>/render/` (agent files, `mcp.json`, `tools/`: `m2-settings.xml`, `gh-hosts.yml`, `glab-config.yml`, `npmrc`, `pip.conf`, `gitconfig`) | every launch |
| `<state>/repos/<h>/sync/sync.lock` | each settings sync |
| `<state>/repos/<h>/git/<sha16>` (config copies), `git/baseline.json`, `pins.json`, `created.json` | container create; copies deleted, pins and created folders removed at the end |
| `<state>/repos/<h>/image.json` (the layer tag the repository wants) | a launch with an image layer |
| `<state>/repos/<h>/proxy/{proxy.json, token, proxy.log, proxy.log.1, access.log, access.log.1}` | proxy start; `proxy.json` removed at stop, `token` with the container |
| `<state>/{salt, grants.json, grants.json.lock, image.json, gc.json, seen.json, mcp-login.json}`, `<state>/provider-hosts/<pi version>.json` | as named |
| `<state>/ca/` (`ca-cert.pem`, `ca-key.pem`, `ca.lock`, `trust.pem`, `extra.pem`; temporary `new-*` and `work-*` dirs removed after use) | first launch with a proxy; leaves are minted in memory |
| `<state>/locks/{vm.lock, build.lock, git-<hash>.lock, mcp-login-<hash>.lock}` and `<lock>.takeover` | while held |
| `<state>/git/no-hooks/` (empty `core.hooksPath` for the launcher's own git calls) | discovery |
| `<state>/mcp-login-<random>/` (empty cwd of a host `pi mcp login` or `logout`) | removed after use |
| `<state>/build/{build,layer}-<random>/` and `<…>.tar` (image build contexts and their archives) | each image build; removed after, leftovers by the sweep |
| `<state>/replaced-pi-link` | `install.sh`, when it replaces pi's managed link; removed by `uninstall.sh` |

Outside the state dir:

- `~/.config/pi-sandbox/config.json`: only its `org` key, by `install.sh --org`.
- In the repository or workspace (each repository's git dir in workspace mode): empty hook dirs and missing volume mount points (overlay folders, `mounts.cacheVolumes` targets), created as the host user and recorded in `created.json`, removed when empty at the end and by uninstall; the `commondir` pin (`.`) in the common dir and each submodule git dir, written through a `commondir.<pid>.<hex>.tmp` hard-linked into place and removed at once, recorded in `pins.json`, removed at the end and by uninstall.
- In the home: missing `mounts.hostCaches` folders, created 0700 and kept as the user's caches.
- `~/.pi/agent/sessions/<slug>/` while host sessions are on: the missing `~/.pi/agent/`, `sessions/` and `<slug>/` (0700), a probe marker written and deleted at container creation and on each doctor run, the sweep's deletions and `.rejected-<random>` renames (also with the feature off); pi inside writes the session files.
- `~/.colima/pi-sandbox/colima.yaml` and colima's `_lima` instance files: rewritten by colima on the launcher's `colima start --mount …`, only when a launch needs a share and no pi session is live.
- Engine objects: containers `pi-sandbox-<h12>`, relays `pi-sandbox-relay-<h12>`, networks `pi-sandbox-<h12>` (removed at the end), volumes `pi-sandbox-agent-*`, `pi-sandbox-cache-*`, `pi-sandbox-shared-*` (kept until `reset --volumes`, `gc` or uninstall), and images (base, `pi-sandbox-layer:*`).
- `install.sh`: the `pi` link or wrapper in `~/.local/bin` (or `--bin-dir`), a marked `PATH` block in `~/.zshrc` and, when they exist, `~/.bashrc` and `~/.bash_profile`, and a smoke repository under `~/.cache/` that it deletes; `uninstall.sh` removes the first two.

Host pi, not the launcher, writes `<agent dir>/mcp-auth.json` during the `pi mcp login` the launcher starts.

## Alternatives considered

- A published, pinned image instead of a local build: rejected, so the sandbox runs the same pi version as the host.
- An unauthenticated proxy shim inside the container: rejected; JVM flags and rendered tool settings cover most clients, and the rest is a documented gap.
- One shared proxy per policy: replaced by one proxy per repository, so rules, env secrets and tokens never cross repositories.
- A second engine, Docker Desktop, or a host process under Seatbelt or OpenShell: not taken; Colima is the one engine, and a container keeps credentials out of reach by construction.

## Tests

Tests check behaviour through public entry points with fakes only at the process boundary: a scripted `CommandRunner`, an in-memory engine HTTP server, a fake backend, temp dirs, real localhost sockets and openssl certificates. The CLI tests run whole commands against the fake backend. Live tests against the real Colima engine run only with `PI_SANDBOX_LIVE=1` and fail when their cleanup had to remove anything.
