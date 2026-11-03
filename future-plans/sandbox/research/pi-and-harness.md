# Pi 1.5.0 isolation, credentials and the harness seams

Research date: 2026-11-02, pi 1.5.0

Sources: the installed package `node_modules/@earendil-works/pi-coding-agent` (1.5.0, `dist/` only, no `src/`), its `docs/`, `examples/`, `CHANGELOG.md`, the sibling packages `pi-agent-core`, `pi-mcp`, and this repo at `main` (worktree `research/sandbox`). Paths below are relative to the pi package root (`docs/…`, `dist/…`, `examples/…`) or to the repo root (`platform/…`, `extensions/…`). Line numbers are from these copies.

## Summary of answers

- Built-in sandbox: none in 1.5.0 (no flag, no setting). Upstream points to whole-process isolation (plain Docker, Docker Sandboxes, OpenShell) or the Gondolin tool-routing example; the native OS `sandbox/` example was removed in 1.5.0.
- Credentials outside the sandbox: no pi feature does it alone. Working patterns are (a) `models.json`/`registerProvider` `baseUrl` to a gateway the sandbox reaches, with placeholder keys, (b) a credential-substituting egress proxy (Docker Sandboxes, OpenShell inference routing), (c) pi on the host with only tools isolated. `pi-agent-core` has an unwired `streamProxy` client.
- Credentials leak inward by default: bash commands and MCP stdio servers inherit the full pi process env, so env-var keys reach every subprocess.
- Remote tools: possible only by overriding built-ins with operations backends (ssh.ts, Gondolin) plus `user_bash`; extension tools, MCP, `fetch` and pi itself stay on the host. The `shellPath` setting is a no-code wrapper seam for model bash and `!` commands.
- This repo: whole-pi-in-container works unchanged if paths are mounted at their host locations; per-agent confinement needs either tool overrides bound to each child's `ctx.cwd` or out-of-process agents behind `AgentRuntime.spawn`; the `fetch` tool has no allowlist; RPC mode would lose this repo's TUI.

## A. What pi 1.5.0 ships for isolation

### No built-in sandbox

- `docs/security.md:3`: pi "can read, change, and execute files with the permissions of the account that started it". `:99`: "lack of a built-in sandbox" is outside the security boundary. `docs/index.md:39`: project trust "does not sandbox tool calls".
- No CLI flag or setting. `docs/cli.md` flags cover `--tools`, `--no-builtin-tools` (`:123`), `--no-extensions` (`:196`), `--approve`/`--no-approve` (`:237-240`), `--offline` (`:241`). A grep of `dist/` for "sandbox" finds only codemode's QuickJS sandbox (`dist/extensions/codemode/execute.js:2-5`) and a tmux probe comment (`dist/modes/interactive/interactive-mode.js:993`).
- `docs/security.md:16`: whole-process isolation "is usually the strongest practical option"; `:17`: tool-only isolation leaves "Pi itself and other extensions" outside. `:19`: the working folder "does not prevent commands from accessing other paths".
- Project trust (`docs/security.md:27-82`) gates `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, `.agents/skills`; `sessionDir` is read before trust (`:31`); saved decisions in `~/.pi/agent/trust.json` (`:70`); print, JSON and RPC modes follow `defaultProjectTrust` (`:77-82`). Context files load regardless of trust (`:57`).

### docs/containerization.md

- Method table `:9-14`: plain Docker (credentials passed in), Docker Sandboxes (provider credentials "remain on the host and are substituted by the proxy"), OpenShell ("Policy-controlled credentials and inference routing"), Gondolin extension (pi on host, built-in tools and `!` in a VM, "commands inherit host environment variables").
- `:16`: when only tools are delegated, "other extension tools still run on the host unless they also delegate their work". `:23`: mounting `~/.pi/agent` exposes credentials, settings, extensions and sessions.
- Plain Docker `:38-70`: `node:24-bookworm-slim` + bash, git, ripgrep, `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`; `docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD:/workspace" -v pi-agent-home:/root/.pi/agent`.
- Docker Sandboxes `:84-119`: "Do not run `/login` inside the sandbox" (`:86`); `sbx secret set-custom --host api.anthropic.com --env ANTHROPIC_OAUTH_TOKEN --placeholder 'sk-ant-oat01-{rand}'` (`:95-98`), the sandbox sees only the placeholder, which the proxy replaces for the configured host (`:101`); `sbx run --kit "docker.io/sbx/pi-kit:latest" pi` (`:110`).
- OpenShell `:123-151`: `openshell sandbox create --name pi-sandbox --from pi -- pi`; remote gateways need `sandbox upload/download`; "OpenShell inference routing can keep raw model credentials outside the sandbox ... point Pi at the corresponding OpenAI-compatible or Anthropic-compatible endpoint exposed by the gateway" (`:151`).
- Gondolin `:155-183`: needs Node 23.6+ and QEMU (`:159`); env-var provider keys "can therefore be visible inside the VM" (`:157`).

### Other docs

- `docs/environment-variables.md:79-101`, process configuration:
  - locations: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`;
  - network: `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `HTTP_PROXY`/`HTTPS_PROXY` (`:101`), `PI_SELF_UPDATE_COMMAND`;
  - concurrency: `PI_CODEMODE_MAX_WORKERS` (default 2, "Raise it when one process runs several sessions, such as in-process subagents", `:88`);
  - terminal: `PI_CLIPBOARD_OSC52`, `PI_HYPERLINKS`, `PI_PROGRAM_STATUS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR`, `PI_TUI_ESC_TIMEOUT`;
  - markers set by the CLI: `AI_AGENT=pi`, `PI_CODING_AGENT=true` (`:15-16`).
