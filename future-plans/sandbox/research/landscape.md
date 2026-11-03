# Coding-agent sandboxing landscape

Research date: 2026-11-02; runtime entries (Apple `container`, Colima, Lima, Podman, nerdctl, Rancher Desktop, Linux without a VM, licence and cost) updated 2026-11-03 for the no-Docker decision. Facts marked "(seen 2026-11-03)" were read that day, mostly through the GitHub API.

Method: vendor docs, GitHub READMEs, release notes and security advisories (GitHub API via `gh`), CVE.org records (cveawg.mitre.org API), NVIDIA's bulletin source in `NVIDIA/product-security`, plus web search. Every URL below was seen on 2026-11-02 unless a different date is given; "published" dates are the source's own. "(secondary)" marks blogs, aggregators or search summaries not confirmed at a primary source. "CHANGED" marks a correction or update against the 2026-10-20 pass.

Requirements used to judge relevance: R1 model tokens outside the boundary, R2 only cwd writable, R3 egress allowlist by domain, R4 central non-loosenable policy plus audit on macOS/Linux laptops, R5 `pi` just works with no visible container lifecycle.

## A. How the agents sandbox today

### Claude Code (local CLI)
- Docs: https://code.claude.com/docs/en/sandboxing
- Mechanism: Seatbelt on macOS; bubblewrap plus a separate network namespace on Linux and WSL2 (needs `bubblewrap`, `socat`; optional seccomp filter blocks Unix sockets); native Windows is not sandboxed; WSL1 unsupported. Built on `@anthropic-ai/sandbox-runtime`.
- Off by default (`/sandbox` or `"sandbox": {"enabled": true}`).
- Scope: Bash, PowerShell and Monitor commands and their children. Outside the boundary: Read/Edit/Write, WebFetch, WebSearch, MCP servers, command hooks, plugin monitors, LSP servers, status line, `apiKeyHelper`, `!` commands, `excludedCommands`, unsandboxed retries. The Claude Code process and its model credential stay on the host.
- Filesystem: writes allowed to cwd, a per-user temp dir and added dirs; reads allowed almost everywhere including `~/.ssh` and `~/.aws/credentials` unless denied. Protected (write-denied even inside cwd): `.claude` settings and hooks, `.mcp.json`, shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, `~/.claude`.
- Network: no direct route; host proxy checks hostnames; allowlist starts empty. Keys: `sandbox.network.allowedDomains`, `deniedDomains`, `strictAllowlist` (v2.1.219+, deny instead of prompt), `allowManagedDomainsOnly`, `tlsTerminate` (experimental, off: no TLS inspection by default), `httpProxyPort`/`socksProxyPort` (hands filtering to your own proxy). Hosts resolving only to local addresses are refused.
- CHANGED: credentials block `sandbox.credentials` with `files`/`envVars` in `mode: "deny"` or `mode: "mask"`. Mask gives the sandbox a per-session sentinel; the proxy substitutes the real value for `injectHosts`; needs `tlsTerminate`; on macOS `mask` file entries behave like `deny`; only honoured from user, managed or `--settings` scope; no built-in credential deny list. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips credentials from all subprocesses.
- Enterprise: managed `failIfUnavailable`, `allowUnsandboxedCommands: false` (with it or `allowManagedDomainsOnly`, repo settings that loosen the sandbox are ignored), `allowManagedReadPathsOnly`, locks for `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `allowNestedUserNamespaces`.
- Delivery of policy (https://code.claude.com/docs/en/server-managed-settings): server-managed (fetched at start, hourly refresh) or endpoint-managed (MDM plist, registry, `managed-settings.json`). Anthropic states server-managed settings are "a client-side control, not a security boundary"; a modified binary, older version, a third-party provider env var or a non-default `ANTHROPIC_BASE_URL` bypasses them. `forceRemoteSettingsRefresh: true` makes startup fail closed. Settings-change audit events via compliance API.
- Latency: in-process wrapper per command; Seatbelt wrap measured locally at about 6 ms (`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`, macOS 27.2 build 26B123, this machine, 2026-11-02).
- UX: invisible; prompts for unlisted hosts unless strict.

### Claude Code on the web / cloud sessions
- Docs: https://code.claude.com/docs/en/claude-code-on-the-web
- Each session runs in an isolated Anthropic-managed VM, or on the customer's self-hosted environment (isolation is then the customer's job).
- Network: limited by default (Default environment uses "Trusted" access with a default allowed-domain list), can be disabled; the Anthropic API stays reachable even with network off ("may allow data to exit the VM").
- Credentials: GitHub credentials stay encrypted on Anthropic servers and never enter the VM; a GitHub proxy attaches them server side. "Network secrets" added to an environment are also attached outside the VM. This is the R1 pattern applied to git and arbitrary secrets.
- Not available for ZDR, HIPAA or CMEK orgs; org IP allowlisting breaks hosted sessions.
- UX: the CLI shows a provisioning checklist; local checkout is cloned from GitHub or uploaded as a bundle (under 100 MB, untracked files excluded). Not a live mount of the local tree.

### Anthropic sandbox-runtime (`srt`)
- Repo: https://github.com/anthropics/sandbox-runtime (CHANGED: now under `anthropics`, the old `anthropic-experimental` URL resolves to it). Apache-2.0. Beta research preview.
- CHANGED version: 0.0.81 on npm, published 2026-10-20 (0.0.78 2026-09-30, 0.0.79 2026-10-07, 0.0.80 2026-10-16) per https://registry.npmjs.org/@anthropic-ai/sandbox-runtime ; repo pushed 2026-10-30.
- macOS: `sandbox-exec` with generated Seatbelt profiles; violation monitoring reads the system sandbox log. Linux: bubblewrap, network namespace, host proxies over Unix sockets, seccomp blocks Unix sockets (x64/arm64). Windows alpha: dedicated `srt-sandbox` local account, WFP egress filter, write-restricted token, NTFS ACEs; Schannel tools (`curl.exe`, PowerShell, .NET HttpClient) do not work.
- Network: HTTP/HTTPS plus SOCKS5 proxies enforce `allowedDomains`/`deniedDomains` (wildcards, `:port`); resolved-address check blocks allowed names resolving to loopback, link-local, metadata or private ranges. Experimental TLS termination lets `filterRequest` inspect and rewrite; `excludeDomains` tunnels pinned/mTLS hosts.
- Credentials: `credentials.envVars`/`credentials.files` with `deny` or `mask`; mask needs `tlsTerminate` unless `allowPlaintextInject`; file masking Linux only.
- Extras: `srt proxy` standalone proxy with external decider, `--control-fd` live config, library API with per-command network lists.
- Advisories: one, GHSA-9gqj-5w7c-vx47 / CVE-2025-66479 (low): network sandbox not enforced when no allowed domains were configured; fixed v0.0.16 (https://github.com/anthropics/sandbox-runtime/security/advisories/GHSA-9gqj-5w7c-vx47).

### OpenAI Codex CLI and Codex cloud
- Docs: https://learn.chatgpt.com/docs/agent-approvals-security.md (CHANGED: developers.openai.com/codex now 308-redirects to learn.chatgpt.com).
- Modes `read-only`, `workspace-write`, `danger-full-access`; Auto preset is `workspace-write` plus `on-request`.
- macOS: Seatbelt via `sandbox-exec`. Linux: `bwrap` plus seccomp by default (a `codex sandbox landlock` alias still exists). CHANGED Windows: Microsoft MXC (`prefer_mxc = true` under `[features]`), `elevated`/`unelevated` as legacy fallbacks; WSL1 dropped from 0.115.
- Network: off in `workspace-write` unless `[sandbox_workspace_write] network_access = true`. Proxy `[features.network_proxy]` with `domains` (allowlist-first; `*.x` subdomains, `**.x` includes apex; deny wins), `unix_sockets`, `allow_local_binding`, `enable_socks5`, `allow_upstream_proxy`. Docs: the proxy does not cover web search, app/MCP connections, "or the client's own model traffic".
- Protected inside writable roots: `.git` (and resolved gitdir), `.codex`, `.agents`, `.aws`.
- Enterprise: `requirements.toml`; MDM and legacy managed-device requirements take precedence over "Agent Security", which takes precedence over the system file; locked managed networking cannot be widened by user config (https://developers.openai.com/codex/config-reference, secondary search summary). Key naming conflicts between `experimental_network` and `application.network.domains` across OpenAI pages.
- Credentials: model auth stays in the Codex process outside the command sandbox; Riptides found the token file, `~/.ssh` and `*TOKEN*` env vars reachable from sandboxed commands (see E).
- Codex cloud: setup phase has network and secrets; secrets removed before the agent phase, which runs offline by default; per-environment internet toggle or domain allowlist.
- Latest release rust-v0.166.0, 2026-10-29 (GitHub releases).

### Gemini CLI
- Docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md
- Opt-in: `-s`/`--sandbox`, `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`, or `tools.sandbox` in settings.
- macOS Seatbelt profiles `permissive-open` (default), `permissive-proxied`, `restrictive-*`, `strict-*`; `-proxied` variants route network via a proxy. Docker/Podman image `ghcr.io/google/gemini-cli:latest` with cwd mounted at the same absolute path; `SANDBOX_MOUNTS` extra mounts (default ro). gVisor `runsc` on Linux (explicit), LXC experimental, Windows `icacls` low-integrity labels that persist after the session.
- No documented credential separation or admin enforcement. Riptides: default macOS profile allows reads of `~/.ssh`, `~/.aws`, gcloud config; container mode mounts gcloud credentials read-only.

### GitHub Copilot CLI and coding agent
- Changelog (published 2026-10-07): https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available/ says local sandboxing is GA for Copilot CLI, the Copilot app and VS Code Agent Host sessions, using MXC to translate one policy to native controls; no extra charge. Conflict: docs pages still say "public preview" (search summary of https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing).
- CHANGED backends (docs): Seatbelt on macOS, bubblewrap 0.5.0+ plus `slirp4netns` on Linux, ProcessContainer BaseContainer tier on Windows 11 25H2/26H1 with specific KBs (https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings).
- Defaults: app sandbox off unless enterprise requires it; CLI outbound internet on, local network off, no host rules ("other hosts remain allowed"); cwd and `.git` read-write.
- Credentials: placeholder `GH_TOKEN`; a local proxy adds the real token only for `github.com`, `api.github.com`, `uploads.github.com`. Git and gh credentials on by default.
- Enterprise: managed settings set a floor; "Enterprise rules can only narrow your allowlist, never widen it"; when required, `--no-sandbox` and `/sandbox disable` cannot turn it off.
- Coding agent (cloud, Actions runner): firewall on by default with a recommended allowlist; applies only to processes the agent starts via its Bash tool, not to MCP servers or setup steps; org owners can stop repos adding rules (https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall, search summary).

### Cursor
- Docs: https://cursor.com/docs/agent/security/run-modes
- macOS Seatbelt (Cursor 2.0+); Linux Landlock v3 plus seccomp, kernel 6.2+ and unprivileged userns, otherwise approval prompts; Windows not covered on that page.
- Shell commands only; Auto-review sandboxes when possible; failed commands can be rerun outside after classifier review.
- Writes: workspace plus temp; reads controlled separately (Read Allowlist, 3.23+). Network modes "sandbox.json Only", "sandbox.json + Defaults" (default, common registries and code hosts), "Allow All".
- Protected: `.git/config`, `.git/hooks`, `.vscode`, `.cursorignore`, Cursor config. No credential protection documented for local runs; Riptides notes `~/.ssh` is always readable and secret redaction applies only to cloud agents.
- Team policy overrides user and project config.
- Cloud agents: one VM per agent on Firecracker microVMs in Cursor's AWS; egress modes allow all / default plus allowlist / allowlist only; internet on by default; secrets encrypted, redacted from the model, injected at agent start; self-hosted cloud agents since 2026-03-25 (https://cursor.com/docs/cloud-agent/security, https://cursor.com/changelog/03-25-26, search summary).

### Amp
- Manual (https://ampcode.com/manual) documents no shell sandbox; agents run locally (CLI) or in Amp-created cloud machines ("orbs"), plus a "Use Your Mac as a Runner" mode. Enterprise sections list MCP registry allowlist, allowed models, minimal data retention. Third-party guides conflict on default approvals (secondary: https://www.verdent.ai/guides/agents/amp-coding-agent).

### Goose (now AAIF)
- CHANGED: the experimental macOS Seatbelt sandbox with egress proxy was removed in v1.25.0 (https://goose-docs.ai/blog/2026/02/23/goose-v1-25-0/ marks the section outdated). Issue #12805 (opened 2026-10-09, open): the server process and `shell` tool run with full user rights; a Linux prototype (PR #12545) is not a boundary; `GOOSE_MODE` prompts are not a sandbox (https://github.com/aaif-goose/goose/issues/12805). Advisory GHSA-r5pp-p5r8-466r / CVE-2026-72718 (2026-07-24): command execution via `goose review` and `core.fsmonitor`.

### OpenCode
- No built-in OS sandbox found; community Docker wrappers only; issue #2242 discusses bubblewrap (https://github.com/anomalyco/opencode/issues/2242). Advisories are about its local HTTP server and web UI (CVE-2026-22812, CVE-2026-22813, 2026-01-12; GHSA-632h-h47v-g4x4, 2026-09-24).

### Devin
- Each session on its own isolated machine; "Devin Brain" container per session in Cognition's tenant; VPC/dedicated option puts the DevBox in the customer network with a websocket to the brain; secrets decrypted at session start into env vars and redacted in the UI; docs say egress is required and internet access "strongly recommended"; no fine-grained egress allowlist documented (https://docs.devin.ai/enterprise/vpc/overview, search summary).

### Factory Droid
- Docs: https://docs.factory.com/autonomy-and-safety/sandbox.md (CHANGED: docs.factory.ai redirects to docs.factory.com).
- Seatbelt on macOS; bubblewrap plus seccomp on Linux/WSL2; blocks instead of running unisolated when primitives are missing.
- `sandbox.mode`: `per-command` (default; main Droid process not isolated) or `whole-process` (whole Droid, MCP transports, subagents; Droid's own requests filtered against `allowedDomains`; refuses to start if the sandbox fails). This is the only vendor-documented whole-process local mode found.
- Network deny by default except Factory and WorkOS domains; HTTP/SOCKS proxy. Settings merge org > project > user; `denyRead`/`denyWrite` union-merge so org denies cannot be removed; admins can set the mode org-wide.

### Jules
- "a secure, short-lived virtual machine" running Ubuntu per task (https://jules.google/docs/environment/); egress and secret handling not documented on that page.

## B. Container and microVM runtimes for a laptop

### Docker Sandboxes (`sbx`)
- Docs: https://docs.docker.com/ai/sandboxes/ , /architecture/, /security/, /governance/, /install/
- CHANGED status: CLI `sbx`, releases at https://github.com/docker/sbx-releases (v0.50.1 2026-10-28, v0.51.0-rc6 2026-10-30); repo license NOASSERTION (binary distribution, source not published). Docs do not say "GA".
- Platforms: macOS Sonoma 14+ on Apple silicon; Windows 11 x64 with Windows Hypervisor Platform; Ubuntu 24.04+ with KVM (derivatives unsupported). Docker Desktop not needed. `sbx login` (Docker OAuth) required.
- Isolation: one microVM per sandbox with its own Docker daemon and image cache; hypervisor not named per OS.
- Workspace: direct mount at the same absolute path, "changes in either direction are instant", virtiofs caching on; also mountless mode and clone mode (host repo read-only, agent works in a private clone).
- Network: all outbound TCP through a host-side proxy, deny-by-default; default allowed domains include broad wildcards like `*.googleapis.com`; `sbx policy ls`; upstream proxy chaining for HTTP/S only; ICMP blocked; UDP experimental.
- Credentials: stay on host; agent sees a sentinel; proxy adds auth headers; "The raw credential values never enter the VM." Fits R1.
- Agent has root inside VM; documented risks: direct-mode writes to git hooks, CI config and `package.json` scripts land on the host; local stdio MCP servers run on the host.
- Governance: org-level network, filesystem and MCP policies in Docker Home or the Governance API; with org governance on, "only organization allow rules grant access" and local deny rules still apply; sign-in enforcement via endpoint management; audit logs; "separate paid subscription", price unpublished. Local CLI and compute free including commercial use.
- Pi kit: https://github.com/docker/sbx-kits-contrib/tree/main/pi ; image `docker.io/sbx/pi-image` installs `@earendil-works/pi-coding-agent` at `latest`, rebuilt nightly; allowlist `api.anthropic.com`, `registry.npmjs.org`, `platform.claude.com:443`; `~/.pi/agent/auth.json` written with sentinels at sandbox start; "Do not authenticate from inside the sandbox". Run: `sbx run --kit docker.io/sbx/pi-kit:latest pi` (pi's own docs, below).
- Startup: no official number; 2-5 s over native is a secondary estimate (https://codex.danielvaughan.com/2026/04/13/docker-sandboxes-codex-cli-microvm-isolation/).
- CVEs: see E (six 2026 CVEs including a 9.4 macOS virtio-fs escape).

### Pi's own guidance (new since October)
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md lists four methods: plain Docker (credentials passed in), Docker Sandboxes (provider credential on host, proxy substitution), OpenShell (`openshell sandbox create --name pi-sandbox --from pi -- pi`), and the Gondolin extension (host pi, built-in tools and `!` commands in a microVM; "Commands inside the VM inherit the host process environment", so not a credential boundary as shipped).
- Gondolin: https://github.com/earendil-works/gondolin , Apache-2.0, "Experimental", v0.14.0 2026-10-22; QEMU by default, experimental libkrun backend; macOS and Linux; TypeScript control plane with `allowedHosts` and per-host secrets where "The guest only sees a placeholder token"; guest assets about 200 MB on first use.
  - (seen 2026-11-03) Its own egress policy: a host-side userspace network stack that "does not rely on host firewall rules", HTTP/TLS allowlist, internal ranges blocked, DNS modes synthetic, trusted or open, optional allowlisted SSH egress (docs/network.md). Placeholder secrets are swapped only for the hosts bound to them and a placeholder sent elsewhere is blocked (docs/secrets.md). The library's docs show env supplied explicitly; the host-env inheritance is the pi extension example's behaviour (pi's containerization.md), which the plan rejects as a default. QEMU is in the trusted base (docs/security.md).

### Apple `container` and Containerization
- https://github.com/apple/container , Apache-2.0. CHANGED: 1.0.0 shipped 2026-06-09; current 1.6.1 (2026-10-23); versions "are product versions, not semantic versions". Apple silicon, supported on macOS 26 (macOS 15 runs with limitations Apple will not fix).
- (seen 2026-11-03) Cadence and churn: 11 releases from 1.0.0 (2026-06-09) to 1.6.1 (2026-10-23), before that 0.11.0 to 0.12.3 (2026-03-31 to 2026-04-30); release notes mark breaking CLI changes in 1.0.0 (two), 1.3.0 and 1.5.0. https://github.com/apple/container/releases
- (seen 2026-11-03) Requirements: "You need a Mac with Apple silicon"; "supported on macOS 26 ... maintainers typically will not address issues that cannot be reproduced on macOS 26" (README). On macOS 15 `container network` commands are unavailable and `--network` errors (docs/technical-overview.md). No Intel support.
- (seen 2026-11-03) Network flags (docs/command-reference.md): `--network none` added by PR #739 (merged 2025-10-21, closes #386); `container network create --internal` "Restrict to host-only network"; `--no-dns`; `--publish-socket host_path:container_path` publishes a socket from container to host, the wrong direction for reaching a host proxy; #1037 (closed 2026-01-27) asked for port publishing under `--network none` and names `--publish-socket` plus socat as the workaround; #2101 (open, 2026-08-08) `--publish-socket` cannot relay a socket on tmpfs with `--read-only`.
- (seen 2026-11-03) ssh agent: `--ssh` "Forward SSH agent socket to container" on `run` and `create` (PR #502, 2025-08-15); guest path changed to `/var/host-services/ssh-auth.sock` because init systems remount `/run` (PR #1441, merged 2026-04-22); #1189 (closed 2026-02-10) socket did not follow a changed `SSH_AUTH_SOCK`; #2247 (open, 2026-09-07) parallel clients of the forwarded agent hang and can freeze the terminal.
- (seen 2026-11-03) Exec TTY: `container exec` takes `--tty`, `--interactive`, `--user`, `--workdir`. #2299 (open, 2026-09-23): `container exec -it` leaves the host tty in `OPOST|ONLCR`, so every bare LF becomes CRLF and full-screen programs (tmux, vim, Ink-based TUIs) draw at column 0; a commenter (2026-09-25) traces it to `Terminal.setraw()` in Containerization. SIGWINCH forwarding work in #1854 (closed 2026-06-27) and #1909 (open). #378 (open, 2025-07-26) asks to attach a terminal to a running container.
- (seen 2026-11-03) Mounts: `-v` and `--mount` bind mounts are virtiofs; #948 (2025-12-10, closed) filesystem throughput slower than Multipass and Docker; #1251 (2026-02-23, closed) single-file mounts failed intermittently; #1209 (2026-02-13) corrupted symlinks on a virtiofs volume; #1937 (open, 2026-07-12) intermittent permission errors on hard links; #165 (open, 2025-06-12) asks for bind mounts with a specific UID/GID. No Docker Engine API; own CLI plus the XPC `container-apiserver` (docs/technical-overview.md).
- One lightweight VM per container via Containerization and Virtualization.framework; vmnet networking; separate networks are isolated from each other (docs/technical-overview.md, docs/networking.md). No egress allowlist or proxy feature found in the docs.
- 2026 advisories: CVE-2026-113951 (high, 2026-09-29) K8s plugin kubeconfig allows host command execution; CVE-2026-64786 env inheritance; CVE-2026-64777 build sync symlink disclosure; several containerization symlink issues (release notes 1.2.0 to 1.6.0).
- Bind-mount performance: no public benchmark found (secondary: https://tech-insider.org/au/apple-containers-vs-docker-vs-orbstack-2026/).

### NVIDIA OpenShell
- See C.

### OrbStack
- Proprietary; commercial use needs a per-user license; 30-day Pro trial then personal-use tier (https://docs.orbstack.dev/licensing). CHANGED: Pro $8/user/month, $96 billed annually; Free is "Personal, non-commercial use" (https://orbstack.dev/pricing , seen 2026-11-03). 2025 benchmark: bind mount 4.22 s vs Docker VZ 9.53 s vs Lima 8.99 s (https://www.paolomainardi.com/posts/docker-performance-macos-2025/, secondary).

### Colima and Lima
- Lima v2.2.1 (2026-10-03), Apache-2.0, CNCF incubating. Colima v0.10.3 (2026-06-04), MIT; `--vm-type=vz` uses Virtualization.framework. No commercial support; no egress policy.
- Colima (seen 2026-11-03, https://github.com/abiosoft/colima): "Containers on Lima"; vmType qemu, vz, krunkit (experimental); default vz on macOS 13+ else qemu (`environment/vm.go`; the template comment still says qemu); runtimes docker (default), containerd, incus, k3s. Docker socket `$HOME/.colima/default/docker.sock` (docs/FAQ.md); it is the real dockerd, so Docker API clients work unchanged. Default mount `$HOME` writable; `mountType` virtiofs (vz default), sshfs (qemu default), 9p; `mountInotify` experimental (embedded/defaults/colima.yaml). Lima overrides through `~/.colima/_lima/_config/override.yaml` (FAQ).
- Colima ssh agent: `-s/--ssh-agent`, config `forwardAgent`, via Lima `ssh.forwardAgent` (cmd/start.go). Into containers: mount the VM's `$SSH_AUTH_SOCK` (maintainer, #127 comment, 2022-01-17); #942 (open, 2023-12-21) uses `/run/host-services/ssh-auth.sock` on 0.6.7 and shows it turning into a directory after `colima stop`/`start` with a running container; #1330 (open, 2025-05-30) declared `SSH_AUTH_SOCK` not mapped.
- Colima maintenance: releases v0.9.0 (2025-09-24), v0.9.1 (2025-09-25), v0.10.0 (2026-02-10), v0.10.1 (2026-02-22), v0.10.2 (2026-06-03), v0.10.3 (2026-06-04); commits continue to 2026-10-02 with no release. abiosoft authored 508 commits and merged all of the last 9 PRs (2026-07-24 to 2026-10-02); about 110 contributors; about 379 open issues. One maintainer in practice.
- Colima mount issues, no benchmark numbers in any of them: #1258 (open, 2025-01-27) virtiofs permission denied; #841 (open, 2023-11-06) writable volume with vz and virtiofs; #1552 (closed, 2026-04-05) zombie containers with Lima 2.x and virtiofs. The template ranks virtiofs fastest (vz only), sshfs faster than 9p but least reliable under heavy concurrent I/O.
- Lima (seen 2026-11-03, https://github.com/lima-vm/lima , https://lima-vm.io/docs/): v2.3.0-rc.0 2026-10-30; vmType vz (default on macOS 13.5+), qemu, krunkit; mount types reverse-sshfs, 9p, virtiofs (vz), default virtiofs for vz and 9p for qemu since Lima 1.0; containerd and rootless nerdctl by default; `ssh.forwardAgent` default false; `portForwards` with `guestSocket`/`hostSocket` and `reverse` for Unix sockets; #5420 (closed, 2026-08-17) socket forwards die with the ssh ControlMaster, silently on vz. Network: user-mode default, host at `host.lima.internal` (192.168.5.2); v2.3 adds `networkOpts.hostLoopback: false` (vz only, rc only). No egress allowlist; no option for a VM without a default route found. #834 (open, 2022-04-30): sockets on 9p (and likely sshfs) mounts are visible but do not connect. Active maintainers AkihiroSuda (41 of the last 100 commits) and jandubois (25).
- What Colima adds over Lima: dockerd (or containerd, incus, k3s) set up in one command, the `docker.sock` socket and Docker context, profiles, a short flag set.

### nerdctl and containerd
- nerdctl v2.4.2 (2026-10-30), Apache-2.0, "Docker-compatible CLI for containerd" (https://github.com/containerd/nerdctl , seen 2026-11-03). containerd speaks gRPC, not the Docker Engine API (no statement to the contrary found; Not verified at containerd docs), so an OCI engine API client cannot drive Lima's default containerd or Colima's containerd runtime; it needs Colima's docker runtime or Podman's compat socket.

### Rancher Desktop
- Apache-2.0, v1.24.0 (2026-07-29), https://github.com/rancher-sandbox/rancher-desktop (seen 2026-11-03). Lima underneath on macOS and the dockerd or containerd choice: Not verified this pass.

### Podman and Podman Desktop
- v1.30.5 (2026-10-13), Apache-2.0; Red Hat backs Podman. No agent-specific egress or credential features.
- CHANGED (seen 2026-11-03): the repo moved to https://github.com/podman-container-tools/podman ; Podman is Apache-2.0; latest stable v6.1.4 (2026-10-12), v6.2.0-rc1 (2026-10-26), v5.8.9 still maintained (2026-10-12); v6.0.0 (2026-06-24) made libkrun the default macOS machine provider (applehv the alternative, macOS 13+; libkrun needs `krunkit`, arm64 build tag). https://github.com/podman-container-tools/podman/releases/tag/v6.0.0
- Docker-compatible socket: `podman machine inspect` gives `ConnectionInfo.PodmanSocket`; `podman-mac-helper install` manages the `/var/run/docker.sock` link; `podman system service` serves a Docker v1.40 compat API plus the libpod API, used with `DOCKER_HOST` (docs/source/markdown/podman-system-service.1.md). Machine is rootless by default (`--rootful` false), default volume `$HOME:$HOME`; `--userns=keep-id` maps the host UID:GID in.
- ssh agent on macOS: nothing built in. #23785 (open since 2024-08-28, activity 2026-10-23): "Since the move to virtiofs, you can no longer share the SSH agent from the macOS host into a Podman container"; community workaround `podman machine ssh -- -R /tmp/ssh-agent.sock:"$SSH_AUTH_SOCK" -N` then bind-mount that VM path. #27630: a maintainer (2026-09-10) says virtiofs has no support for sockets crossing the VM boundary.
- I/O: #27216 (2025-10-02, Podman 5.6.0) MySQL import about 60 min on libkrun vs 3m32s after switching to applehv; #16994 (closed 2024-06-15) slow stat on the old QEMU/9p path.
- Network: no egress allowlist; rootless default `pasta` with `--no-map-gw` and no automatic port forwarding, but host routes are copied so egress exists; `--network none`; `podman network create --internal` adds no default route and aardvark-dns answers only container names, but named networks are rootful only; `--no-hosts` or `host_containers_internal_ip="none"` removes the `host.containers.internal` entry, not the route. gvproxy restriction options: Not verified.
- Windows: machine providers `wsl` (default) and `hyperv`, Windows 11 (docs/tutorials/podman-for-windows.md). Linux: rootless containers without a VM, user namespaces.
- Support: Red Hat sells "Red Hat build of Podman Desktop" from US$180 per licence with Red Hat support (https://www.redhat.com/en/store/red-hat-build-podman-desktop , seen 2026-11-03); whether a RHEL subscription includes it: Not verified.

### microsandbox
- https://github.com/microsandbox/microsandbox , Apache-2.0, v0.7.13 (2026-11-01), "still beta software". libkrun microVMs; Apple silicon macOS, Linux KVM, CHANGED Windows WHP. Claims guest boot under 100 ms on M1. Host allowlists; secrets "never enter the VM", bound to hosts. TypeScript SDK `npm i microsandbox`.

### Firecracker, gVisor, Kata
- Firecracker v1.17.0 (2026-09-10), gVisor release-20261026.0 (2026-10-28), Kata 4.3.1 (2026-10-21); all Apache-2.0, all Linux-only (KVM or ptrace/KVM platforms). Relevant for servers, not directly for a macOS laptop except inside a Linux VM.

### Linux without a VM (seen 2026-11-03)
- bubblewrap v0.13.1 (2026-10-14), LGPL-2.1 (COPYING; the GitHub API reports NOASSERTION). https://github.com/containers/bubblewrap
- Landlock (https://docs.kernel.org/userspace-api/landlock.html): ABI 4 TCP bind and connect by port, ABI 6 scoping of abstract Unix sockets and signals, ABI 9 pathname Unix sockets, ABI 10 UDP; rules are ports, never hostnames, so the hostname allowlist stays in the proxy. Kernel versions per ABI beyond ABI 1 (5.13): Not verified on that page.
- srt v0.0.81 (2026-10-20) confirms bubblewrap on Linux and `sandbox-exec` on macOS, network namespace removed, host HTTP and SOCKS5 proxies. Podman rootless (above) or bubblewrap plus Landlock are the two VM-free Linux shapes.

### Licence and cost of the runtimes (seen 2026-11-03)
- Free and open source: Colima (MIT), Lima (Apache-2.0), Podman and Podman Desktop (Apache-2.0), Apple `container` (Apache-2.0), nerdctl (Apache-2.0), Rancher Desktop (Apache-2.0), Docker Engine moby (Apache-2.0, docker-v29.9.2 2026-10-20) and docker/cli (Apache-2.0). Paid support exists only for Podman Desktop (Red Hat).
- Not free for every company: Docker Desktop is free only for businesses under 250 employees and under $10M annual revenue, personal use, education and non-commercial open source; otherwise Pro, Team or Business (https://docs.docker.com/subscription/desktop-license/ , no page date). OrbStack Free is "Personal, non-commercial use", Pro $8/user/month (https://orbstack.dev/pricing). Docker Sandboxes CLI is free including commercial use but needs a Docker sign-in, ships as a closed binary and charges for governance. These remain comparables only.

### Docker Desktop Enhanced Container Isolation
- Sysbox runtime, container root mapped to unprivileged VM user, blocks bind-mounting `/var/run/docker.sock` by default (https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/). Business subscription (not stated on that page; from Docker pricing knowledge, not verified). Enforced with Settings Management. No egress allowlist or credential injection.

### Dev Containers
- devcontainer CLI MIT (https://github.com/devcontainers/cli). Claude Code reference container adds `init-firewall.sh` with `NET_ADMIN`/`NET_RAW`; warns that a malicious project can exfiltrate anything in the container "including the Claude Code credentials stored in `~/.claude`"; repo-held policy can be edited by anyone with write access (https://code.claude.com/docs/en/devcontainer). Credentials are inside.

### Bind-mount performance on macOS
- VirtioFS beats gRPC FUSE: 25.46 s vs 93.75 s on an npm-style test (https://www.jeffgeerling.com/blog/2022/new-docker-mac-virtiofs-file-sync-4x-faster/, 2022); bind mounts about 3x slower than native in 2025 vs 5-6x in 2023 (Mainardi, above). No 9p measurement found for current tools.
- Landlock plus Docker Desktop VirtioFS is currently broken for OpenShell (issue #4733, below).

### Seatbelt longevity
- `/usr/bin/sandbox-exec` present on macOS 27.2 (build 26B123, file dated 2026-10-23) and working; no removal notice found. Goose issue #12805 notes it is deprecated.

## C. NVIDIA OpenShell

- Repo https://github.com/NVIDIA/OpenShell , Apache-2.0, about 21.0k stars, 2,057 forks, 583 open issues, pushed 2026-11-02.
- CHANGED version and cadence: v0.1.6 (2026-10-27), v0.1.5 (10-20), v0.1.4 (10-13), v0.1.3 (10-09), v0.1.2 (09-28), v0.1.1 (09-26), v0.1.0 (09-25); before that v0.0.x almost daily (v0.0.109 to v0.0.116, 08-19 to 08-28). Roughly weekly releases with breaking upgrade notes.
- v0.1.6 breaking notes: gateways refuse to start without OIDC, mTLS, or gateway JWT auth unless `allow_unauthenticated_users = true`; control connection direction reversed (upgrade supervisor and runtime together); new `sandbox suspend/resume`; gateway OCSF audit events for auth denials and credential use with a High finding when a credential "looks misused"; experimental shared supervisor on Kubernetes; GitHub private vulnerability reporting added (https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.6).
- CVEs (primary: NVIDIA bulletin 5872 source https://github.com/NVIDIA/product-security/tree/main/2026/5872 and CVE.org records, published 2026-08-25; CHANGED from "reported 2026-08-27, affected unstated"):
  - CVE-2026-65093, 9.9, CWE-427, sandbox escape (Linux).
  - CVE-2026-65083, 9.9, CWE-184, provisioning API incomplete disallow list.
  - CVE-2026-65091, 8.8, malicious gateway OS command injection (all platforms).
  - CVE-2026-65092, 8.5, path traversal bypass of L7 REST policy.
  - CVE-2026-65086, 6.8, exec handler command injection.
  - CVE-2026-65085, 5.2, inference proxy output escaping.
  - All six: affected "0 to 0.0.33", updated version v0.0.34. The other 12 bulletin entries are NemoClaw. Disclosure came well after the fix release (v0.0.34 predates v0.0.109 of 2026-08-19).
- macOS: supported as "macOS Apple Silicon via Docker Desktop"; the kernel features run in Docker Desktop's Linux VM. CHANGED: the MicroVM runtime (libkrun; Hypervisor.framework on macOS) is now listed as supported, not experimental (https://docs.nvidia.com/openshell/latest/about/support-matrix , docs v0.1.6). No native macOS process sandbox. Native Windows via MXC on a separate `windows` branch; WSL 2 experimental.
- Open macOS bugs: #4733 Landlock denies reads on Docker-driver bind mounts with Docker Desktop VirtioFS (silent; workaround switch to gRPC FUSE), #4683 0.1.4 Docker supervisor fails to fetch startup config on macOS, #3095 packaged macOS ARM64 VM runtime lacks usable Landlock ABI, #5015 VM socket path exceeds macOS `sun_path`, #4133 `doctor` does not check Docker Desktop prerequisites.
- CHANGED workspace: Docker driver supports host bind mounts via `--driver-config-json` `docker.mounts` (issue #4733), and Podman `bind` mounts (#4579); the pi tutorial still uses `--upload`/`download`.
- Credentials: profile supplies an opaque placeholder env var; "the proxy substitutes a real credential only after network policy and endpoint binding both pass"; credentials bound per endpoint (`credential_endpoint_mismatch`), although NVIDIA/OpenShell#896 (closed 2026-09-03, provider-profile proposal filed 2026-04) describes injection as endpoint-blind before that scoping and proposes the (credential, endpoint, binary) binding, so which injection paths the shipped binding covers is not verified; a running process does not see newly attached providers (https://docs.nvidia.com/openshell/latest/how-it-works/inference.md).
- Network policy: per host, port, binary (`binaries`), L7 `protocol: rest` rules; enforcement field `enforce` vs `audit` (older best-practices doc says audit is the default when omitted; not re-verified).
- Pi: tutorial https://docs.nvidia.com/openshell/latest/tutorials/run-pi-with-openrouter.md builds a local image from `@earendil-works/pi-coding-agent` on `node:24-bookworm-slim`, sets `PI_CODING_AGENT_DIR=/tmp/pi-agent`, profile allows only `openrouter.ai:443` and binary `/usr/local/bin/node`. Conflict: the tutorial says pi publishes no image; pi's own doc uses `--from pi` (community catalogue image).
- SDKs: TypeScript `@nvidia/openshell-sdk` not on public npm (issue #2952 closed not planned 2026-09-21; `npm view` fails); Python SDK ships credential drivers in v0.1.6; Go SDK tagged `sdk/go/vX.Y.Z` from v0.1.6.
- Telemetry: anonymous, on by default; `OPENSHELL_TELEMETRY_ENABLED=false` or Helm `server.telemetryEnabled=false`; can be compiled out (README).
- Commercial: NVIDIA "OpenShell Reference Architecture" announced 2026-10-21 at GTC Berlin with Canonical, Red Hat, SUSE, Microsoft MXC, CrowdStrike, Palo Alto and others; release offers products "when-and-if-available" and mentions no support offering (https://nvidianews.nvidia.com/news/openshell-reference-architecture). Canonical Charmed OpenShell is alpha (2026-09-28, https://canonical.com/blog/charmed-openshell-alpha-release). No NVIDIA AI Enterprise coverage or SLA found.
- Verdict for Nov 2026: not stable enough to depend on as the default laptop path. Pre-1.0, weekly breaking changes, mandatory gateway auth since v0.1.6, macOS only through Docker Desktop or a VM driver with open macOS bugs, six CVEs in its first disclosed batch, npm SDK unavailable. Reasonable as an optional backend or for Linux/Kubernetes pilots.

## D. Hosted sandbox services (fit for an interactive TUI against a local checkout)

None mounts a laptop checkout live; all need clone, upload or sync, and model keys would sit in the remote VM unless the service has a proxy. Ruled out as the default path; possible for remote subagents.
- E2B: Firecracker, Apache-2.0 infra (2026.30, 2026-09-10) self-hostable; good for remote subagents, not for the local TUI.
- Daytona: CHANGED: `daytonaio/daytona` repo archived, last release v0.190.0 (2026-06-23), license field now empty; confirms the move to closed source. Out.
- Modal Sandboxes: gVisor, closed, Python/JS/Go SDKs; remote batch only.
- Vercel Sandbox: Firecracker, SDK Apache-2.0 (`sandbox@4.11.1`, 2026-10-28); also backs Cursor self-hosted pools; remote only.
- Cloudflare Sandbox SDK: `@cloudflare/sandbox@1.0.3` (2026-10-22) on Containers plus Durable Objects; pi ships a Cloudflare codemode example; remote only.
- Fly Machines / Sprites: Firecracker VMs; remote dev box possible via SSH, no local mount.
- Northflank: Kata/gVisor on Kubernetes, BYOC; enterprise remote, not laptop.
- Runloop: devboxes, MIT TS client v3.0.0 (2026-10-23); remote only.
- Blaxel: microVM sandboxes, MIT sandbox repo v0.2.75 (2026-10-29); remote only.
- Anthropic Managed Agents self-hosted sandboxes and Claude Code self-hosted environments: Anthropic-loop specific; not usable for pi.

## E. Security evidence 2025-2026

### Claude Code (GitHub advisories, https://github.com/anthropics/claude-code/security/advisories)
- CVE-2026-25725 (2026-02-06, high, fixed 2.1.2): bubblewrap did not protect a missing `.claude/settings.json`; sandboxed code created it with SessionStart hooks run on the host.
- CVE-2026-39861 (2026-04-20, high, fixed 2.1.64): sandboxed process creates symlinks; unsandboxed parent writes through them.
- CVE-2026-40068 (2026-04-24, high, fixed 2.1.84): trust dialog bypass via git worktree spoofing.
- CVE-2026-55607 (2026-06-25, high, fixed 2.1.163): worktree named `.git` plus symlinks plus fsmonitor overwrote `.zshenv`, code ran outside Seatbelt (write-up https://github.com/Metnew/write-ups/tree/main/claude-code-worktree-sandbox-escape).
- CHANGED, new: CVE-2026-103435 (2026-10-05, high, fixed 2.1.129): write-time symlink following TOCTOU. CVE-2026-46406 (2026-06-25, medium): insecure temp file in `/copy`. CVE-2026-33068 (2026-03-18): trust dialog bypass via repo settings file. Older: CVE-2026-25722/25723/24887/24053 command-injection write bypasses; CVE-2026-24052 domain validation bypass; CVE-2025-55284 permissive default allowlist enabled read plus exfiltration.

### Codex CLI
- CVE-2025-59532 (2025-09-19, high, fixed 0.39.0): sandbox bypass via path configuration bug (https://github.com/openai/codex/security/advisories/GHSA-w5fx-fh39-j5rw).
- "GitPwned" (Pillar, July 2026): allowlisted `git show --output` wrote `.git/config`; fixed 0.95.0.
- Host Docker socket reachable from the sandbox (Pillar/CSA): not fixed by OpenAI or Google per CSA.

### Cursor
- CVE-2026-48124 (CVSS 8.5): workspace `.claude/settings.local.json` Stop hook ran unsandboxed; fixed 3.0.0. venv interpreter replaced and run by an unsandboxed extension, fixed 3.1.2. Non-`.git` git dir with `core.fsmonitor`, patched 3.0.0. DuneSlide CVE-2026-50548/50549 (9.8) attacked sandbox logic itself (https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-sandbox-escapes-20260722-c/, published 2026-07-22).

### Antigravity
- Allow-default Seatbelt profile escaped; `.vscode` task time bomb; Google rated both not-fix (https://www.pillar.security/blog/the-week-of-sandbox-escapes, published 2026-07-20).

### Docker Sandboxes (CVE.org, assigner Docker)
- CVE-2026-77179 (2026-09-15, 9.4, macOS, 0.28.0 to <0.42.0): virtio-fs host server follows symlinks; guest escapes the workspace, reads/modifies host files as the VMM user.
- CVE-2026-79994 (2026-09-15, 8.7, 0.37.0 to <0.42.0): Unix-socket relay TOCTOU via symlinked directory.
- CVE-2026-18171 (2026-08-12, 5.7, 0.35.0 to 0.38.0): read-only host mount writable at the virtio-fs export path.
- CVE-2026-12039 (2026-06-18, 5.7, 0.13.0 to <0.33.0): DNS not covered by the HTTP/S allowlist, DNS-label exfiltration.
- CVE-2026-12539 (2026-06-18, 5.1, 0.14.0 to <0.33.0): ICMP block not re-applied after daemon restart.
- CVE-2026-17106 (2026-08-18, 7.1): moby/go-archive tar extraction; `sbx cp` copy-out affected (secondary says fixed 0.38.0).
- Researcher write-up: https://accomplish.ai/blog/escaping-dockers-hypervisor/ (secondary).

### OpenShell
- Six CVEs, see C. Earlier independent test (sorami.com.au, v0.1.2) found leaks from operator defaults (audit mode, auto-approval), not from the boundary (prior pass, not re-verified).

### Apple container
- CVE-2026-113951 host command execution via guest-controlled kubeconfig (K8s plugin), plus symlink and env-inheritance issues (see B).

### srt
- CVE-2025-66479, empty allowlist meant no network enforcement (low, fixed 0.0.16).

### Goose
- CVE-2026-72718, `core.fsmonitor` command execution.

### Recurring leak classes
1. Trusted-side files written from inside: `.claude/settings*.json`, hooks, `.vscode` tasks, venv interpreters, shell rc files (CVE-2026-25725, CVE-2026-48124, Antigravity).
2. Git metadata: `.git/config` (`core.fsmonitor`, `core.hooksPath`), `.git/hooks`, worktree `.git` pointer files, non-`.git` gitdirs (CVE-2026-55607, CVE-2026-40068, GitPwned, Cursor gitdir, Goose).
3. Symlink and TOCTOU at the boundary, including in hypervisor file servers (CVE-2026-39861, CVE-2026-103435, CVE-2026-77179, CVE-2026-79994, Apple build sync).
4. Inherited env vars and readable credential files (Riptides: every tested agent).
5. Mounted daemon sockets: host Docker socket (Pillar), Unix-socket relays.
6. Side channels the proxy ignores: DNS, ICMP, UDP (CVE-2026-12039, CVE-2026-12539).
7. Denylist profiles (Antigravity allow-default Seatbelt).
8. Components outside the per-command boundary: MCP servers, hooks, file tools, extensions, IDE plugins.
CSA summary: "If an agent gets to write the future inputs of systems, it was never sandboxed in the first place."

### Published evaluations
- Riptides, "Every AI Coding Agent Ships a Sandbox Now. Your Credentials Still Get In.", Nandor Kracser, published 2026-10-05 (https://riptides.io/blog/ai-coding-agent-sandboxes-compared/). Ran one probe script on Ubuntu 26.04 against Claude Code (srt 0.0.78), Codex CLI (0.144.6 Linux, 0.159.2 Windows), Copilot CLI (1.0.89); Gemini CLI and Cursor from docs only. Findings: writes restricted well, reads and network weak; credentials reached commands in every tested agent; Copilot exports `GH_TOKEN` and ran unsandboxed on Windows Server with only a warning. Recommends a VM with only the project mounted and connection-level credential injection. Vendor (Riptides sells kernel-level credential injection).
- Pillar Security, 14 sandbox products in four tiers (https://www.pillar.security/blog/your-ai-agent-will-run-untrusted-code-now-what, per-tier details not read).
- arXiv 2606.08433 "AI Code Sandboxes: A Comparative Security Study, Part 1" and arXiv 2607.05743 "The Balkanization of Execution-Security Research for AI Coding Agents" exist (seen in search results); findings from the prior pass not re-verified.

## F. Enterprise checklist

What buyers ask and what vendors ship:
- Central policy that developers cannot loosen: Claude Code managed settings (MDM plist, registry, `/etc/claude-code/managed-settings.json`, or server-managed; Anthropic calls server-managed "a client-side control, not a security boundary"); Codex `requirements.toml` with MDM precedence; Copilot enterprise floor ("can only narrow your allowlist, never widen it"); Cursor team policy; Factory org-level union-merged denies; Docker Sandboxes org governance ("only organization allow rules grant access", paid). Sources in A and B.
- Fail closed: Claude Code `failIfUnavailable`, `forceRemoteSettingsRefresh`; Factory whole-process refuses to start; Copilot required mode cannot be disabled by flag.
- Sign-in enforcement against personal accounts: Docker sign-in enforcement via endpoint management; Claude Code `forceLoginOrgUUID`.
- Audit: Claude Code settings-change audit via compliance API and OpenTelemetry export; Docker governance audit logs; OpenShell OCSF JSONL, OTLP and v0.1.6 credential-misuse findings; CSA found no vendor alerting when an unsandboxed component consumes an agent-written file.
- Egress: deny-by-default, metadata and private ranges blocked (srt, Codex proxy), TLS inspection where domain fronting matters (srt/Claude Code `tlsTerminate` experimental; Docker sandbox docs silent on TLS, but a user-filed issue shows a per-session "Docker Sandboxes Proxy CA" MITM CA exposed as `$PROXY_CA_CERT_B64` (https://github.com/docker/sbx-releases/issues/322, sbx v0.34.0); Northflank and agentcage checklists ask for TLS-inspecting egress, https://northflank.com/blog/ai-agent-sandbox-security-checklist, vendor).
- Credentials outside the boundary: placeholder plus proxy injection now offered by Claude Code (mask), srt, Copilot (`GH_TOKEN`), Docker Sandboxes, OpenShell, Gondolin, microsandbox, Claude Code cloud network secrets, Cursor cloud (redaction). Short-lived tokens and OIDC federation (Cursor cloud).
- Cover the whole agent: MCP servers, hooks, extensions and file tools (Factory whole-process, sbx and OpenShell whole-process; Claude Code, Codex, Cursor do not).
- Inventory of downstream trusted components (git hooks, IDE extensions, task runners, sockets) and review of agent-written config (CSA recommendations).
- Vendor attestations, SSO, data residency, ZDR/HIPAA: Claude Code cloud sessions excluded for ZDR, HIPAA, CMEK orgs; Devin VPC with PrivateLink; Cursor and Claude self-hosted options. SOC 2 reports not checked.
- Air-gap: needs model endpoint reachable; Codex air-gapped deployments documented by third parties (https://codex.danielvaughan.com/2026/03/31/codex-cli-network-security-requirements-toml/, secondary); OpenShell VM sandboxes now boot digest-pinned images without a registry (v0.1.6); E2B self-host.
- Platforms: macOS primary; Docker Sandboxes requires macOS 14+ Apple silicon (no Intel Macs); Apple container requires macOS 26 for full function; OpenShell macOS via Docker Desktop only.

## Comparison table

| Row | Boundary type | FS confinement | Network allowlist | Credentials outside? | macOS | Latency | Enterprise policy | License |
|---|---|---|---|---|---|---|---|---|
| Claude Code local | OS sandbox per shell command | Writes cwd+tmp; reads open unless denied; protected paths | Host proxy, empty default, managed-only option | Agent key on host outside; mask for listed secrets (needs TLS terminate, file mask Linux only) | Seatbelt | ms | MDM or server-managed, fail-closed flags | Proprietary |
| Claude Code cloud | Anthropic VM | VM only, repo cloned/uploaded | Trusted default list, custom, none | Yes for git and network secrets | Browser/CLI | provisioning, seconds+ | Org settings, not for ZDR/HIPAA | Proprietary |
| srt 0.0.81 | Seatbelt / bwrap+seccomp / Windows alpha | Allow-write list, deny-read list | HTTP+SOCKS proxy, private ranges blocked | Mask via proxy (TLS terminate) | Yes | ms | Library, caller enforces | Apache-2.0 |
| Codex CLI 0.166 | OS sandbox per command | workspace-write; `.git` `.codex` `.agents` `.aws` read-only | `features.network_proxy` domains, off by default | Model auth outside but not via proxy; tokens readable (Riptides) | Seatbelt | ms | `requirements.toml`, MDM | Apache-2.0 |
| Gemini CLI | Seatbelt or Docker/Podman/gVisor | Profile-dependent; cwd mount | `-proxied` profiles only | No | Seatbelt or Docker | ms or container start | None documented | Apache-2.0 |
| Copilot CLI | MXC: Seatbelt/bwrap/ProcessContainer | cwd and `.git` rw | Host rules; default open outbound | GH_TOKEN placeholder via proxy | Yes | ms | Enterprise floor | Proprietary |
| Cursor local | Seatbelt / Landlock+seccomp | Workspace+tmp, read allowlist | sandbox.json + defaults | No local masking | Yes | ms | Team policy | Proprietary |
| Factory Droid | Seatbelt / bwrap, per-command or whole-process | cwd write, denyRead | Deny except Factory, proxy | Not documented | Yes | ms | Org union-merged denies | Proprietary |
| Goose | None (removed v1.25.0) | None | None | No | n/a | n/a | None | Apache-2.0 |
| Docker Sandboxes sbx 0.50 | microVM per sandbox, whole agent | Direct virtiofs mount of workspace, rest of host hidden | Host proxy deny-by-default, wildcard defaults | Yes, sentinel swap | macOS 14+ Apple silicon | seconds (unofficial 2-5 s) | Org governance, paid; sign-in enforcement | Closed binary, free locally |
| OpenShell 0.1.6 | Container+Landlock+seccomp or libkrun VM, supervisor outside | Landlock; upload or driver bind mounts | Per host/port/binary/L7 | Yes, placeholder swap | Via Docker Desktop or VM driver, open bugs | 10-30 s first VM boot (prior pass) | YAML policy, prover, OCSF; gateway auth required | Apache-2.0 |
| Gondolin 0.14 | QEMU or libkrun microVM | Host-controlled FS | `allowedHosts` hooks | Yes in library; pi extension inherits env | Yes (QEMU) | not measured | None | Apache-2.0 |
| Apple container 1.6.1 | VM per container | Mounts you pass | None; `--network none`, `--internal` host-only | No | macOS 26 Apple silicon | not measured | None | Apache-2.0 |
| microsandbox 0.7.13 | libkrun microVM | Volumes | Host allowlist | Yes, host-bound secrets | Apple silicon | <100 ms guest boot (vendor) | None | Apache-2.0 |
| Docker Desktop ECI | Sysbox in Docker Desktop VM | Mounts you pass | None | No | Yes | container start | Settings Management (Business) | Proprietary |
| Dev Containers | Container in Docker VM | Workspace bind mount | Optional iptables script | No | Via Docker | container start | Repo-held unless MDM | MIT (CLI) |
| Lima/Colima (Lima 2.2.1, Colima 0.10.3) | Full Linux VM, dockerd (Colima) or containerd (Lima) | Mounts you pass; virtiofs, sshfs, 9p | None | No | macOS 13+ (vz), Intel and Apple silicon | VM boot | None | Apache-2.0 / MIT |
| Podman 6.1.4 | Linux VM on macOS (libkrun or applehv), WSL2 or Hyper-V on Windows, no VM on Linux | Mounts you pass; `$HOME` by default | None | No | macOS 13+ (applehv) | VM boot | None; paid Red Hat build of Podman Desktop | Apache-2.0 |
| OrbStack | Linux VM | Mounts you pass | None | No | Yes | fast (vendor) | Enterprise plan SSO (secondary) | Proprietary, paid commercial |
| Hosted (E2B, Modal, Vercel, Cloudflare, Fly, Northflank, Runloop, Blaxel) | Remote microVM/gVisor | Remote FS only | Varies | Varies | n/a | remote | Varies | Mixed |

## Not verified

- Copilot local sandboxing GA (changelog 2026-10-07) vs "public preview" (docs); CLI default enablement.
- Codex managed networking key names (`experimental_network` vs `application.network.domains`); OpenAI "Running Codex safely" post returned 403.
- Docker Sandboxes: hypervisor per OS, official startup time, governance price, whether the source will be published, CA lifecycle (the proxy CA is seen only in a user-filed issue, not in the docs), fix version of CVE-2026-17106 for `sbx cp`.
- OpenShell: default `enforcement` when omitted in v0.1.6; whether `--from pi` community image is current; NVIDIA commercial support; VM first-boot time on v0.1.6 (10-30 s figure is from the October pass).
- Apple container bind-mount performance (#948 resolution not read), whether an `--internal` network has no route beyond the host, UID/GID presentation of bind mounts.
- Colima and Lima bind-mount numbers (none published), UID/GID under virtiofs; Podman UID presentation on macOS and Docker-API incompatibilities beyond v1.40; Rancher Desktop internals.
- Cursor cloud Firecracker and default-open egress (search summary of cursor.com docs, not fetched directly); Cursor native Windows sandbox.
- Amp default approval behaviour; Jules egress and secrets.
- Devin egress allowlisting granularity.
- ECI subscription tier on the current docs page.
- SOC 2 / ISO status of any vendor.
- arXiv 2606.08433 and 2607.05743 findings (existence seen, contents not re-read).
- OrbStack enterprise SSO (aggregators only); the $8/user/month price was confirmed at orbstack.dev/pricing on 2026-11-03.
