# Sandbox

Research date: 2026-11-02, pi 1.5.0

Question: how pi and every extension in this repo run inside a sandbox that an enterprise accepts, with model-provider tokens outside it, a writable cwd per agent, a deny-by-default URL allowlist and no visible container handling for the developer, who types `pi` and nothing else. Replaces the 2026-10-20 pass (pi 1.3.0, OpenShell-first, no launcher).

- README.md (this file): requirements, findings, recommendation, phases, risks.
- [research/pi-and-harness.md](research/pi-and-harness.md): what pi 1.5.0 ships for isolation, its credentials, network calls and file footprint, and the seams in this repo, with file and line citations.
- [research/landscape.md](research/landscape.md): how other coding agents sandbox, laptop runtimes, OpenShell, hosted services, 2025-2026 CVEs and the enterprise checklist.
- [research/credentials-and-egress.md](research/credentials-and-egress.md): credential injection patterns (proxy, gateway, host daemon), what pi supports per pattern, egress enforcement and audit.
- [research/developer-experience.md](research/developer-experience.md): launcher shapes, terminal through the boundary, file sharing, identity, image delivery, policy delivery, comparables.

## Requirements

- **R1 Whole boundary.** Pi, all extensions from this repo, MCP servers and every subprocess run inside a container, microVM or OS sandbox.
- **R2 Tokens outside.** No token of any kind is readable inside the boundary, ever: no model-provider key, OAuth or refresh token, MCP server secret, registry token or git token. The one capability that crosses is use (not read) of ssh keys through the agent socket (decision 5).
- **R3 Per-agent cwd.** Each agent writes only to its own cwd or worktree inside the project (plus what git needs); the rest of the host is not visible.
- **R4 Enterprise grade.** Deny-by-default URL allowlist, central policy the agent (and with MDM, the developer) cannot loosen, fail closed, per-user audit, macOS first, Linux second.
- **R5 Zero friction.** The developer types `pi` in a project; no container commands, no image builds, warm start that feels native.

research/landscape.md numbers its five criteria differently (R2 there is "only cwd writable", R3 the allowlist); research/credentials-and-egress.md says "requirement 1" for tokens and "requirement 2" for the allowlist. The numbering above is the one later sections use.

## Findings

1. **The industry runs two tiers.** Local CLIs (Claude Code, Codex, Copilot, Cursor, Gemini, Factory) wrap each shell command in Seatbelt or bubblewrap/Landlock with a host proxy; cloud products (Claude Code web, Codex cloud, Cursor cloud, Devin, Jules) and Docker Sandboxes put the whole agent in a VM with credentials and egress handled outside. [landscape.md](research/landscape.md) A, B and the comparison table.
2. **Only a whole-process boundary meets R1.** Per-command sandboxes leave the agent process, its model credential, file tools, MCP servers, hooks and web fetch outside (Claude Code scope list; Codex proxy "does not cover ... the client's own model traffic"; Copilot cloud firewall skips MCP). Factory's `whole-process` mode is the only vendor-documented local exception. Pi says the same: whole-process isolation "is usually the strongest practical option" and tool-only isolation leaves "Pi itself and other extensions" outside (`docs/security.md:16-17`). For this repo that means `fetch`, `run_agent`, `handoff`, MCP and the extension bus would stay on the host. [landscape.md](research/landscape.md) A; [pi-and-harness.md](research/pi-and-harness.md) A, F "What breaks where".
3. **Placeholder plus a host-side proxy is now standard practice for R2.** Docker Sandboxes ("The raw credential values never enter the VM"), OpenShell, Gondolin, Copilot (`GH_TOKEN` placeholder for three GitHub hosts), Claude Code `mask`, srt and microsandbox all ship it. Gateways (LiteLLM, Bifrost, Agent Router) hold provider keys and do SigV4/GCP/Azure; consumer subscription OAuth does not fit them and Anthropic's terms forbid third-party use of subscription tokens. [credentials-and-egress.md](research/credentials-and-egress.md) A1, A2; [landscape.md](research/landscape.md) F.
4. **Escapes recur in the same classes.** Trusted-side files written from inside (CVE-2026-25725, CVE-2026-48124); git metadata, `core.fsmonitor`, hooks, worktree pointers (CVE-2026-55607, CVE-2026-40068, GitPwned, Goose CVE-2026-72718); symlink and TOCTOU at the boundary, including hypervisor file servers (Docker Sandboxes CVE-2026-77179, 9.4, virtio-fs follows symlinks); inherited env and readable credential files (Riptides: every tested agent); DNS, ICMP, UDP side channels (CVE-2026-12039, CVE-2026-12539). [landscape.md](research/landscape.md) E "Recurring leak classes".
5. **Policy inside the agent is not a boundary.** Anthropic calls server-managed settings "a client-side control, not a security boundary". Pi's `permission-gate.ts` and `protected-paths.ts` are bypassed by bash; a `tool_call` gate is policy, not isolation; the `httpProxy` setting yields to env, so enforcement must sit at the network layer. [landscape.md](research/landscape.md) A; [pi-and-harness.md](research/pi-and-harness.md) A "Examples", B; [credentials-and-egress.md](research/credentials-and-egress.md) B.
6. **Pi 1.5.0 has the pieces but no sandbox.**
   - No flag or setting; the OS `sandbox/` example was removed in 1.5.0 (`CHANGELOG.md:117`); `docs/containerization.md` lists plain Docker, Docker Sandboxes, OpenShell and Gondolin.
   - An undici `EnvHttpProxyAgent` is the global dispatcher, so provider calls and any in-process `fetch` honour `HTTPS_PROXY`; `models.json` `baseUrl` with a dummy key keeps built-in models and needs a placeholder per provider for `/model` to list it.
   - `getShellEnv()` passes the full `process.env` to every bash command and MCP stdio servers get `{ ...process.env }`, so env keys leak to all subprocesses.
   - Outbound calls: version check, install telemetry, catalog refresh, `rg`/`fd` download, `-e npm:`/`-e git:` re-checks, MCP OAuth metadata at `pi.dev/oauth`; `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY=0`/`enableInstallTelemetry: false` turn the automatic ones off.
   - `shellPath` wraps model bash and `!` commands in main and child sessions with no code. [pi-and-harness.md](research/pi-and-harness.md) A, B, C.