- `docs/settings.md`: `defaultProjectTrust` agent-dir only (`:36`); `sessionDir` (`:66`); `httpProxy` "applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients. Can only be set in agent-directory settings" (`:125`); `shellPath`, `shellCommandPrefix`, `npmCommand` (`:142-144`); built-in extensions `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, `builtin:tool-search`, disabled with `-builtin:<name>` (`:164`); `enableInstallTelemetry` (`:171`).
- `docs/custom-provider.md`, `docs/models-configuration.md`, `docs/models.md`, `docs/providers.md`: see section C.
- `docs/rpc.md:3-10`: RPC "runs Pi as a long-lived subprocess controlled through JSON records on stdin and stdout. Use it for ... process isolation"; `RpcClient` is exported. `docs/rpc-extension-ui.md:14-23`: in RPC mode `custom()` returns `undefined`, `setFooter`, `setHeader`, `setEditorComponent`, `setWorkingIndicator`, `addAutocompleteProvider` are no-ops, themes unavailable.
- `docs/sdk.md:96-116`: `createAgentSession` takes `modelRuntime`, `settingsManager`, `sessionManager`, `resourceLoader`, `tools`/`noTools`/`excludeTools`/`customTools`; SDK sessions load codemode, tool_search and MCP only when added to `extensionFactories` (`:116`). `dist/core/sdk.d.ts:12-62` has no executor, sandbox or `streamFn` option.

### Examples (`examples/extensions/`, listed under "Remote & Sandbox" in `docs/extensions.md:3322-3326`)

- `gondolin/` (`index.ts`, deps `@earendil-works/gondolin` 0.14.0): one QEMU micro-VM per extension instance, started on `session_start`, stopped on `session_shutdown` (`:410-420`); mounts `process.cwd()` (`:366`) at `/workspace` via `RealFSProvider` (`:381-389`); overrides read, write, edit, bash, grep, find, ls (`:443-515`) and `user_bash` (`:517-520`); rewrites the cwd line of the system prompt (`:522-530`). Bash env is the host env passed through `sanitizeEnv` (`:315-345`), so env keys reach the guest. No network options are passed to `VM.create`.
  - Boundary: filesystem and processes of built-in tools; not pi, not other extension tools, not env credentials.
- `ssh.ts`: `--ssh user@host[:path]` flag (`:115`); read, write, edit, bash over `ssh` child processes (`:29-31`, `:128-176`); `user_bash` and the cwd prompt line.
  - Boundary: same as Gondolin, remote machine instead of VM. Uses `process.cwd()` (`:117`).
- `bash-spawn-hook.ts`: `createBashTool(process.cwd(), { spawnHook })` rewriting command, cwd and env (`:14-29`).
  - Boundary: none by itself; the hook is where `sandbox-exec`, `bwrap` or `docker exec` would be prefixed.
- `permission-gate.ts`: `tool_call` regex on bash (`rm -rf`, `sudo`, `chmod 777`), confirm or block (`:11-33`).
  - Boundary: none; a policy prompt.
- `protected-paths.ts`: `tool_call` blocks write/edit when `path.includes(".env" | ".git/" | "node_modules/")` (`:11-27`).
  - Boundary: none; bash bypasses it.
- `project-trust.ts`: `project_trust` handler returning yes/no/undecided (`:26-40`). Controls resource loading only.
- `tool-override.ts`: overrides `read` with an access log in `getAgentDir()/read-access.log` and blocked patterns (`.env`, `.ssh`, `.aws`, ...) (`:30-45`). Header names "access control or sandboxing" and "routing tool calls to remote systems" as uses.
- `subagent/`: spawns child `pi` processes with `["--mode", "json", "-p", "--no-session"]` plus `--model`, `--tools`, `--append-system-prompt` (`index.ts:298-344`). Each child is a full pi process, which is the shape an out-of-process sandboxed agent would take.
- `with-deps/`: an extension with its own `node_modules` (`package.json` depends on `ms`); shows that extensions can carry npm deps that must be installed where pi runs.
- `interactive-shell.ts`: persistent shell via `user_bash`.
- Removed in 1.5.0: the native OS `sandbox/` example (`@anthropic-ai/sandbox-runtime`, Seatbelt/bubblewrap, domain allowlist). `CHANGELOG.md:117`: "Removed the native OS `sandbox/` extension example and its dependency. Use the Gondolin example or the containerization guide."

### What Gondolin is

`@earendil-works/gondolin` is Earendil's local Linux micro-VM (QEMU) with a JS API (`VM.create`, `vm.exec`, VFS providers such as `RealFSProvider`), maintained at github.com/earendil-works/gondolin (`docs/containerization.md:155`). In pi it is used only through the example extension. Its own network and secret features are not visible from pi's package (see Not verified).

## B. Tool plumbing

- Built-ins are created per session: `dist/core/agent-session.js:2984-2993` calls `createAllToolDefinitions(this._cwd, { read: { autoResizeImages }, bash: { commandPrefix: shellCommandPrefix, shellPath } })`; `dist/core/tools/index.js:32-42` maps names to `create<Name>ToolDefinition(cwd, options)`. Tools resolve paths against `ctx?.cwd || cwd` at execution (`dist/core/tools/bash.js:174`, `read.js:73`, `write.js:31`, `edit.js:92`), so each session (including an in-process child) gets its own cwd.
- Operations backends: `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `PowerShellOperations`, `LsOperations`, `GrepOperations`, `FindOperations` (`docs/extensions.md:2375-2405`, exported from `dist/index.d.ts:26` with `BashSpawnContext`, `BashSpawnHook`, `BashToolOptions`).
- Default bash backend `createLocalShellOperations` (`dist/core/tools/bash.js:48-70`): `fsAccess(cwd)` first ("Working directory does not exist"), then `spawn(shell, [...args, command], { cwd, detached, env: env ?? getShellEnv() })`. A guest-only cwd therefore needs custom operations, not just a hook.
- `resolveSpawnContext` (`bash.js:135-156`): starts from `getShellEnv()`, strips then re-adds `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` when `exposeSessionEnvironment` (default true), then calls `spawnHook`. `commandPrefix` is prepended as a line (`:173`).
- `getShellEnv()` (`dist/utils/shell.js:147-158`) is `{ ...process.env, PATH: <agentDir>/bin + PATH }`. Every bash command sees every env var of the pi process, provider keys included.
- `shellPath` setting: `getShellConfig(customShellPath)` (`dist/utils/shell.js:76-83`) runs it as `<shellPath> -c <command>` (`:17-18`). It is used for model bash (`agent-session.js:2984-2993`) and for user `!`/`!!` commands (`agent-session.js:3176-3184`, `createLocalBashOperations({ shellPath })`). This is a zero-code seam: a wrapper script as `shellPath` can exec `sandbox-exec`/`bwrap`/`docker exec` around the real shell for both paths, and in-process children inherit it (section F). It does not cover read, write, edit, grep, find, ls, MCP or extension tools. It is settable in project settings only after trust.
- Override: "Extensions can override built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) by registering a tool with the same name ... without a warning" (`docs/extensions.md:2344`); renderers inherit per slot, `promptSnippet`/`promptGuidelines` do not (`:2357-2361`). `--no-builtin-tools` keeps only extension tools (`docs/cli.md:123`).
- `user_bash` (`docs/extensions.md:1076-1106`): return `{ operations }` or `{ result }`; fails closed on errors since 0.86.0 (`CHANGELOG.md:721`); RPC `bash` goes through it (`CHANGELOG.md:1310`). Without a handler, `!` uses local ops with `shellPath`. `!` commands do not get `PI_*` vars (`docs/environment-variables.md:49`).
- Gates: `tool_call` can mutate input or `{ block: true }` (`docs/extensions.md:985`). Nested calls through `ctx.executeTool` (codemode) pass `tool_call`/`tool_result` handlers (`:2772-2776`), as do MCP calls (`docs/mcp.md:252-256`). So one gate covers model, codemode and MCP calls, but a gate is policy, not isolation.
- Codemode: QuickJS in a worker, "no Node APIs, file system, network, or timers; scripts reach the outside world only through tools" (`docs/codemode.md:7`).
- Process spawn sites in `dist/` (files importing `child_process`/`cross-spawn`): `core/exec.js` (`pi.exec`), `core/tools/bash.js`, `grep.js` (`rg --no-config`), `find.js` (`fd`), `core/footer-data-provider.js:49-60` (`git symbolic-ref` for the branch), `core/resolve-config-value.js:123-163` (`!command` credentials, 10 s timeout), `modes/interactive/external-editor.js`, `session-selector.js`, `interactive-mode.js`, `session-share.js` (`gh`), `modes/rpc/rpc-client.js`, `utils/shell.js`, `utils/child-process.js`, `utils/tools-manager.js` (downloads), `utils/open-browser.js`, `utils/clipboard-command.js`. MCP stdio servers: `dist/extensions/mcp/runtime.js:60-70` builds `StdioTransport`, which uses `{ ...process.env, ...config.env }` unless `inheritEnv === false` (`pi-mcp/dist/transports/stdio.js:75`); pi does not pass `inheritEnv`, so MCP servers inherit provider keys too.
- MCP can be replaced: an extension registering `/mcp` replaces built-in MCP; `-builtin:mcp` or `--no-mcp` disables it (`docs/mcp.md:266-270`).

