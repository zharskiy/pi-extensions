# NVIDIA OpenShell fact sheet

Research date 2026-10-20, web only. Some docs pages were read through a summariser, so quote exact wording from the sources. Name: github.com/NVIDIA/OpenShell; the PyPI package `openshell` is its CLI; `theswerd/openshell` is a fork.

## What it is

- Apache-2.0 runtime for autonomous agents. The agent declares what it may access in a policy and OpenShell enforces it from outside the agent. https://github.com/NVIDIA/OpenShell, https://developer.nvidia.com/blog/add-runtime-controls-to-ai-agents-with-nvidia-openshell/
- The runtime layer of NVIDIA's Open Agent Safety Platform, released around GTC 2026, previewed with Canonical for Ubuntu in June 2026. https://en.wikipedia.org/wiki/Nvidia_OpenShell
- Components (https://docs.nvidia.com/openshell/latest/about/architecture): the gateway is the control plane (auth, sandbox lifecycle, policy delivery, provider attachment); the supervisor is the trusted side (checks requests against policy, injects credentials, resolves DNS, opens approved connections); the sandbox runs the agent as a child process and makes no policy decisions; a compute driver creates the sandbox; `openshell-prover` formally checks policy changes.
- Isolation on Linux: non-root workload with no capabilities, Landlock for the filesystem, seccomp user-notify staging network operations, an outer fence denying all egress except the supervisor channel. Runtimes: Docker and Podman (separate supervisor container, networking disabled on the workload), Kubernetes (separate supervisor pod, mTLS, NetworkPolicy), MicroVM (libkrun, supervisor as a host process over vsock, no network device in the guest; Hypervisor.framework on macOS, KVM on Linux). The VM driver is experimental, first boot 10-30 s. https://github.com/NVIDIA/OpenShell/blob/main/crates/openshell-driver-vm/README.md
- A sandbox is a container image (`--from`), attached providers and a YAML policy compiled to OPA/Rego and evaluated per outbound request. The default image `nvcr.io/nvidia/base/ubuntu:24.04` has no agent CLIs. https://docs.nvidia.com/openshell/latest/about/support-matrix
- Lifecycle: Provisioning, Ready, Stopping, Stopped, Starting, Completed, Error, Deleting. `sandbox create --from <image> -- <cmd>` makes the command the main process; `--detach`, `--no-keep`, `--restart-policy`; `stop` and `start` keep policy and workspace; `delete` purges injected credentials. https://docs.nvidia.com/openshell/latest/how-it-works/sandboxes/overview.md
- CLI: `openshell sandbox create | connect | exec [--tty] | upload | download | stop | start | delete | ssh-config`, `forward start`, `logs`, `policy get`, `rule get`, `provider create`, `gateway info`. Written mainly in Rust.

## Platforms

Source: https://docs.nvidia.com/openshell/latest/about/support-matrix

- Supported: Linux Debian/Ubuntu x86_64 and arm64; macOS Apple Silicon via Docker Desktop. Experimental: Windows via WSL 2 plus Docker Desktop. Intel Macs and Podman on macOS are not listed.
- Prerequisites: Docker 28+ or Podman 5.x; Kubernetes 1.29+ with Helm 3 (the Helm chart is marked experimental, not for production; the CNI must enforce NetworkPolicy); or host virtualisation for MicroVM.
- Linux kernel: Landlock ABI 3 (6.2+) and seccomp user-notify; fails closed without them.
- No cloud account needed; a local gateway works.
- macOS: no Lima, Colima or Apple `container` support. Issue #3956 asks for native macOS process sandboxes on managed Macs; none exist. Issue #1809 (old v0.0.40, closed) reported an M1 hang.

## Policy model

- Layers (https://docs.nvidia.com/openshell/latest/about/overview): filesystem (Landlock, locked at creation), process (seccomp, unprivileged user, locked at creation), network (hot-reloadable), provider credentials (attach, rotate, revoke at runtime).
- Network: deny-by-default egress; rules scoped by host, port, binary and, for L7, HTTP method and path; GraphQL and MCP inspection. Caveats (https://docs.nvidia.com/openshell/latest/security/best-practices.md): L7 mode defaults to `audit`, which logs and forwards; endpoints without `protocol` get no request rules; approved endpoints persist for the sandbox's life; binary identity is pinned by SHA256 on first use.
- Secrets (https://docs.nvidia.com/openshell/latest/how-it-works/inference.md): the workload sees an opaque placeholder; the proxy substitutes the real key after network policy and provider binding pass; credentials are never exported; deletion purges them. `tls: skip` disables rewriting for that endpoint; a running process does not see newly attached providers; output is not scrubbed, so stack traces can leak.
- Inference: no central router in current docs; the workload calls the provider's native API and OpenShell gates and injects. The older `inference.local` route is retired. Bedrock needs a custom profile.
- Audit: OCSF events, JSONL gateway audit (v0.1.3), OTLP export (v0.1.5). Logs are per sandbox, no fleet-wide record. https://github.com/NVIDIA/OpenShell/releases
- Policy advisor: an agent proposes a narrow policy change, a human approves.

## Running agents

- Interactive TUI works: `openshell sandbox create --name pi --from pi-agent:local --provider openrouter -- pi` attaches pi's TUI. https://docs.nvidia.com/openshell/latest/tutorials/run-pi-with-openrouter.md Pi's session dir goes to `/tmp` via `PI_CODING_AGENT_DIR`.
- `sandbox connect` reattaches (Ctrl-P Ctrl-Q detaches, 1 MiB replay, one stdin owner); `sandbox exec --tty` gives a separate shell.
- Files: `--upload .:/workspace`, `sandbox upload` and `download`. No host bind mount, except virtiofs for MicroVMs added in v0.1.5.
- Many sandboxes per gateway by design; SDKs create, exec and delete them.
- TypeScript SDK `@nvidia/openshell-sdk` (Node 20.3+), GitHub Packages only, needs a `read:packages` token; public npm publishing closed as not planned (https://github.com/NVIDIA/OpenShell/issues/2952); community mirror https://github.com/openkaiden/openshell-sdk-mirror-npmjs. API: `client.sandbox.create / waitReady / exec / delete`, `watchLogs`, raw gRPC client at `/raw`; auth by OIDC, client credentials or operator mTLS. Streaming and interactive exec are mentioned without signatures. https://docs.nvidia.com/openshell/latest/sdk/typescript.md gRPC reflection since v0.1.4; Go SDK broke in v0.1.5.
- Prior art: https://github.com/himorishige/pi-openshell-subagent (MIT) runs each pi subagent in its own OpenShell sandbox: create, wait for providers, exec `pi --mode json -p --no-session`, stream JSON events, delete; up to 8 tasks, 4 at a time; needs pi 0.87+ and a 0.1.0 gateway; no bind mounts; subagents see only the task text; providers take seconds after READY. Five commits, nothing about macOS.
- Agents named by NVIDIA: Claude Code, OpenCode, Codex, GitHub Copilot CLI, Pi, Hermes, Cursor. Pi is a "Community" tier image (`--from pi`). Integration is image-based: bake the agent into an image and attach a provider profile.

## Licence, governance, maturity

- Apache-2.0. About 16.7k stars, 1.8k forks, 376 open issues, 1,817 commits, last commit a day before 2026-10-19.
- Releases: v0.1.5 (20 Oct), v0.1.4 (13 Oct), v0.1.3 (9 Oct), v0.1.0 (25 Sep), v0.0.116 (28 Aug). v0.1.5 has breaking changes (OCSF `.jsonl`, Helm label allowlists, Go SDK).
- NVIDIA calls it alpha, "proof of life", "single-player". Adopters named: Cadence, Slack, Gecko Robotics.
- No NVIDIA AI Enterprise tier or commercial support found. Security reports to NVIDIA PSIRT, no bug bounty. Anonymous telemetry on by default; `OPENSHELL_TELEMETRY_ENABLED=false` disables it.

## Limitations and criticism

- CVE-2026-65093 and CVE-2026-65083 (CVSS 9.9, sandbox escape and interference with sandbox creation), reported 2026-08-27 with fixes released; affected versions unstated; GitHub shows no published advisory. https://modernizingtech.com/news/nvidia-openshell-flaws-put-ai-agent-sandboxes-at-risk/, https://nvidia.custhelp.com/app/answers/detail/a_id/5872
- Red Hat: supervisor and proxy share a kernel with the workload, "no coverage" for kernel exploits or container escapes; run on Kata underneath. https://developers.redhat.com/articles/2026/07/16/layered-sandboxing-ai-agents-openshift-and-openshell
- Independent test on an M1 with v0.1.2 and the VM driver (https://sorami.com.au/research/nvidia-openshell-agent-sandbox-test/): default-deny held; leaks came from operator settings (read-write rules, audit mode as the default when `enforcement` is omitted, auto-approval of new public hosts); GraphQL, MCP, WebSocket and JSON-RPC rules returned `unsupported` yet loaded silently; DNS-denial and Landlock events missing from `openshell logs` on macOS; OCSF export failed on `/var/log`; the Docker driver could not start sandboxes on that host.
- Tigera: no cross-sandbox, agent-identity or agent-to-agent governance; local-only audit. NVIDIA: multi-agent policy analysis still in development; filesystem or process changes need a new sandbox.

## Fit

- Solo developer on macOS: workable but rough. Apple Silicon through Docker Desktop, custom pi image, writable settings under `/tmp`, upload and download instead of a live mount, weekly breaking changes, one report of unreliable macOS drivers.
- Enterprise: promising design (policy as YAML, prover, OCSF and OTLP audit, OIDC and mTLS, Kubernetes), but alpha, experimental Helm chart, two critical CVEs, shared kernel, no verified support or SLA, telemetry on by default, defaults (`audit`, auto-approval) need hardening. A pilot, not yet a compliance control.
- One sandbox per subagent from Node: conceptually good and already done by the community extension. SDK on GitHub Packages, pre-1.0 churn, no host mounts, seconds to ready, PTY and streaming signatures unconfirmed.
