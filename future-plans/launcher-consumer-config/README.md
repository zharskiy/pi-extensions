# Launcher: services, mounts and consumer-supplied setup

Status: built, not merged; all six phases are done, and a seventh made the services, network, relay, proxy, token, launch registry and grants one per install instead of one per repository (an install is one launcher state dir, named by its install id, a short hash of the state dir), and dropped repo-scope volumes. Not yet run end to end on a real machine (a `pi sandbox doctor` and sessions with services in two folders). This file is the working spec for the refactor; once the change is merged, the launcher docs carry the result and this folder is removed from the index.

## Why

A consumer runs `pi-sandbox` company-wide over three repo families (a Maven monorepo that needs PostgreSQL, a pooler and Redis on localhost; about eighty pnpm repos; about seventy legacy Dart repos with a plain-HTTP package host). Their agents must run the repos' own lint and test commands inside the container, many sessions a day, with nothing done on the host. One session may span several of these stacks at once, so there is one config that holds everything and no per-project variant.

The launcher stays abstract: it knows no service, toolchain, package manager or host by name. Everything specific arrives through the one config file. Where a need can be met by composing two generic features, no third feature is added.

## What each need maps to

| Need | Mechanism | Where |
|---|---|---|
| Several stacks in one session | one config holds everything; nothing is selected per project | launcher |
| PostgreSQL, pooler, Redis on localhost, shared by every session, data kept | per-install `services` with declared `ports`, forwarded to each agent's `localhost`; named volumes | launcher |
| pi starts only when services answer | `services[].ready` | launcher |
| One-time DB bootstrap, cache seeding, rendering config files | `setup` commands, run before pi; the consumer's script makes them idempotent | launcher runs, consumer writes |
| Files at fixed absolute paths (`/etc/<app>/`) | `mounts.binds` (read-only host folder) or a `mounts.volumes` entry at that path filled by `setup` | launcher |
| Persistent caches (`~/.m2/wrapper`, pnpm store, pub cache) | `mounts.volumes` | launcher |
| Seeding a cache from the host | a read-only `mounts.binds` entry plus a `setup` copy | consumer recipe |
| Several JDK, Node, pnpm, Dart versions, selected per repo | consumer image and shims that read each repo's version files when a command runs; `env.set` for what is the same everywhere | consumer |
| Trust for every JDK, not only the one on `PATH` | image layer imports the CAs into every JDK found | launcher |
| `Picked up JAVA_TOOL_OPTIONS` noise and the proxy token in transcripts | the token leaves the container; `JAVA_TOOL_OPTIONS` is no longer set | launcher |
| Git dependencies written as `ssh://git@host` | image-level `insteadOf` rewrite to HTTPS plus a credential rule | consumer recipe |
| Open files, pids, shm, memory | `resources.openFiles`, `resources.pids`, `resources.shmMiB`, existing `resources.memoryGiB` | launcher |
| Headless Chromium | consumer image package, `env.set`, `resources.shmMiB` | consumer |
| What is running, how to read refusals | a status file in the container; the proxy's deny log readable from inside | launcher |
| Maven `target/` shared with the host | documented trade-off, no overlay (hundreds of modules exceed the overlay limit and `mvn clean` fails on a mount point) | docs |

## Config model

One file, as today. New and changed keys only:

```jsonc
{
  "env": {
    "allow": ["TERM"],
    "set": { "CI": "1" }                      // literal values, no expansion
  },
  "resources": {
    "cpus": 4, "memoryGiB": 8,
    "pids": 8192,                              // default 4096
    "openFiles": 65536,                        // nofile soft and hard; default: the engine's
    "shmMiB": 1024                             // /dev/shm; default: the engine's 64
  },
  "mounts": {
    "volumes": [                               // replaces mounts.sharedCaches
      "~/.m2/repository",                      // shorthand: same volume as before the rename
      { "target": "~/.m2/wrapper" },
      { "target": "/etc/app" },
      { "target": "/var/log/services", "name": "service-logs" }
    ],
    "binds": [                                 // read-only host folders
      { "source": "~/company/sandbox", "target": "/opt/company" }
    ],
    "autoOverlays": true
  },
  "services": [
    {
      "name": "postgres",
      "image": "postgres:15",                  // optional; default: the sandbox image
      "command": ["postgres", "-c", "fsync=off", "-c", "listen_addresses=*"],
      "ports": [5432],                         // forwarded to localhost in every agent container
      "user": "999:999",                       // default 1000:1000
      "env": { "PGDATA": "/var/lib/postgresql/data/pgdata" },
      "volumes": [{ "name": "pgdata", "target": "/var/lib/postgresql/data" }],
      "tmpfs": ["/var/run/postgresql"],
      "ready": { "command": ["pg_isready", "-h", "127.0.0.1"], "timeoutSeconds": 60 },
      "memoryGiB": 2,
      "shmMiB": 256
    }
  ],
  "setup": [["/opt/company/bootstrap.sh"]],    // argv lists, run in order before pi
  "egress": {
    "allow": ["registry.example.internal", "pub.example.internal"]
  }
}
```

