# OpenShell: facts

Facts gathered on 2026-11-08 from a shallow clone of `github.com/NVIDIA/OpenShell` (HEAD of 2026-11-06), `gh api` and the launcher at commit 7cfa5d9. Paths without a prefix are relative to the OpenShell repository. Paths under `launcher/` are this repository. V marks a claim read at the source. I marks an inference from the sources. The assessment is in [README.md](README.md).

## Identity

- V: "Safe, private runtime for fleets of autonomous AI agents". Policy is declared, enforcement is in the kernel (Landlock, seccomp), and policy changes go through a formal prover (`README.md`).
- V: Components (`docs/about/architecture.mdx`): the `openshell` CLI; the gateway (`openshell-gateway`, control plane, gRPC, SQLite or Postgres); compute drivers (docker, podman, kubernetes, vm on libkrun, mxc on the `windows` branch, extension drivers over a Unix socket); a per-sandbox supervisor (policy, credential injection, DNS, upstream connections, TLS proxy); the in-sandbox runtime `openshell-sandbox`; the policy prover and the policy advisor; SDKs for Python, TypeScript, Go and Rust.
- V: Written in Rust, about 40 crates under `crates/`. Licence Apache-2.0 (`LICENSE`).
- V: 14 maintainers, 11 from NVIDIA and 3 from Red Hat (`MAINTAINERS.md`). Governance in `GOVERNANCE.md`, RFCs in `rfc/`.
- V: 21,268 stars, 2,081 forks, 637 open issues, last push 2026-11-07 (`gh api repos/NVIDIA/OpenShell`).
- V: Anonymous telemetry is on by default in the gateway. `OPENSHELL_TELEMETRY_ENABLED=false` turns it off (`README.md` L87).
- I: No other sandbox runtime for coding agents uses the name. Search results are NVIDIA OpenShell and projects built on it.

## Versions

- V: Repository created 2026-02-24. First listed release v0.0.6 (2026-03-16). v0.1.0 on 2026-09-25. Latest stable v0.1.7 on 2026-11-03 (`gh api releases`).
- V: Stable tags "generally go out every week". Nightly `X.Y.Z-pre.N` pre-releases and a rolling `dev`. Only the latest minor and N-1 are supported (`docs/about/support-matrix.mdx`).
- V: 0.1.0 removed the workspace-global managed inference route and the `openshell inference` commands. "Clients called a managed virtual endpoint, supplied a placeholder key and model, and relied on OpenShell to rewrite the request." (`docs/how-it-works/inference.mdx` L221-248, `docs/upgrade/0-1-0.mdx`).

## Host matrix

| Host | Status | Source |
|---|---|---|
| Linux Debian/Ubuntu amd64, arm64 | Supported | support-matrix.mdx L54-55 (V) |
| macOS Apple Silicon with Docker Desktop | Supported | support-matrix.mdx L56 (V) |
| Windows WSL 2 with Docker Desktop | Experimental | support-matrix.mdx L57 (V) |
| Native Windows (MXC) | `windows` branch only | support-matrix.mdx L58 (V) |
| Intel macOS | not listed | support-matrix.mdx (V) |
| Colima | not mentioned anywhere in docs, crates or install.sh | grep of the clone (V) |
| Apple `container` | no in-tree driver; directed to an out-of-tree extension driver | #566, #1887 (V) |

- V: Engines: Docker Desktop or Docker Engine >= 28.0 (support-matrix.mdx L142), Podman 5.x rootless, Kubernetes >= 1.29 with Helm, and the opt-in MicroVM driver (libkrun on Hypervisor.framework or KVM). Auto-detect order: Kubernetes, Podman, Docker.
- V: The Docker driver talks to the engine socket through its API, not the `docker` CLI (`crates/openshell-driver-docker/src/lib.rs`). Socket candidates: `DOCKER_HOST`, `/var/run/docker.sock`, `~/.docker/run/docker.sock`, `$XDG_RUNTIME_DIR/docker.sock`, or `socket_path` in gateway.toml (lib.rs about L871-882).
- V: Kernel needs: Landlock ABI >= 3 (Linux 6.2+), seccomp user notification with ADDFD, `process_vm_readv`, `SO_BINDTODEVICE`. Launch fails closed when one is missing. On macOS these run in the engine's VM (support-matrix.mdx).
- V: Install is `curl -LsSf .../install.sh | sh`. It uses Homebrew on macOS and deb, rpm or snap on Linux, and starts the gateway at `https://localhost:17670` (macOS) as a Homebrew service or a systemd user service. Config is `~/.config/openshell/gateway.toml` (`docs/about/installation.mdx`).
- I: Colima can only work if it exposes a Docker Engine >= 28 socket set through `socket_path`, and its VM kernel passes the Landlock and seccomp checks. Untested upstream.

