# launcher architecture

The launcher is a standalone host-side layer. It provides the `pi-sandbox` command (installed as `pi`), which runs pi inside a per-repository container and keeps credentials and network access on the host. What it does for the user is in [README.md](README.md), where things are in [STRUCTURE.md](STRUCTURE.md).

## Layer rules

- No pi imports (`@earendil-works/*`, `typebox`) and no imports from `platform/`, `extensions/` or `test/`. Only `node:*` built-ins and files inside `launcher/`; `launcher/tests/` may also import `vitest`. No npm dependencies: validation, HTTP, TLS and process control are hand-rolled over Node.
- Each folder exposes what other folders use through its `index.ts`, and nothing more. Another folder imports only `../<folder>/index.ts`, never an inner file. `bin/` is the exception: it imports `cli/main.ts` (or `dist/cli/main.js`) and nothing else, which `test/architecture.test.ts` asserts.
- The folder graph is exact, and `test/architecture.test.ts` asserts it edge for edge:

  | folder | imports |
  | --- | --- |
  | `shared` | nothing |
  | `config` | `shared` |
  | `workspace` | `config`, `shared` |
  | `backend` | `shared` |
  | `proxy` | `config`, `shared` |
  | `container` | `backend`, `config`, `workspace`, `shared` |
  | `image` | `backend`, `config`, `shared` |
  | `cli` | any of the above |
  | `bin` | `cli` |

  Nothing imports `cli` except `bin/`, there are no cycles, and shipped code never imports `launcher/tests/`.
- Tests: a file under `launcher/tests/<folder>/` may import inner modules of `launcher/<folder>/` (its own folder) and reaches every other folder through its `index.ts`. `launcher/tests/support/` reaches every folder through its `index.ts` only, and imports nothing from the per-folder test suites. Any test may import `tests/support/`.
- `cli/` is the only folder that writes to the terminal. The proxy daemon writes only its own log files. Every expected failure is a `LauncherError` (`message` and optional `hint`), reported as `pi-sandbox: <message>` and `  hint: <hint>` on stderr with exit code 1 and no stack trace. Any other error is `pi-sandbox: unexpected error: <message>` with exit code 70.
- External processes run through the `CommandRunner` interface, so tests replace them with a scripted fake: git (workspace discovery, `core.hooksPath`, the checkout `HEAD`), npm (`npm pack`), tar (the build context), openssl (the launcher CA), `security` (keychain credentials), `ps` (checking a proxy pid before killing it), the Apple `container` CLI and the `sso` credential command.

## Dev and dist entry

The sources run directly under Node 22.19 or newer through type stripping, so they follow its rules: no enums, no parameter properties, no namespaces, `import type` for types, `.ts` extensions in relative imports. `bin/pi-sandbox-dev.js` imports `../cli/main.ts` and is what a checkout install runs.

Node refuses to strip types under `node_modules`, so the published command runs compiled JavaScript. `tsconfig.build.json` emits `dist/` with relative `.ts` imports rewritten to `.js`; `npm run build:launcher` builds it and `prepack` runs that. `bin/pi-sandbox.js` imports `../dist/cli/main.js`. Assets that are not TypeScript (Dockerfile, entrypoint, profiles, schema, install scripts) stay in the `launcher/` folder, so code finds them through `launcherRoot()` (the `launcher/` folder in either layout) and runnable entries through `launcherEntry()`, never relative to its own compiled file.

## The pipeline

`pi [args]` runs these steps, each a function the other commands reuse (`cli/launch.ts`, around a `LaunchContext` of workspace, effective config and state dir):