## C. Credentials

- Storage: `<agentDir>/auth.json` (`dist/config.js:526-527`) holds API keys and OAuth tokens (`docs/providers.md:12`, `:18`). Precedence: runtime `--api-key`, then `auth.json`, then `models.json` `apiKey`, then provider env vars or ambient cloud credentials (`docs/models.md:23`).
- Env vars per provider (`docs/providers.md:20-67`); Anthropic also takes `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` (bearer) and workload identity federation via `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE` (`:67-69`).
- Commands: `auth.json` `"key": "!security find-generic-password ..."` runs once and is cached for the process lifetime (`docs/providers.md:71-84`). `models.json` `apiKey`/`headers` `!command` "run at request time and are not cached" (`docs/models.md:65`), which suits short-lived tokens from a broker. Both execute where pi runs, so the resolved token is inside the sandbox if pi is.
- `auth.json` entries can carry an `env` object that overrides process env for that provider (`docs/providers.md:90`).
- Gateway with dummy key: built-in provider `baseUrl` override keeps models and auth (`docs/models.md:69-77`); `models.json` fields `baseUrl`, `apiKey` (literal, `$NAME`, `!command`), `headers`, `authHeader` (`docs/models-configuration.md:13-24`); "The dummy key makes the model available to Pi" (`docs/models.md:54-65`); extension form `pi.registerProvider("anthropic", { baseUrl, headers: { "X-Gateway-Key": "$GATEWAY_API_KEY" } })` "for a proxy or gateway that preserves the upstream protocol" (`docs/custom-provider.md:32-49`). The `/model` picker shows only providers "that have usable authentication" (`docs/models.md:28`), so the sandbox needs a placeholder credential per provider.
- Custom wire: a provider with `stream`/`streamSimple` (`docs/custom-provider.md:15`, `:174-176`) can send requests to any host-side broker.
- `before_provider_headers` lets an extension add, override or delete outgoing headers (`docs/extensions.md:846-862`).
- `pi-agent-core` ships `streamProxy` (`pi-agent-core/dist/proxy.js:1-40`, `:71-74`): POSTs to `${proxyUrl}/api/stream` with `Authorization: Bearer <authToken>`; "The server manages auth and proxies requests to LLM providers". The coding agent does not wire it: `createAgentSession` has no `streamFn` option and `dist/core/sdk.js:261-271` always calls `modelRuntime.streamSimple`. Using it from pi means a `streamSimple` provider that calls `streamProxy`. No server side ships.
- SDK: `ModelRuntime.create({ authPath, modelsPath })`, `modelRuntime.setRuntimeApiKey(provider, key)` (`examples/sdk/09-api-keys-and-oauth.ts`), `AuthStorage.inMemory()` (`dist/core/auth-storage.js:296`), `ReadOnlyAuthStorage` (`:164`, used by `--no-refresh` paths in `dist/main.js:139`). Useful only when the process holding keys is outside the sandbox.
- OAuth: `/login` stores credentials in `auth.json`; refresh rewrites it, so OAuth inside a sandbox needs a writable `auth.json` (and puts the refresh token inside). Headless: paste the redirect URL (`docs/providers.md:14`).
- Radius: Earendil's gateway "with organization-level controls and analytics", `/login radius` (`docs/providers.md:104-114`). An enterprise gateway option; its credential is still an OAuth login inside pi.
- HTTP proxy: `applyHttpProxySettings` sets `HTTP_PROXY`/`HTTPS_PROXY` only if unset (`dist/core/http-dispatcher.js:38-44`, called from `dist/main.js:479`, `:717`); `configureHttpDispatcher` installs `undici.EnvHttpProxyAgent({ proxyTunnel: true, ... })` as the global dispatcher and installs undici's fetch as `globalThis.fetch` (`http-dispatcher.js:73-95`). Provider calls, OAuth and any extension `fetch()` in the pi process use it; `NO_PROXY` honored (`CHANGELOG.md:850`). Child processes inherit the vars through `getShellEnv()` but are free to ignore them. With CONNECT tunnelling, a proxy sees host names, not bodies, unless it terminates TLS.
- Other outbound calls (all from the pi process):
  - version check `https://pi.dev/api/latest-version` (`dist/utils/version-check.js:4`, skipped by `PI_OFFLINE` `:37` or `PI_SKIP_VERSION_CHECK` `:66`);
  - install telemetry `https://pi.dev/api/report-install?version=` (`dist/modes/interactive/interactive-mode.js:1083-1092`, off with `PI_OFFLINE`, `PI_TELEMETRY=0` or `enableInstallTelemetry: false`); provider attribution headers follow the same setting (`docs/settings.md:171`);
  - model catalog refresh at interactive start, 15 s timeout (`interactive-mode.js:850-857`, base `https://pi.dev` in `dist/core/remote-catalog-provider.js:5`); OpenRouter `/models/user` (`docs/providers.md:122`);
  - `fd`/`rg` download from GitHub releases into `<agentDir>/bin` (`dist/utils/tools-manager.js:88`, `:231`, skipped offline `:296`);
  - packages: `pi install`, `packages` setting, `-e npm:`/`-e git:` via `npmCommand` and git; 1.5.0 now re-checks `-e npm:<pkg>` without an exact version and re-fetches `-e git:<repo>@<branch>` on every start and `/reload` (1.5.0 changelog entry "Fixed `pi -e npm:<pkg>` staying on the version from the first download");
  - `pi update` installer API `https://pi.dev/api/installer/releases` (`dist/package-manager-cli.js:21`);
  - MCP OAuth Client ID Metadata Document at `https://pi.dev/oauth` (`dist/extensions/mcp/oauth.js:24`, new default in 1.5.0); MCP HTTP servers; llama.cpp Hugging Face lookups (`dist/extensions/llama/`);
  - `/share` (gh gist, `PI_SHARE_VIEWER_URL`), `/bug` (`PI_RADIUS_GATEWAY`).
  - `--offline`/`PI_OFFLINE` disables "automatic network activity, including model catalog refreshes" (`docs/cli.md:241-242`).