## Sandbox

- V: A sandbox is a workload plus a separate supervisor: its own container with Docker or Podman, its own pod on Kubernetes, a host process with the VM driver. The Docker workload has `network=none`. The supervisor is reached over an authenticated Unix socket on a driver-owned volume (`docs/about/architecture.mdx`, `docs/how-it-works/sandboxes/runtimes.mdx`).
- V: Base image `nvcr.io/nvidia/base/ubuntu:24.04`, without an agent. A custom image comes in with `--from <oci ref|rootfs.tar>`. OpenShell builds no Dockerfile. The image `USER` is honoured, else uid and gid 1000. A root image is refused unless policy sets `run_as_user`.
- V: The repository is copied, not mounted, by default. `sandbox create --upload <local>[:<dest>]` copies the tree and skips what `.gitignore` excludes; `sandbox upload` and `download` sync later. "You cannot combine `--upload` with a trailing command." "Pi's changes stay inside the sandbox." (`docs/tutorials/run-pi-with-openrouter.mdx` L187-203).
- V: Docker driver mounts: `volume` (`source`, `target`, `read_only` default true, `subpath`), `tmpfs`, `bind` (`source`, `target`, `read_only` default true, `selinux_label`) (runtimes.mdx L164-168). Volumes must carry the `openshell.ai/sandbox-attachable` labels for resource admission (L150-160).
- V: "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy." They need `allow_driver_config = true`, `enable_bind_mounts = true` and `resource_admission.enabled = false` in `[openshell.drivers.docker]` (runtimes.mdx L171-182). The gateway.toml reference calls `enable_bind_mounts` an "unsafe operator override" (`docs/how-it-works/gateways/configuration.mdx` L1466-1469).
- V: Mount targets cannot replace the workspace root, the container root, `/opt/openshell`, `/etc/openshell` or `/run/openshell` (runtimes.mdx L184).
- V: The VM driver shares directories with virtiofs and warns that libkrun does not confine a compromised guest to the source directory (runtimes.mdx L249 and following).
- V: Sandboxes persist by default (`--no-keep` for ephemeral, `--detach`, `--restart-policy`). Commands: `sandbox connect`, `exec`, `stop`, `start`, `delete`, `list`. `connect` is SSH over the gateway with automatic reattach.
- V: Landlock default policy: working dir read-write; `/bin /usr /lib /proc /dev/urandom /etc /var/log` read-only; `/tmp` read-write. `filesystem_policy` is fixed after creation; network rules hot-reload.
- I: Nothing protects git metadata. `.git` is part of the uploaded tree. Landlock cannot carve a read-only subtree out of a read-write tree, so read-only git paths would come from bind entries.
- I: No orphan garbage collection beyond explicit `delete` is documented.

## Network

