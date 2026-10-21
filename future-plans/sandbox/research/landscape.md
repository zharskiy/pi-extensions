# Coding-agent sandboxing landscape

Research date 2026-10-20, web. Entries marked (secondary) come from blogs or comparisons rather than vendor docs; verify before relying on them.

## How the agents sandbox themselves

| Agent | Mechanism | Default | Network | Admin control |
|---|---|---|---|---|
| Claude Code (https://code.claude.com/docs/en/sandboxing) | Seatbelt on macOS; bubblewrap plus socat proxy on Linux and WSL2; shell commands only, file tools, MCP servers and hooks run outside | Off | Deny-by-default through a host proxy, empty allowlist | Managed settings, `allowUnsandboxedCommands:false`, `sandbox.failIfUnavailable` |
| Anthropic sandbox-runtime `@anthropic-ai/sandbox-runtime` (https://github.com/anthropic-experimental/sandbox-runtime) | Seatbelt, or bubblewrap plus seccomp plus HTTP/SOCKS proxy; Windows alpha; in-process Node API `SandboxManager.wrapWithSandbox(cmd, {commandId})`, `registerCommandNetworkLists` | Library | Domain allow and deny lists per command, ask callback, optional TLS terminate | Apache-2.0, beta research preview |
| OpenAI Codex CLI (https://learn.chatgpt.com/codex/sandboxing) | Seatbelt; bubblewrap with a bundled fallback on Linux and WSL2; own sandbox on Windows; modes `read-only`, `workspace-write`, `danger-full-access` | On | Off in workspace-write (secondary); experimental allowlist proxy | `requirements.toml` |
| Gemini CLI (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md) | Seatbelt profiles, Docker or Podman, gVisor on Linux, LXC experimental; icacls on Windows | Opt-in (`-s`, `GEMINI_SANDBOX`) | `-open` and `-proxied` profiles | |
| Cursor agent (https://cursor.com/docs/agent/security/run-modes) | Seatbelt; Landlock plus seccomp on Linux 6.2+, else approval prompts | On in Auto-review and Allowlist modes | Blocked by default, `sandbox.json`, about 100 registry domains in the default mode | Team policy overrides local config |
| GitHub Copilot CLI (https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available/) | Microsoft MXC, one policy translated to native OS controls | GA 2026-10-07, default unstated | Internet, local network and git credentials policy-controlled | Enterprise-managed settings |
| OpenHands, Devin, Jules, Aider (secondary) | Docker (self-hosted or cloud); cloud VM with "Outposts"; Google cloud VM; none | | | |

De facto standard, late 2026: local agents wrap each command in an OS sandbox (Seatbelt, bubblewrap or Landlock plus seccomp), confine writes to the workspace, and block network behind an allowlisting proxy. Codex and Cursor ship it on, Claude Code off. Anthropic says unattended runs belong inside a container, VM or sandbox-runtime (https://code.claude.com/docs/en/sandbox-environments).

## Building blocks a Node program can drive

| Block | Isolation | macOS | Linux | License | Notes |
|---|---|---|---|---|---|
| Seatbelt `sandbox-exec` | Kernel MAC profiles | Yes | No | Apple | Deprecated CLI, still works on macOS 26 and 27, no removal notice found. Use deny-by-default profiles: an `(allow default)` profile was escaped in Antigravity (https://www.pillar.security/blog/escaping-antigravitys-allow-default-seatbelt) |
| bubblewrap | User, mount and net namespaces | No | Yes (Ubuntu 24.04 needs an AppArmor userns tweak) | LGPL (from memory) | Mature, used by Claude Code and Codex |
| Landlock plus seccomp | LSM plus syscall filter | No | 5.13+, Cursor needs 6.2+ | Kernel | Network rules are TCP ports only |
| firejail, nsjail | Namespaces plus seccomp | No | Yes | GPL, Apache-2.0 (from memory) | No Node API |
| gVisor `runsc` | User-space kernel | No | Yes | Apache-2.0 | Anthropic rates it "excellent with correct setup" (https://code.claude.com/docs/en/agent-sdk/secure-deployment) |
| Firecracker, Kata, Cloud Hypervisor | KVM microVMs | No | Yes | Apache-2.0 | Used by E2B and Vercel, heavy to operate |
| microsandbox (https://github.com/microsandbox/microsandbox) | libkrun microVM | Apple Silicon | KVM | Apache-2.0 | Beta, TypeScript SDK, host allowlists, secrets bound to the host |
| Apple `container` (https://github.com/apple/container) | One VM per container, Virtualization.framework | Apple Silicon, macOS 26 | No | Apache-2.0 | Pre-1.0, network policy not checked |
| Lima, Colima, Tart | Linux or macOS VM | Yes | Yes | Apache-2.0, MIT (from memory) | Heavy, strong boundary |
| Docker, Podman rootless, devcontainers | Namespaces, shared kernel | Via VM | Yes | Apache-2.0 | Claude's devcontainer ships a default-deny iptables firewall |
| Docker Sandboxes `sbx` (https://docs.docker.com/ai/sandboxes/) | microVM with its own kernel and daemon, credential-injecting proxy | Yes | Unstated | Free locally, source closed (secondary); org governance paid | Cloud Sandboxes announced 2026-09-24. Official pi kit at https://github.com/docker/sbx-kits-contrib/tree/main/pi |

## Hosted and remote sandboxes

| Service | Isolation | Self-host | License | SDKs | Pricing (secondary) |
|---|---|---|---|---|---|
| E2B (https://github.com/e2b-dev/infra) | Firecracker, nftables egress, SNI and Host allow and deny | Yes: Docker Compose single node with KVM, or Terraform on GCP, AWS, Azure, Kubernetes | Apache-2.0 | Python, JS/TS | About $0.05 per vCPU-hour plus $0.016 per GiB-hour |
| Daytona | OCI containers, Kata opt-in | Contradictory: one blog says production code went closed on 2026-06-11 with the AGPL repo frozen at v0.190.0 (https://bex.co/blog/2026/10/14/daytona-sandbox-vendor-buy-vs-build) | AGPL-3.0 | Yes | Usage |
| Modal Sandboxes | gVisor | No | Closed | Python, JS, Go | About $0.142 per core-hour |
| Vercel Sandbox (https://vercel.com/docs/vercel-sandbox) | Firecracker | No; SDK open (https://github.com/vercel/sandbox) | SDK open | JS/TS, Python | Active CPU plus memory |
| Cloudflare Sandbox SDK (https://github.com/cloudflare/sandbox-sdk) | Cloudflare Containers behind Durable Objects | No | Apache-2.0 | TypeScript | $5 per month plus usage |
| Northflank | Kata on Kubernetes | BYOC | Closed | REST, SDKs | About $0.0167 per vCPU-hour |
| Blaxel, Runloop, Fly Sprites | microVMs | Unclear, VPC, no | Closed | TS, Python, REST | Usage |
| Anthropic Managed Agents (https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) | Anthropic sandboxes (gVisor per a third party); self-hosted sandboxes in public beta since May 2026 | Sandbox side only, the model loop stays at Anthropic; tool inputs and outputs still flow through Anthropic; not eligible for ZDR or HIPAA (secondary) | Proprietary | TS, Python, Go, Java, C#, PHP, Ruby | API usage |
| Claude Code cloud sessions (https://code.claude.com/docs/en/sandbox-environments) | Anthropic VM, GitHub token held by a proxy outside | Self-hosted environment option exists (https://code.claude.com/docs/en/self-hosted-environments) | Proprietary | | Subscription |

## Research and guidance

1. SandboxEscapeBench, arXiv 2603.02277: nested-sandbox CTF; frontier models reliably exploit easy container misconfigurations, 0% on the hardest tiers (figures secondary).
2. AI Code Sandboxes comparative security study, arXiv 2606.08433: microVM, user-space kernel and OCI classes separate cleanly on attack surface; version-pin policy matters most; downstream patch lag 0 to 471+ days.
3. The Balkanization of Execution-Security Research for AI Coding Agents, arXiv 2607.05743: survey of isolation, access control and TOCTOU flaws including Claude Code CVEs.
4. Pillar Security, Antigravity escape (2026-07-20): allow-default Seatbelt profiles are denylists; devfs plus Launch Services ran code outside.
5. Claude Code sandbox CVEs (third-party databases): CVE-2026-39861 symlink escape, CVE-2026-25725 missing `settings.json` creatable from inside, CVE-2026-55607 git worktree and zsh startup. The boundary leaks through trusted-side files.
6. Riptides, "Every AI Coding Agent Ships a Sandbox Now. Your Credentials Still Get In." (https://riptides.io/blog/ai-coding-agent-sandboxes-compared/): credentials reachable as files, inherited env vars or tokens in every agent tested; MCP servers often outside the sandbox. Vendor commentary.
7. Anthropic, Claude Code sandboxing (https://www.anthropic.com/engineering/claude-code-sandboxing): filesystem and network isolation both required; 84% fewer permission prompts internally; git credentials behind a proxy.
8. OWASP Top 10 for Agentic Applications (Dec 2025): ASI05 Unexpected Code Execution calls for isolated sandboxes, egress controls and a restricted working directory.
9. NIST CAISI: RFI on securing AI agent systems (closed 2026-03-09) and an AI Agent Standards Initiative (2026-02-17). No sandbox standard yet.
10. Prompt-injection benchmarks INFUSE (arXiv 2610.20776), IssueTrojanBench (arXiv 2607.20759), MCP tool poisoning across 7 clients (arXiv 2603.21642): injections land reliably, so a perimeter is needed.
11. Anthropic, securely deploying agents (https://code.claude.com/docs/en/agent-sdk/secure-deployment): the proxy does no TLS inspection so domain fronting is possible; same-kernel sandboxes carry kernel-escape risk; Node `fetch()` ignores `HTTP_PROXY` unless `NODE_USE_ENV_PROXY=1` on Node 24+.

## Enterprise checklist

- Egress: deny-by-default, per-agent or per-command lists, block metadata and internal addresses, TLS-terminating proxy where domain fronting matters.
- Secrets: inject in a proxy outside the boundary (Envoy credential_injector, mitmproxy, LiteLLM, Docker Sandboxes proxy, OpenShell placeholders, sandbox-runtime credential masking); deny credential files; scrub env vars.
- Policy developers cannot loosen: managed settings, `requirements.toml`, team policy, MDM. Disable unsandboxed retry.
- Fail closed when the sandbox cannot start.
- Cover everything that runs: MCP servers, hooks, file tools, extension tools. Wrap the whole process for that.
- Isolation strength: same-kernel sandboxes are perimeters; untrusted repos, multi-tenant or compliance need gVisor or microVMs.
- Audit at the proxy; collect sandbox violation events; no vendor-documented SIEM integration found.
- SSO, SOC2, ISO: check each vendor's trust page; nothing verified here.
- On-prem and air-gapped: E2B self-host, Anthropic self-hosted worker (still needs outbound HTTPS), gVisor, Kata or Firecracker on your cluster, Northflank BYOC. The model API must still be reachable.
- Licensing: Apache-2.0 and MIT are safe to embed (sandbox-runtime, E2B infra, microsandbox, Cloudflare SDK, Apple container, OpenShell). AGPL (Daytona) imposes copyleft. Docker `sbx` is free locally with an unclear source license.
- Laptop versus cluster: laptops use Seatbelt or bubblewrap with MDM policy; clusters use microVMs or gVisor with a proxy; Docker Sandboxes and Cloud Sandboxes are the hybrid. Reuse one policy schema in both.

## Unverified or contradictory

Codex's Linux mechanism (docs say bubblewrap, blogs add Landlock and seccomp) and default network; Copilot's sandbox default and network default; Daytona's closure; the sandbox-runtime repo URL (`anthropic-experimental` versus `anthropics`); `sandbox-exec` longevity; Docker Sandboxes license, Linux support and policy surface; Apple container network policy; hosted vendors' details beyond secondary comparisons; SOC2 and ISO attestations.