1. Discover the workspace: `git rev-parse --show-toplevel --git-common-dir` from the cwd, real paths. Outside git the repository is the cwd.
2. Load the effective config from the layers. Check `workspaceRoots`: the repository and its git common dir must be inside the roots (a linked worktree whose main repository is outside is refused); `outside: warn` prints a warning instead.
3. `--no-sandbox`: refused under `fallback: refuse`, naming the layer; otherwise exec the first host `pi` on `PATH` that is not the launcher.
4. Refuse a workspace that would mount too much (`workspace/guard.ts`, regardless of `workspaceRoots`): a repository root or git common dir that equals or contains `$HOME`, `~/.pi`, the launcher state dir, the user config dir, or `/`, or that lies inside `~/.pi`, the state dir or the config dir. The config dir is protected only when it is the default `~/.config/pi-sandbox`; with `PI_SANDBOX_USER_CONFIG` elsewhere only that file is, so a repository equal to or containing it is refused and its siblings are not. A dotfiles repository rooted at `$HOME` is the case this catches. The hint is `run pi inside a project directory`.
5. Select the backend (`auto` tries Colima, then Apple `container`). The error lists every adapter and why it is unavailable, and suggests `--no-sandbox` when the fallback is `host`.
6. Hot path: `recordedImage(stateDir, config)` reads `<stateDir>/image.json` (reference, digest, image id). When `findCurrentContainer(backend, workspace, digest, configHash)` finds this repository's container with that digest and config hash, the image step is skipped. Cold path: print `preparing pi sandbox, one time`, resolve the extensions source and `ensureBuiltImage`.
7. Start the proxy, only when a gateway or a non-empty `egress.allow` or `egress.mcpHosts` exists. A proxy that cannot start stops the launch: the launcher never runs without it. `ensureProxyRunning` returns the instance (`policyHash`, `port`, `token`, `pid`), `backend.prepareProxyRoute(port, policyHash, imageId)` returns the guest's route (network and address); the image id is the one the agent container is created from, so a digest pulled as `repo@digest` (no tag) works for the relay too, and `guestProxyUrl(route, token)` builds the proxy URL. The launcher CA is passed only when a gateway is configured.
8. Discover the git files to protect, build the container spec (`buildContainerSpec` owns the network, the proxy environment and the CA mount; nothing patches the spec afterwards), ensure the container, exec pi in it with the host cwd as workdir and the `env.allow` host variables as the exec's environment (`forwardedEnv`), and return pi's exit code.

`pi sandbox doctor` uses the same pipeline, so it builds the image and creates the container, then runs its probes (`container/probes.ts`) through execs into it. Rendering stays in `cli/commands/doctor.ts`.

### Signals

`runPi` (`container/run-pi.ts`) puts a tty stdin in raw mode, so Ctrl-C reaches pi as a keystroke. It listens for SIGTERM and SIGHUP, and for SIGINT only when stdin is not a tty. Pi runs as `sh -c 'echo $$ > /tmp/pi-sandbox-<launch id>.pid; exec "$@"' sh pi <args>`, with a random hex launch id per `runPi` call. On one of the signals it runs `kill -TERM "$(cat <pid file>)"` inside the container through `backend.exec`, waits up to five seconds for pi's exec to end, stops the container (two-second timeout) only if it has not, restores the terminal and returns `128 + signal number` (130, 143, 129). Afterwards it removes the pid file, best effort. Only pi gets the signal, so the container's idle process keeps running and the next `pi` reuses the container.

## Config

`SandboxConfig` is the merged result of the defaults, the profile, and the policy, user and project layers. Each layer is validated by a hand-written key spec (precise `<layer>: <key> <problem>` messages); `schema/sandbox-config.schema.json` documents the same keys, and a test keeps the two key sets equal.

The merge has two kinds of keys. Security keys (`egress.allow`, `egress.mcpHosts`, `credentials`, `mounts.extraReadOnly`, `fallback`, `workspaceRoots`, `ssh.agent`, `image.digest`, `image.reference` while a digest is pinned above, `gateway`, and `backend` when policy sets it) may only be tightened by a lower layer: lists may lose entries, `refuse` stays `refuse`, `ssh.agent: false` stays off, roots may only narrow, a value set above cannot change. The project layer is locked by everything above it, including the defaults and the profile, so it can never turn `ssh.agent` on; the user layer is locked by policy, and by the profile when policy chose it. A violation is a `LauncherError` naming the locking layer.

