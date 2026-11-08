# OpenShell: could it replace the launcher?

The question: could NVIDIA OpenShell give the same UX as the launcher in PR #42? How would it differ, how many lines could go, and what would we lose?

Fixed constraints, from [sandbox-approaches](../sandbox-approaches/README.md): free and open-source tooling only, no Docker Desktop, no Podman, Colima as the default engine and Apple `container` second. No tokens inside the container. The internal LLM gateway stays invisible to the agent. One sh install script, then `pi` in a repository just works. The SNI check, the private-range deny and the mount guard stay in force. Defaults stay safe. Shipped code adds no npm dependencies.

Facts and sources are in [research.md](research.md). Line counts are `wc -l` of the launcher at commit 7cfa5d9: 24,966 shipped lines in 197 files and 31,072 test lines. Opinions are marked as such.

## A. Verdict

Partly, not now.

- OpenShell does the core of what our proxy does: the workload holds placeholders, and a trusted proxy outside it swaps in the real credential.
- On macOS it supports only Docker Desktop. Colima is not mentioned anywhere in the repository. Apple `container` would need an out-of-tree driver.
- The repository is copied in by default. A live bind mount needs three gateway-wide switches, weakens OpenShell's own isolation and is reported broken on VirtioFS (#4733, open).
- Biggest blocker: there is no qualified Docker-Desktop-free engine on macOS that also supports a live bind mount of the repository.

## B. How it would work on OpenShell

