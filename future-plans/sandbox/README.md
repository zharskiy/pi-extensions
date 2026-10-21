# Sandbox

Research date: 2026-10-20. Question: what it takes to run the pi main session and every agent in a sandbox, whether one sandbox per agent is worth it, what the industry does, and which options work for one developer on a laptop and for a company.

- README.md (this file): findings, recommendation and phases.
- research/pi-and-harness.md: what pi 1.3.0 ships for isolation and where our extensions would change.
- research/openshell.md: NVIDIA OpenShell fact sheet.
- research/landscape.md: how other agents sandbox, building blocks, hosted services, research and the enterprise checklist.

## Findings

1. **The industry runs two tiers.** Local coding agents (Claude Code, Codex CLI, Cursor, Gemini CLI, Copilot) wrap each command in an OS sandbox: Seatbelt on macOS, bubblewrap or Landlock plus seccomp on Linux, writes confined to the workspace, network deny-by-default behind an allowlisting proxy. Enterprises put the whole agent in a container or microVM (gVisor, Firecracker, Kata, Docker Sandboxes) with a proxy outside the boundary that enforces egress, injects credentials and writes audit logs, under admin policy developers cannot loosen.
2. **Pi already has the hooks, and this repo uses none of them.** Pi's `docs/containerization.md` documents plain Docker, Docker Sandboxes, OpenShell and a micro-VM extension. Every built-in tool factory takes an operations backend, bash also takes a `spawnHook`, and `user_bash` routes `!` commands and fails closed. Pi ships reference extensions for Anthropic sandbox-runtime, SSH and a micro-VM.
3. **Our agents are in-process sessions.** `core/adapter/pi-child.ts` creates them with `createAgentSession` in the main Node process. They share the model runtime, the credentials, the host agent dir and the extension bus. The only subprocess is git for worktrees. The `AgentRuntime.spawn` contract (`core/adapter/contract.ts`) is the seam for a per-agent backend.
4. **A tool-only sandbox leaves things on the host.** Our custom tools (`fetch` with no network policy, `handoff` writing to the OS temp dir, the agent tools), MCP servers and codemode run in the host process. Worktrees live under `<cwd>/.pi/worktrees` and share the host `.git`. Pi's docs say the same about extension tools.
5. **OpenShell fits as one backend, not as the only one.** Apache-2.0, pi is in its agent catalogue, pi's docs cover it, and a community pi extension already runs one OpenShell sandbox per subagent. Against: alpha with weekly breaking releases, macOS only through Docker Desktop (the microVM driver is experimental), no host bind mounts except virtiofs on microVMs, two critical sandbox-escape CVEs in August 2026, telemetry on by default, TypeScript SDK on GitHub Packages only, no verified commercial support.
6. **Boundaries leak through trusted-side files.** Claude Code's sandbox had three 2026 CVEs through symlinks, a missing settings file and git worktrees. Every agent sandbox tested by Riptides still exposed credentials as files or environment variables. The whole-process boundary with credentials kept outside is the only design that closes this.

## Recommendation

Mirror the industry: whole-session isolation as the mandatory layer, per-agent tool policy as a cheap second layer, full per-agent sandboxes deferred.

### Phase 0: whole-session recipe, no code

Build a pi image with our extensions and document three launchers: OpenShell (`openshell sandbox create --from <image> -- pi`), Docker Sandboxes (`sbx run --kit docker.io/sbx/pi-kit:latest pi`, Docker maintains the kit) and plain Docker with a deny-by-default firewall. Verify inside the sandbox: agents, worktrees, handoff files, MCP, the agent dir on a writable path, credentials kept outside through the OpenShell or Docker Sandboxes proxy. This satisfies the enterprise requirement on its own.

### Phase 1: a `sandbox` extension for per-agent policy

- A `sandbox:` key in agent frontmatter: writable paths (the agent's cwd or worktree), a network allowlist, or `false`.
- Inject an operations-backed `bash` override into the child extension factories in `pi-child.ts`, with Anthropic sandbox-runtime (`@anthropic-ai/sandbox-runtime`, Apache-2.0, Seatbelt or bubblewrap plus proxy) as the local backend. Keep the backend behind our own interface so a container or OpenShell exec can replace it.
- Cover the main session's `bash` and `user_bash` with the same policy. Apply the network allowlist to our `fetch` tool.
- Fail closed: refuse to run the agent when the sandbox cannot start.
- Result: the scout is read-only, the implementer writes only inside its worktree, the fetch chore reaches only listed domains, all on a laptop without a VM.

### Phase 2, deferred: one sandbox per agent

A second `AgentRuntime` whose `spawn` starts `pi --mode json -p --no-session` inside an OpenShell sandbox (TypeScript SDK) or a container, with the `ChildSession` surface (start, events, send, wake, abort, dispose, usage, texts, session file) carried over RPC or the JSON event stream. Hold until there is a concrete need (untrusted repositories, multi-tenant runs): it costs seconds per agent, breaks the in-process registry and semaphore, needs the worktree and handoff paths inside the sandbox, and the OpenShell SDK is still churning.

## Not verified

The official NVIDIA CVE bulletin and fixed versions, any commercial support tier for OpenShell, the exact PTY and streaming API of its TypeScript SDK, the Docker Sandboxes source license, Daytona's reported move to closed source, and whether `sandbox-exec` survives future macOS releases.
