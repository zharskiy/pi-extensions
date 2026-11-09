# launcher structure

Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
launcher/
├── bin/
│   ├── pi-sandbox.js        the package bin: imports the built ../dist/cli/main.js
│   ├── pi-sandbox-dev.js    development entry: imports ../cli/main.ts, not published
│   └── uninstall-engine.mjs run by uninstall.sh with node, imports nothing: --host-side <state> refuses while a launch is live, else releases each repos/<hash>/ pins, created dirs and live proxy and the recorded sign-in groups (its own copy of the liveness rule); otherwise removes the labelled containers, relays, pi-sandbox networks and (--volumes) volumes over the engine socket
├── cli/
│   ├── main.ts              builds the real CliDeps and calls run
│   ├── run.ts               the command table, routes argv (intercepted commands before the pass-through), renders LauncherError and unexpected errors
│   ├── deps.ts              CliDeps: runner, env, home, cwd, streams, terminal, signals, platform, uid, machine (host CPUs and GiB), backend, proxy control (ensure, read, stop, denials, trust), bundledPi, resolveHost, confirm, now; writeNotices, hostAgentDirOf, reachableBackend (the one engine unreachable error, no VM start)
│   ├── launch.ts            LaunchContext (repoHash computed once), openContext(deps, mode) (sandbox: strict discovery, workspace checks, the backend; admin: lenient, a reachable backend; host: lenient, no backend), vmPathsOf (the paths the VM must share, host caches writable), the pi pipeline and withSandbox (stages vm, shares, host, proxy, image, container, sync, each reported through an optional report; a signal cancels preparation at the next step and waits for the current one), prepareSandbox(input) with proxy and image, then render, git notices, version, git plan and host sessions; prints the workspace, node_modules overlay and host cache notices (host caches created in the shares stage, resolved before the spec), then the settings sync
│   ├── derive.ts            the host side: host pi files, provider host table, deriveHostTools and deriveSandboxPi, private-host notices (DNS waited for at most 2 s), trust bundle
│   ├── sandbox-proxy.ts     the repository's RepoProxyInput (envSecretsFor with no line breaks, parentProxyAuth apart), the repository token and ensureRepoProxy under the repository launch lock, the denial summary on exit (the grant hint, or egress.allow when grants are off)
│   ├── mcp-sign-in.ts       signInMcpServers: at launch start, one interactive host pi mcp login per derived OAuth server that needs one (TTY only, the shared lock and mcp-login.json, 24 h quiet after a failure), with its notices
│   ├── launches.ts          beginLaunch (repo.json, the launch entry and its heartbeat) and finishLaunch (ends the launch, removeRepoSandbox and the launch-end git notices after the last one, the top-level session sweep otherwise, then sweepOrphans), othersLive, busyLaunches (the count the VM share and stop steps refuse on)
│   ├── sweep.ts             removeRepoSandbox (container, relay and network, proxy and token, recorded pins, created dirs, git config copies, host sessions; the engine steps skipped when it is unreachable), sweepOrphans (repositories with leftovers and no live launch, forgetting those whose root is gone, the daily collection in gc.json: orphaned volumes and dangling sandbox images), the gc pass
│   ├── host-sessions.ts     host sessions on or off for this launch (with the notice), readyHostSessions (prepare, guard, sweep), sweepWhenIdle under the repository's launch lock, the share probe, the exit and --no-sandbox sweeps
│   ├── intercept.ts         pi install|remove (a local source inside the repository or workspace refused), pi mcp add|remove|login|logout on the host with the host agent dir (login and logout in an empty <state>/mcp-login-<random>/ folder), bare pi update
│   ├── host-pi.ts           resolveJobPi (managed, else bundled: host jobs and the image), resolveShellPi and hostPiCommand (one selection, also PATH outside sandboxRoots: doctor, pi update, --no-sandbox), the doctor's host pi text
│   ├── versions.ts          launcher version, testedPiVersion (the devDependency pin), imagePiVersion (the host pi's, else the pin), isOlderVersion
│   ├── index.ts             the public surface
│   └── commands/
│       ├── status.ts            runtime, container (and its session dir label), proxy, image, live launches, grants, node_modules overlays, shared caches
│       ├── config.ts            config show (the effective config and the source of each key)
│       ├── egress.ts            egress allow, revoke and list [--user] (persistent grants per repository or user-wide, denials)
│       ├── gc.ts                stopped containers (and the proxy token of each repository whose container it removes), idle relays and proxies (repositories with a live session kept), unmounted volumes whose labelled repository root is gone (shared caches kept; --shared-caches removes this user's unmounted ones)
│       ├── reset.ts             this repository's container, proxy instance, render dir, and with --volumes its volumes (node_modules overlays included, shared caches kept) and sync copy
│       ├── stop.ts              pi sandbox stop: backend.vm.stop (refused while a launch runs), then every proxy instance
│       ├── doctor.ts            the doctor: withSandbox with a stage report (ok|fail per stage), then the probes in the container, then the host checks
│       ├── doctor-probes.ts     CheckResult (ok, warn, fail, skip) and the in-container probes: proxy health, same-path mount, credential sweep (environment, auth.json, mcp.json), no-route, PI_OFFLINE, pi mcp list, the mcp-auth.json placeholder sweep, the settings.json package URL sweep, the host sessions share probe, trust and one request per credential rule host; exports OFFLINE_PROBE and MCP_LIST_PROBE
│       ├── doctor-host.ts       host checks: host pi (warn below the tested version), provider hosts, parent proxy, org baseline (the file the config loaded), grants, the host session dir, one line per OAuth MCP server from host pi's mcp-auth.json (signed in with the expiry, or needs sign-in)
│       └── help.ts              usage
├── config/
│   ├── types.ts             SandboxConfig, layers, credential rules, secret sources, egress, tls, image and org keys
│   ├── validate.ts          the key spec (egress host[:port], rules, secret sources, org file), validateLayer, layerKeys, projectKeyRefusal (PROJECT_KEYS, the four keys a project may set)
│   ├── merge.ts             mergeLayers over policy, org, user and project: policy and org keys final, egress.deny and env.allow unions, per-key sources
│   ├── load.ts              loadEffectiveConfig from defaults, policy, the org file, user, project; refuses a project layer that sets a key outside PROJECT_KEYS
│   ├── egress-entry.ts      the egress entry grammar: TLS_PORT, normalizeHost, parseEntry, matchesPattern (single-label *.), matchesEntry, authorityOf, isLoopbackName, SECRET_MARKER, fillTemplate
│   ├── defaults.ts          the default config and image reference
│   ├── egress-presets.ts    EGRESS_PRESETS (npm, pypi, github, maven, gradle, go, cargo hosts) and egressAllowList (presets expanded ahead of egress.allow)
│   └── dotted.ts            dotted key access
├── workspace/
│   ├── created.ts           removeCreatedDirs: recorded dirs removed deepest first while empty and not links
│   ├── discover.ts          discoverWorkspace: the nearest .git found without git, its layout checked, then git rev-parse must agree; without one, workspace mode (each nested repository confirmed, git dirs inside the root, 128 repositories and the scan budget, refusals), unreadable directories refused, the 512 node project cap; lenient for admin commands and --no-sandbox
│   ├── workspace-scan.ts    scanWorkspace: one level-by-level walk (50 000 directories, node_modules, .pi and .git skipped, unreadable directories recorded, submodule checkouts not registered) for nested repositories and node projects (lockfile dirs, package.json dirs below them, 256 per repository)
│   ├── git/workspace.ts     workspaceSelfBinds, workspaceNotices, gitConfigFiles (every non-command config origin of a repository, includes too), assertWorkspaceGitConfig (root and nested listings, config inside the workspace outside its repositories refused) and the listing refusal
│   ├── git/layout.ts        gitLayoutAt (main, separate, submodule and linked worktree git dirs, refusing links and foreign commondir or gitdir pointers, pinning an empty commondir in place), findGitRoot, findModuleGitDirs, findWorktreeGitDirs, gitRefusal
│   ├── git/protect.ts       findProtectedGitPaths (hooks dirs, config and pointer files, pins; config origins, includes too, inside the repository bound read-only; in a workspace those inside any nested repository, and a hooksPath or origin in the workspace outside every repository refused), gitPathGuard (the protected-path check with the engine sockets passed in), protectedGitOverlay (each leaf lstat'ed, refused when it is a link or goes through one, then the self binds)
│   ├── git/launch.ts        recordGitBaseline (scan and alternates in repos/<repo hash>/git/baseline.json), gitLaunchNotices, gitLaunchEndNotices (layout, alternates and nested-repository notices), per repository of a workspace
│   ├── git/integrity.ts     assertGitIntegrity, pinGitDirs (returns the pins it wrote) and unpinRecorded (recorded pins removed under their pin lock while they read . and no other sandbox uses the git dir), withGitPinLock (one lock per git common dir, every repository's in a workspace), gitAlternatesNotices, gitDirOf
│   ├── git/scan.ts          scanGitBaseline (nested .git entries and gitlinks, one walk skipping every known git dir and the gitlinks of each repository), nestedGitNotices
│   ├── git/command.ts       inertGitOptions: core.fsmonitor off and an empty core.hooksPath for the launcher's own git calls
│   ├── guard.ts             assertSafeWorkspace over the protected table of mounts.ts: refuses a repo at or above / or any protected path, or inside a protected path other than the home (~/.pi, the host agent dir, state, config, ~/.ssh and the other protected home dirs, the system dirs); assertHostSessionsDir, the one ~/.pi exception
│   ├── pi-session-dir.ts    pi's session slug, hostSessionsDir, hostSessionsChoice (on, or off with its reason)
│   ├── mounts.ts            protectedPaths, the one protected table (the home, ~/.pi, the host agent dir, state, user config, PROTECTED_HOME, SYSTEM_DIRS, engine sockets); resolveExtraMounts: mounts.extraReadOnly checked (exists, real path, protected paths, .git, engine socket); HOST_CACHES (mounts.hostCaches presets to home cache subfolders and guest paths), hostCachePaths, createHostCacheDirs (creates missing ones 0700 after the checks) and resolveHostCaches (not a link, real path under the home and outside the protected table, no credential file at the top level, no sharedCaches overlap)
│   ├── roots.ts             assertWithinWorkspaceRoots
│   └── types.ts             Workspace (nested repositories, node projects), gitRepos, mountedGitDirs
├── backend/
│   ├── types.ts             Backend (the test seam of the one engine) with Vm (ensureRunning, coverage, ensureShares, size, recommendedSize, stop), waitRemoved, listNetworks, removeRepoNetwork, ContainerSpec, ExecSpec (with user), ExecIo, ImageInfo, MountSpec, NetworkRef, NetworkSummary, ProxyRoute
│   ├── image-reference.ts   repository, tag and repo@digest of an image reference
│   ├── labels.ts            LABELS: every pi-sandbox.* label key
│   ├── exec-capture.ts      execCapture: a non-tty exec with optional stdin, its exit code and collected stdout and stderr
│   ├── managed-network.ts   repoNetworkName, relayName, repoNetworkLabels
│   └── colima/              createColimaBackend: the Docker Engine API adapter for the Colima VM and the VM itself; profile.ts (the pinned profile and ~/.colima/pi-sandbox/docker.sock), engine client (socket resolved per call), container body, exec session (streams with backpressure), images (pull with digest check, build), volumes, relay per repository (AutoRemove, network alias pi-sandbox-proxy, recreated on a port change); vm.ts (ensureRunning under locks/vm.lock with --activate=false and the detect retry, size from colima status, recommendedVmSize mirroring install.sh, stop refused while a launch runs), shares.ts (coverage and ensureShares: the full --mount list, lock, busy refusal, restart), colima-yaml.ts (the lima.yaml and colima.yaml mounts reader)
├── container/
│   ├── spec.ts              buildContainerSpec (network, proxy env naming pi-sandbox-proxy, the proxy token hash label, git paths bound read-only from the host and config from its copy, render and trust mounts, the host session dir bind and env, host cache binds read-write with only their guest parents owned, volume labels with cache-path and owned paths, spec hash), nodeModulesOverlays, sharedCacheVolumes, repoVolumes, forwardedEnv
│   ├── git-overlay.ts       planGitOverlay (discovery once per launch: the overlay for the spec and ready() for right before a create: pins recorded, layout checks, hook dirs created and recorded, leaves checked again, git config copies, baseline), the merged overlay of a workspace's repositories; re-exports gitLaunchNotices and gitLaunchEndNotices from workspace
│   ├── names.ts             container and volume names, userHashOf, the shared cache volume name (re-exports LABELS from backend)
│   ├── lifecycle.ts         ensureContainer (container.lock, reuse of a running current container or of an outdated one while other launches are live, beforeStart right before a create inside aroundStart, unused cache volumes removed, missing mount points created and recorded, the root chown of owned volume paths after each create), discardContainer (stop 3 s, wait for the removal, delete), gitDirInUseElsewhere (both git dir labels), findCurrentContainer, findRepoContainer, listLauncherContainers, removeRepoContainers
│   └── run-pi.ts            runPi: exec behind a pid file, PI_SANDBOX_LAUNCH_ID (the launch id), raw mode, resizes, signal handling
├── image/
│   ├── Dockerfile           the sandbox image (no pi config baked in; base tools with curl, jq, python3, make and gh; the pinned glab .deb checked with sha256sum -c; the launcher CA in the system store; the pi-sandbox stub that points back to the host; BASH_ENV set to bash-env.sh, which /etc/bash.bashrc also sources first)
│   ├── entrypoint.sh        render links, render/tools links into the home (~/.m2/settings.xml, ~/.config/gh/hosts.yml, ~/.npmrc, ~/.config/pip/pip.conf) and copies (~/.gitconfig, ~/.config/glab-cli/config.yml with mode 600), CA bundle, the JVM truststore, idle
│   ├── bash-env.sh          /usr/local/lib/pi-sandbox/bash-env.sh in the image, read through BASH_ENV and the system bashrc: command_not_found_handle with the image.packages hint, and the trust flags appended to JAVA_TOOL_OPTIONS when the entrypoint built the truststore
│   ├── sandbox-image.ts     ensureSandboxImage: the recorded image when a current container uses it, else a pinned pull or a build, then the layer, then removeStaleImages after a build
│   ├── context.ts           buildInContext (a temporary build dir from stateLayout, removed after), reusableImage
│   ├── build.ts             build context, ensureBuiltImage, pullPinnedImage, recordedImage
│   ├── layer.ts             ensureLayerImage: the content-addressed pi-sandbox-layer tag, reused through resolveImage; a fixed template on top of the base (trust, image.packages, npmGlobal, the image.dockerfile text verbatim, the fixed USER pi, WORKDIR, ENTRYPOINT and CMD tail)
│   ├── record.ts            <state>/image.json: { base: { id, digest, inputsHash, pi } }; repos/<hash>/image.json: { layer } the tag the repository wants, and wantedLayers over every repository
│   ├── prune.ts             removeStaleImages (unreferenced layer tags and the previous base) and collectImages (the daily gc: unreferenced layer tags, dangling images); referenced means a container uses it or a repos/<hash>/image.json names it, and nothing created in the last hour is removed
│   ├── build-trust.ts       the extra CAs in the build context
│   └── build-proxy.ts       parent proxy build arguments, refused with credentials
├── hostpi/
│   ├── files.ts             readHostPiFiles
│   ├── derive.ts            deriveSandboxPi: rules, hosts, files, tools and notices
│   ├── derive-tools.ts      deriveHostTools: the gh, glab, npm, pip, Maven and git derivers (host files and commands, placeholders only)
│   ├── tools/               gh.ts (hosts.yml hosts, gh on PATH, version check, gh auth token rules, GH_TOKEN), glab.ts (config.yml hosts in glab's order, glab config get token rules, api_host, gh wins a shared host, GITLAB_TOKEN), npmrc.ts, pip.ts, maven.ts (servers for mirror or profile repository hosts, encrypted ones skipped), git.ts (user.name and user.email), files.ts (file reads, PATH lookup, placeholder rules)
│   ├── derive-auth.ts       auth.json entries and environment keys
│   ├── derive-models.ts     models.json providers and models
│   ├── derive-mcp.ts        mcp.json HTTP and stdio servers
│   ├── headers.ts           header values to placeholders and secret sources
│   ├── rules.ts             placeholder and rule construction per identity
│   ├── endpoints.ts         rule endpoints (host, port) and their keys; URL credential checks and strippedUrl (userinfo removed with a notice)
│   ├── provider-endpoints.ts  hosts of a provider from the table or its baseUrl
│   ├── json.ts              objectOr and jsonPointer
│   ├── locate.ts            locateManagedPi (pi's managed install in the host agent dir), locateBundledPi (an unreadable pi package.json counts as no bundled pi), locatePiPackage (a PATH pi's package)
│   ├── provider-hosts.ts    readProviderHosts with its cache per pi version
│   ├── provider-hosts.mjs   run with node against the host pi's package: the built-in provider host table (the one launcher file that loads a pi package)
│   ├── mcp-auth.ts          mcpSignIns (each OAuth server of the host user mcp.json with its host pi mcp-auth.json entry) and mcpSignInsNeeded (no refresh token, access token missing or expired)
│   └── types.ts             HostPiFiles, DeriveInput, DerivedSandboxPi, BundledPi
├── provision/
│   ├── render.ts            renderAgentDir: <state>/repos/<repo hash>/render/ (auth.json, models.json, mcp.json, the copied entries and tools/: m2-settings.xml with the sandbox proxy and the derived servers and mirrors, gh-hosts.yml, glab-config.yml, npmrc, pip.conf, gitconfig), returns { renderDir }
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
│   ├── launches.ts          the launch registry: newLaunchId, registerLaunch (with its heartbeat) and endLaunch (both delete entries that are not live), liveLaunches (pid, boot time and heartbeat), withRepoLaunchLock
│   └── types.ts             Grant, GrantRequest, GrantMatch, Launch, RegisteredLaunch
├── proxy/
│   ├── daemon.ts            the proxy process entry: --repo and --state, RepoProxyInput on stdin, proxy.json with its heartbeat, the idle exit
│   ├── start.ts             ensureRepoProxy (reuse by inputHash, the changed-input notice while others live), stopRepoProxy (SIGTERM, 2 s, SIGKILL through shared/liveness.ts), readRepoProxy, repoProxyToken, removeRepoToken, readDenials, PROXY_LOG_LIMIT
│   ├── idle.ts              watchIdle: the 30 s check under the repository launch lock, idle after two empty checks
│   ├── client.ts            the launcher's HTTP client to a daemon: readHealth, fetchDenials, DenialRecord
│   ├── server.ts            startProxyServer: token check, decideConnect, CONNECT dispatch to the denial page, the interceptor or the tunnel, listen on loopback and close
│   ├── routes.ts            createRoutes: /healthz and /denials; plain HTTP refused otherwise
│   ├── tunnel.ts            createTunnel: address check before the 200, ClientHello and server name check before the upstream dial, then the splice
│   ├── intercept.ts         createInterceptor: TLS termination for rule hosts, one TLS context per host and leaf
│   ├── denials.ts           createDenials: the last 200 denials per repository, the access log line, the JSON 403 or the denial page
│   ├── replies.ts           PROXY_AGENT, ESTABLISHED, rawReply, sendJson
│   ├── private-hosts.ts     privateHostNotices: rule hosts that resolve to a restricted address and are not in egress.privateHosts
│   ├── single-flight.ts     singleFlight: one pending promise per key (secret cache)
│   ├── denial-page.ts       createDenialPages: the 403 page over TLS for a denied CONNECT, with the mint rate and name limits
│   ├── runtime.ts           the repository's rules and extras: derived hosts and its grants read live from grants.json
│   ├── auth.ts              the repository token authorization, guestProxyUrl
│   ├── policy.ts            decideConnect, restricted addresses, the denial reason
│   ├── rules.ts             matchRule, header rewrite (Basic values through their decoded text) and response scrub (also the base64 sent)
│   ├── terminate.ts         credential injection for rule hosts on the terminated stream, a secret's local reply (the MCP sign-in 503) answered without dialling upstream, an upstream 401 to an injected token turned into that reply; keep-alive upstream agents per repository, host, port and access, upgrades on a fresh connection
│   ├── parent.ts            parent proxy route (IPv6 literal without brackets) and CONNECT through it
│   ├── trust.ts             ensureTrustBundle: the launcher CA plus tls.extraCa
│   ├── sign-in.ts           createSignIn: the proxy's host pi mcp login per server (own process group, output to proxy.log, the shared lock, 60 s after a start and 10 min after a failure in mcp-login.json), waited on by mcp-oauth and killed at close
│   ├── secrets/             createSecretResolver: env (urlPassword), file (a JSON pointer or a tool config format), command, pi-auth, mcp-oauth (host pi's mcp-auth.json entry, else the sign-in and its 503 reply), cache, errors
│   ├── sni.ts               ClientHello server name parsing
│   ├── dial.ts              resolving dialer with the private-address filter, 10 s connect timeout
│   ├── tls-ca.ts            launcher CA (created once under a lock, pair renamed into place) and leaf certificates through openssl, kept in memory (LRU of 256)
│   ├── access-log.ts        JSON-line access log capped with one rotation, capLog
│   ├── settings.ts          proxyPolicy: the egress policy from the RepoProxyInput
│   └── files.ts             RepoProxyInput, RepoProxy (the proxy.json record), DaemonInput
├── shared/                  LauncherError, errorMessage, CommandRunner, sha256Hex, repoHash, stableHash, JSON files (readJsonFile, writeJsonFile, and the lenient isJsonObject, parseJsonObject, readJsonObject), writeFileAtomic, ensureRandomHexFile, launcherPaths, realOrResolved (and its sync variant), launcherRoot, launcherEntry, expandHome, isWithin, isSecretName, isAuthLikeHeader, placeholders, tool-config.ts (npmrc, ini and Maven settings parsers, the json select, toolConfigValue), settleAll (waits for every promise, then throws the first error), ensureSalt, stateLayout, GUEST_PATHS; regular-file.ts (readRegularFile without following links, lstatOrUndefined, sameEntry); pi-env.ts (PI_AGENT_DIR_VARIABLE, PI_SESSION_DIR_VARIABLE, LAUNCHER_SET_VARIABLES with BASH_ENV, hostAgentDir); mcp-auth-key.ts (MCP_SERVER_NAME, mcpAuthKey, readMcpAuthEntry, the one parser of host pi's mcp-auth.json, isFreshMcpToken, mcpLoginCommand, makeMcpLoginDir, readMcpLogins and updateMcpLogin over mcp-login.json); state-layout.ts (stateLayout, every state path: repo(repoHash) with record, launches, lock, containerLock, render, sync, git, gitCopy(path), gitBaseline, pins.json, created.json and proxy (record, token, log, accessLog) under repos/<repo hash>/, the locks (vmLock, gitPinLock, mcpLoginLock(key)), buildContext, ca, extraPem, imageRecord, gcRecord, mcpLogin), liveness.ts (bootTime, processMark, isLive and isLiveFile: pid alive, boot time within 30 s, heartbeat under 90 s; heartbeat, terminateProcess, HEARTBEAT_MS), repo-state.ts (files only: repo.json, pins.json, created.json, git config copies, hasRepoLeftovers, knownRepos, forgetRepo), file-lock.ts (withFileLock, the pid and boot lock every launcher lock uses, refreshed while held, withFileLockIfFree; withDirectoryLock, the mkdir lock of vm.lock)
├── examples/                org-baseline.json (a starting point for an org baseline)
├── schema/                  sandbox-config.schema.json
├── install.sh               macOS install: Colima profile (started with --activate=false), launcher and its bundled pi (or the managed pi, whose ~/.local/bin/pi link it replaces and records in replaced-pi-link), PATH, the user config's org key (--org), doctor in a temporary repository (host sessions off)
├── uninstall.sh             removes what install.sh and the launcher created: the host side through bin/uninstall-engine.mjs --host-side (refused while a session runs), engine objects through bin/uninstall-engine.mjs (no docker CLI), the Colima profile unless --keep-vm, the recorded managed pi link restored when the record names this shim, then the state dir
├── THREAT-MODEL.md          assets, trust boundaries, what each feature weakens, known gaps
├── tsconfig.build.json      emits dist/ (gitignored) for the published bin
└── tests/
    ├── shared/ config/ workspace/ backend/ container/ image/ proxy/ grants/ hostpi/ provision/ cli/   unit tests per folder
    ├── backend/conformance.ts   the adapter conformance suite, run on the fake engine, the fake backend and live
    ├── backend/colima-vm.test.ts   the launch's start of the stopped VM through the Colima vm (notice, status then start, no profile, running but unreachable, colima failures, admin commands never start it) and pi sandbox stop (order of colima stop and proxy stop, live-launch refusal, already stopped, no profile, arguments, help)
    ├── backend/colima-shares.test.ts   the lima.yaml parser, shareFor, the launch's VM share step against a fake colima (notice, full --mount list, live-launch refusal, colima failures, custom colima.yaml keys) and coverage
    ├── backend/colima-size.test.ts   recommendedSize against install.sh's sizing on sample machines, size from colima status
    ├── container/run-pi.test.ts runPi, including the signal path, on the fake backend
    ├── backend/fake-backend.conformance.test.ts   the conformance suite and the fake's own contract (refusals, guest agent dir)
    ├── proxy/hello.test.ts, keep-alive.test.ts, private-hosts.test.ts   ClientHello reading and the dial timeout, upstream connection reuse, privateHostNotices
    ├── proxy/start.test.ts  ensureRepoProxy (reuse by input, the changed-input notice, env secrets never on disk, a stale record's process never killed), stopRepoProxy, the idle watch under the launch lock
    ├── config/project-keys.test.ts, egress-entry.test.ts, mounts.test.ts   the project allowlist, the egress entry grammar, mounts.sharedCaches and mounts.autoNodeModules (validation, defaults, layers)
    ├── workspace/git-integrity.test.ts, created-dirs.test.ts   worktree pointer checks, the launch-end notices and recorded pins; removeCreatedDirs
    ├── workspace/workspace-mode.test.ts   workspace discovery (scan, nested repository and git config refusals, node projects, lenient mode), self binds and notices, pin locks and launch-end notices over nested repositories
    ├── image/sandbox-image.test.ts   ensureSandboxImage paths (recorded, pinned, built, layer) and the image removal after a build
    ├── image/bash-env.test.ts   the missing-command hint under a bash -c spawned like pi's shell tool (sourced, sourced twice, through a bashrc, and BASH_ENV skipped for socket stdin without SHLVL; skipped on bash older than 4), BASH_ENV refused in env.allow and never forwarded
    ├── cli/harness.ts       temp dirs (removed after each test), fake runner, CliDeps with collected output, recorded proxy inputs, stopped proxies and confirmations, holdLaunch (a live launch of the repository), a fake bundled pi, a fixed machine size; unreachable (a backend whose engine and VM are down); writeManagedPi and writePathPi; writeLimaMounts and writeColimaMounts
    ├── cli/launch-sessions.test.ts   the end of a session (the engine and the state dir back to steady state, the removal order, the engine gone at the end), the sweep after a killed launcher, a config change while others live, signals
    ├── cli/launch-wiring.test.ts, intercept.test.ts, egress.test.ts, mcp-sign-in.test.ts, launch-host-sessions.test.ts   launch wiring, intercepted commands, grants, the launch-start MCP sign-in, host sessions
    ├── cli/host-pi.test.ts, install.test.ts, uninstall.test.ts   the host pi of host jobs, the image and --no-sandbox; install.sh's managed pi takeover run for real with a temp HOME and fake uname, sw_vers, brew, colima and npm (no git, so the smoke step is skipped), and the colima start with --mount $HOME:w only for a new profile; uninstall.sh's host side (pins, created dirs, a live proxy and sign-in, the live-launch refusal), engine cleanup, --keep-vm and link restore
    ├── config/fixtures.ts   layer files in temp dirs
    ├── proxy/mcp-oauth.test.ts   the mcpOAuth source against a fake host pi script: fresh token, login on expiry, the 503 after the wait, cooldowns across resolvers, the 401 cases through the proxy, the login group killed at proxy close
    ├── proxy/proxy-client.ts    CONNECT and TLS client helpers
    ├── support/             fake-runner.ts (+ its test), fake-engine.ts, fake-backend.ts (with guestAgentDir, guestFile, a vm with overridable steps, relays, AutoRemove on stop, the created specs, images that a rebuild leaves untagged and the image removals), fake-clock.ts, sandbox-config.ts, temp-dir.ts (tempDir, writeText, writeJson, writeExecutable, removed after each test), expect-no-leak.ts (expectNoLeak over container specs, exec argv, env and stdin, and render files)
    └── live/                *.live.test.ts against a real engine with fixtures/ and harness/, run only with PI_SANDBOX_LIVE=1 against ~/.colima/pi-sandbox/docker.sock; harness/resolve-preload.mjs is the --import preload that resolves the fixture hosts for host pi scripts and the proxy daemon
```

Each folder with code has an `index.ts` that is its only public surface. The docs are `README.md` (for users), `ARCHITECTURE.md`, `THREAT-MODEL.md` and this file.