7. **This repo runs unchanged inside a container if paths match the host.** Sessions are grouped by cwd path, `trust.json` keys on canonical paths, and git worktree metadata stores absolute paths, so a `/workspace` remap breaks host git. Needed in the image: Node, `git`, `rg`, `fd`, this package. What breaks: mcp-import finds no `~/.claude.json` or `~/.cursor`; a read-only agent dir fails sessions, trust saves, model-default, style and `/agents setup` user scope; image paste (`wl-paste`/`xclip` absent); OAuth callbacks on 1455/8085/51121 land in the guest; `open` and `$EDITOR` run in the guest. [pi-and-harness.md](research/pi-and-harness.md) D, E, F; [developer-experience.md](research/developer-experience.md) Baseline, C, G.
8. **File-share speed, not boot time, decides the macOS experience.** Numbers below are npm install, seconds, M4 Pro, from the Mainardi 2025 benchmark unless stated. [developer-experience.md](research/developer-experience.md) C.

   | Setup | Result |
   |---|---|
   | macOS native | about 3.4 |
   | Docker Desktop VZ + synchronized file shares (paid) | 3.88 |
   | OrbStack | 4.22 |
   | Docker VMM | 8.47 |
   | Lima | 8.99 |
   | Docker Desktop VZ + virtiofs | 9.53 |
   | Any setup with `node_modules` on a named volume | 3.2-4.1 |
   | Docker Sandboxes, Maven build (sbx 0.24.1, issue #31, still open) | 2:30 native vs ~13 min on the virtiofs workdir vs 2:39 from in-sandbox `/tmp` |
   | Linux native Docker bind mount | 5.29 vs 5.32 native |

9. **No off-the-shelf product is a safe single dependency.**
   - Docker Sandboxes (`sbx` v0.50.1): microVM, same-path mount, deny-by-default proxy, credential swap, paid org governance, an official pi kit; but a closed binary (license NOASSERTION), Docker sign-in, the file-share issue above, linked worktrees that cannot commit, and the 9.4 escape CVE plus five more in 2026.
   - OpenShell v0.1.6: pre-1.0, weekly breaking releases, six CVEs in the first disclosed batch (two at 9.9), macOS only via Docker Desktop or the VM driver with open macOS bugs (#4733 Landlock on VirtioFS), TypeScript SDK not on npm, no support offering found.
   - Apple `container` 1.6.1: Apache-2.0, VM per container, macOS 26 for full function, no egress allowlist or proxy feature.
   - Gondolin 0.14.0: "Experimental"; the pi example passes host env into the VM. [landscape.md](research/landscape.md) B, C, E; [developer-experience.md](research/developer-experience.md) C, H.
10. **Only two launcher shapes feel instant.** An OS sandbox on the host (Seatbelt measured at 4.87 ms vs 1.15 ms bare) or `exec` into an already-running container (expected tens to low hundreds of ms, not measured). `pi --version` takes 0.128 s, so the warm target is under 200 ms. Docker Desktop engine warm restart is 15-20 s and Lima ~29 s, so engine and container must stay warm. sbx and Gemini's Docker mode set the precedent: per-project container, cwd at the same absolute path. [developer-experience.md](research/developer-experience.md) A1, A2, "Derived".

## Recommendation

```
 HOST (macOS, user account)        |  BOUNDARY (Linux VM / container)  |  GUEST (per-repo container)
                                   |                                   |
 MDM ── policy file (root-owned) ──┤                                   |
   writable paths, allowlist,      |                                   |
   image digest, gateway URL       |                                   |
            │                      |                                   |
 `pi` shim ─┼─ Docker API / Apple  |  no default route                 |  real pi + repo extensions
   repo root, warm container       |  DNS: none, metadata IPs blocked  |  (PTY, TERM*, size, SIGWINCH)
   named by repo path hash ────────┼── exec -it ───────────────────────┼─▶ models.json: baseUrl=gateway,
            │                      |                                   |   placeholder key per provider
 host bridge (socket) ◀────────────┼── open, pbpaste, notify, editor ──┤  sandbox extension (Phase 2):
            │                      |                                   |   bwrap+Landlock per agent
 egress proxy ◀────────────────────┼── HTTPS_PROXY (only exit) ────────┤
   CONNECT + SNI allowlist         |                                   |  mounts at host paths:
   TLS terminate: gateway host     |                                   |   repo top-level      rw
   swaps placeholder for SSO token |                                   |   git common dir      rw
            │                      |                                   |   .git/hooks, config  ro
 keychain / SSO ── per-user token  |                                   |   ~/.pi/agent  named volume
            ▼                      |                                   |   deps/caches  named volumes
 corporate LLM gateway ── provider keys, SigV4/GCP/Azure, budgets, audit   rest of image  ro
```

### 1. Boundary: the whole pi process in a Linux container or microVM

- Pi, every extension, MCP stdio servers, codemode, bash children and the custom tools run in the guest; only the shim, proxy and bridge run on the host. This is the only shape that meets R1 (finding 2) and keeps every TUI feature, since RPC mode makes `custom()`, `setFooter` and `setEditorComponent` no-ops ([pi-and-harness.md](research/pi-and-harness.md) A "Other docs", G).
- Rejected as the primary layer: per-command tool sandboxing (Claude Code, Codex style, or pi's Gondolin and `ssh.ts` operations backends). It leaves pi's process, its model key, MCP, `fetch`, `run_agent`, `handoff` and the extension bus on the host, and pi 1.5.0 removed its own OS-sandbox example ([pi-and-harness.md](research/pi-and-harness.md) A, F "What breaks where").
- Rejected: open egress with the `fetch` tool removed. Removing `fetch` closes one door; bash (`curl`, `git`, `npm`, `pip`), package postinstall scripts, MCP servers and DNS stay open, and the host proxy is needed anyway for the token swap, so the allowlist is a config file on a component that exists regardless. Gateway-only egress (no allowlist, nothing but the LLM gateway reachable, git over ssh as the single extra rule) remains a valid stricter profile a company may choose; the plan's default is the allowlist.
- Rejected: RPC-driven pi in a container with a host UI. Clean boundary, but this repo's footer, composer, agent view, transcript panes and forms would need a new client.

### 2. Credentials: nothing real inside

- The image ships a `models.json` whose `baseUrl` per provider points at a corporate gateway (LiteLLM, Bifrost or Agent Router class) with format-correct placeholder keys, so pi's "No API key" check passes and `/model` lists the provider. Bedrock uses `AWS_BEDROCK_SKIP_AUTH=1` and the gateway re-signs ([credentials-and-egress.md](research/credentials-and-egress.md) B "Pattern A2/A3").

  | Provider path | Placeholder shape inside | Note |
  |---|---|---|
  | Anthropic API | literal `x-api-key` placeholder, never containing `sk-ant-oat` | that substring switches pi to OAuth mode, beta headers and tool remapping |
  | OpenAI-compatible | literal bearer placeholder | same "No API key" check as Anthropic |
  | Bedrock | `AWS_BEDROCK_SKIP_AUTH=1`, dummy SigV4 | gateway re-signs; or bearer path with a gateway token |
  | Vertex | none in the client | prefer the gateway's Anthropic- or OpenAI-compatible endpoint; ADC would need real GCP creds inside |
  | Google AI Studio | `x-goog-api-key` header placeholder | header-only replacement misses a `?key=` query form |

- The host proxy terminates TLS for the gateway host only and swaps the placeholder for a short-lived per-user token minted on the host from SSO (keychain). A placeholder sent to any other host is not swapped. The token the proxy injects comes from the configured credential source (`sso` in the enterprise profile, `host-pi-auth` or `static` otherwise, decision 8); the mechanism inside the boundary is identical for all three. Attribution comes from the boundary, not from headers set inside ([credentials-and-egress.md](research/credentials-and-egress.md) "Recommended combination" 4-5, D).
- The gateway holds provider keys, does SigV4/GCP/Azure, budgets and per-user audit. Exfiltrating the placeholder or even a minted token has near-zero value when the token is short-lived and the gateway is reachable only through the proxy ([credentials-and-egress.md](research/credentials-and-egress.md) A2 "Properties").
- Out of scope for the enterprise path: OAuth subscription logins (Claude Pro/Max, ChatGPT). Terms forbid third-party use and gateways cannot carry them. API and cloud accounts only. `/login` inside the guest fails because `auth.json` is mounted read-only with placeholders and OAuth token endpoints are blocked.
- Other outbound calls off with pi's switches: `PI_OFFLINE=1` (version check, catalog refresh, `rg`/`fd` download), `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and `enableInstallTelemetry: false`; `rg`, `fd` and this package baked into the image so nothing downloads at start.
- Env scrubbing: the container env carries no provider variables, because pi passes the full `process.env` to bash and MCP ([pi-and-harness.md](research/pi-and-harness.md) B). The shim passes an explicit allowlist (the terminal variables in decision 5) and nothing else, never the host `process.env`; that is also why Gondolin's default env passthrough is rejected.
- MCP server secrets: stdio MCP servers run inside and often need an API key. The proxy does per-host credential injection for allowed hosts (placeholder in the container, real header added by the proxy; OpenShell documents it as per-endpoint credential binding, Docker Sandboxes as credential swapping), so an MCP server is configured with a placeholder and never sees the real key. Servers whose protocol cannot be proxied this way (non-HTTP) are not supported in the enterprise profile.
- Git and registries: `git push` over https and private npm registries get the same per-host header injection; no `.npmrc` token, no git credential helper, no `GH_TOKEN` inside. No `/login` inside either: `pi login` on the host obtains or refreshes the credential for the configured source and stores it host-side only; nothing is written to the agent-state volume.
- Rejected: `apiKey: "!command"` fetching a real key (puts it in pi's memory); a proxy in the same container (key readable); Gondolin-style env passthrough.

### 3. Egress: one exit, deny by default

- The container has no default route; the only reachable endpoint is the host proxy (Docker `--network none` plus a Unix-socket relay, or an `--internal` network with the proxy dual-homed). `HTTPS_PROXY` is a client convenience, not the enforcement ([credentials-and-egress.md](research/credentials-and-egress.md) C).
- Allowlist on CONNECT by hostname with SNI matched to the target, the proxy resolving and dialing itself, no TLS interception for git, npm, pip and other registries. TLS termination only for the gateway host (and later private registries that need injected tokens).
- MCP hosts are allowed through the same list: policy declares the company's MCP hosts, a project's `.pi/mcp.json` may only pick servers on hosts already allowed, and a project file never adds a host.
- No resolver inside (internal Docker networks still resolve through embedded DNS, a known exfil channel); refuse IP literals, loopback, link-local and 169.254.169.254.
- Tools that ignore proxy env (Java, some Go transports, Node children without `NODE_USE_ENV_PROXY`) fail closed; the proxy returns a policy-denied body naming the host and rule instead of a bare 403.
- Corporate CA: the shim exports System keychain roots into the image trust store and sets `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO` wherever interception exists (Zscaler class or the gateway termination) ([developer-experience.md](research/developer-experience.md) D).
- Rejected: DNS-only allowlists (IP literals, DoH, DNS exfil); transparent TLS interception of all hosts (breaks pinning clients).
- Audit: proxy access log (CONNECT host, SNI, bytes, decision) per container and user, plus gateway spend logs per user and model, both shipped to the SIEM; pi `spending` stays a local estimate ([credentials-and-egress.md](research/credentials-and-egress.md) D).

### 4. Files

- Repo top-level (`git rev-parse --show-toplevel`; cwd itself as the plain fallback outside git) and its git common dir (`--git-common-dir`) mounted read-write at the same absolute paths as on the host. One repo per container. Reasons: sessions keyed by cwd, `trust.json` keyed by path, worktree metadata stores absolute paths, the subagents `.pi/worktrees` live under cwd, and a linked worktree otherwise cannot commit (the sbx failure) ([developer-experience.md](research/developer-experience.md) C).
- `.git/hooks` and `.git/config` overlaid read-only (`core.fsmonitor`, `core.hooksPath`, hooks are the documented attack path, finding 4). Cost: agents cannot run `git config`, add remotes or install hooks inside; worktree creation still works because it writes `.git/worktrees/`, not `config` (to be confirmed in Phase 0, see Not verified).
- `~/.pi/agent` on a named volume per user, writable (sessions, trust, model-default, style, `/agents setup`), with `models.json` and `auth.json` overlaid read-only from the image. Sessions inside do not mix with host pi sessions.
- `node_modules`, `.venv`, `target` and caches (`~/.npm`, `~/.cache/pip`) on named volumes when file-share speed demands it; host tools then see empty dirs there.
- Everything else read-only: `--read-only` root, tmpfs for `$HOME`; `/tmp` container-local and kept for the container's life (handoff documents, `pi-bash-*.log`). No Docker socket mounted.
- Symlinks out of the repo dangle on purpose; the shim warns once and offers an explicit read-only extra mount.

### 5. Launcher: a `pi` shim

- A small package from this repo, first on PATH. Hot path (target under 200 ms warm): find repo root and common dir (cwd itself outside git), read policy, check `workspaceRoots` if set, find the per-repo container by label (repo path hash, image digest, policy hash), start or create it if needed, `exec -it` the real pi with working dir = host cwd.
- Host install: pi itself is installed only in the image. The host installs the launcher package, which provides the `pi` command and must be first on PATH. An existing host pi installation is not required and, while the launcher is active, is unused; the launcher can print how to call it (for example `pi --no-sandbox`, only when policy allows). Host-side `pi login` is implemented by the launcher using pi's auth library rather than a full pi install (which login flows `@earendil-works/pi-ai` exports for reuse: Not verified). Consequence: this repo's extensions are installed in the image, not on the host, so the image is rebuilt when the extensions package changes; the launcher pins the image by digest and updates it in the background.
- Terminal: forward `TERM`, `COLORTERM`, `TERM_PROGRAM*`, `LC_TERMINAL`, `COLORFGBG`, `LANG` as an explicit env allowlist and nothing else (never the host `process.env`); pass initial size and SIGWINCH (the 80x24 bug class in Docker and sbx); ship `ncurses-term`; run an init process; set `PI_CLIPBOARD_OSC52=1`.
- Mounts the runtime's host ssh-agent socket (`/run/host-services/ssh-auth.sock` on Docker Desktop and OrbStack, `--ssh` on Apple `container`). No key material enters; the guest can sign with, not read, loaded keys. This is the sole credential-related capability that crosses the boundary. The strict alternative, a policy choice, is https git through the proxy with injected headers and no agent socket; a filtered agent is a later option.
- One host bridge socket for host-only actions: `open`, `pbpaste` for image paste, desktop notifications, `code -g path:line`/editor; OAuth callback relay on 127.0.0.1:1455/8085/51121 only if a login flow is ever allowed.
- Policy: a root-owned file managed by MDM (writable paths, allowlist, image digest, gateway URL), read by the shim only, mounted read-only into the guest; projects may only tighten. Optional `workspaceRoots: { roots: [...], outside: refuse | warn }` limits where `pi` may start (default unrestricted), so policy can forbid starting pi at `~` or `/`; it is independent of the `fallback` key below. Layers, profiles and settings are in decision 8. Fail closed when the runtime or proxy is missing or the policy is unreadable.
- Host-only subcommands go through the image, not the developer: `pi update` and `pi install` of pi itself are answered with "new image digest from policy"; package installs of extensions happen inside under egress policy; the image updates by background pull of the pinned digest.
- Cold path: one line ("preparing pi sandbox, one time"), never a build log; never auto-install a VM runtime.

### 6. Runtime backends behind one interface

| Backend | Role | Why |
|---|---|---|
| Docker Engine API | Default | Covers Docker Desktop (Business licences and Settings Management usually in place), OrbStack, Colima unchanged |
| Apple `container` | Second, macOS 26+ | Free, VM per container; no egress allowlist of its own, so only with the no-route plus host-proxy pattern |
| Docker Sandboxes (`sbx`, `docker.io/sbx/pi-kit`) | Evaluate in Phase 0, never the only path | Closest fit (microVM, same-path mount, allowlist, credential proxy, paid governance); closed binary, Docker sign-in, file-share issue, linked-worktree failure, 9.4 escape CVE |
| OpenShell | Not now, possible backend | Pre-1.0, weekly breaking changes, six CVEs, macOS via Docker Desktop or VM driver, SDK not on npm, no support |
| Gondolin | Watch | Pi authors' microVM, experimental, example passes host env into the VM |
| OS sandbox (srt-style Seatbelt or bubblewrap around all of pi) | Fallback, only where policy allows it | Visible warning that credentials and the proxy then share the user account; never silent |

The fallback and fail-closed rules meet through policy: `fallback: refuse` (enterprise default) makes the shim exit with the runtime IT must install; `fallback: os-sandbox` allows the weaker mode with the warning.

### 7. Per-agent layer inside the container

- A `sandbox` extension (second layer, cheap because the guest is always Linux) reads a `sandbox:` frontmatter key per agent definition: writable paths (default: the agent's cwd or worktree plus the git common dir), a network allowlist (a subset of the container's), or `false`.
- It overrides `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` with operations backends that run in bubblewrap plus Landlock bound to the child's `ctx.cwd`, covers `user_bash`, applies the allowlist and a private-address check to the subagents `fetch` tool (no allowlist or SSRF guard today, `extensions/subagents/core/fetch-tool/fetch.ts:94-110`), and scrubs env for MCP stdio servers.
- Seams: inline child extension factories in `platform/pi-adapter/child/child-runtime.ts:172-179` (the loader already loads user extensions in every child, `:166-171`); `SpawnSpec` (`platform/pi-adapter/types/runtime.ts:44-69`) gets a policy field flowing from `extensions/subagents/core/run-agent/runner.ts:741-753`; [../cwd/spec.md](../cwd/spec.md) supplies the per-agent cwd value (it gives the value, not enforcement). [pi-and-harness.md](research/pi-and-harness.md) F "Seams", "future-plans/cwd/spec.md".
- Interim no-code seam: `shellPath` set to a wrapper that execs `bwrap` around the shell. Covers model bash and `!` in main and children; does not cover read, write, edit, grep, find, ls, MCP or extension tools; per-agent policy only by deriving it from `$PWD` or `PI_SESSION_FILE`; settable in project settings only after trust.
- Related primitives in [../enterprise-workflow/harness/harness-side.md](../enterprise-workflow/harness/harness-side.md): 2.2 holds the `cwd` contract this layer confines to; 2.3, the per-agent MCP filter, is "a guard against accidental writes, not a sandbox" and stays that way.
- Not a security boundary on its own (same process, finding 5); it limits what one agent can do to another agent's files and the network, inside a container that already holds no credentials.

### 8. Configuration: nothing company-specific in the package

- Every company-specific value is configuration: gateway URL and auth style, image reference and digest, egress allowlist, MCP hosts, workspace roots, backend preference, `fallback`, idle timeouts, mount extras. The package ships a JSON schema and a documented default profile, no company values.
- Three layers, already in the plan: system/MDM policy (root-owned, wins), user config (`~/.pi/agent/sandbox.json` or similar; the exact path is Phase 1's choice), project config (`<repo>/.pi/sandbox.json`). In a solo or small-team profile there is no MDM layer, so the user file is the top.
- Two kinds of settings. Security settings (allowlist, credentials source, mounts outside the repo, `fallback`, `workspaceRoots`) may only be tightened by lower layers. Convenience settings (toolchain image or Dockerfile, extra cache volumes, idle timeout, published ports for dev servers, extra env allowlist entries that are not secrets) may be set by any layer.
- Credential source is pluggable, because a solo developer has no corporate gateway: `sso` (the host mints a token for the gateway), `host-pi-auth` (the host proxy reads the developer's own provider credentials on the host side and injects them; the container still sees only placeholders), `static` (a key from the host keychain or env, host side only). All three keep R2; only the issuer differs.
- Profiles are preset config files shipped with the package: `enterprise` (SSO, MDM policy, `fallback: refuse`, allowlist), `team`, `solo` (`host-pi-auth`, allowlist defaulting to the gateway plus common registries, `fallback: os-sandbox` allowed).
- `pi sandbox config` shows the effective merged config and which layer set each value; `pi sandbox config set <key> <value>` edits the user or project layer, and the shim refuses a change that would loosen a locked security setting, naming the layer that locked it. Changing the image or a mount recreates the container on the next `pi` start (the policy hash and image digest labels already drive this).

### 9. Deferred: one sandbox or process per agent

- `pi --mode rpc` per agent behind a second `AgentRuntime`. Not needed once credentials sit outside the whole box. Costs seconds per agent, breaks the in-process registry and semaphore, RPC has no custom-message command (`sendCustom`, `sendHidden`) and drops custom components, so this repo's UI breaks for those agents.
- Hold until multi-tenant use or untrusted repositories appear. [pi-and-harness.md](research/pi-and-harness.md) F "Seams" 1.

## Phases

### Phase 0: prove it on the company Mac, no product code

- Image: `node:24-bookworm-slim` base, pi 1.5.0, this package, `git`, `rg`, `fd`, `ncurses-term`, `socat`, tini; `models.json` with gateway `baseUrl` and placeholders; `PI_OFFLINE=1`, `PI_TELEMETRY=0`.
- Shim prototype on the Docker Engine API (script is enough): same-path mounts, ro overlays, named volumes, `exec -it` with env and size.
- Proxy: mitmproxy addon (~30 lines) or a small Node proxy; LiteLLM as gateway with a test virtual key; decide build vs buy for the proxy at the end.
  - Build-vs-buy criteria: host-bound placeholder swap, SSE streaming without buffering, WebSocket upgrade, per-user log lines, MDM-deliverable config, signed updates.
- Measure on the standard Mac per backend (Docker Desktop, OrbStack, Colima, Apple `container`): cold and warm start, `npm install` and `git status` on a large repo, worktree agent create and commit.
- Run `sbx run --kit docker.io/sbx/pi-kit:latest pi` side by side with the same repo and record the same numbers.
- Output: one table per backend (start times, file-share numbers, TUI defects, licensing) and a go or no-go for sbx as an optional backend.
- Acceptance:
  - [ ] Main session, a lead and a `worktree: true` agent run; the worktree is valid in host git.
  - [ ] `env` inside shows no provider variable; `auth.json` and `models.json` hold placeholders only.
  - [ ] Model calls work through proxy and gateway; gateway log shows the user from the host token.
  - [ ] `curl https://example.com`, `curl https://1.1.1.1`, `dig` and 169.254.169.254 fail from bash inside.
  - [ ] Warm start measured and compared to the 200 ms target; file-share numbers recorded against finding 8.
  - [ ] Footer, composer, agent view, OSC 52 copy, notifications and resize work in the default terminal.

### Phase 1: launcher package

- Deliverables: the `pi` shim with the backend interface (Docker API, Apple `container`), policy reader with MDM path and schema and JSON schema, the three layers and the shipped profiles of decision 8, `pi sandbox config` and `config set`, host proxy with CONNECT+SNI allowlist and gateway-only TLS termination, SSO token minting on the host, host bridge, cache and agent-state volumes, `pi sandbox status|gc|reset|config`, background image updates, completion that never starts the container.
- Acceptance:
  - [ ] Missing runtime, stopped proxy, unreadable or invalid policy, image digest mismatch: the shim refuses with a one-line reason (fail-closed tests).
  - [ ] Escape-class tests from inside: writes to `.git/hooks` and `.git/config` fail; a symlink to `~` dangles; no Docker socket; DNS and ICMP blocked; a placeholder sent to an allowlisted non-gateway host is not swapped; OAuth token endpoints blocked.
  - [ ] Linked worktree as project: commit works and host git sees it.
  - [ ] Config change: editing the project config (for example adding a cache volume or a published port) takes effect on the next `pi` start without any docker command; a loosening change to a locked security setting is refused with the locking layer named.
  - [ ] Corporate TLS inspection on: npm, pip, git and pi provider calls succeed.
  - [ ] Linux: files created inside are owned by the host UID.
  - [ ] Credential sweep: a test dumps the running container's environment, `~/.pi/agent/auth.json`, `~/.npmrc`, `~/.gitconfig`, `~/.aws`, `~/.config` and the whole writable filesystem and finds no real credential.
  - [ ] A provider request captured from inside the container carries only the placeholder.

### Phase 2: `sandbox` extension for per-agent policy

- Deliverables: `extensions/sandbox/` with the tool overrides and `user_bash` handler; `sandbox:` frontmatter in subagents; policy field on `SpawnSpec`; `fetch` allowlist and private-address check; MCP stdio env scrub; adapter exports for the operations backends through `platform/pi-adapter/index.ts` (only the adapter imports pi).
- Docs the AGENTS.md rule requires: `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` of `extensions/sandbox/` and of `extensions/subagents/` (frontmatter key, `SpawnSpec`), plus root `ARCHITECTURE.md` and `STRUCTURE.md`, checked by `test/docs-sync.test.ts`; the AGENTS.md file rule only if the extension writes files.
- Acceptance:
  - [ ] A read-only agent cannot write anywhere; a worktree agent writes only its worktree and the git common dir; `sandbox: false` runs as today.
  - [ ] `fetch` refuses hosts outside the agent's list and private addresses.
  - [ ] Bubblewrap and Landlock start inside the container under the default runtime profile, or the agent is refused (fail closed).
  - [ ] `npm run check` green.

### Phase 3: deferred

One process per agent (decision 9), when multi-tenant or untrusted-repo needs appear.

Also deferred: running pi in a parent folder holding several repos so agents can take a cwd in another repo. Two facts worth keeping: pi collects `AGENTS.md` and the other context files walking up from cwd, never down (`dist/core/resource-loader.js:130`, `:73-87`), and project `.pi/` resources come from `<cwd>/.pi`, so children in child repos would need their own resource resolution defined by the [cwd plan](../cwd/spec.md); and a linked worktree whose git common dir is outside the mounted folder would be unsupported in the container.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| File-share performance on macOS (virtiofs ~2.8x native npm, sbx Maven ~5x) | Builds and installs feel slow; developers bypass | Dependency dirs on named volumes (3.2-4.1 s); OrbStack or synchronized file shares where licensed; measure in Phase 0 |
| Corporate TLS-inspecting proxies | Nothing works on day one ("self-signed certificate in chain") | Export System keychain roots at start; set CA env vars; chain the host proxy upstream to the corporate one |
| Placeholder format drift per provider | Pi rejects or misroutes a placeholder (Anthropic `sk-ant-oat` switches to OAuth mode) | Placeholders per provider in the image, tested against each pi upgrade; gateway path keeps one shape per provider |
| Gateway cost and usage for `/spending` | Pi prices from its catalog times usage, so list price, not negotiated; translating gateways may drop cache fields | Pass-through gateway routes; model IDs matching pi's catalog; gateway spend logs as the source of truth |
| Read-only `.git/config` | Agents cannot add remotes, set config or install hooks | Document; host-side `git` for those; revisit per project via policy |
| Docker Business licensing ($24/user/month above the SMB threshold) | Cost or procurement delay | Docker Engine API also serves OrbStack and Colima; Apple `container` on macOS 26 |
| Runtime CVE cadence (sbx six 2026 CVEs, OpenShell six, Apple container advisories) | A boundary escape between patches | Pin runtime versions through MDM; credentials outside limit the blast radius; no Docker socket; track advisories |
| Developers run pi outside the shim (`npm i -g`, `npx`) | Unsandboxed pi on the host | An MDM and PATH problem: MDM protects the shim and runtime settings; the decisive control is that no real provider key exists on the laptop and the gateway accepts only proxy-minted tokens, so a bypassing pi has no model access |
| Landlock inside Docker Desktop VirtioFS mounts (OpenShell #4733 silently denies reads) | Phase 2 layer breaks reads | Test in Phase 0 on each backend; bubblewrap bind rules as the fallback mechanism |

## Open questions

- Gateway vendor: LiteLLM, Bifrost, Agent Router, an existing internal gateway, or Radius; who runs it and where.
- MDM product (Jamf, Kandji, Intune) and whether it can deliver a root-owned policy file and protect the shim binary.
- Docker Business already licensed, or OrbStack or Colima as the standard runtime.
- macOS fleet version (Apple `container` needs macOS 26; sbx needs 14+ on Apple silicon; Intel Macs remain).
- Windows: WSL2 with the Linux shim, or out of scope.
- SSO flow for the host token (OIDC device flow, MDM-issued device certificate) and its TTL.
- Which git remotes dominate (ssh agent vs HTTPS with injected tokens), and whether commit signing is required.

## Not verified

- Warm `docker exec -it` / `container exec -t` latency on Docker Desktop, OrbStack, Colima, Apple `container`; cold start of Colima, Apple `container`, sbx, OpenShell, Gondolin (vendor claims and anecdotes only).
- Whether pi's undici dispatcher (`proxyTunnel: true`) trusts a TLS-terminating proxy through `NODE_EXTRA_CA_CERTS` (confirmed by Node docs, not exercised end to end).
- Whether bubblewrap and Landlock run inside a container under the default seccomp profile without extra privileges (no research file covers it).
- Whether `git worktree add` and normal commits succeed with `.git/config` read-only.
- Docker Sandboxes: hypervisor per OS, official startup time, governance price, source publication, CA lifecycle (the proxy CA is seen only in a user-filed issue), WebSocket upgrade injection, injection for arbitrary custom hosts, fix version of CVE-2026-17106, whether pi is first-class or kit-only.
- OpenShell: default `enforcement` in v0.1.6, whether the endpoint binding that closed #896 (endpoint-blind injection) covers every injection path, whether `--from pi` still resolves after the catalog retirement, commercial support, VM first-boot time (10-30 s is from the October pass), inference-routing pages (404).
- Gondolin's network model and secret binding (DeepWiki only); license is Apache-2.0.
- Apple `container`: bind-mount performance, egress filtering beyond isolated networks, host-only network flag name, `--ssh` guest socket path, TERM default, UID/GID presentation.
- Inotify propagation of host edits per runtime; UID/GID presentation under sbx.
- SIGHUP propagation through `docker exec` when the terminal closes.
- Which kitty graphics transmission mode pi uses; Kitty keyboard protocol through each runtime's exec path; capability detection without `TERM_PROGRAM`.
- Gateway `baseUrl` with OAuth-subscription providers; whether pi's Google adapter sends the key as a query parameter; whether pi-mcp HTTP transports use pi's global dispatcher.
- Per-tool proxy and CA behaviour list (general knowledge); pip truststore default version.
- Agent Router SigV4 and token metrics; TensorZero, Portkey, Kong licenses; Bifrost latency claims.
- Anthropic's April 2026 subscription OAuth block date (secondary sources).
- Claude Code `allowManagedDomainsOnly` and `enableWeakerNetworkIsolation` semantics (source mirror only).
- Docker `registry.json` sign-in enforcement, the <250 staff / <$10M free tier, ECI subscription tier; OrbStack pricing, MDM keys and admin lock-down; Docker Desktop and OrbStack minimum macOS versions.
- Copilot local sandboxing GA vs preview; Codex managed networking key names; Cursor cloud and background agents; Amp approvals; Jules egress; Devin allowlist granularity; SOC 2 or ISO status of any vendor; arXiv 2606.08433 and 2607.05743 contents.
- gVisor startup and I/O penalty; WSL2 `/mnt/c` performance; Windows Terminal kitty graphics.
- `@earendil-works/pi-env` and the durable harness; owner of `oauth.json` in the agent dir; upstream issue numbers cited by the October pass.
- Seatbelt overhead covers process start only, not per-syscall cost.