- V: Default deny. The default policy has no network rules. In the Docker workload, TCP connects and DNS are trapped by seccomp user notification and relayed over one mutually authenticated HTTP/2 channel to the supervisor. Not iptables.
- V: Rules (`docs/how-it-works/policies/schema.mdx`, `network-rules.mdx`): `network_policies.<name>.{endpoints[], binaries[]}`. An endpoint has `host` (exact or wildcard), `port`, `allowed_ips`, `protocol` (rest, websocket, graphql, mcp, json-rpc, tcp), `access` presets, `rules` and `deny_rules` (method, path glob, query), `enforcement` (`audit` default, `enforce`), `tls: skip`. Binaries are real executable paths, hash-pinned on first use, children included. Deny beats allow.
- V: TLS. "TLS detected: terminate unconditionally." The supervisor completes the client handshake with a leaf for the policy host, then opens upstream TLS with `tls_connect_upstream(upstream, &host_lc, ...)`, so the upstream SNI is the policy host, not the client's (`crates/openshell-supervisor-network/src/proxy.rs` L3262-3290; also `l7/tls.rs` L259-270). Corrects the fact sheet, which left this open.
- V: `tls: skip` is "raw tunnel, no termination, no credential injection" through `relay::relay_tcp`, with no ClientHello check (proxy.rs L3248-3258).
- V: The per-sandbox CA reaches the workload through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT` and `/run/openshell-supervisor-ca` (`docs/security/best-practices.mdx`). Pinned or mTLS clients need `tls: skip`.
- V: Request authority and Host must match the destination (`network-rules.mdx`).
- V: Private ranges. "Exact hostnames can reach the private addresses they resolve to, unless the endpoint comes from an approved policy advisor proposal. Wildcard and hostless endpoints can reach private addresses only through `allowed_ips`." Loopback, link-local, unspecified and `169.254.169.254` are never authorized. Kubernetes and etcd control-plane ports are blocked on exact-host endpoints (schema.mdx L141-155).
- V: Denials. Inspected HTTP gets `403` with a `policy_denied` JSON body. Non-HTTP gets a connection failure. `openshell logs <sb> --tail --source sandbox` shows OCSF events.
- V: The policy advisor is off by default. The agent proposes rules through `policy.local`, the prover risk-checks them, a human approves in the CLI or TUI (`docs/how-it-works/policies/advisor.mdx`). Approved rules hot-load.
- V: Corporate proxy. The Docker driver accepts `https_proxy`, `no_proxy`, `proxy_auth_file`, `proxy_auth_allow_insecure`, `proxy_connect_by_hostname`, `proxy_ca_bundle`. "The companion supervisor chains policy-approved TLS tunnels through the proxy with HTTP CONNECT." `proxy_ca_bundle` also covers "upstream certificates re-signed by a TLS-intercepting proxy". Sandbox env, image and driver config "cannot alter these settings". Invalid settings fail closed (runtimes.mdx L130-148).
- V: These are keys of `[openshell.drivers.docker]` in gateway.toml, so one value per gateway (configuration.mdx L1477-1487). `proxy_auth_file` holds one `user:pass`. With an `http://` proxy, Basic auth goes in cleartext and needs `proxy_auth_allow_insecure = true` (configuration.mdx L1640-1655).
- V: The supervisor CONNECTs to the parent with the validated IP address. `proxy_connect_by_hostname` sends the hostname instead, "at the cost of re-opening proxy-side resolution". Policy and SSRF validation run before the dial in both cases. "Plain-HTTP requests never take this path: they always dial the destination directly." (proxy.rs L4660-4681).
- I: A name the agent uses must resolve on the gateway host, or the SSRF check fails before the parent proxy is reached.

## Secrets

- V: A provider is a named credential plus a provider profile: `credentials[]` with `env_vars`, `auth_style` (header, bearer, basic, query, path), `header_name`, `query_param`, `path_template`; `endpoints[]`; `binaries[]`; optional refresh and token grant (`docs/how-it-works/providers/overview.mdx`, `profiles.mdx`).
- V: "At startup, OpenShell replaces each credential with an opaque placeholder token in the agent's environment." The proxy swaps it only when the binary and destination are allowed, the host, port and path match the binding, and the placement matches (overview.mdx L438-450).
- V: Placeholders start with `openshell:resolve:env:`. "A trusted launcher can wrap an issued placeholder in a JWT-shaped alias" whose signature segment is `OPENSHELL-RESOLVE-ENV-<suffix>`. "Use the placeholder supplied to the running workload; do not substitute a bare environment key or manufacture a handle." (overview.mdx L500-515).
- V: Basic auth is decoded and re-encoded. SigV4 re-signing with `credential_signing: sigv4`. Body and WebSocket rewrite only with `request_body_credential_rewrite`.
- V: Sources: `--from-existing` (host env vars named by the profile), `--credential KEY=VAL`, bare `--credential KEY`, `--from-gcloud-adc`, `--from-oidc-token`. I: no command or file source.
- V: Store: gateway-side SQLite under `$XDG_STATE_HOME/openshell/gateway/` (configuration.mdx L22). Optional `credential_drivers`: Kubernetes secrets, Vault, a database credstore with a key-encryption key.
- V: OAuth: gateway-managed refresh (Google Vertex ADC; Microsoft Graph tutorial `docs/tutorials/microsoft-graph-provider-refresh.mdx`) and token grants that use the sandbox SPIFFE JWT-SVID as client assertion. The sandbox gets access tokens as placeholders only.
- V: MCP: `protocol: mcp` inspects method and tool name. I: no MCP OAuth vault or in-sandbox sign-in flow.
- V: `sandbox create --env KEY=VAL` and `--env-from` put real values in the workload env. The CLI warns on credential-looking names.
- V: Supervisor middleware: "OpenShell removes credential, routing, and hop-by-hop headers before sending them to your service." "OpenShell protects credential, routing, framing, and connection headers." "Request header values cannot contain OpenShell credential placeholders." (`docs/extensibility/supervisor-middleware/operations.mdx` L29, L103).

## Agent integration