## D. Filesystem footprint

- Agent dir: `getAgentDir()` = `$PI_CODING_AGENT_DIR` or `~/.pi/agent` (`dist/config.js:495`, `:510-516`; SDK `agentDir`).
  - configuration: `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, `AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `themes/` (`docs/configuration.md:11-24`);
  - secrets: `auth.json`, `mcp-auth.json`;
  - state: `trust.json` (`dist/core/trust-manager.js:180`), `models-store.json` (`dist/core/models-store.js:30`), `sessions/` (`config.js:546`), `crashes.json` (`dist/core/crash-log.js:8`), `mcp.log`, `pi-debug.log` (`config.js:551`);
  - binaries and packages: `bin/` (`fd`, `rg`; `config.js:538`), `tools/`, `npm/` and `git/` for user packages (`dist/core/package-manager.js:1845`, `:1921`), temporary package dirs for `-e` sources (`package-manager.js:1923-1929`);
  - managed installer: `install/` (`releases/`, `staging/`, `current-version`, `managed-install.json`, marker checked in `dist/package-manager-cli.js:22-37`) and `bin/pi` (observed in the local `~/.pi/agent`);
  - this repo: `pi-<extension>.json`, `agents/`.
- Sessions: `<agentDir>/sessions/--<cwd with / as ->--/<file>.jsonl`, grouped by working directory (`docs/sessions.md:60`; observed names such as `--Volumes-Projects-pi-extensions--`). Relocate with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` (`docs/environment-variables.md:82`, `docs/settings.md:66`).
- Project: `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, `.pi/extensions|skills|prompts|themes` (`docs/configuration.md:28-37`), project packages in `.pi/npm` and `.pi/git` (`package-manager.js:1843`, `:1919`), `.agents/skills` in cwd and ancestors, context files from cwd and every parent (`docs/configuration.md:43`).
- Temp (`os.tmpdir()`): truncated bash output `pi-bash-<hex>` (`dist/utils/output-files.js:16`, prefix `bash.js:319`), external editor `pi-editor-*` (`external-editor.js:7`), `/share` `pi-share-*`, WSL clipboard files.
- Writes in normal interactive use: `settings.json` (`lastChangelogVersion`, `dist/core/settings-manager.js:516-520`; `/settings`; Ctrl+S model default), `auth.json` (login, refresh), `models-store.json` (catalog refresh), `trust.json`, sessions, `bin/` on first `grep`/`find`, `crashes.json`. A read-only agent dir therefore needs at least `sessions/` moved out and `bin/` pre-populated or the tools on `PATH`.
- `PI_PACKAGE_DIR` relocates the package itself (themes, docs, codemode worker; `config.js:334-336`).

