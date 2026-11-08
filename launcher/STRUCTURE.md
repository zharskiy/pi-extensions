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
│   ├── deps.ts              CliDeps: runner, env, home, cwd, streams, terminal, signals, platform, uid and gid, adapters, proxy control (ensure, list, stop, remove, control, denials, trust), bundledPi, resolveHost, confirm, now; writeNotices, hostAgentDirOf, settleAll (waits for every promise, then throws the first error)
│   ├── launch.ts            LaunchContext (repoHash computed once), the pi pipeline, withSandbox (a signal cancels preparation at the next step and waits for the current one) and the steps other commands reuse (prepareImage through ensureSandboxImage, prepareContainer with render, the git plan, sync and grant pruning); proxy and image, then render, git notices, version, git plan and host sessions, then the two syncs, each group in parallel
│   ├── derive.ts            the host side: host pi files, MCP token seed, provider host table, vault discovery, deriveSandboxPi, private-host notices (DNS waited for at most 2 s), trust bundle; deriveVaultServers
│   ├── sandbox-proxy.ts     starts the proxy with daemonEnv and the discover command, the repository token, dynamic.json (under a lock) with the vault servers, envSecretsFor over /control (no line breaks), the cap-aware denial summary on exit (rule egress.cap)
│   ├── mcp-auth-sync.ts     syncSandboxMcpAuth: containerMcpAuth and syncContainerMcpAuth into a container, with notices
│   ├── sessions.ts          registers and ends a launch session, stops the idle container after the last one (then the full host sessions sweep), prunes ended grants
│   ├── host-sessions.ts     host sessions on or off for this launch (with the notice), readyHostSessions (prepare, guard, sweep), sweepWhenIdle under the session registry lock, the share probe, the exit and --no-sandbox sweeps
│   ├── intercept.ts         pi install|remove (write-back of the packages entry), pi mcp add|remove|login|logout on the host (then the mcp-auth.json sync into a running container), bare pi update
│   ├── host-pi.ts           finds the host pi for --no-sandbox; bundledPiCommand (the pi next to the launcher, else the host pi)
│   ├── versions.ts          launcher version, pinned pi version
│   ├── index.ts             the public surface
│   └── commands/
│       ├── status.ts            backend, container (and its session dir label), proxy, image, sessions, grants, gaps
│       ├── config.ts            config show and set
│       ├── egress.ts            egress allow, revoke and list (grants, denials)
│       ├── gc.ts                stopped containers (and the proxy token of each repository whose container it removes), idle relays and proxies (repositories with a live session kept), unmounted volumes whose labelled repository root is gone, ended grants
│       ├── reset.ts             this repository's container, proxy instance, render dir, and with --volumes its volumes and sync copy
│       ├── doctor.ts            the doctor's order and rendering
│       ├── doctor-container.ts  in-container checks: PI_OFFLINE, pi mcp list, the mcp-auth.json placeholder sweep, the settings.json package URL sweep, xdg-open --pi-sandbox-check, the host sessions share probe, trust and one request per credential rule host; exports OFFLINE_PROBE, MCP_LIST_PROBE and SHIM_PROBE
│       ├── doctor-host.ts       host checks: bundled pi, provider hosts, parent proxy, org baseline (orgBaselineStatus), grants, the host session dir, one line per vault server
│       ├── migrate.ts           volumes to another backend
│       └── help.ts              usage
├── config/
│   ├── types.ts             SandboxConfig, layers, credential rules, secret sources, egress, tls, image and org keys, EgressCap
│   ├── validate.ts          the key spec (egress host[:port], rules, secret sources, org; the schema's noProxy pattern matches it), validateLayer, layerKeys, projectKeyRefusal (one list of 17 project-refused keys, each with the layer that owns it)
│   ├── merge.ts             tighten-only and convenience rules over policy, org, user and project, mergeLayers, per-key sources, the D3 cap
│   ├── load.ts              loadEffectiveConfig from defaults, profile, policy, org, user, project, with the org notices and an injectable fetchText; refuses a project layer that sets a project-refused key
│   ├── org-source.ts        loadOrgLayer: fetch or read the org baseline, sha256 pin, cache in <state>/org/ with the last failed attempt, offline mode, httpsFetchText (1 MiB cap), orgBaselineStatus for the doctor
│   ├── egress-entry.ts      the egress entry grammar: TLS_PORT, normalizeHost, parseEntry, matchesPattern (single-label *.), matchesEntry, authorityOf, isLoopbackName, SECRET_MARKER, fillTemplate
│   ├── rule-cap.ts          capManualRules: the D3 cap on credentials.rules below policy, with notices
│   ├── vault.ts             vaultEnabled: credentials.vault.enabled while credentials.derive.enabled
│   ├── legacy-gateway.ts    legacyGatewayRule: the gateway and the legacy credentials as one credential rule
│   ├── set.ts               setConfigValue over the same four layers, with the .pi/.gitignore write
│   ├── defaults.ts          the default config and image reference
│   ├── profiles.ts          loadProfile from profiles/
│   ├── hash.ts              configHash
│   └── dotted.ts            dotted key access
├── workspace/
│   ├── discover.ts          discoverWorkspace: the nearest .git found without git, its layout checked, then git rev-parse must agree
│   ├── git-layout.ts        gitLayoutAt (main, separate, submodule and linked worktree git dirs, refusing links and foreign commondir or gitdir pointers, pinning an empty commondir in place), findGitRoot, findModuleGitDirs, findWorktreeGitDirs, gitRefusal
│   ├── git-protect.ts       findProtectedGitPaths (hooks dirs, config and pointer files, pins), gitPathGuard (the protected-path check with the engine sockets passed in), protectedGitOverlay (each leaf lstat'ed, refused when it is a link or goes through one, then the self binds)
│   ├── git-session.ts       recordGitBaseline (scan and alternates in git/<repo hash>/baseline.json), gitLaunchNotices, gitSessionEndNotices (unpin under the pin lock, layout, alternates and nested-repository notices)
│   ├── git-integrity.ts     assertGitIntegrity, pinGitDirs and unpinGitDirs (the commondir pin), withGitPinLock (one lock per git common dir), gitAlternatesNotices, gitDirOf
│   ├── git-scan.ts          scanGitBaseline (nested .git entries and gitlinks), nestedGitNotices
│   ├── git-command.ts       inertGitOptions: core.fsmonitor off and an empty core.hooksPath for the launcher's own git calls
│   ├── guard.ts             assertSafeWorkspace: refuses a repo at or above home, ~/.pi, state, config or /, or inside ~/.pi, state or config; assertHostSessionsDir, the one ~/.pi exception
│   ├── pi-session-dir.ts    hostAgentDir, pi's session slug, hostSessionsDir, hostSessionsChoice (on, or off with its reason)
│   ├── mounts.ts            resolveExtraMounts: mounts.extraReadOnly checked (exists, real path, protected paths, .git, engine socket)
│   ├── roots.ts             assertWithinWorkspaceRoots
│   └── types.ts             Workspace
├── backend/
│   ├── types.ts             Backend, BackendCapabilities, ContainerSpec, ExecSpec, ExecIo, ImageInfo, MountSpec, NetworkRef, ProxyRoute
│   ├── select.ts            selectBackend, createDefaultAdapters
│   ├── image-reference.ts   repository, tag and repo@digest of an image reference
│   ├── labels.ts            LABELS: every pi-sandbox.* label key
│   ├── exec-capture.ts      execCapture: a non-tty exec with optional stdin, its exit code and collected stdout and stderr
│   ├── managed-network.ts   repoNetworkName, repoNetworkLabels, pruneCandidates and removeWithNetworkCleanup, shared by both adapters
│   ├── pull.ts              verifiedPull (inspect, pull, inspect, digest check) and missingImage, shared by both adapters
│   ├── docker-engine/       Docker Engine API adapter (backend name colima): socket, engine client, container body, exec session (streams with backpressure), images, volumes, relay per policy (kept while other repositories use it), the bridge gateway the proxy listens on for a native Linux engine
│   └── apple/               Apple container adapter: backend.ts (container inspect for one container, a labelled network per repository), cli.ts (every flag and JSON shape it assumes, the volume list and container mounts included)
├── container/
│   ├── spec.ts              buildContainerSpec (network, proxy env with the repository token, render and trust mounts, the host session dir bind and env, ssh agent, spec hash), repoVolumes, forwardedEnv
│   ├── git-overlay.ts       planGitOverlay (discovery once per launch: the overlay for the spec and ready() for right before a start: pins, layout checks, hook dirs, leaves checked again, snapshots, baseline), discoverGitOverlay and readyGitOverlay over it; re-exports gitLaunchNotices and gitSessionEndNotices from workspace
│   ├── git-snapshot.ts      writeGitSnapshots, gitSnapshotPath, gitSnapshotsDir: launcher-owned copies of the read-only git paths
│   ├── names.ts             container and volume names (re-exports LABELS from backend)
│   ├── lifecycle.ts         ensureContainer (per-repository lock, wanted identity, reuse while other sessions are live, beforeStart right before a create or start, inside aroundStart, replacement that keeps the repository network), gitDirInUseElsewhere, isCurrentContainer, stopIdleContainer, findCurrentContainer, findRepoContainer, removeRepoContainer, collectGarbage
│   ├── run-pi.ts            runPi: exec behind a pid file, PI_SANDBOX_LAUNCH_ID, raw mode, resizes, signal handling
│   └── probes.ts            doctor checks: same-path mount, credential sweep (environment, auth.json, mcp.json), no-route, proxy health
├── image/
│   ├── Dockerfile           the sandbox image (no pi config baked in)
│   ├── entrypoint.sh        render links, settings seed, CA bundle, idle
│   ├── xdg-open.mjs         /usr/local/bin/xdg-open in the image: one https: URL to POST /oauth/open, long-polls the callback and replays it to pi, --pi-sandbox-check
│   ├── sandbox-image.ts     ensureSandboxImage: the recorded image when a current container uses it, else a pinned pull or a build, then the layer
│   ├── context.ts           buildInContext (a temporary build dir under the state dir, removed after), reusableImage
│   ├── extensions.ts        resolveExtensionsSource (tarball pack cache, skipped on a dirty tree, registry or none), packExtensionsTarball
│   ├── build.ts             build context, ensureBuiltImage, pullPinnedImage, recordedImage
│   ├── layer.ts             ensureLayerImage: image.packages, npmGlobal and dockerfile on top of the base, the dockerfile allowlist with heredoc bodies skipped
│   ├── record.ts            image.json with its layer record
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
│   ├── gateway.ts           the legacy gateway's providers and rule
│   ├── endpoints.ts         rule endpoints (host, port) and their keys
│   ├── provider-endpoints.ts  hosts of a provider from the table or its baseUrl
│   ├── userinfo.ts          credentials in URLs
│   ├── json.ts              objectOr and jsonPointer
│   ├── provider-hosts.ts    locateBundledPi (an unreadable pi package.json counts as no bundled pi), readProviderHosts with its cache
│   ├── provider-hosts.mjs   run with node against the bundled pi: the built-in provider host table (with mcp-discover.mjs, the launcher files that load a pi package)
│   ├── mcp-auth.ts          sanitizeMcpServer (server names checked against MCP_SERVER_NAME), mcpLoginServer, prepareMcpLogin, oneServerDir, seedMcpAuth, recordServer
│   ├── vault.ts             vaultCandidates, mcpDiscoverCommand, discoverVaultServers with its cache, containerMcpAuth (placeholder entries)
│   ├── mcp-discover.mjs     run with node against the bundled pi: one server's authorization server discovery as a VaultDiscovery
│   ├── package-source.ts    package source keys, sourceOfEntry, withoutSourceCredential (URL userinfo)
│   ├── model-secret.mjs     run with node as a command secret: one model's secret in models.json, found by provider, model id and base URL
│   ├── write-back.ts        writeBackPackageChange: the packages key of the host settings.json, under a settings.json.lock directory lock compatible with pi's
│   └── types.ts             HostPiFiles, DeriveInput, DerivedSandboxPi, BundledPi, PackageChange
├── provision/
│   ├── render.ts            renderAgentDir: <state>/render/<repo hash>/, returns { renderDir }
│   ├── tree.ts              filtered copy of the host agent dir entries (16 reads at a time)
│   ├── pool.ts              inPool: runs work over a list with at most n in flight
│   ├── sync.ts              syncWritableFiles (the volume settings read once per sync, a base copy written only when it changed), readVolumeSettings, packageChangeFor
│   ├── merge-settings.ts    mergeTopLevel, host settings preparation, the baked package entry
│   ├── volume.ts            read and write a file in the agent volume through exec
│   ├── mcp-auth.ts          syncContainerMcpAuth: vault entries, the placeholder sweep, the lock and the read in one exec, and the write of the volume's mcp-auth.json only when it changed
│   ├── host-sessions.ts     prepareHostSessions (0700), sweepHostSessions (special files, pi's header rule failing closed with bare-CR rejection, owner access restored, size, 8 files at a time, failures), probeHostSessions (host marker, guest create and delete)
│   └── types.ts             RenderInput, SyncInput and results
├── grants/
│   ├── store.ts             grants.json: addGrant with the limits, revokeGrants, activeGrants, pruneGrants
│   ├── sessions.ts          newLaunchId, registerSession and endSession (both delete entries of dead launchers), liveSessions, withRepoSessionLock
│   └── types.ts             Grant, GrantScope, SessionEntry
├── proxy/
│   ├── daemon.ts            the proxy process entry
│   ├── control.ts           ensureProxyRunning, readProxyInstances, stopProxy, removeProxyInstance, daemonEnv, per-instance lock, control token, kept port and extra listen hosts
│   ├── client.ts            the launcher's HTTP client to a daemon: readHealth, sendProxyControl, fetchDenials
│   ├── server.ts            startProxyServer: token check, decideConnect, CONNECT dispatch to the denial page, the interceptor or the tunnel, listen (extra listen hosts) and close
│   ├── control-routes.ts    createControlRoutes: /healthz, /policy, /denials, /control and /oauth/open|callback|cancel
│   ├── tunnel.ts            createTunnel: address check before the 200, ClientHello and server name check before the upstream dial, then the splice
│   ├── intercept.ts         createInterceptor: TLS termination for rule and vault hosts, per-host TLS contexts rechecked against the leaf on disk
│   ├── denials.ts           createDenials: the last 200 denials per repository, the access log line, the JSON 403 or the denial page
│   ├── replies.ts           PROXY_AGENT, ESTABLISHED, rawReply, sendJson, readLimited
│   ├── private-hosts.ts     privateHostNotices: rule hosts that resolve to a restricted address and are not in egress.privateHosts
│   ├── single-flight.ts     singleFlight: one pending promise per key (secret cache, vault discovery)
│   ├── denial-page.ts       createDenialPages: the 403 page over TLS for a denied CONNECT, with the mint rate and name limits
│   ├── runtime.ts           live view of dynamic.json, the token files and grants (live sessions read on every request), extras per repository
│   ├── dynamic.ts           dynamic.json { version, shared, repos } keyed by token hash, writeProxyDynamic, repoProxyToken, removeRepoToken, tokenFileHashes, readDenials
│   ├── auth.ts              repository and control authorization, guestProxyUrl
│   ├── policy.ts            decideConnect, restricted addresses, the denial reason
│   ├── rules.ts             matchRule, header rewrite and response scrub
│   ├── terminate.ts         credential injection for rule hosts and vault hosts on the terminated stream, with the vault's token hook; keep-alive upstream agents per repository, host, port and access, upgrades on a fresh connection
│   ├── parent.ts            parent proxy route (IPv6 literal without brackets) and CONNECT through it
│   ├── trust.ts             ensureTrustBundle: the launcher CA plus tls.extraCa
│   ├── vault/               createVault: index.ts (the hook), protocol.ts (OAUTH_ROUTES, the /oauth types and statuses, code placeholders), oauth-http.ts (form, JSON and Basic helpers for token bodies), discovery.ts (discoverCommand when the cache is missing), open.ts (authorize URL checks, rate limit), callback.ts (host listener, flows, long poll), token.ts (code, client and refresh placeholders, token responses), store.ts (vault entries), browser.ts (host open or xdg-open)
│   ├── secrets/             createSecretResolver: env, file, command, pi-auth, mcp-oauth, cache, errors
│   ├── sni.ts               ClientHello server name parsing
│   ├── dial.ts              resolving dialer with the private-address filter, 10 s connect timeout
│   ├── test-resolve.ts      PI_SANDBOX_TEST_RESOLVE, honoured only from the sources (live tests)
│   ├── tls-ca.ts            launcher CA (created once under a lock, pair renamed into place) and leaf certificates through openssl
│   ├── access-log.ts        JSON-line access log
│   ├── settings.ts          proxy settings from the config and the cap, proxyPolicyHash
│   └── files.ts             per-instance file paths under proxy/<policy hash>/ and the ProxyInstance record
├── shared/                  LauncherError, errorMessage, CommandRunner, sha256Hex, repoHash, stableHash, JSON files (readJsonFile, writeJsonFile, readText, and the lenient isJsonObject, parseJsonObject, readJsonObject), writeFileAtomic, ensureRandomHexFile, launcherPaths, realOrResolved (and its sync variant), launcherRoot, launcherEntry, expandHome, isWithin, BACKEND_NAMES, isSecretName, isAuthLikeHeader, placeholders, ensureSalt, stateLayout, GUEST_PATHS; regular-file.ts (readRegularFile without following links, lstatOrUndefined, sameEntry); pi-env.ts (PI_AGENT_DIR_VARIABLE, PI_SESSION_DIR_VARIABLE, LAUNCHER_SET_VARIABLES); vault.ts (VaultServer, VaultDiscovery, VaultEntry, vaultPlaceholders, readVaultStore, updateVaultStore, writeVaultEntry, mcpAuthKey, MCP_SERVER_NAME); state-layout.ts (stateLayout, every state path including configLock, ca, extraPem, imageRecord, pack, copies, orgBaseline, orgMeta, proxyRoot and proxyInstance(policyHash) with dynamic, dynamicLock, tokensDir and repoToken), file-lock.ts (withFileLock, the pid lock every launcher lock uses; withDirectoryLock, the mkdir lock pi uses on mcp-auth.json; isProcessAlive)
├── profiles/                solo.json, team.json, enterprise.json
├── examples/                org-baseline.team.json, org-baseline.enterprise.json (starting points for an org baseline)
├── schema/                  sandbox-config.schema.json
├── install.sh               macOS install: Colima profile, launcher and its bundled pi, PATH, user config (and --org), doctor in a temporary repository (host sessions off)
├── uninstall.sh             removes what install.sh and the launcher created (engine objects through bin/uninstall-engine.mjs, no docker CLI), and the session, render, sync, mcp-auth, provider-hosts, org and grants state
├── THREAT-MODEL.md          assets, trust boundaries, what each feature weakens, known gaps
├── tsconfig.build.json      emits dist/ (gitignored) for the published bin
└── tests/
    ├── shared/ config/ workspace/ backend/ container/ image/ proxy/ grants/ hostpi/ provision/ cli/   unit tests per folder
    ├── backend/conformance.ts   the adapter conformance suite, run on fakes and live
    ├── container/run-pi.test.ts runPi, including the signal path, on the fake backend
    ├── backend/fake-backend.conformance.test.ts   the conformance suite and the fake's own contract (refusals, prune rules, guest agent dir)
    ├── proxy/hello.test.ts, keep-alive.test.ts, vault-protocol.test.ts, private-hosts.test.ts   ClientHello reading and the dial timeout, upstream connections never shared between repositories, the code placeholders, privateHostNotices
    ├── config/project-keys.test.ts, egress-entry.test.ts   the project-refused keys, the egress entry grammar
    ├── workspace/git-integrity.test.ts   worktree pointer checks and the session-end notices
    ├── image/sandbox-image.test.ts   ensureSandboxImage paths (recorded, pinned, built, layer)
    ├── cli/harness.ts       temp dirs (removed after each test), fake runner, CliDeps with collected output, recorded control messages and confirmations, a fake bundled pi
    ├── cli/launch-wiring.test.ts, intercept.test.ts, egress.test.ts, vault-wiring.test.ts, launch-host-sessions.test.ts   launch wiring, intercepted commands, grants, the token vault wiring and its doctor lines, host sessions
    ├── config/fixtures.ts   layer files in temp dirs
    ├── proxy/proxy-client.ts    CONNECT and TLS client helpers
    ├── support/             fake-runner.ts (+ its test), fake-engine.ts, fake-container-cli.ts, fake-backend.ts (with guestAgentDir and guestFile), fake-clock.ts, fake-fetch.ts, sandbox-config.ts, temp-dir.ts (tempDir, writeText, writeJson, removed after each test), expect-no-leak.ts (expectNoLeak over container specs, exec argv, env and stdin, and render files)
    └── live/                *.live.test.ts against a real engine with fixtures/ and harness/, run only with PI_SANDBOX_LIVE=1; apple.live.test.ts runs the conformance suite on darwin with container on PATH
```

Each folder with code has an `index.ts` that is its only public surface. The docs are `README.md` (for users), `ARCHITECTURE.md`, `THREAT-MODEL.md` and this file.