Three keys are host-only: a project layer that sets `env.allow`, `image.reference` or `image.digest` is refused when it loads, with a `LauncherError` naming the file. Above the project, `env.allow` is the union of the policy and user layers, and secret-looking names (the shared `isSecretName` predicate, also used by the doctor's credential sweep) are refused. Convenience keys take the lowest layer's value; `resources` (`cpus`, `memoryGiB`) merges per subkey.

Egress entries are `host`, `*.domain`, `host:port` or `*.domain:port`. `fallback` is `refuse` or `host`. `PI_SANDBOX_POLICY_FILE` is honoured only when the default policy file does not exist, so a user environment cannot hide a real policy; `PI_SANDBOX_STATE_DIR` and `PI_SANDBOX_USER_CONFIG` always apply.

The merge also records the source layer of every dotted key, which `pi sandbox config` prints. `setConfigValue` applies a change to one layer, validates and lock-checks the result against the layers above, and writes nothing when refused. `configHash` is the sha256 of the key-sorted JSON of the effective config (`stableHash` in `shared/`), so every security key, `ssh.agent` included, changes it.

## Backend contract

A `Backend` is the only thing that talks to a container runtime. It detects itself, pulls images by digest (`pullImage(reference, digest?)`, which pulls `repo@digest` when a digest is given and verifies it), looks images up locally (`resolveImage`), builds them (`buildImage`), all returning `ImageInfo { id, digest }`; it finds, creates, starts, stops (`stopContainer(id, timeoutSeconds?)`) and removes containers, runs an exec (`exec(ExecSpec, ExecIo)`: stdin, separate stdout and stderr, tty, size and `onResize`), manages volumes, exports and imports them through a helper started from an image id the caller passes (`exportVolume(name, tarPath, imageId)`, `importVolume(name, tarPath, imageId)`), prepares the guest's proxy route and reports a status map. Specs are runtime-agnostic: `ContainerSpec` (image id, mounts, `NetworkRef`, env, user, read-only root, tmpfs, init, resources, labels, and `sshAgent: { guestSocket }` when the agent is forwarded) and `ExecSpec` (container, command, env, workdir). The image id is opaque: on Apple it may be a `repo@digest` string.

Each backend declares `BackendCapabilities`, which the container spec and `status` read instead of branching on the backend name:

| capability | docker-engine (`colima`) | apple |
| --- | --- | --- |
| `singleFileMount` | yes | no |
| `sshAgent` | when a Colima profile is detected (bind mount of the forwarded agent socket) | yes (`--ssh`) |
| `internalNetwork` | yes | yes |

- `backend/docker-engine/` is the adapter behind the backend name `colima`. It speaks the Docker Engine HTTP API over a Unix socket with `node:http`. The socket is `DOCKER_HOST` (unix), then `~/.colima/pi-sandbox/docker.sock`, `~/.colima/default/docker.sock`, `/var/run/docker.sock`; `status()` reports it. Exec is a hijacked `Upgrade: tcp` stream with raw stdin and demultiplexed stdout and stderr frames; the exit code comes from exec inspect. Volumes carry `pi-sandbox.managed` and are exported and imported as tar archives through a helper container, created from the given image id and never started. Builds use the legacy build endpoint, so the Dockerfile avoids BuildKit-only syntax.
- `backend/apple/` drives the `container` CLI through the `CommandRunner`; a tty exec uses the host terminal directly through an interactive spawn, a non-tty exec pipes `ExecIo`. Its ssh agent comes from `--ssh`. Every flag and JSON shape it relies on is kept in one table so it can be corrected against a real host.
- `backend/image-reference.ts` splits references into repository and tag and builds `repo@digest`.

A conformance suite runs the same behaviour tests against both adapters on fakes (an in-process engine HTTP server, a fake `container` CLI) and against a real engine in the live tests.

## Network: proxy instances and relays

There is one proxy instance per policy hash (`proxyPolicyHash(config)`: allowlist, MCP hosts, gateway settings, credential source), so two repositories with different policies never share a proxy. Each instance has a random token (32 bytes, hex), created once in `proxy-token` (mode 600) when the instance directory has none and reused by every later start, so restarting the proxy (a reboot, `gc`, a hung proxy replaced) keeps the container's proxy URL and spec hash. The token rotates only when the instance directory goes: `pi sandbox reset` removes the instance of the repository's policy hash (`removeProxyInstance`) unless a running container of another repository carries that `proxy-policy-hash` (`policyHashesInUse`, the same check `collectGarbage` uses), and the next launch creates a new token. The daemon also records it in `proxy.json` (mode 600). The proxy answers `407` to any request, `/healthz` included, without `Proxy-Authorization: Basic base64("pi-sandbox:" + token)`; the guest gets the token in its proxy URL, `http://pi-sandbox:<token>@<route address>`. The token only proves to the proxy that a request comes from a container the launcher started; it is not a credential for anything else, and it never appears in the proxy's logs.

Agent containers have no route out. With the docker engine they join only `pi-sandbox`, an internal bridge network carrying `pi-sandbox.managed`; the launcher inspects it and refuses a network of that name that is not internal or not managed, naming it. One relay container per proxy instance, `pi-sandbox-relay-<first 8 of the policy hash>`, from the sandbox image id passed to `prepareProxyRoute` (which has socat), sits on both the default `bridge` network and `pi-sandbox`. It runs `socat TCP-LISTEN:3128` and forwards each connection to its proxy's port through `host.lima.internal` (Colima) or `host.docker.internal` (mapped to the host gateway). Its address is read from network inspect after creation, not fixed. Relays carry `pi-sandbox.managed`, `pi-sandbox.relay`, `pi-sandbox.relay-port`, `pi-sandbox.relay-image` and `pi-sandbox.proxy-policy-hash`; a relay whose port and policy hash labels match is reused whatever its image (started again when stopped, so it usually keeps its address and the agent's spec hash), and only a relay whose port or policy hash differ is recreated; the image id is used only when a relay is created and kept in `pi-sandbox.relay-image` for information. An agent container carries the same `pi-sandbox.proxy-policy-hash`, so `gc` removes relays and stops proxy instances that no running container uses.