## E. Terminal and IO

- The TUI opens only when stdin and stdout are terminals; with either redirected and no JSON/RPC mode pi falls back to print mode (`docs/cli.md:30`). A container needs `-it` (PTY).
- Capability detection for OSC 8, inline images and truecolor can be wrong behind proxies or multiplexers; override with `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR` (`docs/terminal-setup.md:209-219`, `docs/environment-variables.md:95-98`). OSC 7501 program status is sent only after the terminal answers a query; tmux and screen do not forward it (`docs/terminal-setup.md:223-235`).
- Platform-local fallbacks fail remotely: Apple Terminal modifier fallback "works only when Pi runs on the same Mac" (`docs/terminal-setup.md:45`); the Windows Shift+Enter fallback does not work in WSL or SSH (`:173`).
- Clipboard: `copyToClipboard` uses `pbcopy`, `wl-copy`, `xclip`/`xsel` (`dist/utils/clipboard.js:87-117`) and emits OSC 52 only when `SSH_CONNECTION`, `SSH_CLIENT`, `MOSH_CONNECTION` or `PI_CLIPBOARD_OSC52=1` is set (`:10-15`). In a container set `PI_CLIPBOARD_OSC52=1`. Image paste reads the system clipboard through `wl-paste`/`xclip`/PowerShell (`dist/utils/clipboard-image.js:76-163`), which a headless container lacks.
- Browser: `openBrowser` spawns `open`/`xdg-open` (`dist/utils/open-browser.js:9-21`). Needed only for `/login` and MCP OAuth, not at startup; the headless fallback is pasting the redirect URL (`docs/providers.md:14`). Device-code login now opens the page on Enter (1.5.0).
- External editor: `$VISUAL`/`$EDITOR` run where pi runs (`docs/environment-variables.md:100`).
- Driving pi from outside: `--mode json` (run prompts, JSONL events, exit; `docs/cli.md:47`), `--mode rpc` (JSONL commands on stdin; `:48`, `docs/rpc.md`), `RpcClient` (`dist/modes/rpc/rpc-client.js`). RPC commands cover prompt, steer, follow_up, abort, bash, model, thinking, compaction, session stats, entries, fork, switch (`docs/rpc-commands.md` headings `:7-786`); there is no command to inject a custom message. Extension dialogs (`select`, `confirm`, `input`, `editor`) become `extension_ui_request` records; custom components do not (`docs/rpc-extension-ui.md:7-23`).

## F. This repo

### Per extension (shipped code, `tests/` excluded)

- subagents:
  - spawns: `git -C <cwd>` via `execFile` for worktrees, env = `process.env` minus `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_PREFIX` (`extensions/subagents/core/run-agent/worktree.ts:11-26`); in-process child sessions (`platform/pi-adapter/child/child-runtime.ts:125-221`), whose tools spawn what pi spawns.
  - network: the `fetch` tool, global `fetch(target.href, { redirect: "follow" })`, http/https only, no host allowlist, no private-address check (`core/fetch-tool/fetch.ts:94-110`); it goes through pi's global undici dispatcher, so `HTTPS_PROXY` applies.
  - writes: `<session dir>/agents/<id>/manifest.json` (`core/agent-registry/registry.ts:19-50`), `result.md` (`core/run-agent/result.ts:36-37`), agent handoff files (`core/run-agent/runner.ts:390-391`), `<cwd>/.pi/worktrees/<id>-<stamp>` with its `.gitignore` plus git's `pi-agents/…` branch and `.git/worktrees/` metadata (`worktree.ts:28-73`), `.pi/pi-subagents.json` or `<agentDir>/pi-subagents.json` on `/agents setup` (`core/agent-setup/write.ts:44`).
  - reads: agent files from the built-in `agents/`, `<agentDir>/agents/`, `<cwd>/.pi/agents/`.