Rules:

- **Repo.** Where something below is still per repo (the overlays, the agent home volume, the preparation lock), it uses the launcher's existing key: the git root that contains the launch folder, or the launch folder itself when it is not inside a repository. **Install** means one launcher state dir in the one sandbox VM, named by its install id (a short hash of the state dir); several installs can share the VM.
- **Env.** `env.set` values are literal. A name the launcher sets itself is refused at validation; a name that is also in `env.allow` takes the `env.set` value.
- **Volumes.** Every entry, a string or an object, is one volume shared by every repo, named as `sharedCaches` named it, so existing volumes are found. There is no `scope` (a per-repo scope was built and then removed in phase 7). `name` makes the identity the name instead of the target path; a service volume and a `mounts.volumes` entry with the same `name` are the same volume. Targets may be anywhere outside launcher-owned paths, not only under home: never inside or above `/usr/local`, `/opt/pi-sandbox` or `/etc/ssl`, never `/home/pi` or `/tmp` themselves or a folder above them, never a private home path (`~/.pi`, `~/.ssh` and the rest), and no two mounts nested or at the same target.
- **Binds.** Read-only. The source must exist and passes the two existing host-side checks (private home paths, workspace-root rules), checked before the Engine is called. It must be visible in the VM: a source inside an existing share needs no new share; any other source becomes a read-only share, and a source that holds another share is refused, as colima refuses nested shares. A new share restarts the VM, which waits until no other session runs. The target is absolute and outside launcher-owned paths.
- **Services.** One set per install, shared by every session in every folder. Start in list order, each ready before the next; they stop in parallel, 30 s each. `ports` lists the TCP ports the launcher forwards to `localhost` in every agent container; a service must listen on a non-loopback address for the forwarder to reach it. They run confined more tightly than the agent container: no capabilities at all (the agent keeps `CHOWN` for its hand-over exec), no new privileges, read-only root, an init, a numeric user other than uid 0 or gid 0, 4096 processes, writable only `/tmp` and their `tmpfs` paths (mode 1777) and their volumes. They get no workspace, no home, no render folder, no credentials and none of the forwarded environment, only their own `env`. The command replaces the image's entrypoint. Volumes are per install, and two services that mount one volume must use the same user. Paths are absolute, normalised, not `/` and apart from each other; the agent's reserved paths do not apply to services. The agent's memory plus every service's `memoryGiB` must fit the VM, checked where `resources` is checked today.
- **Setup.** Runs in the agent container as pi, with pi's environment, no stdin and the repo as working directory, after the services are ready and the volumes are handed over, on every launch; output goes to the terminal; a non-zero exit aborts the launch. Serialised per repo by the preparation lock, so a second session of the folder waits for the first one's bootstrap instead of repeating it. An interrupted setup leaves whatever it wrote, so a consumer script writes its done-marker last.
- `mounts.sharedCaches` is rejected with a message naming `mounts.volumes`.

## Design

### Image: trust is baked, not assembled at start

Today the base image holds the proxy CA, extra CAs are trusted only during the build, a bundle is mounted at run time, the entrypoint builds a JVM truststore for the `java` on `PATH`, and `JAVA_TOOL_OPTIONS` points every JVM at it. A pulled pinned image has none of it in its system store.

After:

- A local layer is always built, also over a pinned base. Its build context carries the proxy CA, the `tls.extraCa` certificates, the trust script and the relay script, so none of them has to exist in the base.
- First step: the CAs go into the system store (which also gives the hashed `/etc/ssl/certs/<hash>.0` links that tools ignoring `SSL_CERT_FILE` need). Then packages, npm globals and the user Dockerfile lines as today. Last step: the trust script finds every JDK in the image and, for each, imports the CAs into its `cacerts` and writes the proxy host, port and non-proxy hosts into its `net.properties`.
- The trust script stays in the image at a fixed path and takes a JDK path, so a `setup` command can trust a JDK that lives in a volume.
- The layer tag hashes the Dockerfile text and every context file. Today it hashes the text only, so a changed certificate does not rebuild. The "layer exists" shortcut goes.
- The base image no longer contains the proxy CA.
- Removed: the run-time CA bundle mount, the entrypoint's bundle and truststore steps, the truststore flags in `JAVA_TOOL_OPTIONS` (set in the container spec and appended in `bash-env.sh`), `PI_SANDBOX_TRUST_HASH`. CA variables point at the system bundle.
- Gradle needs nothing of its own: client, daemon and wrapper download all follow the JDK's `net.properties`. Maven keeps its rendered `settings.xml` proxy entry (Maven reads nothing else).