With `apple`, the agents join an internal network created with `--internal` and `--label pi-sandbox.managed=true`, and the route address is that network's gateway with the proxy's port. An existing `pi-sandbox` network is inspected first (`container network inspect` JSON, the fields assumed in `APPLE_NETWORK_FIELDS` in `apple/cli.ts`); one that is not internal, not managed, or whose output cannot show it is internal is refused with a `LauncherError`.

The internal network's embedded DNS answers container names only; external names do not resolve inside, so every tool must go through the proxy.

## Proxy

The proxy is a detached Node process (`proxy/daemon.ts`) on `127.0.0.1`, started on demand. Its state lives in `<stateDir>/proxy/<policyHash>/`: `proxy.json` (pid, port, policy hash, token), `proxy-token` (mode 600, kept when the proxy stops), `proxy-config.json` (mode 600), `proxy.log` (the daemon's stderr), `proxy-access.log` and `lock`. Start-up holds `lock` (exclusive create, a stale lock is detected by its pid and taken over by renaming it to a unique name, then creating a new one, so of two waiters only one creates the lock and the other sees `EEXIST` and waits; the renamed file is compared with the stale lock read before, by inode, mtime and content, and only a different lock whose owner is alive is linked back, so a lock whose holder has gone is not resurrected); the launcher reuses an instance whose pid is alive and whose `/healthz` answers with the same policy hash, and kills and replaces one that fails the health check twice. `readProxyInstances` lists only live instances; `stopProxy` stops one or all and removes dead records, keeping the token; `removeProxyInstance` stops one and deletes its directory. The launcher CA is shared at `<stateDir>/ca/`.

- `CONNECT host:port` is allowed for hosts in `egress.allow`, `egress.mcpHosts` and the gateway host, on 443 unless the entry names a port (`host:port`, `*.domain:port`), the gateway on its URL's port. IP literals, localhost, loopback, link-local, private and reserved ranges, the metadata address and names that resolve only to such addresses are refused. The proxy resolves and dials itself, reads the TLS ClientHello and refuses a missing SNI or one that differs from the CONNECT host. Allowed tunnels are not decrypted.
- A denial is `403` with a JSON body `{ denied, rule, reason }` and `Proxy-Agent: pi-sandbox`. Plain HTTP is refused except `/healthz` (`{ ok, policyHash, pid }`) and `/policy`.
- The gateway host is the only one whose TLS is terminated, with a per-host leaf signed by the launcher CA (made with openssl). The request goes on over TLS to `gateway.url`; the configured auth header is replaced when its value is the placeholder or `<scheme> <placeholder>`, and anything else is forwarded untouched. Server-sent events stream unbuffered and WebSocket upgrades are forwarded.
- Credential sources: `static` (an environment variable of the proxy process or a macOS keychain item), `host-pi-auth` (the host's `~/.pi/agent/auth.json`, or `authFile` with `~` expanded, an API key or an OAuth access token, without refresh), `sso` (a command whose stdout is a token or `{ token, expiresAt }`, cached until expiry or five minutes).
- Every decision is one JSON line in `proxy-access.log` (`time, user, host, sni, decision, rule, reason, bytesIn, bytesOut`), never a credential or the token.

## Container identity

A container belongs to one repository: its name is `pi-sandbox-<first 12 of the repo hash>`. Its labels carry `pi-sandbox.managed`, the full `repo-hash`, `repo-root`, `image-digest`, `image-reference`, `config-hash`, `proxy-policy-hash` (when it has a proxy), `version` and `spec-hash`, the sha256 of the rendered spec as key-sorted JSON. The container is created from the image id, with the reference kept in its label. `ensureContainer` reuses a container whose image digest, config hash and spec hash all match (starting it when stopped) and otherwise stops and removes it and creates a new one. So a config change, a new image or any change in the rendered spec (a new proxy route, a token rotated by `reset`, a new mount) gives the next `pi` a fresh container, while the volumes survive.

The spec mounts the repository and git common dir read-write at their host paths and overlays these read-only: the git dir's `hooks` and `config`, the effective `core.hooksPath` when it resolves inside a mounted path, the `hooks` and `config` of every submodule git dir, `config.worktree` and every `.git/worktrees/*/config.worktree`. Hook dirs are overlaid whether they exist or not: `discoverGitOverlay` creates a missing `.git/hooks`, `core.hooksPath` or submodule `hooks` dir (empty) on the host first, so the agent cannot create hooks the host would run. A `core.hooksPath` outside every mounted path is left alone, since the container cannot see it. Submodule git dirs are found by walking `.git/modules/`: a dir with a `HEAD` file is a module git dir, and only its `modules/` subdir is walked further (a dir without `HEAD` is a path segment of a module name and is walked into), so objects are never listed. When the backend has no single-file mounts, the files come from copies under the spec's `copiesDir` (`<stateDir>/copies/<repo hash>/`). It adds `mounts.extraReadOnly`, the repository's agent volume `pi-sandbox-agent-<user hash>-<repo hash>` at `/home/pi/.pi/agent` and per-repository cache volumes; `repoVolumes` lists both kinds for `reset --volumes` and `migrate`. The root is read-only with tmpfs `/tmp` and `/home/pi`, under an init process, as `<uid>:<gid>` on Linux. The environment holds no host variables (the allowlisted ones go to each exec, so the spec hash does not change with the terminal): the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`) when there is a proxy, `NODE_EXTRA_CA_CERTS` when the CA is mounted, the CA bundle paths and pi's offline and telemetry switches. With `ssh.agent` on and a backend that can forward it, the spec asks for the agent at `/run/host-ssh-agent.sock` and the adapter sets `SSH_AUTH_SOCK`.

## Image

`image/Dockerfile` builds on a slim Node image with git, search tools, ssh, tini, socat and netcat, a `pi` user with uid 1000, pi pinned to the version in the package's dev dependencies, and this package's extensions from `EXTENSIONS_SOURCE`: a tarball packed from the checkout (`npm pack`, cached in `<stateDir>/pack/` by package version and git `HEAD`, `image/extensions.ts`), a registry version when the launcher itself runs from `node_modules`, or none when the digest is pinned. Pi's `models.json` and `auth.json` are rendered from the gateway config with placeholder keys only and baked into `/opt/pi-sandbox/`. Each provider's `apiKind` is written unchanged into pi's `api` field, so the launcher names no API protocol itself. The renderer refuses a `gateway.placeholder` that does not start with `pi-sandbox-`, so no other key can reach either file.

The entrypoint links those files read-only into the agent dir, seeds `settings.json` once (the agent dir is a volume), builds a CA bundle from the system roots plus the launcher CA so tunneled hosts keep the system roots, and idles under tini; pi runs through exec. `ensureBuiltImage` pulls and verifies a pinned digest through `backend.pullImage`, or hashes the build inputs (reference, pi version, Dockerfile, entrypoint, rendered files, tarball) against `<stateDir>/image.json` and rebuilds when they changed or the recorded image is gone. Either way it records the reference, digest and image id; `recordedImage` is the one reader of that record.

## Files written

- `~/.local/state/pi-sandbox/` (or `PI_SANDBOX_STATE_DIR`): the launcher's own state.
- `~/.config/pi-sandbox/config.json`: the user config, written by the installer when absent, on `pi sandbox config set` and by `migrate`.
- Inside the repository's git dir and worktree: empty hook directories (`.git/hooks`, a `core.hooksPath` inside a mounted path, submodule `hooks`) created when missing, so they can be mounted read-only.
- `<repo>/.pi/sandbox.json`: written only on the user's command (`pi sandbox config set --project`). When the launcher creates `<repo>/.pi/`, it also writes `<repo>/.pi/.gitignore` with `*`. It may not import `platform/shared`, so it carries its own equivalent of that write; an existing `.pi/` is left as it is.

## Tests

Tests check behaviour with fakes only at the process boundary: a scripted `CommandRunner`, an in-memory engine HTTP server on a temp Unix socket, a fake `container` CLI, a fake backend, temp dirs, real localhost sockets and openssl certificates. A folder's tests may reach that folder's inner modules; everything else goes through `index.ts`. The CLI tests run whole commands against the fake backend with an injected proxy control and collect their output. Live tests against a real engine run only with `PI_SANDBOX_LIVE=1`.
