# Sandbox services

> Status: planned, not implemented. Date: 2026-11-08. Branch the design was written against: `feat/sandbox-launcher`.

Question: how a test suite inside the pi sandbox reaches the Postgres, Redis or similar it needs, without giving the sandbox a path to the host.

- README.md (this file): the problem, the decision and its open points.
- spec.md: config, layers, lifecycle, networking, CLI, the Apple gap, alternatives and the implementation outline.

## The problem

The sandbox container sits on its repository's internal network. Its only hop out is the socat relay to the host proxy, and the proxy refuses loopback, private ranges and IP literals. So the developer's own `localhost:5432` is unreachable by design. No engine socket is mounted, so Testcontainers cannot start anything. Today a suite that needs a database either runs the server inside the sandbox container (read-only root, data under `/tmp`) or does not run.

## Decision

The launcher runs sidecar service containers next to the sandbox, one per entry of a new `services` config section.

- The host launcher pulls each image through the engine. The sandbox needs no egress for it.
- Each service sits on an internal network shared only with the repository's sandbox container. The sandbox reaches it by name (`postgres:5432`). Nothing is published to the host, and a service has no proxy, no relay and no route out.
- Services start with the sandbox and wait for readiness before pi starts. They go away when the last session of the repository ends, through the existing "alone in the repository" path. `gc` and `reset` clean them up with their repository.
- The user and policy layers define services freely. A project file may define them only when a layer above sets `services.allowProject`, and only for images on an allowlist set above it, pinned by digest.
- Service passwords are test values. They are visible inside the sandbox by design and must never be real credentials.

## Open points

| point | state |
| --- | --- |
| Apple `container`: name resolution between containers, more than one network per container, the sandbox runs with `--no-dns` today | to verify on a real host; services refuse on Apple until then (spec.md, Apple backend) |
| Separate services network instead of the repository network the relay sits on | recommended by the spec; it changes the owner's "same internal network" wording |
| Remove services at the last session end (fresh data every first launch) rather than only stop them | recommended by the spec; it refines the owner's "stop" |
| Private registries for service images | no registry credentials, as for the sandbox image (a known gap already) |

## Interim

Until this ships, run the server inside the sandbox: add it with `image.packages` (for example `postgresql`, `redis-server`), start it as the `pi` user with its data under `/tmp` (`initdb -D /tmp/pg`, `pg_ctl -D /tmp/pg -o "-k /tmp" start`, `redis-server --dir /tmp --daemonize yes`), and point the tests at `127.0.0.1`. `/tmp` is a tmpfs, so the data counts against the container's memory and is gone when the container stops. The launcher README should carry this recipe.