### Network identity: the token leaves the container

Today every client inside must present the proxy token (`Proxy-Authorization`, or `Authorization` on a `CONNECT`), so the token sits in six proxy URLs, `JAVA_TOOL_OPTIONS`, the rendered Maven settings and an env variable, and every tool that cannot send proxy credentials needs its own workaround.

The token only ever protected the host-side listener from other host processes; everything on the internal network holds it anyway. So the relay presents it instead:

- The relay (before this work, a per-repo `socat`) becomes one Node script for the install, in the container `pi-sandbox-relay-<install id>`, passed as the relay container's command (`node -e`) from the launcher's own source, so the script that runs is always the running launcher's and never one left in an image. For each connection it opens the upstream connection, writes one preamble line carrying the token, then pipes both ways. The token reaches it in an environment variable the script deletes at start; the variable stays in the container's config, so an engine inspect shows it. The relay container carries a label with a hash of the preamble, the host port, the subnet and the script, so a changed token, port, subnet or script replaces the relay.
- The host proxy reads and checks that line (bounded length, short timeout, constant-time compare) on the raw socket before handing the socket to its HTTP server. Host-side callers (`doctor`, the deny-log reader) send the same line.
- Removed: the `Proxy-Authorization` and `Authorization` checks, the 407 path, the token in every container variable, the credentials in the rendered Maven settings, the rest of `JAVA_TOOL_OPTIONS`.
- Inside the container the proxy is just `http://pi-sandbox-proxy:3128`. The proxy's own name joins `NO_PROXY`, `no_proxy` and the JDK non-proxy hosts, so `/healthz` and `/denials` answer a direct request from inside. No route becomes reachable from inside that the token did not already open.
- An internal network's gateway address is the VM itself, and the VM's sshd answers on it. The install's network, `pi-sandbox-network-<install id>`, is created `Internal`, with `EnableIPv6: false`, `"Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}`, the launcher's managed and install labels and no IPAM settings, so the bridge gets no gateway address at all. The option needs Docker Engine 28 or later; the launcher reads the engine version before it creates the network and fails with a message to update colima and recreate the VM otherwise. An existing network of that name without the launcher's managed label fails the launch; one with it is used as it is. The relay, the network, the proxy and its token are removed when no session of the install runs.

### Mounts and setup

- `mounts.volumes` entries are per install and never pruned, as `sharedCaches` were. Service data volumes are removed by `pi sandbox reset --services` (only those the current config names) and by uninstall.
- The volume hand-over waits for every path it owns, also outside home.
- Bind sources join the VM shares read-only, in both places shares are computed.
- `setup` runs after the agent container is up and its volumes are handed over, and before the agent files are synced and pi starts, with the user, environment and working directory pi gets. It runs inside the repo's preparation lock; see the locks below.
- `doctor`'s probe container skips binds, services and setup.

### Services: one set per install, forwarded to localhost

Tests hard-code `localhost`, and every session must share one instance of each service. Phase 5 put the services and the agents of one repo in one network namespace. Phase 7 replaced that with one set for the install and a forwarder in each agent.

