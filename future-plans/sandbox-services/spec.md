# Sandbox services: spec

> Status: planned, not implemented. Date: 2026-11-08. Overview and open points in README.md. Paths are under `launcher/` unless they say otherwise.

## Goal

`pi` in a repository whose config names services starts those containers next to the sandbox, waits until they answer, and lets test code inside reach them by name. Nothing new reaches the host: no published port, no route from a service or the sandbox to host ports, no engine socket.

## Config

A new top-level `services` object. Every key except the three control keys is a service name.

```json
{
  "services": {
    "allowProject": false,
    "allowImages": ["docker.io/library/postgres", "docker.io/library/redis"],
    "readyTimeoutSeconds": 60,
    "postgres": {
      "image": "docker.io/library/postgres:16",
      "digest": "sha256:…",
      "env": { "POSTGRES_PASSWORD": "test", "POSTGRES_DB": "app_test" },
      "ports": [5432],
      "volumes": [{ "target": "/var/lib/postgresql/data", "persist": false }],
      "healthcheck": { "command": ["pg_isready", "-U", "postgres"], "intervalSeconds": 1 },
      "cpus": 1,
      "memoryGiB": 1
    },
    "redis": { "image": "docker.io/library/redis:7", "ports": [6379] }
  }
}
```

| key | type | rule |
| --- | --- | --- |
| `<name>` | object | `^[a-z][a-z0-9-]{0,30}$`, a valid DNS label; `allowProject`, `allowImages`, `readyTimeoutSeconds`, `localhost` and names starting with `pi-sandbox` are reserved. At most 8 services. |
| `image` | string | Required. A reference with a registry, repository and tag, normalised the way the engine does (`postgres` reads as `docker.io/library/postgres:latest`). |
| `digest` | string | `sha256:<64 hex>`. Pulled as `repo@digest` and verified through `backend.pullImage` (`backend/pull.ts`), as the sandbox image is. Required for a service defined in the project layer. |
| `env` | object of strings | Plain strings only. No `{ env }`, `{ file }` or `{ command }` source, no `$NAME` expansion, no host variable. A value that matches the placeholder shape `pi-sandbox-[0-9a-f]{24}` is refused at load (`services.<name>.env.<VAR> holds a sandbox placeholder; service env values are test values`). |
| `ports` | array of 1-65535 | The ports the service listens on. Used for the readiness probe and `NO_PROXY`. Never published. This is not the removed top-level `ports` key, which stays refused. |
| `command` | array of strings | Replaces the image's command (`Cmd`), not its entrypoint. |
| `volumes` | array of `{ target, persist? }` | `target` an absolute path inside the service. No `source`: a host path or a named volume chosen by the config is refused, so a service can never bind host files or another repository's volume. `persist` defaults to `false`. |
| `healthcheck` | `{ command, intervalSeconds?, timeoutSeconds? }` | `command` runs inside the service through `backend.exec`. Without it the probe is a TCP connect to the first port. |
| `cpus`, `memoryGiB` | numbers | Per service. Each falls back to `resources.cpus` and `resources.memoryGiB`. |
| `allowProject` | boolean | Default `false`. Whether the project layer may define services. |
| `allowImages` | array of strings | Image patterns a project-defined service must match: a full repository (`docker.io/library/postgres`) or a prefix ending in `/*` (`registry.corp.example/test-images/*`). Matched on the normalised repository without tag or digest. |
| `readyTimeoutSeconds` | number | Default 60, at most 600. |

Fixed for every service, not configurable: no privileged mode, no added capabilities, no devices, no host namespaces, no host mounts, `no-new-privileges`, a pids limit of 512, `Init: true`, the image's own user. The root fs stays writable, since most server images write under `/var/run`; the data paths are volumes.

## Layers

| layer | may define services | may set `allowProject`, `allowImages`, `readyTimeoutSeconds` |
| --- | --- | --- |
| policy | yes | yes |
| org | yes | yes |
| user | yes, within the policy and org `allowImages` when they set one | yes, tighten-only below policy and org |
| project | only when the merged `allowProject` of the layers above is `true`; each image must match the merged `allowImages` and carry a `digest` | no (refused like the other host-only keys, hint `set it in the user config instead`) |