- session-limits: writes the main handoff document `<tmpdir>/pi-handoff/<session id>/main-handoff.md` through the shared `handoff` tool (`platform/shared/handoff/handoff-document.ts:58-64`, `handoff-tool.ts:46-47`, `extensions/session-limits/core/limits.ts:234`); custom session entries (`limits.ts:153`, `:168`). No spawns, no network.
- spending: session entries only (`extensions/spending/core/spending.ts:16`, `:59-61`); cost and tokens from pi's usage figures. No network.
- context: session entries (`extensions/context/api/plugin.ts:68`); `homedir()` only for display. No network.
- transcript: session entries (`extensions/transcript/api/plugin.ts:29`); reads session files through the adapter.
- mcp-import: reads `~/.claude.json`, `<cwd>/.mcp.json`, `~/.cursor/mcp.json`, `<cwd>/.cursor/mcp.json` (`extensions/mcp-import/core/sources.ts:68-88`); writes `<agentDir>/mcp.json` or `.pi/mcp.json` (`core/import-flow.ts:54`, `:79`); converted header helpers become a `!(<helper>) | node -e '…'` command (`core/convert.ts:55-57`) that pi runs when it connects, so `node` and the helper must exist where pi runs.
- model-default: writes `defaultProvider`, `defaultModel`, `enabledModels`, `defaultThinkingLevel` into `<agentDir>/settings.json` through pi's `SettingsManager` (`platform/pi-adapter/runtime/default-model.ts:51-59`); a failed write comes back as a failure string (`extensions/model-default/api/plugin.ts:20`, `:35`).
- style: writes `<agentDir>/pi-style.json` (`extensions/style/core/settings.ts:24-29`); reads prompt files.
- notifications: OSC 9, OSC 777 (rxvt only, chosen from `TERM`/`TERM_PROGRAM`) or BEL, written to pi's TUI terminal only in TUI mode (`platform/pi-adapter/ui/create-ui.ts:66-86`, `:232-245`).
- footer, composer, command-aliases, questionnaire, working-indicator: no spawns, no network, no files beyond settings and session entries; pi's footer data provider runs `git` for the branch. These, the agent view, transcript panes and forms depend on `custom()`, `setFooter`, `setEditorComponent` and overlays, all no-ops in RPC mode.
- Settings writes for all managed extensions: `<agentDir>/pi-<extension>.json` or `<cwd>/.pi/pi-<extension>.json` (`platform/shared/plugin/settings-files.ts:132-134`); `.pi/` creation with `.gitignore` (`platform/shared/project-dir.ts:12-46`). `copyText` uses pi's `copyToClipboard` (`create-ui.ts:246`).
- No interception today: the repo registers no `tool_call`, `user_bash`, built-in override, `spawnHook` or provider (grep over `extensions/` and `platform/`); the host listens only to lifecycle, message, tool-execution and model events (`platform/pi-adapter/runtime/host.ts`). `createBashToolDefinition` is imported only for rendering (`platform/pi-adapter/tools/transcript.ts:7`, `:37`).

### How children are built (what a sandbox inherits)

- One process. `spawn` builds an `AgentSession` with `cwd: spec.cwd`, the shared `getAgentDir()`, one shared `ModelRuntime` (`child-runtime.ts:117-123`, `:152`, `:190-205`) and `SessionManager.create(spec.cwd, spec.sessionDir, { parentSession })` (`:186-188`). Credentials are resolved once in-process for every agent.
- Settings: an in-memory copy of the parent's settings with compaction off and cache warming off (`childSettings`, `:48-52`, `:148-150`), so `shellPath`, `shellCommandPrefix` and `httpProxy` carry over; `isProjectTrusted` is copied from the parent ctx.
- Extensions: `DefaultResourceLoader({ cwd: spec.cwd, agentDir, ... })` loads the user's configured extensions; `extensionsOverride` drops only paths under `childExclude`, which is the subagents root (`:166-171`, `extensions/subagents/api/extension.ts:18`). A separately installed sandbox extension therefore loads in every child, and its tools see `ctx.cwd = spec.cwd`. Examples that capture `process.cwd()` at factory time (Gondolin `:366`, ssh `:117`) would mount the main session's cwd, not the child's or its worktree.
- Inline factories: the hidden child extension (`child/child-extension.ts:16-31`, which records the first provider payload into the child session) and codemode, tool_search and, when `spec.mcp` and MCP is loaded, MCP for every child with a non-empty tool list (`child-runtime.ts:78-95`, `:172-179`). Shipped chores have `mcp: false`, leads `mcp: true` (`extensions/subagents/agents/*/*.md`).
- Custom tools (`run_agent`, `message_agent`, `agent_status`, `handoff`, `fetch` when listed) are host closures passed as `customTools` through `toPiTool` (`child-runtime.ts:204`, `platform/pi-adapter/tools/tool-bridge.ts`).
- Placement: `place(record, definition, session.cwd)` then `spawn({ id, cwd: placement.cwd, sessionDir: record.dir, parentSessionFile, model, thinking, tools, customTools, skills, mcp, promptAppend, reserveTokens })` (`extensions/subagents/core/run-agent/runner.ts:723-753`). Nested agents currently use the session cwd.

### What breaks where