- When the config declares services, the install gets a **pod**, `pi-sandbox-pod-<install id>`: a holder container on the install's network, with the alias `pi-sandbox-services`, that owns the services' network namespace and outlives single launches. Services join it (`NetworkMode: container:<pod>`). Agent containers do not: each keeps its own namespace on the install's network.
- Each agent container runs a small Node forwarder that listens on `127.0.0.1` and `::1` on every declared port and forwards to `pi-sandbox-services:<port>`. So a service must listen on a non-loopback address. It has no upstream timeout and no IPv6 fallback.
- Every launcher container carries a role label (agent, relay, pod, service). One predicate answers "is this a session", and every listing uses it: status, doctor, the sweep, uninstall, host sessions, the busy count.
- Two kinds of lock. The install's **ground lock** (`<state>/locks/ground.lock`, no timeout, a visible message while waiting) covers the relay, the network, the proxy and its token, and bringing up the pod and services; it also covers their removal. The registry lock (`<state>/locks/launches.lock`) is a leaf under both. The per-repo **preparation lock** covers creating the agent container, handing its volumes over and running `setup`, so a second session of the same folder waits for the first one's bootstrap. A dead holder's lock is taken over.
- The services start with the first session that needs them and are stopped, with the pod, when no session of the install runs, under the ground lock and only when it is free. `stop`, `reset --services` and uninstall stop them too. The stop gives every service 30 s, in parallel, then removes the pod.
- The pod mounts the service volumes and hands their roots to each service's user with the same root `chown` exec the agent's volume hand-over uses. No helper containers.
- The pod carries a hash of the sandbox image and the resolved services list. A running pod with the same hash keeps its running services and gets the missing or exited ones created anew. A changed services config while other sessions are live keeps the running set and prints a notice; with none live, everything is stopped and started afresh.
- Readiness is an exec of `ready.command` as the service user, without a TTY and with its output discarded, about every 500 ms. A service that exits first, or is not ready in time, fails the launch with the last 40 lines of its log and a hint naming `services[<i>]`; Ctrl-C aborts the wait. After a failure the services are stopped unless another session is live. A foreign image is pulled by the VM's engine, not through the proxy.
- After a VM restart the pod and services are stopped; the next launch brings them up.
- A pod that is not running is replaced, and its services are created anew with it: a container that joined the old namespace cannot be restarted into the new one. Service containers are therefore always created, never restarted.
- Consequences to document: every session in every folder reaches every service port, and any port of another session's container, over the install's network; declared services start with the first session, also one that does not need them (a start costs seconds, their idle memory stays in use); service data is shared by every folder until `reset --services`; services sit on the install's network and can reach the relay, so their egress is the same policy as the agents'; a service without `memoryGiB` is not counted against the VM.
- The launcher guarantees one instance per data volume: service volumes are mounted by the install's one service set only. The agent's hand-over leaves service volumes alone.
- The pod runs `sleep infinity` as 65534:65534 with a read-only root, an init and 64 processes; its one root exec (`chown -h <uid:gid>`, one per service user) hands the volume roots over. `pi sandbox status` lists each service with its state; the doctor's probe starts none.

### One proxy, token, grant list and launch registry per install

Phase 7 also made the host side one per launcher state dir: one proxy process, one token at `<state>/proxy/token`, one denial log, one `grants.json` and one launch registry. Every session in every folder shares them. Each launch writes its egress allow and deny settings, which the running proxy applies at once, so the latest launch sets the egress of every live session; it prints a notice when others are live. Changed credential, parent proxy or CA settings keep the running proxy while other sessions are live, with a notice, and apply once they all exit. `pi sandbox egress allow` grants a host to every folder, and `--user` is gone. Two state dirs used at once are two installs: each has its own relay, network, pod, services, proxy and token, named and labelled by its install id, and neither lists, changes or removes the other's.

### Status for the agent

A JSON file in the read-only render folder, `tools/status.json`, path in `PI_SANDBOX_STATUS` (`/opt/pi-sandbox/render/tools/status.json`): `version`, `proxy` (`url`, `denials`, `health`), `resources`, `volumes` and `binds` (guest targets only), `setup` and `services` (`{ name, command, ports, ready? }`). The file holds only what the config says, nothing per launch, and every session sees the same one.

## Breaking changes

- `mounts.sharedCaches` → `mounts.volumes` (string entries keep their volumes).
- `JAVA_TOOL_OPTIONS` is no longer set. JVMs get proxy and trust from their own configuration files. Recorded in `REMOVED-DEFAULTS.md` with the `env.set` line that restores it.
- `PI_SANDBOX_PROXY_TOKEN` and credentials in proxy URLs are gone; a consumer script that read them stops working.
- A pinned image now gets a local layer on top.
- Every proxy, network and grant list was per folder; there is one of each per install. Grants made in one folder apply to every folder, `egress allow --user` is refused, and grants from before the change are not read.

## Phases

Each phase is one change set that passes `npm run check` with the launcher and root docs updated as `AGENTS.md` requires.