- `allowProject` may only turn off below the layer that sets it. `allowImages` may only lose entries below the layer that sets it, so the user cannot widen an allowlist that policy set. A user-defined service whose image is outside a policy or org `allowImages` is refused, naming the locking layer.
- Service definitions merge per name: the lowest layer that defines a name owns the whole entry, with no deep merge, and a project entry passes the image check whatever it replaces. A layer may remove a name defined above with `"<name>": null`, except in the project layer.
- The three control keys join `projectKeyRefusal` in `config/validate.ts` (20 keys then). `services` itself is not on that list: its project-layer check is conditional and runs in `config/merge.ts`, after the layers above are merged.
- The effective services feed `configHash`, so a change of any service gives the sandbox a new config hash.

Why a project file is gated: a cloned repository that could name any image would run code the developer never chose, on the developer's engine, every time `pi` starts in that checkout. The container has no host access and no egress, but it still gets CPU, memory and disk in the VM, a long-lived position on the network next to the sandbox (where it can feed hostile answers to the test code and to pi's tools), and an image pull from any registry the engine reaches. The allowlist limits that to images the developer or the administrator vetted, and the digest pin stops a tag from moving to a different image under the same name.

## Secrets

Service passwords are test values. The sandbox must know them to connect, so they are visible inside: in the project or user config the sandbox may read, in the test code, and in the environment the tests set. The launcher does not hide them and does not try to.

- The README and the threat model say: never put a real credential in `services`. A service is a throwaway local database, not a gateway to a real one.
- `env` values cannot reference the vault, a placeholder, a host variable or a secret source, so a host secret can never reach a service through this key.
- A service gets no proxy variables and no repository token.

## Lifecycle

Services follow the sandbox container. Every step runs under the repository's container lock (`<state>/copies/<short repo hash>.lock`) that `ensureContainer` already takes.

| when | what happens |
| --- | --- |
| launch, step 10 (beside the image) | Pull each service image that is not present locally (`resolveImage`, then `pullImage(reference, digest)`). A pull failure stops the launch: `pi-sandbox: services: <name>: <image> could not be pulled: <reason>`. |
| launch, step 11 | Ensure the services network (see Networking), then `ensureServices` beside `ensureContainer`: reuse a running service whose `pi-sandbox.service-hash` matches, start a stopped matching one, otherwise create it. A changed service while other sessions of the repository are live is kept, with `pi-sandbox: services: <name> changed; it applies after every session in this repository exits`, as for the sandbox container. |
| before step 12 | Wait for readiness (below). pi starts only when every service is ready. |
| step 13, last session (`endSession` `onLast`) | After `stopIdleContainer`, remove every service container of the repository with its anonymous volumes. Named volumes stay. |
| a signal during preparation | `ensureServices` checks the same `AbortSignal` between services; the `onLast` path removes what was created. |
| `pi sandbox reset` | Removes the services with the sandbox container; `--volumes` also removes the services' named volumes. |
| `pi sandbox gc` | Removes service containers of repositories outside the keep set (no running sandbox and no live session), then prunes networks; named service volumes follow the existing orphan rule (repository root gone from disk, not in use). |
| doctor | Creates the services when it creates the container and removes them with it. One `ok|fail services <name>: <state>` line each. |

The owner's design says services stop at the last session. This spec removes them instead: "ephemeral by default" then means fresh data at every first launch, an anonymous volume never outlives its service, and a stopped service with stale data cannot be picked up days later. The cost is the image's init time (a few seconds for Postgres) on the first launch of a day. Stopping only is the fallback if that proves too slow.

### Identity and labels

| item | value |
| --- | --- |
| container name | `pi-sandbox-svc-<repo12>-<name>` |
| network alias | `<name>` on the services network |
| labels | `pi-sandbox.managed=true`, `pi-sandbox.repo-hash`, `pi-sandbox.repo-root`, `pi-sandbox.service=<name>`, `pi-sandbox.service-hash` (sha256 of the rendered service spec), `pi-sandbox.version` |
| named volume (`persist: true`) | `pi-sandbox-svc-<user12>-<repo12>-<name>-<8 hex of sha256(target)>`, with `pi-sandbox.managed`, `repo-hash`, `repo-root` and `service` |

