# launcher threat model

What the sandbox protects, where its trust boundaries are, and what each feature weakens. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md); what the user sees is in [README.md](README.md).

## 1. Assets

- **Host credentials:** model provider keys and OAuth tokens in `~/.pi/agent/auth.json`, keys and header values in `models.json` and `mcp.json`, environment variables, keychain items, password manager entries, MCP OAuth tokens, parent proxy credentials.
- **Host files:** everything in the home directory outside the repository, other repositories, `~/.pi`, the launcher's state and config.
- **The network:** hosts the developer can reach (internal services, cloud metadata, private ranges) and the developer's identity toward them.

The agent inside the container is assumed hostile: it may run any command, write any file it can reach, and send anything to any host the proxy lets through.

## 2. Trust boundaries

- **Container:** runs pi and every tool it starts. Sees the repository and its git dir (read-write, hooks and git config read-only), its own agent volume, the read-only render dir and the trust bundle. Its only network path is the proxy URL, authenticated with a per-repository token.
- **Proxy:** a host process per policy hash. Holds secrets in memory only, decides every connection, terminates TLS for credential rule hosts and injects credentials there. Trusts the launcher (control token), never the container.
- **Host pi helper:** the bundled pi next to the launcher, run on the host to print credentials (`pi auth print-api-key`, `print-bearer-token`), to sign in and refresh MCP OAuth (`pi mcp login`, `pi mcp list` in `<state>/mcp-auth/`), and to read the provider host table. It runs with the developer's rights.
- **Colima VM:** runs the container engine and mounts `$HOME` writable so repositories under it can be mounted. The VM is not a security boundary against the developer's own files; only the container's mounts are.

## 3. Baseline guarantees

- No real secret in the container's filesystem, environment or volumes. Rendered `auth.json`, `models.json` and `mcp.json` hold placeholders (`pi-sandbox-` plus 24 hex of a salted hash; JWT-shaped for JWT access tokens), the rendered files are read-only links, and `pi sandbox doctor` sweeps the environment, `auth.json` and `mcp.json` for anything else.
- Egress allowlist: a host leaves only when it is in `egress.allow` or `egress.mcpHosts`, a credential rule host, a derived host or an active grant; `egress.deny` always wins.
- SNI check: a tunnel whose ClientHello names another host than the CONNECT target is refused.
- Private-range deny: IP literals, localhost, link-local, private and reserved ranges, the metadata address and names that resolve only to such addresses are refused, except the names in `egress.privateHosts` and the legacy gateway host.
- Workspace guard: a repository at or above the home directory, `~/.pi`, the state or config dir, or `/` is refused before anything is mounted.
- Read-only git overlay: hooks, git config, `core.hooksPath` and submodule and worktree config are read-only inside, so the agent cannot plant code the host's git will run.
- Per-repository proxy tokens: one repository's container cannot use another repository's grants, and the container never holds the instance (control) token.

## 4. What each feature weakens, and the mitigation