1. **Config surface.** `env.set`, `resources.pids`, `resources.openFiles`, `resources.shmMiB`. A map type in the validator, types, schema, defaults, container body.
2. **Image trust.** Always-on layer with its scripts in the build context, baked system and JDK trust, tag hash over the context, run-time bundle and truststore flags removed, base without the proxy CA.
3. **Proxy identity.** Node relay with preamble and token label, host-side check and client, token removed from the container and the Maven settings, `JAVA_TOOL_OPTIONS` gone, the proxy's name in the no-proxy lists, the isolated gateway.
4. **Mounts and setup.** `mounts.volumes` with names and labels, `mounts.binds` with VM shares, hand-over for targets outside home, the preparation lock, `setup`, the `doctor` skip.
5. **Services.** Role label and session predicate, pod, services, readiness, stop, sweep, reset and uninstall, the VM memory sum, the status file.
6. **Docs.** `CONFIGURATION.md`, `README.md`, `ARCHITECTURE.md`, `THREAT-MODEL.md`, `REMOVED-DEFAULTS.md` read as one; a generic `examples/` config showing services, volumes and setup; recipes for seeding, SSH-written git dependencies and logs.
7. **Per install.** One network, relay, proxy, token, launch registry and grant list per install; volumes without `scope`; one service set in one pod with declared `ports` and a loopback forwarder in each agent; the ground lock; `reset --services`.

## Not in this work

- Plain HTTP. The proxy keeps refusing plain requests and port 80; a package server must be served over HTTPS, and a tool is pointed at it with an HTTPS URL set through `env.set`.
- Profiles or any per-project config. A session may span every stack, so one config applies everywhere; a `setup` script that has nothing to do in a folder exits early.
- Config files inside repos. A repo is what the agent edits; letting it widen its own sandbox needs an approval design of its own.
- Toolchain managers in the launcher. Selection is the consumer's image and scripts.
- An overlay for Maven `target/`.
- The setup wizard, the prompt UI and `doctor` beyond what the phases touch.
- Generating the JSON schema from the validator. The parity test already catches drift, and the schema's descriptions are written for editors.

## Evidence

Measured on the `pi-sandbox` VM with throwaway containers; notes are not kept in the repo.

- Sidecars joined to another container's network namespace run under the full confinement; a namespace owner that is removed takes the namespace with it, so the owner must be a holder that outlives launches. PostgreSQL does not refuse a second instance on the same volume from another container.
- `JAVA_TOOL_OPTIONS` cannot be silenced and an options file does not work on JDK 8. `net.properties` proxy settings work on JDK 8 to 21. The only trust source a JDK reads without an option is its own `cacerts`; one file with the CA imported is readable by JDK 8 to 21.
- Maven 3.9 reads its proxy only from `settings.xml`. Gradle 8 and 9 (client, daemon, wrapper) follow the JDK's `net.properties` and ignore `HTTPS_PROXY`.
- npm 11 and pnpm 6, 8, 9 and 10 install git dependencies written as `git+ssh://git@host/…`, `git+ssh://git@host:…` and (pnpm only) `ssh://git@host/…` over HTTPS with no ssh binary when the system git config rewrites both `ssh://git@host/` and `git@host:` to `https://host/`; a user git config does not cancel the rewrite.
- Dart 2.13 `pub` uses `http_proxy` with absolute-URI requests for a plain-HTTP host, ignores `SSL_CERT_FILE` and a CA appended to the bundle, and trusts a hashed certificate in `/etc/ssl/certs`.
- A container that joins a pod's namespace resolves the proxy's network alias, has no route out other than the relay, and accepts the full confinement plus memory, pids, open-files and shm limits; the engine refuses hostname, DNS and port options on it. Two joiners share `localhost` and ports. A restarted or replaced pod leaves earlier joiners in a dead namespace, and they cannot be started again.
- A relay that writes one preamble line before piping passes keep-alive, pipelining, half-close and a 1 GiB stream at the speed of `socat`; `socat`'s default listen backlog of 5 drops connections under a burst, Node's does not. On the proxy side the bytes that arrive with the preamble must be handed on and half-open sockets allowed.
- `Ulimits`, `PidsLimit` and `ShmSize` set at create apply to processes started with exec. Open files above 1048576 (the VM's `fs.nr_open`) fail at container start.
- The gateway address of an internal network is the VM: its port 22 accepts a connection from a container. A network created with only `Internal` and the isolated gateway option (engine 29.5) has no IPAM gateway; from a container under the full confinement, a connect to its `.1` port 22 is refused, while the same probe on an internal network without the option connects.
- The shipped Node relay on that network, with the host side behind the preamble check on `127.0.0.1`, answered a request to `pi-sandbox-proxy:3128` and 2000 concurrent connections without losing one (about 0.3 s); the agent-like container's environment held no token, and the relay's held it once.
