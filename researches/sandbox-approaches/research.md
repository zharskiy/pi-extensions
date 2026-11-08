# Sandbox approaches: per-tool facts

Facts gathered on 2026-11-08 from official docs and source. Each claim carries its source. "Inferred" marks a conclusion drawn from the sources, not stated in them. "Unverified" marks a point the sources leave open. The assessment is in [README.md](README.md).

## Claude Code: built-in Bash sandbox

Source: <https://code.claude.com/docs/en/sandboxing>.

- **Mechanism.** Seatbelt on macOS, bubblewrap plus `socat` on Linux and WSL2, no sandbox on native Windows. Built on the open-source sandbox runtime (`srt`, below).
- **What is sandboxed.** Shell commands and their children only. "The sandbox covers shell commands only. Claude's file tools, MCP servers, and hooks run outside it." WebFetch, the status line and `apiKeyHelper` also run outside.
- **Agent tokens.** Stored in the macOS Keychain, or in `~/.claude/.credentials.json` on Linux (<https://code.claude.com/docs/en/authentication>). The sandbox page write-protects `~/.claude`, `~/.claude.json` and `.credentials.json`. It does not say reads of them are denied.
- **Read policy.** "Read access to the entire computer, except certain denied directories. This default still allows reading credential files." `~/.ssh` and `~/.aws/credentials` are readable by default. "There is no built-in credential deny list, so only the files and variables you list are restricted."
- **Credential controls (opt-in).** `sandbox.credentials` with `mode: "deny"` blocks file reads and unsets env vars. `mode: "mask"` shows a placeholder and the proxy substitutes the real value on allowed hosts. Mask needs the experimental `network.tlsTerminate`.
- **Keychain.** Unverified. One bug report says sandboxed `security find-generic-password` fails ([#44195 mirror](https://claudeissues.com/issue/44195-sandbox-blocks-macos-keychain-access-breaking-cli-tools-that-use-keyring-auth-gh)). Another says any same-user process can read the Claude Code Keychain item through `/usr/bin/security` ([#29783 mirror](https://claudeissues.com/issue/29783-bug-oauth-token-stored-in-keychain-on-mac-can-be-read-by-any-process-that-can-ex)). The `srt` macOS profile allows `mach-lookup` to `com.apple.SecurityServer` and `com.apple.securityd.xpc` (`src/sandbox/macos-sandbox-utils.ts`, lines 1112 and 1236).
- **Network.** All traffic goes through a host proxy. `allowedDomains` starts empty. Unlisted hosts prompt, are refused or are allowed by permission mode. Names resolving only to local addresses are refused. Non-TCP traffic cannot leave. The proxy decides on the hostname and "by default, does not terminate or inspect TLS traffic". The docs warn that broad domains such as `github.com` "can create paths for data exfiltration" and that domain fronting may bypass the filter.
- **Filesystem writes.** Working directory, a per-user temp dir and added dirs. Always write-denied: `.git/hooks`, `.git/config`, `.bashrc`, `.zshrc`, `.gitconfig`, `.vscode`, `.idea`, also in worktrees.
- **Default.** "The sandbox is off by default." Enable with `/sandbox` or `sandbox.enabled`. If the platform check fails, commands run unsandboxed unless `sandbox.failIfUnavailable` is set.
- **Escape hatch.** A failed command may be retried with `dangerouslyDisableSandbox`, with or without a prompt depending on mode. `allowUnsandboxedCommands: false` disables it.
- **Known incompatibilities.** `docker`, `watchman`, Apple Events, Chromium and rootless Podman on Linux. Tools that ignore proxy variables (plain `ssh`, most DB drivers) cannot connect.
- **Toolchains.** Host tools run as they are, since reads are open (inferred).

## Claude Code: reference dev container

Source: <https://code.claude.com/docs/en/devcontainer>.

- Claude Code itself runs inside a Docker dev container. The repository is bind-mounted.
- `init-firewall.sh` limits egress to an allowlist with iptables. It needs `NET_ADMIN` and `NET_RAW`.
- Tokens live inside the container, in `~/.claude` on a named volume, or come in as env vars. The docs warn: "dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`."
- Needs Docker and a Dev Containers aware editor.

## `srt` (sandbox runtime)

Source: <https://github.com/anthropic-experimental/sandbox-runtime> (redirects to `anthropics/sandbox-runtime`), README fetched with `gh api`. Apache-2.0. Labelled "Beta Research Preview".

- **What it wraps.** "Enforcing filesystem and network restrictions on arbitrary processes at the OS level, without requiring a container." The restrictions "apply to the entire process tree". CLI (`srt "<cmd>"`) and library.
- **Mechanism.** `sandbox-exec` with a generated Seatbelt profile on macOS. bubblewrap with the network namespace removed on Linux, plus seccomp. A dedicated local user plus WFP filters on Windows (alpha).
- **Reads.** Open by default. `filesystem.denyRead` with `allowRead` re-opening paths inside a denied region, for example `"denyRead": ["/Users"], "allowRead": ["."]`. So a deny-home, allow-list read policy is expressible.
- **Writes.** Denied by default. `allowWrite` opens paths, `denyWrite` wins over it. Mandatory write denies: shell rc files, `.gitconfig`, `.gitmodules`, `.git/hooks/`, `.git/config`, `.vscode/`, `.idea/`, `.mcp.json`, `.claude/commands/`, `.claude/agents/`.
- **Network.** Denied by default. `allowedDomains`, `deniedDomains` (deny wins), optional `:port`. A resolved-address check refuses loopback, link-local, metadata endpoints and the host's own addresses. Private ranges only through `deniedResolvedAddresses`. Unix sockets blocked by default.
- **External proxy.** `network.httpProxyPort` names an external proxy (README, the per-command list section and `enableWeakerNetworkIsolation`). `network.parentProxy` chains upstream. One passage says "Custom proxy configuration is not yet supported in the new configuration format." Unverified which applies to the current release.
- **Credential injection.** `credentials.envVars` and `credentials.files` with `mode: "deny"` or `mode: "mask"`. Mask "puts a sentinel in its place inside the sandbox and has the proxy substitute the real value back on egress to the hosts that entry's `injectHosts` lists". Requires `network.tlsTerminate` (experimental). "Files are masked on Linux only; macOS denies a masked file instead." Also SigV4 re-signing for AWS.
- **macOS caveats it names.** `enableWeakerNetworkIsolation` (needed by Go TLS through a MITM proxy) opens an exfiltration path through `trustd`. `allowAppleEvents` "removes code-execution isolation". Broad domains such as `github.com` allow exfiltration. Domain fronting may bypass the filter. A copy of `srt` inside a writable `node_modules` can be rewritten and then run unsandboxed.

## Codex CLI

Sources: <https://developers.openai.com/codex/concepts/sandboxing> (now <https://learn.chatgpt.com/docs/sandboxing>), source in <https://github.com/openai/codex> (Apache-2.0).

- **Mechanism.** Seatbelt on macOS. bubblewrap on Linux and WSL2, using the first `bwrap` on `PATH`, with Landlock and seccomp code in `codex-rs/sandboxing/src/`. Native sandbox on Windows.
- **What is sandboxed.** Spawned commands: `git`, package managers and test runners "inherit the same sandbox boundaries". The Codex process itself is not sandboxed (inferred from the source layout: the sandbox wraps spawned commands).
- **Modes.** `read-only`, `workspace-write` (the default for local work), `danger-full-access`. Approval policies `on-request` and `never`.
- **Agent tokens.** `cli_auth_credentials_store` chooses `~/.codex/auth.json` or the OS keychain. Sources disagree on the default (`file` in an older example config, `auto` preferring keyring in a mirror of the reference: <https://www.mintlify.com/openai/codex/configuration/reference>). Unverified.
- **Read policy.** Full disk read by default. `FileSystemSandboxPolicy::has_full_disk_read_access` in `codex-rs/protocol/src/permissions.rs`. Deny-read rules (`access = "none"`, globs) were added later and are opt-in ([third-party summary](https://codex.danielvaughan.com/2026/04/25/codex-cli-filesystem-security-deny-read-policies-credential-protection/)). So `~/.codex/auth.json` is readable by sandboxed commands unless denied (inferred).
- **Write policy.** Workspace plus temp. `.git`, `.agents`, `.codex` and `.aws` at the top of a writable root stay read-only (`PROTECTED_METADATA_PATH_NAMES` and `append_default_read_only_project_root_subpath_if_no_explicit_rule`, `permissions.rs` lines 43 to 53 and 845 to 847). The whole `.git`, not only hooks and config.
- **Network.** Off by default in `workspace-write` (`sandbox_workspace_write.network_access = false`, <https://learn.chatgpt.com/docs/config-file/config-reference>). An optional `codex-network-proxy` (`codex-rs/network-proxy/README.md`) adds a domain allow/deny list, a "limited" read-only mode, private-range refusal, MITM hooks per host, method and path (for example strip `authorization` on `POST` to `api.github.com`), placeholder AWS credentials re-signed with SigV4 and "exact secret substitution".
- **Keychain.** The network Seatbelt policy allows `mach-lookup` to `com.apple.SecurityServer` "for TLS certificate information" (`seatbelt_network_policy.sbpl`, line 19).

## Cursor: local agent

Sources: <https://cursor.com/docs/agent/security/run-modes>, <https://cursor.com/blog/agent-sandboxing>.

- **Mechanism.** Seatbelt through `sandbox-exec` on macOS, applied to the whole subprocess tree. Landlock and seccomp on Linux (kernel 6.2+), with a bubblewrap fallback. Windows runs the Linux sandbox in WSL2.
- **What is sandboxed.** Terminal commands. The editor and agent are not (inferred: the docs sandbox "terminal commands" only).
- **Agent tokens.** Not documented. Inferred: stored by the editor (an Electron app), outside the sandboxed command.
- **Read policy.** Default read mode "System". A stricter "Workspace" mode limits reads to the workspace, a read allowlist and system paths for toolchains. `.cursorignore` files are made unreadable (Linux: Landlocked copies in an overlay). Whether home and credential files are readable in System mode is not stated (inferred: yes).
- **Write policy.** Workspace plus temp. Write-denied: `.git/config`, `.git/hooks`, `.vscode`, `.cursorignore`, most of `.cursor`.
- **Network.** Default "sandbox.json + Defaults": your allowlist plus built-in package hosts (github.com, pypi.org, npmjs.org, crates.io, rubygems.org). No proxy design documented.
- **Default and UX.** Applies to shell commands under Auto-review. A failed command can be rerun outside the sandbox after a classifier review. The blog reports sandboxed agents "stopped for user input 40% less often" and about a third of requests on supported platforms running sandboxed.
- **Open source.** No.

## Cursor: cloud agents

Sources: <https://cursor.com/docs/cloud-agent/security>, <https://cursor.com/docs/cloud-agent/security-network>.

- One VM per agent, on Cursor's infrastructure. Agents cannot see each other.
- Secrets are env vars visible to the agent. "Runtime secrets" are redacted from transcripts, output and commits, but still present in the VM (inferred).
- Internet on by default. Modes: allow all, defaults plus allowlist, allowlist only. Source control and Cursor's services stay reachable in every mode. The docs warn that wildcard entries open exfiltration paths.
- Not local, not open source.

## Gemini CLI

Source: <https://geminicli.com/docs/cli/sandbox/>.

- Off unless `-s`, `GEMINI_SANDBOX` or `settings.json` turns it on. A separate per-tool sandbox (`security.toolSandboxing`) also exists.
- With the sandbox on, the whole CLI runs inside it: `sandbox-exec` on macOS, or Docker or Podman with the project mounted at the same path. gVisor and LXC on Linux. A native Windows mode.
- Seatbelt profiles: `permissive-open` (default: writes limited to the project, broad reads, network open), `-closed`, `-proxied`, `restrictive-*`, `strict-*` (reads limited too).
- How API keys reach the container is not documented. Inferred: as env vars, so they sit inside the sandbox.
- Apache-2.0 (<https://github.com/google-gemini/gemini-cli>).

## `sandbox-exec` status

- The man page marks it deprecated and points to App Sandbox. It still works on current macOS ([HN thread](https://hn.svelte.dev/item/44283454), [Gastown notes](https://gastown.dev/docs/research/macos-sandbox-exec)).
- There is no public replacement for applying a Seatbelt profile to a process without App Sandbox entitlements (same sources).
- Claude Code, Codex CLI, Cursor and Gemini CLI all ship on it (sections above). Inferred: Apple removing it would break all four at once, so the risk is shared and visible, not specific to pi.

## The PR (`launcher/`, branch `feat/sandbox-launcher`)

From `launcher/README.md`, `launcher/ARCHITECTURE.md`, `launcher/THREAT-MODEL.md` and a line count of non-test `.ts` files.

- pi and every tool it starts run in a Linux container (Colima VM by default, Apple `container` second). The repository is bind-mounted, `~/.pi` is not, except this repository's session directory.
- Rendered `auth.json`, `models.json` and `mcp.json` hold placeholders. A host proxy per policy terminates TLS for rule hosts, swaps placeholders for real secrets, refuses non-allowlisted hosts and private ranges, and keeps MCP OAuth tokens on the host (vault).
- Git hooks, config and worktree metadata are bound read-only from launcher snapshots.
- Source size by folder (non-test lines): `proxy/` 6.7k (of which `vault/` 1.3k, `secrets/` 0.7k), `cli/` 3.2k, `backend/` 2.4k, `config/` 2.0k, `hostpi/` 2.0k, `workspace/` 1.4k, `container/` 1.3k, `provision/` 1.2k, `shared/` 1.0k, `image/` 0.8k, `grants/` 0.3k. Tests 29k.
- Known limits it lists itself: toolchains must be added to the image, macOS `node_modules` with native binaries break on Linux, caches go with the container, services need sidecars, host IDE MCPs are unreachable, the Colima VM mounts `$HOME` writable, the Apple backend is untested on a real host, the relay is unverified on Colima.