- V: There is no agent manifest. An agent is an OCI image plus a provider profile plus a network policy. Example profiles in `providers/` are "example, not loaded; import explicitly".
- V: Pi has a tutorial, `docs/tutorials/run-pi-with-openrouter.mdx`. It builds `node:24-bookworm-slim` with `npm i -g @earendil-works/pi-coding-agent`, installs `fd` and `ripgrep` because the sandbox blocks pi's download of them, sets `ENV PI_CODING_AGENT_DIR=/tmp/pi-agent` because `/tmp` is "one of the few places the sandbox lets Pi write" (L45-58), uses a profile with `binaries: [/usr/local/bin/node]`, then runs `openshell sandbox create --name pi --from pi-agent:local --provider <name> -- pi`.
- V: No mechanism for an agent config dir. Options: bake into the image, `sandbox upload`, a bind mount, or `--env`. Upload of `~/.pi/agent` would carry the real `auth.json`.
- V: "The workload calls the provider's native API." (inference.mdx L11-14). `host.openshell.internal` reaches host services when policy allows it.
- V: Env names starting `OPENSHELL_` are reserved; env limit 256 KiB.

## Enterprise and audit

- V: A gateway global policy replaces the per-sandbox policy, it does not merge (`docs/how-it-works/policies/overview.mdx` L47-73). "A global override suppresses provider-derived policy layers." (inference.mdx).
- V: Workspaces with OIDC RBAC, mTLS or OIDC gateway auth, gateway interceptors and supervisor middleware, Helm and OpenShift, HA with Postgres.
- V: OCSF security events to console, JSONL or OTLP; OTel traces and metrics (`docs/observability/`).

## Open issues (2026-11)

| Issue | State | Summary |
|---|---|---|
| #4683 | open | 0.1.4 Docker supervisor fails to fetch startup config on Apple Silicon with Docker Desktop |
| #4733 | open | Landlock denies reads on bind mounts with Docker Desktop VirtioFS on macOS |
| #4403 | open | `host.openshell.internal` unavailable with the Docker Desktop gateway endpoint |
| #3095 | open | packaged macOS arm64 VM guest kernel lacks a usable Landlock ABI |
| #5015 | open | VM driver socket path may exceed the macOS `sun_path` limit |
| #4133 | open | `doctor` does not check Docker Desktop prerequisites |
| #4831 | open | Podman supervisor sends the wrong credential to the upstream proxy on 0.1.4 and 0.1.5 |
| #4903, #4671, #4674 | open | TCP and `tls: skip` edge cases, encoded slashes, DNS TTL expiry |
| #3956 | closed, not planned | native macOS process sandboxes |
| #566, #1887 | closed | Apple `container`; directed to an out-of-tree extension driver |

- I: No issue mentions Colima or LLM gateways.

## Launcher facts this research relies on

- V: Legacy `gateway` mode writes `baseUrl = <gateway.url>/<provider id>` (or the provider's own `baseUrl`) and `apiKey = <gateway.placeholder>` into the sandbox `models.json`, and the placeholder into `auth.json` (`launcher/hostpi/gateway.ts` L15-16, L30-39).
- V: The legacy gateway becomes one credential rule whose `host` is the gateway URL's hostname, with the secret from env, keychain command, host pi auth, a file pointer or an SSO command (`launcher/config/legacy-gateway.ts` L54-77).
- V: The terminating proxy dials `target.host` and sets `servername: target.host` (`launcher/proxy/terminate.ts` L267-271). `TerminatedTarget` has `host`, `port`, `repoHash`, `access`, `pathPrefix` and no upstream host (L29-35). For the gateway, `pathPrefix` is the gateway URL's pathname, prepended to the request path (`launcher/proxy/intercept.ts` L132, `launcher/proxy/server.ts` L95, `terminate.ts` L119-120, L316).
- V: Derived rules keep each host `baseUrl` minus userinfo (`launcher/hostpi/derive-models.ts` L51, L174-178).
- I, from the above: in both modes the container sees the gateway hostname and only a placeholder for the token.
- V: In `launcher/proxy/`, `tunnel.ts` imports `sni.ts` and `policy.ts`; `dial.ts` imports `restrictedAddress` from `policy.ts`; `intercept.ts` imports `sniDenial` from `policy.ts`; `runtime.ts` imports `dynamic.ts`; `private-hosts.ts` imports `policy.ts` (file heads).
- V: Line counts, `wc -l` at 7cfa5d9: 24,966 shipped lines in 197 files (proxy 6,739, cli 3,414, backend 2,392, hostpi 2,259, config 2,035, workspace 1,918, container 1,573, image 1,247, provision 1,235, shared 1,034, root scripts 644, grants 323, bin 153); 31,072 test lines (tests/proxy 6,383, tests/cli 4,254, tests/live 3,981, tests/config 2,736, tests/container 2,118, tests/backend 2,040).