Existing code that must learn to skip services, since they carry `pi-sandbox.repo-hash`:

- `findRepoContainer`, `findCurrentContainer`, `removeRepoContainer` and `listLauncherContainers` in `container/lifecycle.ts` (`isAgent` today excludes only relays), and so `gitDirInUseElsewhere`, `policyHashesInUse`, `collectGarbage`, `pi sandbox status` and the doctor.
- `removeWithNetworkCleanup` in `backend/managed-network.ts` counts any container with the repository label as remaining. That is right: the network goes with the last of the sandbox and its services.
- `removeNetwork` in `backend/docker-engine/relay.ts` refuses a network that holds a non-relay container. It keeps that rule; the services are removed first.
- `repoVolumes` in `container/spec.ts` adds the named service volumes, so `reset --volumes` and `migrate` see them.

### Readiness

- With `healthcheck.command`: `backend.exec` into the service every `intervalSeconds` (default 1) until exit 0, each exec bounded by `timeoutSeconds` (default 5). This is the launcher polling, not the engine's own healthcheck, so it works the same on both backends.
- Without it: `nc -z -w 2 <name> <first port>` exec'd inside the sandbox container (netcat is in the image), which also proves the name resolves from where the tests run.
- The services are probed in parallel. The overall bound is `readyTimeoutSeconds`.
- Output on stderr while waiting, once: `pi-sandbox: services: waiting for postgres, redis`. On timeout the launch stops before pi starts, the session ends as a normal exit does: `pi-sandbox: services: postgres was not ready after 60 s` with `  hint: pi sandbox services logs postgres`. A service container that exits during the wait stops the launch at once with its exit code.

## Networking

| from | to | allowed |
| --- | --- | --- |
| sandbox | service, any port | yes, by name |
| service | sandbox | yes (same network; the sandbox listens on nothing by default) |
| service | other service of the repository | yes |
| service | relay, proxy, host, internet, other repositories | no |
| host | service | no, nothing is published |

- A second internal network per repository, `pi-sandbox-svc-<repo12>`, `Internal: true`, labelled `pi-sandbox.managed` and `repo-hash`. The sandbox container joins it beside the repository network; services join only it. The relay never joins it.
- Why not the existing repository network: the relay listens there on 3128 and forwards to the host proxy. A service on that network could reach the proxy. The proxy answers `407` without a repository token and a service never gets one, but the proxy's plain-HTTP routes would still be a host listener within a service's reach. A separate network costs one more network per repository and closes that. This changes the owner's "same internal network" wording; flagged in README.md.
- No `ExtraHosts` on a service, no `host.docker.internal` or `host.lima.internal` mapping, no DNS servers set. On an internal network the engine's embedded DNS answers container names and aliases only, so external names do not resolve.
- No proxy variables in a service. A service only receives connections.
- `ContainerSpec.network` becomes a list (`networks: NetworkRef[]`, the first one primary), or the spec gains `extraNetworks`. The sandbox's spec hash then includes the services network, so turning services on recreates the sandbox at the next launch that is alone in the repository.
- `pruneCandidates` in `backend/managed-network.ts` learns the `pi-sandbox-svc-<12 hex>` names.

### Proxy variables in the sandbox

The sandbox sets `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` to the relay and `NO_PROXY=""` (`proxyEnv` in `container/spec.ts`).

- Database drivers (libpq, the Redis clients, most JDBC drivers) open plain TCP and ignore these variables, so `postgres:5432` works as is.
- HTTP clients do not. curl uses `ALL_PROXY` for every scheme it proxies, and does not read uppercase `HTTP_PROXY`, so `curl http://minio:9000` goes to the relay through `ALL_PROXY`. Node with `NODE_USE_ENV_PROXY=1` sends `http://elasticsearch:9200` to `HTTP_PROXY`. The proxy refuses both (plain HTTP, and a name that does not resolve to an allowed address).
- So when services are configured, `NO_PROXY` becomes the comma-joined service names, and `no_proxy` gets the same value for clients that read only the lowercase form. Sorted, so the spec hash is stable. Without services it stays `""`.

## CLI

```text
pi sandbox services status          one line per service: name, image, state, ready or not, ports, data (ephemeral | volume <name>)
pi sandbox services logs <name>     the service's logs; --follow, --tail N (default 200)
pi sandbox services restart <name>  stop and start the service, then wait for readiness
```