| feature | what it weakens | mitigation |
| --- | --- | --- |
| TLS termination of rule hosts | The launcher CA is trusted inside the container and has no name constraints, so it could sign any name there. | The CA key never leaves the host state dir; only rule hosts are terminated, every other tunnel stays end to end. |
| Placeholder substitution (D4) | A rule host that echoes request headers or bodies reflects the real secret back into the container. | Substitution happens only in auth-like request headers (`authorization` and secret-like names, never `proxy-authorization`), never in query parameters or bodies. Every response header value is scrubbed by substring (`Location`, `Set-Cookie`, `WWW-Authenticate` included). Response bodies are not scrubbed: allow rule hosts that do not echo. |
| Derived hosts | Host config files widen egress: every provider and MCP host in `auth.json`, `models.json` and `mcp.json` becomes reachable. | `credentials.derive.enabled: false` or `credentials.derive.hosts`, `egress.deny`, and the D3 cap: an `egress.allow` set by the policy or org layer clips derived hosts and the user layer's `credentials.rules` (the policy's own rules are exempt) unless that same layer opts in with `credentials.derive.enabled: true`. |
| `egress.privateHosts` and the legacy gateway | Names in `privateHosts` and the gateway host skip the private-address filter, so a rebinding DNS answer for them reaches an internal address. | Only names, no IP literals or localhost; set by policy or user, never by a project; a lower layer may only drop entries. A rule host that resolves privately and is not listed gets a launch notice (D10). |
| Grants | The developer can widen egress at run time. | `egress.grants.enabled`, `maxHours` and `permanent` from policy or org can only turn grants off or shrink them, the D3 cap clips them, `egress.deny` and the private-range check still apply. The container cannot create grants: the CLI runs on the host only and the proxy has no grant endpoint. Session grants end with their launch (12 h cap). |
| Parent proxy | DNS is delegated: with a parent proxy set, an NXDOMAIN locally is passed to the parent, which resolves it. | The private-range check still runs on every local resolution; `noProxy` names are dialled directly. The parent's credentials are resolved on the host and kept in the proxy's memory; with `"env"` they are sent over the control socket and stripped from the environment the proxy starts with. |
| Extra CAs | Trust widens to the corporate CA, inside the container, in the proxy's upstream trust and during image builds. | `tls.extraCa` is a policy or user key, never a project key, and only shrinks under a higher layer. The build removes the CA from the image again. |
| Image layers | `image.dockerfile` runs as root at build time on the engine's default network. | Policy, org or user only, an absolute path, no `FROM`; the layer runs on top of the sandbox image and ends as `USER pi`. Treat the file as code the developer runs. |
| Host pi helper | `!command` values in host `models.json` and `mcp.json` run on the host, as they would with local pi. | Only values from the developer's own host files; a value in a file the container can write (the repository's `.pi/`) is never run on the host. |
| MCP auth store on the host | `<state>/mcp-auth/` holds real OAuth tokens; a token seeded from the host's own `mcp-auth.json` then lives in two places. | Mode 600 files outside every mount. The helper `mcp.json` is written only by `pi mcp login|logout <name>` typed in the shell and holds only `{ url, oauth }` with plain values (D1); refresh uses the definition recorded at login, never a file the container can write. A server defined only in the repository's `.pi/mcp.json` needs a y/N confirmation. |
| Write-back of `packages` | The host `~/.pi/agent/settings.json` changes from a sandbox action. | Only the `packages` key, only on `pi install|remove <source>` typed in the shell with exit 0, only the entry for that source, and never a path that exists only inside the container. Agent edits inside are never written back. |
| Org baseline | A compromised baseline source changes the effective policy. | HTTPS or an absolute path, an optional pinned sha256 (a mismatch refuses a new copy; without a valid cache it stops the launch), validated as the `org` layer, which cannot override policy. On fetch failure the cached copy is used and a notice printed. |
| Removing `PI_OFFLINE` | Startup installs and catalog refreshes reach the network. | They reach only allowed hosts; a denial is reported, never bypassed. |
| `PI_SANDBOX_TEST_RESOLVE` (D12) | A name-resolution override for live tests. | Honoured only when the launcher runs from its sources, never from the published `dist/` build; a unit test asserts it. |

## 5. Known gaps

- Plain HTTP is refused (CONNECT to port 80 has no SNI to check).
- Host-local model servers (`localhost`, plain `http`) are unreachable from the sandbox; a notice says so.
- Secrets in the `env` of stdio MCP servers become placeholders that nothing replaces until a manual `credentials.rules` entry binds them to the host the server calls.
- `/login` and the `/mcp` sign-in inside the interface fail (read-only `auth.json` and `mcp-auth.json`); log in on the host. A proxy token vault would close this (deferred).
- Project-level OAuth MCP servers get no token inside: move the server to the user `mcp.json` or give it a placeholder `Authorization` header with a rule.
- Providers whose client derives the API host from the token content may not work with a placeholder token (D5); the doctor's per-rule check shows a 401 or 403.
- NTLM and Kerberos parent proxies need a local relay such as `px` or `cntlm`.
- Private image registries: pulls send no registry credentials.
- Org baselines have no signature and no ETag, only a pinned sha256.
- `tls.extraCa` `hostStore` reads the macOS System keychain only; on Linux use `{ file }`.
- No in-interface prompt for a blocked host: the 403 body and the CONNECT failure carry `pi-sandbox: <host> is not allowed; run pi sandbox egress allow <host>`, and the launcher prints one line per blocked host when pi exits.
- No in-container unauthenticated proxy shim, so tools that cannot send proxy credentials (headless browsers) have no network.
- Domain fronting through a CDN host on the allowlist.
- The Colima VM sees all of the home directory.
- Sessions live in the sandbox volume and are not shared with host pi.
