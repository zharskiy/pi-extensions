# launcher structure

Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
launcher/
├── bin/
│   ├── pi-sandbox.js        the package bin: imports the built ../dist/cli/main.js
│   ├── pi-sandbox-dev.js    development entry: imports ../cli/main.ts, not published
│   └── uninstall-engine.mjs run by uninstall.sh with node: removes the labelled containers, relays, pi-sandbox networks and (--volumes) volumes over the engine socket, imports nothing
├── cli/
│   ├── main.ts              builds the real CliDeps and calls run
│   ├── run.ts               the command table, routes argv (intercepted commands before the pass-through), renders LauncherError and unexpected errors
│   ├── deps.ts              CliDeps: runner, env, home, cwd, streams, terminal, signals, platform, uid, backend, proxy control (ensure, list, stop, remove, control, denials, trust), bundledPi, resolveHost, confirm, now; writeNotices, hostAgentDirOf, settleAll (waits for every promise, then throws the first error)
│   ├── launch.ts            LaunchContext (repoHash computed once), the pi pipeline, withSandbox (a signal cancels preparation at the next step and waits for the current one) and the steps other commands reuse (prepareImage through ensureSandboxImage with the host pi resolved once per launch, hostPiMoved and the image pi notice, prepareContainer with render, the git plan and sync); proxy and image, then render, git notices, version, git plan and host sessions; prints the workspace and node_modules overlay notices, then the settings sync
│   ├── derive.ts            the host side: host pi files, provider host table, deriveSandboxPi, private-host notices (DNS waited for at most 2 s), trust bundle
│   ├── sandbox-proxy.ts     starts the proxy with daemonEnv, the host pi command, its version, the repository token, dynamic.json (under a lock), envSecretsFor over /control (no line breaks), the denial summary on exit (the grant hint, or egress.allow when grants are off)
│   ├── mcp-sign-in.ts       signInMcpServers: at launch start, one interactive host pi mcp login per derived OAuth server that needs one (TTY only, the shared lock and mcp-login.json, 24 h quiet after a failure), with its notices
│   ├── sessions.ts          registers and ends a launch session, stops the idle container after the last one (then the full host sessions sweep); the session-end git notices with a pins-in-use check per git common dir
│   ├── host-sessions.ts     host sessions on or off for this launch (with the notice), readyHostSessions (prepare, guard, sweep), sweepWhenIdle under the session registry lock, the share probe, the exit and --no-sandbox sweeps
│   ├── intercept.ts         pi install|remove (a local source inside the repository or workspace refused), pi mcp add|remove|login|logout on the host with the host agent dir (login and logout in an empty <state>/mcp-login-<random>/ folder), bare pi update
│   ├── host-pi.ts           resolveJobPi (managed, else bundled: host jobs and the image), resolveShellPi and hostPiCommand (one selection, also PATH outside sandboxRoots: doctor, pi update, --no-sandbox), the doctor's host pi text
│   ├── vm-lifecycle.ts      the Colima VM operations every caller shares: the vm.lock, the colima runner wrapper, the detect retry, reachableBackend (the one engine unreachable error) and openLaunchBackend (starts the stopped pi-sandbox profile on the launch path only)
│   ├── vm-shares.ts         ensureVmShares (share a missing folder with the Colima VM: lima.yaml and colima.yaml mounts, the full --mount list, lock, live-session refusal, restart) and checkVmShares for the doctor
│   ├── versions.ts          launcher version, testedPiVersion (the devDependency pin), imagePiVersion (the host pi's, else the pin), isOlderVersion
│   ├── index.ts             the public surface
│   └── commands/
│       ├── status.ts            runtime, container (and its session dir label), proxy, image, sessions, grants, node_modules overlays, shared caches
│       ├── config.ts            config show (the effective config and the source of each key)
│       ├── egress.ts            egress allow, revoke and list [--user] (persistent grants per repository or user-wide, denials)
│       ├── gc.ts                stopped containers (and the proxy token of each repository whose container it removes), idle relays and proxies (repositories with a live session kept), unmounted volumes whose labelled repository root is gone (shared caches kept; --shared-caches removes this user's unmounted ones)
│       ├── reset.ts             this repository's container, proxy instance, render dir, and with --volumes its volumes (node_modules overlays included, shared caches kept) and sync copy
│       ├── stop.ts              pi sandbox stop: colima stop of the pi-sandbox profile (refused while a pi session runs), then every proxy instance
│       ├── doctor.ts            the doctor's order and rendering
│       ├── doctor-container.ts  in-container checks: PI_OFFLINE, pi mcp list, the mcp-auth.json placeholder sweep, the settings.json package URL sweep, the host sessions share probe, trust and one request per credential rule host; exports OFFLINE_PROBE and MCP_LIST_PROBE
│       ├── doctor-host.ts       host checks: host pi (warn below the tested version), provider hosts, parent proxy, org baseline (the file the config loaded), grants, the host session dir, vm size (colima status, warn below 8 CPUs or 10 GiB), vm shares (checkVmShares, report only), one line per OAuth MCP server from host pi's mcp-auth.json (signed in with the expiry, or needs sign-in)
│       └── help.ts              usage
├── config/
│   ├── types.ts             SandboxConfig, layers, credential rules, secret sources, egress, tls, image and org keys
│   ├── validate.ts          the key spec (egress host[:port], rules, secret sources, org file), validateLayer, layerKeys, projectKeyRefusal (PROJECT_KEYS, the four keys a project may set)
│   ├── merge.ts             mergeLayers over policy, org, user and project: policy and org keys final, egress.deny and env.allow unions, per-key sources
│   ├── load.ts              loadEffectiveConfig from defaults, policy, the org file, user, project; refuses a project layer that sets a key outside PROJECT_KEYS
│   ├── egress-entry.ts      the egress entry grammar: TLS_PORT, normalizeHost, parseEntry, matchesPattern (single-label *.), matchesEntry, authorityOf, isLoopbackName, SECRET_MARKER, fillTemplate
│   ├── defaults.ts          the default config and image reference
│   └── dotted.ts            dotted key access
├── workspace/
│   ├── discover.ts          discoverWorkspace: the nearest .git found without git, its layout checked, then git rev-parse must agree; without one, workspace mode (each nested repository confirmed, git dirs inside the root, 128 repositories and the scan budget, refusals), unreadable directories refused, the 512 node project cap; lenient for admin commands and --no-sandbox
│   ├── workspace-scan.ts    scanWorkspace: one level-by-level walk (50 000 directories, node_modules, .pi and .git skipped, unreadable directories recorded, submodule checkouts not registered) for nested repositories and node projects (lockfile dirs, package.json dirs below them, 256 per repository)
│   ├── git-workspace.ts     workspaceSelfBinds, workspaceNotices, gitConfigFiles (every non-command config origin of a repository, includes too), assertWorkspaceGitConfig (root and nested listings, config inside the workspace outside its repositories refused) and the listing refusal
│   ├── git-layout.ts        gitLayoutAt (main, separate, submodule and linked worktree git dirs, refusing links and foreign commondir or gitdir pointers, pinning an empty commondir in place), findGitRoot, findModuleGitDirs, findWorktreeGitDirs, gitRefusal
│   ├── git-protect.ts       findProtectedGitPaths (hooks dirs, config and pointer files, pins; config origins, includes too, inside the repository bound read-only; in a workspace those inside any nested repository, and a hooksPath or origin in the workspace outside every repository refused), gitPathGuard (the protected-path check with the engine sockets passed in), protectedGitOverlay (each leaf lstat'ed, refused when it is a link or goes through one, then the self binds)
│   ├── git-session.ts       recordGitBaseline (scan and alternates in git/<repo hash>/baseline.json), gitLaunchNotices, gitSessionEndNotices (unpin under each pin lock, layout, alternates and nested-repository notices), per repository of a workspace
│   ├── git-integrity.ts     assertGitIntegrity, pinGitDirs and unpinGitDirs (the commondir pin), withGitPinLock (one lock per git common dir, every repository's in a workspace), gitAlternatesNotices, gitDirOf
│   ├── git-scan.ts          scanGitBaseline (nested .git entries and gitlinks, one walk skipping every known git dir and the gitlinks of each repository), nestedGitNotices
│   ├── git-command.ts       inertGitOptions: core.fsmonitor off and an empty core.hooksPath for the launcher's own git calls
│   ├── guard.ts             assertSafeWorkspace: refuses a repo at or above home, ~/.pi, the host agent dir, state, config or /, or inside ~/.pi, the host agent dir, state or config; assertHostSessionsDir, the one ~/.pi exception
│   ├── pi-session-dir.ts    pi's session slug, hostSessionsDir, hostSessionsChoice (on, or off with its reason)
│   ├── mounts.ts            resolveExtraMounts: mounts.extraReadOnly checked (exists, real path, protected paths, .git, engine socket)
│   ├── roots.ts             assertWithinWorkspaceRoots
│   └── types.ts             Workspace (nested repositories, node projects), gitRepos, mountedGitDirs
├── backend/
│   ├── types.ts             Backend (the test seam of the one engine), ContainerSpec, ExecSpec (with user), ExecIo, ImageInfo, MountSpec, NetworkRef, ProxyRoute
│   ├── image-reference.ts   repository, tag and repo@digest of an image reference
│   ├── labels.ts            LABELS: every pi-sandbox.* label key
│   ├── exec-capture.ts      execCapture: a non-tty exec with optional stdin, its exit code and collected stdout and stderr
│   ├── managed-network.ts   repoNetworkName, repoNetworkLabels, pruneCandidates and removeWithNetworkCleanup
│   └── docker-engine/       Docker Engine API adapter for the Colima VM: socket (the pinned ~/.colima/pi-sandbox/docker.sock), engine client, container body, exec session (streams with backpressure), images (pull with digest check, build), volumes, relay per policy (kept while other repositories use it)
├── container/
│   ├── spec.ts              buildContainerSpec (network, proxy env with the repository token, render and trust mounts, the host session dir bind and env, volume labels and owned paths, spec hash), nodeModulesOverlays, sharedCacheVolumes, repoVolumes, forwardedEnv
│   ├── git-overlay.ts       planGitOverlay (discovery once per launch: the overlay for the spec and ready() for right before a start: pins, layout checks, hook dirs, leaves checked again, snapshots, baseline), the merged overlay of a workspace's repositories; re-exports gitLaunchNotices and gitSessionEndNotices from workspace
│   ├── git-snapshot.ts      writeGitSnapshots, gitSnapshotPath, gitSnapshotsDir: launcher-owned copies of the read-only git paths
│   ├── names.ts             container and volume names, userHashOf, the shared cache volume name and the wanted identity file (re-exports LABELS from backend)
│   ├── lifecycle.ts         ensureContainer (per-repository lock, wanted identity, reuse while other sessions are live, beforeStart right before a create or start, inside aroundStart, replacement that keeps the repository network, missing mount points created on the host, the root chown of owned volume paths after each start), gitDirInUseElsewhere (both git dir labels), isCurrentContainer, findCurrentContainer, findRepoContainer, removeRepoContainer, collectGarbage
│   ├── run-pi.ts            runPi: exec behind a pid file, PI_SANDBOX_LAUNCH_ID (the session id), raw mode, resizes, signal handling
│   └── probes.ts            CheckResult (ok, warn, fail, skip) and doctor checks: same-path mount, credential sweep (environment, auth.json, mcp.json), no-route, proxy health
├── image/
│   ├── Dockerfile           the sandbox image (no pi config baked in; BASH_ENV set to bash-env.sh, which /etc/bash.bashrc also sources first)
│   ├── entrypoint.sh        render links, CA bundle, idle
│   ├── bash-env.sh          /usr/local/lib/pi-sandbox/bash-env.sh in the image, read through BASH_ENV and the system bashrc: command_not_found_handle with the image.packages hint
│   ├── sandbox-image.ts     ensureSandboxImage: the recorded image when a current container uses it, else a pinned pull or a build, then the layer
│   ├── context.ts           buildInContext (a temporary build dir under the state dir, removed after), reusableImage
│   ├── build.ts             build context, ensureBuiltImage, pullPinnedImage, recordedImage
│   ├── layer.ts             ensureLayerImage: a fixed template on top of the base (trust, image.packages, npmGlobal, the image.dockerfile text verbatim, the fixed USER pi, WORKDIR, ENTRYPOINT and CMD tail)
│   ├── record.ts            image.json with its layer record and the pi version of a local build
│   ├── build-trust.ts       the extra CAs in the build context
│   └── build-proxy.ts       parent proxy build arguments, refused with credentials
├── hostpi/
│   ├── files.ts             readHostPiFiles
│   ├── derive.ts            deriveSandboxPi: rules, hosts, files and notices
│   ├── derive-auth.ts       auth.json entries and environment keys
│   ├── derive-models.ts     models.json providers and models
│   ├── derive-mcp.ts        mcp.json HTTP and stdio servers
│   ├── headers.ts           header values to placeholders and secret sources
│   ├── rules.ts             placeholder and rule construction per identity
│   ├── endpoints.ts         rule endpoints (host, port) and their keys
│   ├── provider-endpoints.ts  hosts of a provider from the table or its baseUrl
│   ├── userinfo.ts          credentials in URLs
│   ├── json.ts              objectOr and jsonPointer
│   ├── locate.ts            locateManagedPi (pi's managed install in the host agent dir), locateBundledPi (an unreadable pi package.json counts as no bundled pi), locatePiPackage (a PATH pi's package)
│   ├── provider-hosts.ts    readProviderHosts with its cache per pi version
│   ├── provider-hosts.mjs   run with node against the host pi's package: the built-in provider host table (the one launcher file that loads a pi package)
│   ├── mcp-auth.ts          mcpSignIns (each OAuth server of the host user mcp.json with its host pi mcp-auth.json entry) and mcpSignInsNeeded (no refresh token, access token missing or expired)
│   ├── model-secret.mjs     run with node as a command secret: one model's secret in models.json, found by provider, model id and base URL
│   └── types.ts             HostPiFiles, DeriveInput, DerivedSandboxPi, BundledPi
├── provision/
│   ├── render.ts            renderAgentDir: <state>/render/<repo hash>/ (auth.json, models.json, mcp.json and the copied entries), returns { renderDir }
│   ├── tree.ts              filtered copy of the host agent dir entries (16 reads at a time)
│   ├── pool.ts              inPool: runs work over a list with at most n in flight
│   ├── sync.ts              syncSettingsFile: the host settings.json keys over the volume copy, under the sync lock
│   ├── merge-settings.ts    hostWinsSettings (host-owned keys from the host only), host settings preparation
│   ├── package-source.ts    sourceOfEntry, withoutSourceCredential (URL userinfo), credentialHosts
│   ├── volume.ts            read and write a file in the agent volume through exec
│   ├── host-sessions.ts     prepareHostSessions (0700), sweepHostSessions (special files, pi's header rule failing closed with bare-CR rejection, owner access restored, size, 8 files at a time, failures), probeHostSessions (host marker, guest create and delete)
│   └── types.ts             RenderInput, SyncInput and results
├── grants/
│   ├── store.ts             grants.json: addGrant (refused while egress.grants is false), revokeGrants, activeGrants
│   ├── sessions.ts          newSessionId, registerSession and endSession (both delete entries of dead launchers), liveSessions, withRepoSessionLock
│   └── types.ts             Grant, GrantRequest, GrantMatch, SessionEntry
├── proxy/
│   ├── daemon.ts            the proxy process entry
│   ├── control.ts           ensureProxyRunning, readProxyInstances, stopProxy, removeProxyInstance, daemonEnv, per-instance lock, control token, kept port, restart on a host pi version change
│   ├── client.ts            the launcher's HTTP client to a daemon: readHealth, sendProxyControl, fetchDenials
│   ├── server.ts            startProxyServer: token check, decideConnect, CONNECT dispatch to the denial page, the interceptor or the tunnel, listen on loopback and close
│   ├── control-routes.ts    createControlRoutes: /healthz, /policy, /denials, and /control
│   ├── tunnel.ts            createTunnel: address check before the 200, ClientHello and server name check before the upstream dial, then the splice
│   ├── intercept.ts         createInterceptor: TLS termination for rule hosts, one TLS context per host and leaf
│   ├── denials.ts           createDenials: the last 200 denials per repository, the access log line, the JSON 403 or the denial page
│   ├── replies.ts           PROXY_AGENT, ESTABLISHED, rawReply, sendJson, readLimited
│   ├── private-hosts.ts     privateHostNotices: rule hosts that resolve to a restricted address and are not in egress.privateHosts
│   ├── single-flight.ts     singleFlight: one pending promise per key (secret cache)
│   ├── denial-page.ts       createDenialPages: the 403 page over TLS for a denied CONNECT, with the mint rate and name limits
│   ├── runtime.ts           live view of dynamic.json, the token files and grants (live sessions read on every request), extras per repository
│   ├── dynamic.ts           dynamic.json { repos } keyed by token hash, writeProxyDynamic, repoProxyToken, removeRepoToken, tokenFileHashes, readDenials
│   ├── auth.ts              repository and control authorization, guestProxyUrl
│   ├── policy.ts            decideConnect, restricted addresses, the denial reason
│   ├── rules.ts             matchRule, header rewrite and response scrub
│   ├── terminate.ts         credential injection for rule hosts on the terminated stream, a secret's local reply (the MCP sign-in 503) answered without dialling upstream, an upstream 401 to an injected token turned into that reply; keep-alive upstream agents per repository, host, port and access, upgrades on a fresh connection
│   ├── parent.ts            parent proxy route (IPv6 literal without brackets) and CONNECT through it
│   ├── trust.ts             ensureTrustBundle: the launcher CA plus tls.extraCa
│   ├── sign-in.ts           createSignIn: the proxy's host pi mcp login per server (own process group, output to proxy.log, the shared lock, 60 s after a start and 10 min after a failure in mcp-login.json), waited on by mcp-oauth and killed at close
│   ├── secrets/             createSecretResolver: env, file, command, pi-auth, mcp-oauth (host pi's mcp-auth.json entry, else the sign-in and its 503 reply), cache, errors
│   ├── sni.ts               ClientHello server name parsing
│   ├── dial.ts              resolving dialer with the private-address filter, 10 s connect timeout
│   ├── tls-ca.ts            launcher CA (created once under a lock, pair renamed into place) and leaf certificates through openssl, kept in memory (LRU of 256)
│   ├── access-log.ts        JSON-line access log
│   ├── settings.ts          proxy settings from the config, proxyPolicyHash
│   └── files.ts             per-instance file paths under proxy/<policy hash>/ and the ProxyInstance record
├── shared/                  LauncherError, errorMessage, CommandRunner, sha256Hex, repoHash, stableHash, JSON files (readJsonFile, writeJsonFile, and the lenient isJsonObject, parseJsonObject, readJsonObject), writeFileAtomic, ensureRandomHexFile, launcherPaths, realOrResolved (and its sync variant), launcherRoot, launcherEntry, expandHome, isWithin, isSecretName, isAuthLikeHeader, placeholders, ensureSalt, stateLayout, GUEST_PATHS; regular-file.ts (readRegularFile without following links, lstatOrUndefined, sameEntry); pi-env.ts (PI_AGENT_DIR_VARIABLE, PI_SESSION_DIR_VARIABLE, LAUNCHER_SET_VARIABLES with BASH_ENV, hostAgentDir); mcp-auth-key.ts (MCP_SERVER_NAME, mcpAuthKey, readMcpAuthEntry, the one parser of host pi's mcp-auth.json, isFreshMcpToken, mcpLoginCommand, makeMcpLoginDir, readMcpLogins and updateMcpLogin over mcp-login.json); state-layout.ts (stateLayout, every state path including ca, extraPem, imageRecord, wanted, mcpLogin, mcpLoginLock(key), proxyRoot and proxyInstance(policyHash) with dynamic, dynamicLock, tokensDir and repoToken), file-lock.ts (withFileLock, the pid lock every launcher lock uses, withFileLockIfFree; withDirectoryLock, the mkdir lock of vm.lock; isProcessAlive)
├── examples/                org-baseline.json (a starting point for an org baseline)
├── schema/                  sandbox-config.schema.json
├── install.sh               macOS install: Colima profile, launcher and its bundled pi (or the managed pi, whose ~/.local/bin/pi link it replaces and records in replaced-pi-link), PATH, the user config's org key (--org), doctor in a temporary repository (host sessions off)
├── uninstall.sh             removes what install.sh and the launcher created (restores the recorded managed pi link when the record names this shim; engine objects through bin/uninstall-engine.mjs, no docker CLI), and the session, render, sync, mcp-login.json, provider-hosts and grants state
├── THREAT-MODEL.md          assets, trust boundaries, what each feature weakens, known gaps
├── tsconfig.build.json      emits dist/ (gitignored) for the published bin
└── tests/
    ├── shared/ config/ workspace/ backend/ container/ image/ proxy/ grants/ hostpi/ provision/ cli/   unit tests per folder
    ├── backend/conformance.ts   the adapter conformance suite, run on the fake engine, the fake backend and live
    ├── container/run-pi.test.ts runPi, including the signal path, on the fake backend
    ├── backend/fake-backend.conformance.test.ts   the conformance suite and the fake's own contract (refusals, prune rules, guest agent dir)
    ├── proxy/hello.test.ts, keep-alive.test.ts, private-hosts.test.ts   ClientHello reading and the dial timeout, upstream connections never shared between repositories, privateHostNotices
    ├── config/project-keys.test.ts, egress-entry.test.ts, mounts.test.ts   the project allowlist, the egress entry grammar, mounts.sharedCaches and mounts.autoNodeModules (validation, defaults, layers)
    ├── workspace/git-integrity.test.ts   worktree pointer checks and the session-end notices
    ├── workspace/workspace-mode.test.ts   workspace discovery (scan, nested repository and git config refusals, node projects, lenient mode), self binds and notices, pin locks and session-end notices over nested repositories
    ├── image/sandbox-image.test.ts   ensureSandboxImage paths (recorded, pinned, built, layer)
    ├── image/bash-env.test.ts   the missing-command hint under a bash -c spawned like pi's shell tool (sourced, sourced twice, through a bashrc, and BASH_ENV skipped for socket stdin without SHLVL; skipped on bash older than 4), BASH_ENV refused in env.allow and never forwarded
    ├── cli/harness.ts       temp dirs (removed after each test), fake runner, CliDeps with collected output, recorded control messages and confirmations, a fake bundled pi; writeManagedPi and writePathPi; writeLimaMounts and writeColimaMounts
    ├── cli/launch-wiring.test.ts, intercept.test.ts, egress.test.ts, mcp-sign-in.test.ts, launch-host-sessions.test.ts   launch wiring, intercepted commands, grants, the launch-start MCP sign-in, host sessions
    ├── cli/vm-lifecycle.test.ts   the launch's start of the stopped VM (notice, status then start, no profile, running but unreachable, colima failures, admin commands never start it) and pi sandbox stop (order of colima stop and proxy stop, live-session refusal, already stopped, no profile, arguments, help)
    ├── cli/vm-shares.test.ts   the lima.yaml parser, shareFor, and the launch's VM share step against a fake colima (notice, full --mount list, live-session refusal, colima failures, custom colima.yaml keys)
    ├── cli/host-pi.test.ts, install.test.ts, uninstall.test.ts   the host pi of host jobs, the image and --no-sandbox; install.sh's managed pi takeover run for real with a temp HOME and fake uname, sw_vers, brew, colima and npm (no git, so the smoke step is skipped), and the colima start with --mount $HOME:w only for a new profile; uninstall.sh's engine cleanup and link restore
    ├── config/fixtures.ts   layer files in temp dirs
    ├── proxy/mcp-oauth.test.ts   the mcpOAuth source against a fake host pi script: fresh token, login on expiry, the 503 after the wait, cooldowns across resolvers, the 401 cases through the proxy, the login group killed at proxy close
    ├── proxy/proxy-client.ts    CONNECT and TLS client helpers
    ├── support/             fake-runner.ts (+ its test), fake-engine.ts, fake-backend.ts (with guestAgentDir and guestFile), fake-clock.ts, sandbox-config.ts, temp-dir.ts (tempDir, writeText, writeJson, removed after each test), expect-no-leak.ts (expectNoLeak over container specs, exec argv, env and stdin, and render files)
    └── live/                *.live.test.ts against a real engine with fixtures/ and harness/, run only with PI_SANDBOX_LIVE=1 against ~/.colima/pi-sandbox/docker.sock; harness/resolve-preload.mjs is the --import preload that resolves the fixture hosts for host pi scripts and the proxy daemon
```

Each folder with code has an `index.ts` that is its only public surface. The docs are `README.md` (for users), `ARCHITECTURE.md`, `THREAT-MODEL.md` and this file.