- `status` needs no running sandbox; with none it prints the configured services as `not running`.
- `logs` and `restart` refuse an unknown name (`pi-sandbox: services: no service <name> in this repository`) and a service that is not running.
- `restart` keeps the container and its anonymous volume. To get fresh data, end every session or run `pi sandbox reset`.
- `pi sandbox status` adds `service: <name> <state> <image>` lines after the container line.
- The `services` commands run on the host only, like `egress`; the sandbox cannot restart or read the logs of a service through the launcher.

## Apple `container` backend

What is known from the adapter: it creates per-repository networks with `--internal` and labels, reads container labels through `container inspect`, and starts the sandbox with `--network <name> --no-dns` (`backend/apple/backend.ts`). Each container is its own lightweight VM.

| need | state |
| --- | --- |
| internal network per repository, with labels | works today for the sandbox |
| second network on the sandbox | unverified: whether `--network` may be repeated |
| name resolution between containers | unverified. The sandbox runs with `--no-dns` today; whether the CLI's DNS resolves other containers by name on an internal network, and under which domain, must be checked on a real host |
| network alias `<name>` | no known flag; the container name would have to be `<name>` or the domain-qualified name, which breaks the `pi-sandbox-svc-…` naming |
| exec-based readiness, logs (`container logs`), labels, resource limits | expected to work; the flags go into the `cli.ts` table |
| memory | each service is a VM with its own overhead |

Plan: release 1 supports the docker engine (Colima) only. On Apple, a config with services refuses at launch with `pi-sandbox: services: not supported on the apple backend yet` and `  hint: run pi sandbox migrate --to colima, or remove services from the config`, and `pi sandbox status` prints a `gap:` line. A new `BackendCapabilities.services` drives both, so nothing branches on the backend name. The Apple work is a follow-up once the DNS and multi-network questions have answers; if DNS cannot resolve names, the fallback to evaluate is a launcher-written hosts file in a read-only directory mount, since Apple has no single-file mounts.

## Threat model changes

New row in THREAT-MODEL.md section 4:

| feature | what it weakens | mitigation |
| --- | --- | --- |
| Sidecar services | Configured images run on the developer's engine next to the sandbox, with CPU, memory and disk in the VM; a hostile image can answer the test code and pi's tools with crafted data; service passwords are readable inside. | Only policy, org and user define services freely; a project file needs `allowProject` from above, an image on the allowlist set above and a digest. Services sit on their own internal network with no relay, no proxy variables, no host mapping, no published port, no host mounts, no privileges and a pids limit; resources are capped per service. Env values are plain strings and cannot carry a placeholder or a host secret. Service passwords are documented as test values. |

New known gaps: Apple has no services yet; image pulls for services send no registry credentials; a service's image is trusted as much as the layer that named it.

## Alternatives considered

| alternative | why not |
| --- | --- |
| Relay from the sandbox to the developer's own services (`host.docker.internal:5432`) | A hole from the sandbox to host ports. The proxy's private-range deny exists to stop exactly that, and the database on the host is usually the developer's real one, with real data. |
| Engine socket in the sandbox, so Testcontainers works | The socket is root on the engine, and the Colima VM mounts the whole home writable. The agent could start a container that mounts `$HOME`. A filtering socket proxy is a large attack surface for one library. |
| Testcontainers against a launcher-side API | Testcontainers speaks the Docker API, so this is the socket proxy again. |
| Services inside the sandbox container | Works today without code (README.md, Interim). Fiddly on a read-only root, the data lives in tmpfs and counts against the sandbox's memory, and every repository repeats the recipe. Kept as the documented interim. |
| Services on the existing repository network | Puts them next to the relay; see Networking. |

## Implementation outline

