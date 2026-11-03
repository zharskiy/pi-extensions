# launcher structure

Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
launcher/
├── bin/
│   ├── pi-sandbox.js        the package bin: imports the built ../dist/cli/main.js
│   └── pi-sandbox-dev.js    development entry: imports ../cli/main.ts, not published
├── cli/
│   ├── main.ts              builds the real CliDeps and calls run
│   ├── run.ts               the command table, routes argv, renders LauncherError and unexpected errors
│   ├── deps.ts              CliDeps: runner, env, home, cwd, streams, terminal, signals, platform, uid and gid, adapters, proxy control (ensure, list, stop, remove, ensureCa), now
│   ├── launch.ts            LaunchContext, the pi pipeline and the steps other commands reuse
│   ├── host-pi.ts           finds the host pi for --no-sandbox
│   ├── versions.ts          launcher version, pinned pi version
│   ├── index.ts             the public surface
│   └── commands/            status, config, gc, reset, doctor (rendering only), migrate, help
├── config/
│   ├── types.ts             SandboxConfig, layers, credential sources
│   ├── validate.ts          the key spec (egress host[:port], ssh.agent), validateLayer, layerKeys
│   ├── merge.ts             tighten-only and convenience rules, mergeLayers, per-key sources
│   ├── load.ts              loadEffectiveConfig from defaults, profile, policy, user, project; refuses project env.allow and image.reference
│   ├── set.ts               setConfigValue, with the .pi/.gitignore write
│   ├── defaults.ts          the default config and image reference
│   ├── profiles.ts          loadProfile from profiles/
│   ├── hash.ts              configHash
│   └── dotted.ts            dotted key access
├── workspace/
│   ├── discover.ts          discoverWorkspace through git
│   ├── guard.ts             assertSafeWorkspace: refuses a repo at or above home, ~/.pi, state, config or /, or inside ~/.pi, state or config
│   ├── roots.ts             assertWithinWorkspaceRoots
│   └── types.ts             Workspace
├── backend/
│   ├── types.ts             Backend, BackendCapabilities, ContainerSpec, ExecSpec, ExecIo, ImageInfo, MountSpec, NetworkRef, ProxyRoute
│   ├── select.ts            selectBackend, createDefaultAdapters
│   ├── image-reference.ts   repository, tag and repo@digest of an image reference
│   ├── docker-engine/       Docker Engine API adapter (backend name colima): socket, engine client, container body, exec session, images, volumes, relay per policy
│   └── apple/               Apple container adapter: backend.ts, cli.ts (every flag and JSON shape it assumes)
├── container/
│   ├── spec.ts              buildContainerSpec (network, proxy env, CA mount, ssh agent, spec hash), repoVolumes
│   ├── git-overlay.ts       discoverGitOverlay: core.hooksPath, submodule and worktree git files to protect, creating missing hook dirs
│   ├── names.ts             container and volume names, labels
│   ├── lifecycle.ts         ensureContainer, findCurrentContainer, findRepoContainer, removeRepoContainer, collectGarbage
│   ├── run-pi.ts            runPi: exec behind a pid file, raw mode, resizes, signal handling
│   └── probes.ts            doctor checks: same-path mount, credential sweep, no-route, proxy health
├── image/
│   ├── Dockerfile           the sandbox image
│   ├── entrypoint.sh        agent dir links, settings seed, CA bundle, idle
│   ├── render.ts            renderModelsJson, renderAuthJson
│   ├── extensions.ts        resolveExtensionsSource (tarball pack cache, registry or none), packExtensionsTarball
│   └── build.ts             build context, ensureBuiltImage, recordedImage
├── proxy/
│   ├── daemon.ts            the proxy process entry
│   ├── control.ts           ensureProxyRunning, readProxyInstances, stopProxy, removeProxyInstance, per-instance lock and token
│   ├── server.ts            CONNECT handling, token check, health endpoints, denials, guestProxyUrl
│   ├── policy.ts            decideConnect, restricted addresses
│   ├── sni.ts               ClientHello server name parsing
│   ├── dial.ts              resolving dialer with the private-address filter
│   ├── gateway.ts           TLS termination and header injection toward the gateway
│   ├── credentials.ts       static, host-pi-auth and sso sources
│   ├── tls-ca.ts            launcher CA and leaf certificates through openssl
│   ├── access-log.ts        JSON-line access log
│   ├── settings.ts          proxy settings from the config, proxyPolicyHash
│   └── files.ts             per-instance file paths under proxy/<policy hash>/ and the ProxyInstance record
├── shared/                  LauncherError, errorMessage, CommandRunner, sha256Hex, stableHash, JSON files, launcherPaths, launcherRoot, launcherEntry, expandHome, isWithin, BACKEND_NAMES, isSecretName
├── profiles/                solo.json, team.json, enterprise.json
├── schema/                  sandbox-config.schema.json
├── install.sh               macOS install: Colima profile, launcher, PATH, user config, doctor in a temporary repository
├── uninstall.sh             removes what install.sh and the launcher created
├── tsconfig.build.json      emits dist/ (gitignored) for the published bin
└── tests/
    ├── shared/ config/ workspace/ backend/ container/ image/ proxy/ cli/   unit tests per folder
    ├── backend/conformance.ts   the adapter conformance suite, run on fakes and live
    ├── container/run-pi.test.ts runPi, including the signal path, on the fake backend
    ├── cli/harness.ts       temp dirs, fake runner, CliDeps with collected output
    ├── config/fixtures.ts   layer files in temp dirs
    ├── proxy/proxy-client.ts    CONNECT and TLS client helpers
    ├── support/             fake-runner.ts (+ its test), fake-engine.ts, fake-container-cli.ts, fake-backend.ts, sandbox-config.ts
    └── live/                *.live.test.ts against a real engine, run only with PI_SANDBOX_LIVE=1
```

Each folder with code has an `index.ts` that is its only public surface. The docs are `README.md` (for users), `ARCHITECTURE.md` and this file.