Common to both designs. `install.sh` installs Colima and the `openshell` Homebrew formula, starts `openshell-gateway` as a brew service, and writes `~/.config/openshell/gateway.toml`. That file sets `socket_path` to `~/.colima/pi-sandbox/docker.sock` (not among the driver's default candidates), turns on `allow_driver_config` and `enable_bind_mounts`, turns off `resource_admission`, and the installer sets `OPENSHELL_TELEMETRY_ENABLED=false`. The `pi` wrapper stays ours. It still runs the workspace guard, the git layout checks, the four config layers and the host pi derivation. It builds our image with the engine API, since OpenShell cannot build images. Per repository it runs `openshell sandbox create --name pi-<repo hash> --from <our image> --policy <rendered yaml> --driver-config-json '<mounts>' --detach` once, then `openshell sandbox exec` or `connect` per session. Each sandbox is a supervisor container plus a workload container with `network=none`.

**Design 1: OpenShell replaces the proxy.** The supervisor becomes the only egress proxy. Each derived credential rule becomes a provider profile (`auth_style`, `endpoints`, `binaries: [/usr/local/bin/node]`) and `openshell provider create --credential KEY=<value>` with a value resolved on the host. OpenShell issues an `openshell:resolve:env:...` placeholder into the workload's environment at startup, so an in-sandbox step must write it into the rendered `auth.json` and `models.json`. Grants become `openshell policy update`. The corporate proxy moves to `https_proxy` in gateway.toml. Our proxy, its CA, the vault and the relay are deleted.

**Design 2: OpenShell replaces the container runtime and egress filter, our proxy stays as parent.** gateway.toml sets `https_proxy = http://host.lima.internal:<port>`, `proxy_connect_by_hostname = true`, `proxy_ca_bundle = <launcher CA>` and `proxy_auth_allow_insecure = true` (a plain-HTTP parent with Basic auth needs that acknowledgement). The supervisor applies the OpenShell policy, terminates the client's TLS, and re-originates every approved TLS tunnel through our host proxy with a hostname CONNECT. Our proxy then works as today: it terminates rule and vault hosts with our CA, swaps `pi-sandbox-` placeholders, checks SNI and private ranges on the rest, and keeps the command, file, piAuth and MCP OAuth sources and the `/oauth/*` routes. Backends, relay, internal networks and our denial page go.

What the user types is the same in both: `curl -LsSf <url>/install.sh | sh`, then `cd <repo> && pi`. The `pi sandbox` commands stay. Two things change for the user: `openshell logs <sandbox>` becomes the place to read denials, and an inside 403 is OpenShell's `policy_denied` JSON, not our page.

## C. Capability map

Status: native, configurable, needs glue, kept (our code stays), lost. "D1" and "D2" mark where the designs differ.

| Launcher feature | OpenShell | Status | Source |
|---|---|---|---|
| Colima engine via Engine API | Docker driver speaks the Engine API; macOS supported row is Docker Desktop only; Colima never mentioned; Engine >= 28 | unqualified | support-matrix.mdx L56; research.md s2 |
| Apple `container` engine | no driver; maintainers point to an out-of-tree extension driver | lost | #566, #1887 |
| No secret in container | provider placeholders in env; `--env` and upload carry real values | D1 configurable, D2 kept | providers/overview.mdx L438-443 |
| Only path out via proxy | workload has no NIC; connect() and DNS trapped by seccomp, relayed to supervisor | native, stronger | architecture.mdx |
| Egress allowlist, deny wins, 443 | `network_policies`, deny beats allow, per-binary | configurable | policies/schema.mdx |
| SNI check | TLS always terminated; upstream SNI and leaf both use the policy host; `tls: skip` is a raw relay with no SNI check | D1 native except `tls: skip`; D2 kept | proxy.rs L3248-3290 |
| Private-range deny incl. names resolving private | loopback, link-local, metadata always blocked; exact hostnames may resolve to RFC1918 | D1 weaker; D2 kept (our dial still checks) | schema.mdx L143-146 |
| Plain HTTP refused | allowed if a rule allows the port; plain HTTP never goes through the parent proxy | configurable (never emit port 80) | proxy.rs L4668 |
| Placeholder injection, response header scrub | header, bearer, basic, query, path, SigV4, opt-in body; scrub not documented | D1 native, scrub unknown; D2 kept | providers/overview.mdx |
| TLS termination for rule hosts only | every TLS flow terminated by a per-sandbox CA | behaviour change (both) | best-practices.mdx |
| Auto-derive rules from host pi files | none | kept | research.md s6 |
| Secret sources env, file, command, piAuth, mcpOAuth | env, literal, gcloud ADC, OIDC token | D1 lost or glue; D2 kept | research.md s5 |
| MCP OAuth vault, in-sandbox sign-in | gateway-side refresh per provider only | D1 lost; D2 kept, callback path unverified | research.md s5 |
| Hide the internal LLM gateway | workload calls the native endpoint; no rewrite | not done today either (section D) | inference.mdx L11-14 |
| Mount guard | none; bind mounts "can bypass workspace isolation" | kept, advisory once bind mounts are on | runtimes.mdx L171 |
| `extraReadOnly` check | bind entries with `read_only` | kept | runtimes.mdx L166-168 |
| Git metadata protection | nothing git-specific | kept, rendered as read-only binds | research.md s3 |
| Workspace mode | none | kept | none |
| Host-shared sessions dir | bind mount | needs glue, #4733 | runtimes.mdx |
| Agent, cache, node_modules, shared-cache volumes | `volume` mounts of pre-labelled volumes we create | needs glue | runtimes.mdx L150-166 |
| Grants with session, hours, permanent | `policy update`, hot reload, advisor; no expiry | needs glue (we reapply) | research.md s4 |
| Four config layers, tighten-only | global policy replaces sandbox policy | kept | policies/overview.mdx |
| Parent proxy with Basic auth | `https_proxy`, `proxy_auth_file` | D1 native; D2 occupied by our proxy | runtimes.mdx L130-146 |
| Extra CAs | `proxy_ca_bundle`, generated trust bundle | native for runtime, ours for builds | runtimes.mdx L137-142 |
| Image extensions | `--from` only, no build | kept | research.md s3 |
| Missing-command hint, SSH agent | none | kept in image; ssh socket bind unverified | none |
| `--no-sandbox`, intercepts, `packages` write-back | none | kept | none |
| doctor, status, gc, reset | `sandbox list/delete`, `logs`, `doctor` | needs glue | research.md s7 |
| `migrate --to colima|apple` | no second engine | lost | none |
| Denial page and exit summary | 403 `policy_denied` JSON, OCSF logs | needs glue (parse logs) | research.md s4 |
| One container per repo, stopped after last session | persistent sandboxes, start/stop | needs glue (keep lock and counting) | research.md s3 |
| Signals, exit code, resize | `sandbox exec`/`connect` over gateway SSH | unverified | research.md s7 |

## D. The internal LLM gateway, today and on OpenShell

The three assessments disagreed. One said the launcher hides the gateway through a rewrite. The code says it does not.

- **Legacy `gateway` mode.** `hostpi/gateway.ts` L15-16 and L37 write `baseUrl = <gateway.url>/<provider id>` and `apiKey = <gateway.placeholder>` into the sandbox `models.json`, and the placeholder into `auth.json`. `config/legacy-gateway.ts` L65-76 makes one credential rule whose `host` is the gateway URL's hostname. The proxy terminates TLS for that host, and `proxy/terminate.ts` L267-271 dials `target.host` with `servername: target.host`. `TerminatedTarget` (L29-35) has no upstream host field. The only rewrite is the gateway URL's path, prepended to the request path (`proxy/intercept.ts` L132, `terminate.ts` L119-120, L316).
- **Credential-rule mode.** `hostpi/derive-models.ts` keeps each host `baseUrl`, minus userinfo (L51, L174-178), and the rule host comes from it. The proxy dials the same host.

So in both modes the container sees the gateway hostname and never the token. The constraint "the gateway stays invisible" is not met today.

On OpenShell:
- Design 1 changes nothing for the hostname and removes the place where we could fix it. "The workload calls the provider's native API" (inference.mdx L11-14). The managed inference route, the one feature that rewrote requests, was removed in 0.1.0 (inference.mdx L221-248). Supervisor middleware may not change credential or routing headers, and request header values may not carry placeholders (supervisor-middleware/operations.mdx L29, L103).
- Design 2 is the same as today. Our parent proxy could add a host rewrite, which is new code in either case. One caveat: the supervisor resolves the requested name for its SSRF check before it dials the parent (proxy.rs L4660-4681, the `dial_upstream` doc comment). So the name the agent sees must resolve publicly (inferred).

Opinion: if the constraint matters, add an upstream-host field to `TerminatedTarget` in the current launcher. It is the same work with or without OpenShell.

## E. Code that could go

Shipped code per folder, `wc -l`. Each row's removable plus kept equals the folder total. All splits are estimates (inferred), reconciled from the three assessments.

### Design 1: OpenShell replaces the proxy

| Folder (total) | Removable | Kept | New | Reason |
|---|---|---|---|---|
| install.sh, uninstall.sh (644) | 140 | 504 | 120 | Colima bootstrap stays; add openshell, gateway.toml, telemetry off |
| backend/ (2,392) | 1,792 | 600 | 0 | Gateway drives containers, networks, exec; Apple adapter and relay go; engine build and pull stay |
| bin/ (153) | 60 | 93 | 30 | Uninstall goes through `openshell sandbox delete` |
| cli/ (3,414) | 1,350 | 2,064 | 300 | sandbox-proxy, mcp-auth-sync, migrate go; launch, doctor, gc, status, egress rewritten over openshell |
| config/ (2,035) | 240 | 1,795 | 400 | Layers and tighten-only stay; new renderer to policy and profile YAML |
| container/ (1,573) | 920 | 653 | 200 | Spec becomes a driver-config builder; lock, session counting, git snapshots stay |
| grants/ (323) | 0 | 323 | 60 | Expiry is ours; reconcile with `policy update` |
| hostpi/ (2,259) | 640 | 1,619 | 200 | vault.ts, mcp-auth.ts, mcp-discover.mjs go; derivation emits profiles |
| image/ (1,247) | 300 | 947 | 50 | socat, CA install, xdg-open shim, idle entrypoint go |
| provision/ (1,235) | 220 | 1,015 | 100 | mcp-auth sync goes; placeholder copy into auth.json added |
| proxy/ (6,739) | 6,308 | 431 | 300 | Everything but secrets/{env,file,command,pi-auth,cache,index,errors} and single-flight, kept as a host refresher |
| shared/ (1,034) | 150 | 884 | 0 | Proxy token and vault types go |
| workspace/ (1,918) | 0 | 1,918 | 50 | Guard, git layout, workspace scan have no counterpart |
| new `openshell` CLI adapter | | | 200 | Version pin, output parsing |
| **Total (24,966)** | **12,120** | **12,846** | **2,010** | Net about 10,100 lines fewer (40%) |

Tests: about 10,000 of 31,072 lines would go (most of tests/proxy 6,383, most of tests/backend 2,040, half of tests/container 2,118, the vault and migrate tests, part of tests/live). The glue needs new unit tests and a live suite against a real gateway (inferred).

Lost in this design: the command, file and piAuth sources as on-demand sources (a host refresher pushing `provider update` is the glue), the MCP OAuth vault, the place to add a gateway host rewrite, grant expiry inside a running sandbox (inferred), and our denial page.

### Design 2: OpenShell replaces runtime and egress, our proxy is the parent

| Folder (total) | Removable | Kept | New | Reason |
|---|---|---|---|---|
| install.sh, uninstall.sh (644) | 0 | 644 | 120 | Same additions as Design 1 |
| backend/ (2,392) | 1,700 | 692 | 0 | Engine client stays for build, pull, labelled volume create and prune |
| bin/ (153) | 50 | 103 | 0 | Uninstall deletes sandboxes via openshell |
| cli/ (3,414) | 450 | 2,964 | 250 | migrate and engine parts of launch, gc, doctor, status go |
| config/ (2,035) | 30 | 2,005 | 400 | Renderer to policy YAML and gateway.toml |
| container/ (1,573) | 630 | 943 | 0 | Network, relay and engine create go; mounts become driver config |
| grants/ (323) | 0 | 323 | 0 | Kept; pushed through the adapter |
| hostpi/ (2,259) | 0 | 2,259 | 0 | Kept |
| image/ (1,247) | 150 | 1,097 | 0 | Idle entrypoint and relay bits go |
| provision/ (1,235) | 100 | 1,135 | 0 | Sync through `sandbox exec` |
| proxy/ (6,739) | 500 | 6,239 | 0 | denial-page.ts, the `/policy` and `/denials` routes, per-policy-hash instances go |
| shared/ (1,034) | 0 | 1,034 | 0 | Kept |
| workspace/ (1,918) | 0 | 1,918 | 0 | Kept |
| new `backend/openshell/` adapter and session glue | | | 930 | create, exec, connect, stop, delete, `policy set`, log parsing, signal bridge |
| **Total (24,966)** | **3,610** | **21,356** | **1,700** | Net about 1,900 lines fewer (8%) |

Tests: about 3,000 lines would go (most of tests/backend, part of tests/container, the denial-page and control tests).

Spot-check of the proxy split. One assessment put policy.ts, private-hosts.ts, sni.ts, dynamic.ts and denials.ts on the removable side of Design 2. Kept files import them: `tunnel.ts` imports `sni.ts` and `policy.ts`, `dial.ts` and `intercept.ts` import from `policy.ts`, `runtime.ts` imports `dynamic.ts`. Our proxy still sees every approved TLS tunnel, so its SNI and private-range checks keep running. So Design 2 removes about 500 proxy lines, not 1,200. In Design 1 the kept proxy files (secrets/ minus mcp-oauth.ts, plus single-flight.ts) sum to 431 lines, not 459.

## F. What we lose

Tags: constraint violation (CV), security regression (SR), UX regression (UX), maintenance trade (MT).

1. **CV.** Colima is not a supported or tested engine. macOS support means Docker Desktop. The kernel needs (Landlock ABI 3, seccomp user notification with ADDFD) are unproven in Colima's VM. Both designs.
2. **CV.** Apple `container` is gone, and `pi sandbox migrate` with it. Both designs.
3. **UX, SR.** Live repository editing. The default copies the tree in, and `--upload` cannot carry the command. A bind mount needs three gateway-wide switches, and #4733 reports Landlock denying reads on VirtioFS bind mounts. Our Colima profile uses VirtioFS. Both designs.
4. **SR, CV.** Mount guard becomes advisory. With bind mounts on for the whole gateway, any gateway client can bind any VM-visible host path. Our guard only covers launches through `pi`. "Defaults stay safe" no longer holds at the gateway level. Both designs.
5. **SR.** Private-range deny. Exact allowlisted hostnames may resolve to RFC1918 addresses, which reopens DNS rebinding toward the LAN. Closing it needs `allowed_ips` restricted to public ranges per endpoint (untested). Design 1 only; in Design 2 our dial still refuses restricted addresses.
6. **SR.** `tls: skip` endpoints are raw relays with no SNI check and no injection. Pinned and mTLS clients need them. Design 1; in Design 2 the tunnel still reaches our SNI check.
7. **SR, UX.** Every TLS flow is re-signed by a per-sandbox CA, not just rule hosts. Design 2 adds a second interception hop. Both designs.
8. **CV, feature.** No command, file or piAuth source, and no MCP OAuth vault with in-sandbox `/mcp` sign-in. Design 1 only. Configuring OpenShell's own refresh would put provider token endpoints in our code, against the no-provider-knowledge rule (inferred).
9. **SR.** Per-repository proxy identity (Design 2). `proxy_auth_file` is one gateway-wide `user:pass`, sent as cleartext Basic to an `http://` parent. Our proxy can no longer tell repositories apart by token (inferred: the setting lives in the `[openshell.drivers.docker]` table of gateway.toml, configuration.mdx L1477-1487, and sandboxes cannot alter it, runtimes.mdx L144-146). Allowlists stay per sandbox in OpenShell's policy, but our per-repository rule and vault state needs another key.
10. **UX.** Denials. Our 403 page naming `pi sandbox egress allow <host>` becomes `policy_denied` JSON, and the exit summary needs log parsing. Grants lose native expiry. Both designs.
11. **UX.** Footprint. A permanent gateway daemon, two containers per sandbox, first-start pulls from `ghcr.io` and `nvcr.io` outside our digest-pinned flow, and an SSH-over-gateway exec path whose signal and exit-code behaviour is unverified. Both designs.
12. **SR, CV.** Telemetry is on by default in the gateway. The installer must turn it off. Both designs.
13. **MT.** 0.1.x, weekly releases, support for the latest minor and N-1 only, 637 open issues, several open macOS bugs (#4683, #4403, #3095, #5015), and a corporate-proxy credential bug on Podman (#4831). 0.1.0 already removed a feature (inference routes). We would track a moving CLI, profile schema and gateway.toml. Both designs.
14. **MT.** Two policy languages. Our layers stay because OpenShell's global policy replaces instead of merging. A user debugging a denial reads both. In Design 2 two policy engines run in series.

The gateway hostname is not on this list. It is visible today too (section D).

## G. What we gain

1. **Stronger workload boundary.** No network interface. TCP and DNS trapped by seccomp user notification and relayed to a supervisor outside the workload. Landlock, non-root, no capabilities, fail-closed kernel qualification. Both designs.
2. **Per-binary rules.** Endpoints limited to `/usr/local/bin/node` or `git`, with hash pinning on first use. Both designs.
3. **L7 rules.** Method, path, query, GraphQL and MCP method and tool name. Both designs.
4. **Audit and observability.** OCSF events to JSONL or OTLP, OTel traces, `openshell logs`. Both designs.
5. **Policy tooling.** Hot reload, a policy advisor that drafts rules from denials, a formal prover and a TUI for approvals. Both designs.
6. **Broader injection** (Design 1). Basic, query and path placement, SigV4 re-signing, opt-in body rewrite, Vault and Kubernetes secret back-ends.
7. **Future backends.** Kubernetes and Helm, a libkrun MicroVM driver, remote gateways, OIDC and RBAC workspaces. Both designs.
8. **Offloaded maintenance.** About 12,100 lines (Design 1) or 3,600 (Design 2), including our most security-critical code in Design 1 (TLS termination, CA, SNI parser, dial). It moves to an Apache-2.0 project with 14 maintainers from NVIDIA and Red Hat. Pi has an upstream tutorial (`docs/tutorials/run-pi-with-openrouter.mdx`).

## H. Experiments that would settle the open questions

Each is half a day on a real Mac, with nothing installed into the user's main Colima profile.

1. **Colima qualification.** `colima start --profile os-test --vm-type vz --mount-type virtiofs`. `brew install openshell`. In gateway.toml set `socket_path = "~/.colima/os-test/docker.sock"`, then `brew services start openshell-gateway`. Build the tutorial's image and run `openshell sandbox create --from pi-agent:local -- pi --version`. Record the engine version (>= 28?), `uname -r` in the VM, the Landlock ABI, and whether the supervisor starts. Pass: pi prints its version.
2. **Bind mount on VirtioFS (#4733).** Same profile, the three bind-mount switches on. Bind a test repo read-write at its host path and `.git/hooks` read-only. In `sandbox exec`: `cat README.md`, `git status`, `touch x`, `touch .git/hooks/y`. Pass: reads work, `x` appears on the host, `y` is refused. Repeat with `--mount-type sshfs`.
3. **Exec semantics.** `openshell sandbox exec -t <sb> -- sh -c 'exit 7'`, then `sleep 100` killed with SIGTERM and SIGHUP, then a terminal resize under `tput cols`. Record exit code, which processes got the signal, resize delivery, warm-start latency against today's `pi`.
4. **Placeholder into pi (Design 1).** `provider create --credential` for a test header rule. In the sandbox, read the placeholder from env, write it into a rendered `auth.json`, run pi against an echo server allowed by policy. Then `provider update` mid-session. Pass: the echo server sees the real value, then the new one, without restart.
5. **Parent-proxy chain (Design 2).** Set `https_proxy`, `proxy_connect_by_hostname`, `proxy_ca_bundle` and `proxy_auth_file`. Allow a rule host. From pi, send a request with a `pi-sandbox-` placeholder. Pass: our proxy sees `CONNECT <host>:443`, the placeholder header arrives unmodified, injection works. Then run the `/mcp` sign-in and check that the `/oauth/open` POST and callback round-trip.
6. **Private range and `tls: skip`.** Allowlist an exact name that resolves to 10.0.0.5 through local DNS, and check it connects (expected). Add `allowed_ips` with public ranges only, check it is refused. With a `tls: skip` endpoint, send a ClientHello with SNI `evil.example`. Record whether it is relayed.
7. **Gateway client scope.** From inside a sandbox, use whatever gateway credential the supervisor exposes and try `CreateSandbox` with a bind mount of `$HOME`. Pass: refused.

Experiments 1 and 2 decide go or no-go on their own.

## I. Recommendation

Opinion: not now. Keep the launcher.

- Design 1 removes about 12,100 lines but breaks two constraints (Colima, Apple `container`), weakens two guarantees (private-range deny, mount guard) and drops the SSO command source and the MCP vault.
- Design 2 keeps every guarantee our proxy gives, but removes only about 3,600 lines, adds 1,700, and still breaks the engine constraints and the mount guard.
- In both, the UX hangs on a bind mount that is off by default, gateway-wide when on, and reported broken on VirtioFS.
- The gateway-invisibility gap is ours to close in `proxy/terminate.ts`. OpenShell does not help with it.

Opinion: if OpenShell comes in, bring it as Design 2 behind the existing `Backend` interface, as one more backend for Linux and Kubernetes users, not as a replacement. This matches [future-plans/sandbox](../../future-plans/sandbox/README.md) item 5.

Revisit when all of these hold:
1. The support matrix lists Colima, Lima or another free Docker Engine on macOS, or the macOS MicroVM guest gets a usable Landlock ABI (#3095 closed).
2. #4733 is fixed, and bind mounts can be enabled per sandbox or per host path instead of gateway-wide.
3. Exact hostnames can be held to public addresses without hand-written `allowed_ips` lists.
4. For Design 1: a command or exec credential source, or a refresh hook, exists upstream.
5. A 1.0 or a stable policy and CLI contract ships.
6. Experiments 1, 2, 3 and 7 pass.