| folder | change |
| --- | --- |
| `config/` | `services` in `types.ts` and `defaults.ts`; key spec and the placeholder and name checks in `validate.ts`; the three control keys in `projectKeyRefusal`; the conditional project check, the allowlist lock and the per-name merge in `merge.ts`; image reference normalisation and pattern match in a new `service-image.ts`; `schema/sandbox-config.schema.json` and its key-set test. |
| `backend/` | `types.ts`: `ServiceSpec` (name, image, env, command, mounts, network, alias, resources, labels), `networks` on `ContainerSpec`, `BackendCapabilities.services`. New methods: `ensureServiceNetwork(repoHash)`, `createService(spec)`, `containerLogs(id, { tail, follow }, io)`. `removeContainer` gains `{ volumes: true }`. `labels.ts`: `service`, `serviceHash`. `managed-network.ts`: the services network name and its prune pattern. `docker-engine/`: `HostConfig` with `SecurityOpt: ["no-new-privileges"]`, `PidsLimit`, `NanoCpus`, `Memory`, `EndpointsConfig.<net>.Aliases`, `DELETE ?v=true`, `GET /containers/{id}/logs` with frame demux (reuse `exec-session.ts`). `apple/`: `services: false` and the refusal. |
| `container/` | New `services.ts`: `buildServiceSpec`, `ensureServices`, `waitForServices`, `removeRepoServices`. `lifecycle.ts`: skip services in the agent lookups, call `removeRepoServices` from the idle stop and `collectGarbage`. `spec.ts`: the extra network, `NO_PROXY` and `no_proxy` from the service names, the service volumes in `repoVolumes`. `names.ts`: service container and volume names. |
| `image/` | Nothing. Service pulls go through `backend.pullImage` from `container/services.ts` or a small `image/service-images.ts`. |
| `cli/` | `launch.ts`: the pulls beside step 10, `ensureServices` in step 11, `waitForServices` before step 12, removal in `onLast`. New `commands/services.ts` and its help text; `status.ts`, `reset.ts`, `gc.ts`, `doctor.ts` lines. |
| docs | `launcher/README.md` (config keys, layer rules, the CLI, the secrets rule, the interim recipe moved to a "without services" note), `ARCHITECTURE.md` (pipeline steps 10 to 13, the backend contract, the networks section), `STRUCTURE.md`, `THREAT-MODEL.md`, `examples/` with a user config that defines Postgres and Redis. |

Tests:

- Unit, with fakes: config validation and merge (project refused without `allowProject`, outside the allowlist, without a digest; user refused outside a policy allowlist; placeholder in env refused; host-source keys refused; reserved names), service spec rendering and hash stability, `NO_PROXY` from names, lifecycle on the fake backend (create, reuse, changed while another session is live, removal at the last session, abort during preparation), readiness (healthcheck exec, TCP probe, timeout message, exited service), gc and reset with services and named volumes, `findRepoContainer` ignoring services.
- Engine fake: the create body (no `ExtraHosts`, internal network only, alias, security options, limits), logs demux, `v=true` on removal, network pruning with services attached.
- Conformance suite: services create, exec and remove on the docker-engine adapter; the Apple adapter reports `services: false`.
- One live suite, `tests/live/services.live.test.ts` (`PI_SANDBOX_LIVE=1`, docker engine): a Postgres and a Redis service; from the sandbox, `pg_isready -h postgres` and `nc -z redis 6379` succeed; from a service, the relay address, `host.docker.internal`, `host.lima.internal` and an external name all fail; nothing is published (`GET /containers/{id}/json` has no `Ports` bindings); the services are gone after the session ends.

Size: about 1,500 lines of code and 1,200 lines of tests, plus docs. Config and the lifecycle are the bulk; the CLI is small. The Apple follow-up is separate and depends on what the DNS check finds.

## Acceptance checks

- [ ] With a user-config `postgres` service, `pi -p "run the test suite"` in a repository whose tests use `postgres:5432` passes, and `pi sandbox services status` shows it ready.
- [ ] A project-defined service is refused without `allowProject`, outside `allowImages` and without a digest, each with a message naming the locking layer.
- [ ] From a service container, the relay, the proxy port, the host aliases and the internet are unreachable (live test).
- [ ] `curl http://<service>:<port>` from the sandbox reaches the service, not the proxy.
- [ ] After the last session, no service container remains; `reset --volumes` removes named service volumes; `gc` removes services and networks of ended repositories.
- [ ] On Apple, a config with services refuses with the hint, and `status` prints the gap.
- [ ] `npm run check` green; launcher README, ARCHITECTURE, STRUCTURE and THREAT-MODEL updated.
