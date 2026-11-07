# launcher structure

Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
launcher/
├── bin/
│   ├── pi-sandbox.js        the package bin: imports the built ../dist/cli/main.js
│   └── pi-sandbox-dev.js    development entry: imports ../cli/main.ts, not published
├── cli/
│   ├── main.ts              builds the real CliDeps and calls run
│   ├── run.ts               the command table, routes argv (intercepted commands before the pass-through), renders LauncherError and unexpected errors
│   ├── deps.ts              CliDeps: runner, env, home, cwd, streams, terminal, signals, platform, uid and gid, adapters, proxy control (ensure, list, stop, remove, control, denials, trust), bundledPi, resolveHost, confirm, now; writeNotices, hostAgentDirOf
│   ├── launch.ts            LaunchContext, the pi pipeline, withSandbox and the steps other commands reuse (prepareImage with the layer, prepareContainer with render, sync and grant pruning)
│   ├── derive.ts            the host side: host pi files, MCP token seed, provider host table, vault discovery, deriveSandboxPi, private-host notices, trust bundle; deriveVaultServers
│   ├── sandbox-proxy.ts     starts the proxy with a minimal env and the discover command, the repository token, dynamic.json (under a lock) with the vault servers, env secrets over /control (no line breaks), the cap-aware denial summary on exit
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
│       ├── gc.ts                stopped containers, idle relays and proxies (repositories with a live session kept), ended grants
│       ├── reset.ts             this repository's container, proxy instance, render dir, and with --volumes its volumes and sync copy
│       ├── doctor.ts            the doctor's order and rendering
│       ├── doctor-container.ts  in-container checks: PI_OFFLINE, pi mcp list, the mcp-auth.json placeholder sweep, the settings.json package URL sweep, xdg-open --pi-sandbox-check, the host sessions share probe, trust and one request per credential rule host
│       ├── doctor-host.ts       host checks: bundled pi, provider hosts, parent proxy, org baseline, grants, the host session dir, one line per vault server
│       ├── migrate.ts           volumes to another backend
│       └── help.ts              usage
├── config/
│   ├── types.ts             SandboxConfig, layers, credential rules, secret sources, egress, tls, image and org keys, EgressCap
│   ├── validate.ts          the key spec (egress host[:port], rules, secret sources, org), validateLayer, layerKeys
│   ├── merge.ts             tighten-only and convenience rules over policy, org, user and project, mergeLayers, per-key sources, the D3 cap
│   ├── load.ts              loadEffectiveConfig from defaults, profile, policy, org, user, project, with the org notices; refuses project env.allow, image.reference and sessions.host
│   ├── org-source.ts        loadOrgLayer: fetch or read the org baseline, sha256 pin, cache in <state>/org/ with the last failed attempt, offline mode, httpsFetchText (1 MiB cap)
│   ├── rule-cap.ts          capManualRules: the D3 cap on credentials.rules below policy, with notices
│   ├── vault.ts             vaultEnabled: credentials.vault.enabled while credentials.derive.enabled
│   ├── legacy-gateway.ts    legacyGatewayRule: the gateway and the legacy credentials as one credential rule
│   ├── set.ts               setConfigValue over the same four layers, with the .pi/.gitignore write
│   ├── defaults.ts          the default config and image reference
│   ├── profiles.ts          loadProfile from profiles/
│   ├── hash.ts              configHash
│   └── dotted.ts            dotted key access
├── workspace/
│   ├── discover.ts          discoverWorkspace through git
│   ├── guard.ts             assertSafeWorkspace: refuses a repo at or above home, ~/.pi, state, config or /, or inside ~/.pi, state or config; assertHostSessionsDir, the one ~/.pi exception
│   ├── pi-session-dir.ts    hostAgentDir, pi's session slug, hostSessionsDir, hostSessionsChoice (on, or off with its reason)
│   ├── mounts.ts            resolveExtraMounts: mounts.extraReadOnly checked (exists, real path, protected paths, .git, engine socket)
│   ├── roots.ts             assertWithinWorkspaceRoots
│   └── types.ts             Workspace
├── backend/
│   ├── types.ts             Backend, BackendCapabilities, ContainerSpec, ExecSpec, ExecIo, ImageInfo, MountSpec, NetworkRef, ProxyRoute
│   ├── select.ts            selectBackend, createDefaultAdapters
│   ├── image-reference.ts   repository, tag and repo@digest of an image reference
│   ├── docker-engine/       Docker Engine API adapter (backend name colima): socket, engine client, container body, exec session, images, volumes, relay per policy
│   └── apple/               Apple container adapter: backend.ts, cli.ts (every flag and JSON shape it assumes)
├── container/
│   ├── spec.ts              buildContainerSpec (network, proxy env with the repository token, render and trust mounts, the host session dir bind and env, ssh agent, spec hash), repoVolumes, forwardedEnv
│   ├── git-overlay.ts       discoverGitOverlay: core.hooksPath, submodule and worktree git files to protect, creating missing hook dirs
│   ├── names.ts             container and volume names, labels
│   ├── lifecycle.ts         ensureContainer (per-repository lock, wanted identity, reuse while other sessions are live, replacement that keeps the repository network), isCurrentContainer, stopIdleContainer, findCurrentContainer, findRepoContainer, removeRepoContainer, collectGarbage
│   ├── run-pi.ts            runPi: exec behind a pid file, PI_SANDBOX_LAUNCH_ID, raw mode, resizes, signal handling
│   └── probes.ts            doctor checks: same-path mount, credential sweep (environment, auth.json, mcp.json), no-route, proxy health
├── image/
│   ├── Dockerfile           the sandbox image (no pi config baked in)
│   ├── entrypoint.sh        render links, settings seed, CA bundle, idle
│   ├── xdg-open.mjs         /usr/local/bin/xdg-open in the image: one https: URL to POST /oauth/open, long-polls the callback and replays it to pi, --pi-sandbox-check
│   ├── extensions.ts        resolveExtensionsSource (tarball pack cache, registry or none), packExtensionsTarball
│   ├── build.ts             build context, ensureBuiltImage, recordedImage
│   ├── layer.ts             ensureLayerImage: image.packages, npmGlobal and dockerfile on top of the base
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
│   ├── host-pattern.ts      host and *.domain matching for derive.hosts and privateHosts
│   ├── userinfo.ts          credentials in URLs
│   ├── json.ts              JSON object helpers and pointers
│   ├── private-hosts.ts     privateHostNotices
│   ├── provider-hosts.ts    locateBundledPi, readProviderHosts with its cache
│   ├── provider-hosts.mjs   run with node against the bundled pi: the built-in provider host table (with mcp-discover.mjs, the launcher files that load a pi package)
│   ├── mcp-auth.ts          mcpAuthKey, sanitizeMcpServer, mcpLoginServer, prepareMcpLogin, oneServerDir, seedMcpAuth, recordServer
│   ├── vault.ts             vaultCandidates, mcpDiscoverCommand, discoverVaultServers with its cache, containerMcpAuth (placeholder entries)
│   ├── mcp-discover.mjs     run with node against the bundled pi: one server's authorization server discovery as a VaultDiscovery
│   ├── package-source.ts    package source keys, sourceOfEntry, withoutSourceCredential (URL userinfo)
│   ├── model-secret.mjs     run with node as a command secret: one model's secret in models.json, found by provider, model id and base URL
│   ├── write-back.ts        writeBackPackageChange: the packages key of the host settings.json
│   └── types.ts             HostPiFiles, DeriveInput, DerivedSandboxPi, BundledPi, PackageChange
├── provision/
│   ├── render.ts            renderAgentDir: <state>/render/<repo hash>/
│   ├── tree.ts              filtered copy of the host agent dir entries
│   ├── sync.ts              syncWritableFiles, readVolumeSettings, packageChangeFor
│   ├── merge-settings.ts    mergeTopLevel, host settings preparation, the baked package entry
│   ├── volume.ts            read and write a file in the agent volume through exec
│   ├── mcp-auth.ts          syncContainerMcpAuth: vault entries, the placeholder sweep and the locked write of the volume's mcp-auth.json
│   ├── host-sessions.ts     prepareHostSessions (0700), sweepHostSessions (special files, pi's header rule failing closed with bare-CR rejection, owner access restored, size, 8 files at a time, failures), probeHostSessions (host marker, guest create and delete)
│   └── types.ts             RenderInput, SyncInput and results
├── grants/
│   ├── store.ts             grants.json: addGrant with the limits, revokeGrants, activeGrants, pruneGrants
│   ├── sessions.ts          newLaunchId, registerSession, endSession, liveSessions, withRepoSessionLock
│   ├── lock.ts              file lock written by link, with stale-pid takeover
│   └── types.ts             Grant, GrantScope, SessionEntry
├── proxy/
│   ├── daemon.ts            the proxy process entry
│   ├── control.ts           ensureProxyRunning, readProxyInstances, stopProxy, removeProxyInstance, sendProxyControl, per-instance lock and control token
│   ├── server.ts            CONNECT handling, token check, health, policy, denials, control and /oauth/open|callback|cancel endpoints
│   ├── denial-page.ts       createDenialPages: the 403 page over TLS for a denied CONNECT, with the mint rate and name limits
│   ├── runtime.ts           live view of dynamic.json, repository tokens and grants
│   ├── dynamic.ts           writeProxyDynamic, repoProxyToken, readDenials, extraAllowList
│   ├── auth.ts              repository and control authorization, guestProxyUrl
│   ├── policy.ts            decideConnect, restricted addresses, the denial reason
│   ├── rules.ts             matchRule, header rewrite and response scrub
│   ├── terminate.ts         TLS termination and credential injection for rule hosts and vault hosts, with the vault's token hook
│   ├── parent.ts            parent proxy route and CONNECT through it
│   ├── trust.ts             ensureTrustBundle: the launcher CA plus tls.extraCa
│   ├── vault/               createVault: index.ts (the hook), discovery.ts (discoverCommand when the cache is missing), open.ts (authorize URL checks, rate limit), callback.ts (host listener, flows, long poll), token.ts (code, client and refresh placeholders, token responses), store.ts (vault entries), browser.ts (host open or xdg-open)
│   ├── secrets/             createSecretResolver: env, file, command, pi-auth, mcp-oauth, cache, errors
│   ├── sni.ts               ClientHello server name parsing
│   ├── dial.ts              resolving dialer with the private-address filter
│   ├── test-resolve.ts      PI_SANDBOX_TEST_RESOLVE, honoured only from the sources (live tests)
│   ├── tls-ca.ts            launcher CA and leaf certificates through openssl
│   ├── access-log.ts        JSON-line access log
│   ├── settings.ts          proxy settings from the config and the cap, proxyPolicyHash
│   └── files.ts             per-instance file paths under proxy/<policy hash>/ and the ProxyInstance record
├── shared/                  LauncherError, errorMessage, CommandRunner, sha256Hex, stableHash, JSON files, writeFileAtomic, launcherPaths, launcherRoot, launcherEntry, expandHome, isWithin, BACKEND_NAMES, isSecretName, isAuthLikeHeader, placeholders, ensureSalt, stateLayout, GUEST_PATHS; pi-env.ts (PI_AGENT_DIR_VARIABLE, PI_SESSION_DIR_VARIABLE, LAUNCHER_SET_VARIABLES); vault.ts (VaultServer, VaultDiscovery, VaultEntry, vaultPlaceholders, readVaultStore, writeVaultEntry, the /oauth types), file-lock.ts (withFileLock, the mkdir lock pi uses)
├── profiles/                solo.json, team.json, enterprise.json
├── examples/                org-baseline.team.json, org-baseline.enterprise.json (starting points for an org baseline)
├── schema/                  sandbox-config.schema.json
├── install.sh               macOS install: Colima profile, launcher and its bundled pi, PATH, user config (and --org), doctor in a temporary repository (host sessions off)
├── uninstall.sh             removes what install.sh and the launcher created, and the session, render, sync, mcp-auth, provider-hosts, org and grants state
├── THREAT-MODEL.md          assets, trust boundaries, what each feature weakens, known gaps
├── tsconfig.build.json      emits dist/ (gitignored) for the published bin
└── tests/
    ├── shared/ config/ workspace/ backend/ container/ image/ proxy/ grants/ hostpi/ provision/ cli/   unit tests per folder
    ├── backend/conformance.ts   the adapter conformance suite, run on fakes and live
    ├── container/run-pi.test.ts runPi, including the signal path, on the fake backend
    ├── cli/harness.ts       temp dirs, fake runner, CliDeps with collected output, recorded control messages and confirmations, a fake bundled pi
    ├── cli/launch-wiring.test.ts, intercept.test.ts, egress.test.ts, vault-wiring.test.ts, launch-host-sessions.test.ts   launch wiring, intercepted commands, grants, the token vault wiring and its doctor lines, host sessions
    ├── config/fixtures.ts   layer files in temp dirs
    ├── proxy/proxy-client.ts    CONNECT and TLS client helpers
    ├── support/             fake-runner.ts (+ its test), fake-engine.ts, fake-container-cli.ts, fake-backend.ts, fake-clock.ts, fake-fetch.ts, sandbox-config.ts
    └── live/                *.live.test.ts against a real engine with fixtures/ and harness/, run only with PI_SANDBOX_LIVE=1
```

Each folder with code has an `index.ts` that is its only public surface. The docs are `README.md` (for users), `ARCHITECTURE.md`, `THREAT-MODEL.md` and this file.