- Whole pi in a container: everything runs inside, TUI included. Needs `git`, `rg`, `fd` (or GitHub egress), Node, and this package baked in or installable (`pi install git:github.com/zharskiy/pi-extensions` needs GitHub egress). Path identity matters: sessions are grouped by cwd path, `trust.json` keys on canonical paths, and git worktree metadata (`.git/worktrees/<name>/gitdir`, the checkout's `.git` file) stores absolute paths, so a worktree created at `/workspace/...` is broken on the host. Mount the project at its host path. mcp-import finds no `~/.claude.json` or `~/.cursor`. Handoff files live in the container's tmp, fine within one process. Clipboard needs `PI_CLIPBOARD_OSC52=1`; notifications need `TERM`/`TERM_PROGRAM` forwarded for the OSC 777 choice.
- Read-only agent dir: pi fails on sessions (relocate), `lastChangelogVersion`, catalog refresh, trust saves, OAuth refresh, `bin/` downloads; in this repo model-default and style saves, `/agents setup` (user scope), mcp-import (user scope) and every settings UI fail as data. The subagents agent dirs live in the session dir and are unaffected if that is writable.
- One OS sandbox (Seatbelt/bubblewrap) around the whole pi: needs write access to the agent dir (or a relocated session dir), `os.tmpdir()` (handoff, bash output), `<cwd>/.pi`, and the repository's git common dir, which is outside the cwd when pi runs in a subfolder or a linked worktree, and is always written by worktree agents' commits. The policy is per process, so it cannot give different agents different cwds.
- Tool-only sandbox with pi on the host: a sandbox extension installed at user level applies to children too, but these stay on the host: the `fetch` tool, MCP stdio servers (full env) and HTTP servers, other user extensions, `!command` credential helpers, `@file` reads by the editor, `rg`/`fd` unless grep/find are overridden. Each child session would start its own VM with the Gondolin pattern.

### Seams for a per-agent policy (cwd confinement, egress allowlist)

1. `AgentRuntime.spawn(SpawnSpec)` (`platform/pi-adapter/types/runtime.ts:44-69`). `SpawnSpec` has `cwd`, `tools`, `customTools`, `mcp`, but no policy field. A `sandbox` field (write roots, egress hosts) would flow definition → `runner.ts:741-753` → spawn. This is the only seam that also moves credentials and MCP per agent. An out-of-process implementation (child `pi --mode rpc` inside a per-agent sandbox, as `examples/extensions/subagent/` does with `--mode json`) has to carry the `ChildSession` surface (`types/runtime.ts:29-42`):
   - `start`, `send` (RPC `prompt`, `steer`, `follow_up`), `abort`, `dispose` (close stdin);
   - `sendCustom`, `sendHidden`: no RPC command; needs a child-side extension loaded with `-e`;
   - `subscribe` (events on stdout), `ownUsage` (`get_session_stats`), `lastText` (`get_last_assistant_text`), `runTexts`, `sessionFile` (a host-visible session dir);
   - the host custom tools (`run_agent`, `message_agent`, `agent_status`, `handoff`) bridged back to the parent process.
2. Child loader `extensionFactories` (`child-runtime.ts:172-179`): an inline factory per spawn that overrides bash, read, write, edit, grep, find, ls with operations bound to `spec.cwd` and the policy, plus a `tool_call` gate for `fetch` and `mcp__*`. In-process, so it confines tools, not the process. The main session needs the same through a user-level extension or the adapter, plus `user_bash`.
3. `shellPath` wrapper: no code; covers model bash and `!` in main and children (settings copy); per-agent policy only by deriving it from `$PWD` or `PI_SESSION_FILE` (child session files live under `<session>/agents/<id>/`).
4. Custom tools: the `fetch` spec (`extensions/subagents/api/plugins/fetch-tool.ts:27-47`) is the place for an egress allowlist and SSRF guard; `toPiTool` is the common wrapper for all host tools.
5. Egress: since every in-process `fetch` and provider call uses the undici global dispatcher, one egress proxy via `httpProxy`/`HTTPS_PROXY` covers pi, the fetch tool and MCP HTTP; child processes need OS-level enforcement to not bypass it.

### future-plans/cwd/spec.md

It gives the cwd value per agent, not enforcement: optional `cwd` per `run_agent` item, symlinks resolved, must be the session cwd or inside it, else the batch is refused (`future-plans/cwd/spec.md:11`); per-target trust (`:12`); nested agents inherit the caller's cwd, successors their predecessor's (`:13`); worktrees under `<target>/.pi/worktrees/` (`:14`). Agents in other repos than the caller's (pi started in a parent folder holding several repos) are a deferred item of the sandbox plan, not part of it. The cwd rule would already admit them, but project resources are the gap: pi collects context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`) by walking up from cwd through parent directories to the filesystem root, never down (`dist/core/resource-loader.js:130` and `:73-87`), and project `.pi/` resources come from `<cwd>/.pi`, so a child whose cwd is a repo under the parent would need its own resolution of `AGENTS.md`, `.pi/settings.json`, `.pi/agents`, skills, extensions and `.pi/mcp.json`, which the cwd plan would have to define. A linked worktree whose common dir lies outside a mounted parent folder would also be unsupported in the container. For a sandbox this is the right input (write root = agent cwd, always under the session cwd), but a policy also needs the repo's git common dir writable for worktree or subfolder agents, the agent's session dir and tmp for host-written files, and it must reach `SpawnSpec` as a policy, not only as `cwd`.

## G. Making a sandboxed pi feel native

- Whole pi in a container, terminal attached: the only option where every extension in this repo works unchanged (full TUI). Native feel comes from a host `pi` shim that runs the container with the cwd mounted at its host path, a persistent non-credential agent dir volume, `TERM`, `COLORTERM`, `TERM_PROGRAM`, `PI_CLIPBOARD_OSC52=1` forwarded, and provider `baseUrl` in `models.json` pointing at a host or central gateway with placeholder keys (or a Docker Sandboxes/OpenShell credential proxy). Credentials stay out; per-agent confinement inside the container is still tool-level only.
- TUI on the host, tools remote: pi supports this only through operations backends in extensions (Gondolin, ssh.ts). There is no generic remote-tools mode in 1.5.0. Credentials stay in the host process by construction; the host process, extension tools, MCP and `fetch` stay unconfined; every agent session needs the backend bound to its own `ctx.cwd`.
- Host UI driving a containerized pi over RPC: process boundary and credentials are clean, but the UI is the client's; `custom()`, footer, editor component and overlays do not exist in RPC (`docs/rpc-extension-ui.md:14-23`), so this repo's footer, composer, agent view, transcript panes and forms would need a new client. Not native.
- Hybrid: main session as today (on host or in one container), subagents as out-of-process `pi --mode rpc` in per-agent sandboxes behind the `AgentRuntime` seam. Gives real per-agent cwd and egress policy and keeps the main TUI native, at the cost of the RPC bridge described in F.

## What changed since the 1.3.0 research

- Removed upstream in 1.5.0: `examples/extensions/sandbox/` and its `@anthropic-ai/sandbox-runtime` dependency (`CHANGELOG.md:117`). The old "insertion point 2" reference implementation is gone; Gondolin and the containerization guide are the official paths.
- Gondolin example bumped to `@earendil-works/gondolin` 0.14.0 for security advisories (`CHANGELOG.md:90`, 1.5.0). Still no env scrubbing; still `process.cwd()`.
- 1.4.0: codemode scripts wait up to 60 s for a worker instead of failing, `PI_CODEMODE_MAX_WORKERS` raises the cap of two; relevant for in-process subagents (this repo's `platform/pi-adapter/child/codemode.ts` sets it).
- 1.5.0 security-relevant fixes: MCP sign-in rejects non-http(s) OAuth metadata URLs; login dialog strips control characters from URLs; a saved "Do not trust" now wins for projects without trust-requiring resources (so `ctx.isProjectTrusted()` can be false where it was true); macOS bash abort stops the process group; `grep` runs `rg --no-config`.
- 1.5.0 new outbound behaviour: MCP OAuth defaults to a Client ID Metadata Document at `https://pi.dev/oauth`; `-e npm:`/`-e git:` sources re-check the registry or remote on every start and `/reload`; `PI_SELF_UPDATE_COMMAND`/`selfUpdateCommand` allow a wrapper for `pi update`.
- Confirmed unchanged: containerization method table; security doc stance; operations interfaces and `spawnHook` (now also `exposeSessionEnvironment`, `commandPrefix`); `PI_*` injected before the hook; local backend's cwd existence check; built-in override by name (now including `powershell`); `user_bash` fail-closed; subagent example flags; no executor or `streamFn` in `createAgentSession`.
- Not in the old research: the `shellPath` setting as a wrapper seam for both model bash and `!`; `getShellEnv()` and MCP stdio passing the full process env (provider env keys leak to every command and MCP server); the global undici `EnvHttpProxyAgent` covering in-process `fetch`; `streamProxy` in pi-agent-core; `models.json` `!command` evaluated per request; Radius as a vendor gateway; RPC's missing custom-component support.
- Repo side since the old pass: `core/adapter/pi-child.ts` is now `platform/pi-adapter/child/child-runtime.ts`, the contract is `platform/pi-adapter/types/runtime.ts`; handoff documents moved from `<tmpdir>/pi-subagents/…` to `<tmpdir>/pi-handoff/<session id>/main-handoff.md` and `<agent id>-handoff.md`; `SpawnSpec` gained `parentSessionFile`, `skills`, `mcp`, `reserveTokens`; `ChildSession` has `sendCustom` and `sendHidden` instead of `wake`; every child with tools gets inline codemode and tool_search, MCP per definition; `.pi/` writes go through `platform/shared/project-dir.ts`; `fetch` is a `fetchTool` service plugin.

## Not verified

- Gondolin's own network model (default egress, HTTP hooks, host allowlist, secret placeholders): the package is not installed and the example passes no network options. The old note that issue #6297 fixed an allow-all default could not be checked offline.
- Docker Sandboxes proxy and `pi-kit` contents, OpenShell inference routing and policy format: only what `docs/containerization.md` states.
- Whether a gateway `baseUrl` works for OAuth-subscription providers (token refresh through the gateway) as it does for API keys.
- Whether pi trusts a TLS-terminating egress proxy via `NODE_EXTRA_CA_CERTS` with its undici dispatcher (`proxyTunnel: true`): confirmed by Node docs (https://nodejs.org/api/cli.html#node_extra_ca_certsfile), not exercised end to end.
- `@earendil-works/pi-env` and the durable harness (`packages/durable/src/env/node.ts` is cited in `dist/utils/shell.js:20`): not in `node_modules`; status unknown.
- How capability detection behaves in `docker run -it` without `TERM_PROGRAM`; OSC 9/777 passthrough in tmux.
- `oauth.json` in the agent dir: a string match in `dist/`, owner not traced.
- Upstream issue and PR numbers cited by the old research (#4104, #903, #5356, #8788, #10624, #10846).
