# launcher structure

One line per file. Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md). Each folder with code has an `index.ts` that is its only public surface.

## Top level

```
README.md                      for users: install, everyday use, configuration, troubleshooting
ARCHITECTURE.md                how it works, the files it writes
STRUCTURE.md                   this file
THREAT-MODEL.md                assets, trust boundaries, what each feature weakens, known gaps
install.sh                     macOS install: Colima profile, the launcher and its pi link, PATH blocks (zsh, bash, fish), smoke test
uninstall.sh                   runs the launcher's cleanup, deletes the profile, removes the link, state, package and PATH blocks
tsconfig.build.json            emits dist/ (gitignored) for the published bin
examples/policy.json           a starting point for the administrator's policy file
schema/sandbox-config.schema.json  the config keys of every layer
```

## bin/

```
bin/pi-sandbox.js              the package bin: runs the built dist/
bin/pi-sandbox-dev.js          checkout entry: runs the .ts sources, not published
bin/path-block.sh              the PATH block helpers and the sh and fish lines, sourced by install.sh and uninstall.sh
```

## cli/

```
cli/main.ts                    builds the real dependencies, the host git outside the started folder included, and runs
cli/run.ts                     the command table, the hidden __uninstall route and error rendering
cli/deps.ts                    the dependencies every command gets, and the shared terminal helpers
cli/index.ts                   public surface
cli/launch.ts                  the pi pipeline with its stages, and withSandbox for the doctor
cli/context.ts                 the launch context: the folder to mount, the guard and workspaceRoots before the search, config, discovery and the checks after it
cli/vm.ts                      VM start and shares, the VM paths a launch needs
cli/launch-notices.ts          the launch notice texts, the host-file flag notice and the proxy stage detail
cli/terminal.ts                the host terminal: streams, size read at use, resize
cli/launches.ts                begin and finish a launch (removing its container), the last-session removal, the live launch count
cli/sweep.ts                   removeRepoSandbox, the sweep of ended launches' containers, the orphan sweep and the daily collection
cli/derive.ts                  the host side of a launch: host pi files, derivation, trust bundle, notices
cli/sandbox-proxy.ts           the repository's proxy input and token, and the denial summary at exit with a hint per kind
cli/mcp-sign-in.ts             the launch-start MCP sign-in on the host
cli/host-sessions.ts           host sessions for a launch: choice, preparation, sweeps, share probe
cli/intercept.ts               pi install, uninstall, remove, mcp and update run on the host
cli/host-pi.ts                 the one host pi (managed, else bundled) and --no-sandbox (runHostPi)
cli/notices.ts                 notices printed once per repository and text
cli/versions.ts                launcher version and image pi version
cli/commands/status.ts         pi sandbox status
cli/commands/config.ts         pi sandbox config
cli/commands/egress.ts         pi sandbox egress allow, revoke and list
cli/commands/reset.ts          pi sandbox reset: the folder's sandbox and volumes
cli/commands/stop.ts           pi sandbox stop
cli/commands/uninstall.ts      the hidden __uninstall command uninstall.sh runs: live-session refusal, engine objects by label, host-side release
cli/commands/doctor.ts         pi sandbox doctor: stages, probes, host checks
cli/commands/doctor-probes.ts  the doctor's checks inside the container
cli/commands/doctor-host.ts    the doctor's checks on the host
cli/commands/help.ts           usage
cli/commands/options.ts        the option check of the sandbox commands and egress
```

## config/

```
config/index.ts                public surface
config/types.ts                the config, layer and rule types
config/defaults.ts             the default config and image reference
config/load.ts                 loads the policy and user layers and merges them
config/merge.ts                the layer merge: union and final keys, the egress lock, ignored keys and their warning, sources
config/validate.ts             the key spec of every layer
config/dotted.ts               dotted key access
config/egress-entry.ts         the host entry grammar, entry parsing and host matching
config/egress-presets.ts       the egress preset hosts and the expanded allow list
config/parent-proxy.ts         the parent proxy read from HTTPS_PROXY and NO_PROXY
```

## workspace/

```
workspace/index.ts             public surface
workspace/types.ts             the workspace shape
workspace/discover.ts          the folder to mount, and repository and workspace discovery, strict and lenient; strict mode sorts the walk into nested repositories, detached checkouts (any .git file not wholly inside) and bare dirs, and refuses unreadable folders of the user
workspace/workspace-scan.ts    the scan for nested repositories, bare-shaped dirs and overlay folders, optionally not descending into overlaid build output
workspace/walk.ts              the budgeted level-by-level directory walk
workspace/paths.ts             path ordering by depth and code unit, the dirs between a root and a path, the real path of a missing path, a pointer resolved through links as the filesystem does
workspace/overlay-markers.ts   which marker file gives which build output folder
workspace/guard.ts             the refusal of protected folders and workspaces (home, pi and launcher dirs, credential, system and image dirs) and the host session dir check
workspace/mounts.ts            the protected path table
workspace/roots.ts             the workspaceRoots refusal
workspace/pi-session-dir.ts    pi's session slug and the host session dir choice
workspace/created.ts           removal of recorded created folders
workspace/git/layout.ts        git dir layout from the files, refusing links, foreign pointers and a foreign commondir; the git-dir shape and the .git name in any letter case
workspace/git/protect.ts       the hooks dirs bound read-only, the self binds and the workspace bare-dir check
workspace/git/integrity.ts     layout re-checks (worktree pointers, foreign commondir) and the alternates notice
workspace/git/launch.ts        the git baseline (kept while other launches are live), the launch and end notices, the pending report of an unfinished session
workspace/git/scan.ts          nested .git entries in any letter case, git-dir-shaped folders, gitlinks and a digest of each repository's own git files
workspace/git/workspace.ts     workspace self binds and notices (detached checkouts, bare dirs)
workspace/git/command.ts       inert options for the launcher's own git calls
```

## backend/

```
backend/index.ts               public surface
backend/types.ts               the Backend contract with its VM
backend/labels.ts              every pi-sandbox.* label key
backend/image-reference.ts     image reference parsing
backend/managed-network.ts     per-repository network and relay names and labels
backend/exec-capture.ts        a non-tty exec with collected output
backend/colima/backend.ts      the Colima backend
backend/colima/profile.ts      the pi-sandbox profile, its socket and the VM's name for the host
backend/colima/engine-client.ts  the engine HTTP client over the socket, with its timeouts
backend/colima/container-body.ts  container create bodies from a spec, with the capability, privilege and process limits
backend/colima/exec-session.ts exec streams with backpressure, ended quietly when the host output closes
backend/colima/images.ts       image pull, build (with the output tail of a failed build) and removal
backend/colima/volumes.ts      volume operations
backend/colima/relay.ts        the per-repository network and relay
backend/colima/vm.ts           VM start, size and stop
backend/colima/shares.ts       VM shares and the share restart
backend/colima/colima-yaml.ts  the lima.yaml mounts reader
```

## container/

```
container/index.ts             public surface
container/spec.ts              the container spec: mounts, env, labels, the mount table check (no target twice, no mount over the image's paths), the overlay backstop
container/volumes.ts           the volume plan: agent, overlay and shared volume names, targets and labels
container/git-overlay.ts       the git overlay plan and its ready() step before a start: layout re-check, hooks dirs, the baseline and the pending report
container/names.ts             container and volume names
container/lifecycle.ts         startLaunchContainer and removeLaunchContainer: one container per launch, mount points, volume hand-over
container/run-pi.ts            pi through exec, the pty only for a terminal, signals and resize
```

## image/

```
image/index.ts                 public surface
image/Dockerfile               the sandbox image
image/entrypoint.sh            render links, CA bundle, JVM truststore, idle
image/bash-env.sh              the missing-command hint and the JVM trust flags
image/sandbox-image.ts         ensureSandboxImage under the build lock: pull or build, then the layer; build leftovers
image/build.ts                 the base image build and pinned pull
image/context.ts               build contexts under <state>/build/
image/layer.ts                 the user image layer
image/record.ts                the image record: base image and current layer
image/prune.ts                 the one rule that removes stale layer tags and untagged launcher images, skipped while a build holds build.lock
image/build-trust.ts           extra CAs in the build context
image/build-proxy.ts           the parent proxy as build arguments, loopback proxies pointed at the host
```

## hostpi/

```
hostpi/index.ts                public surface
hostpi/types.ts                host pi file and derivation types
hostpi/files.ts                reads the host pi files
hostpi/derive.ts               deriveSandboxPi: sandbox files, rules and notices
hostpi/derive-auth.ts          auth.json entries and provider keys
hostpi/derive-models.ts        models.json providers and models
hostpi/derive-mcp.ts           mcp.json servers
hostpi/derive-tools.ts         the host tool derivers together
hostpi/headers.ts              header values to placeholders and secret sources, credential-shaped values
hostpi/rules.ts                placeholders and rules per identity
hostpi/endpoints.ts            rule endpoints and URL credential checks
hostpi/provider-endpoints.ts   a provider's hosts
hostpi/provider-hosts.ts       the provider host table with its cache
hostpi/provider-hosts.mjs      run against the host pi: the built-in provider hosts
hostpi/locate.ts               finds the managed and bundled pi packages
hostpi/path-search.ts          PATH lookup outside the sandbox roots and the executable check
hostpi/mcp-auth.ts             MCP servers and their host sign-in state
hostpi/json.ts                 small JSON helpers
hostpi/tools/files.ts          shared helpers of the tool derivers
hostpi/tools/gh.ts             gh hosts and tokens
hostpi/tools/glab.ts           glab hosts and tokens
hostpi/tools/npmrc.ts          ~/.npmrc credentials
hostpi/tools/pip.ts            pip.conf in the home locations
hostpi/tools/maven.ts          ~/.m2/settings.xml servers (passwords and httpHeaders), mirrors, profiles, activeProfiles, pluginGroups
hostpi/tools/git.ts            git user name and email
```

## provision/

```
provision/index.ts             public surface
provision/types.ts             render and sync types
provision/render.ts            the render dir and its tool files
provision/tree.ts              filtered copy of host agent dir entries, with one notice for what was left out
provision/pool.ts              bounded parallel work
provision/sync.ts              the filtered host settings.json written into the volume
provision/merge-settings.ts    the sandbox copy of the host settings: dropped keys, package sources and their notices
provision/package-source.ts    package sources and their URL credentials
provision/volume.ts            files in the agent volume through exec
provision/host-sessions.ts     host session dir preparation, sweep and share probe
```

## grants/

```
grants/index.ts                public surface
grants/types.ts                grant and launch types
grants/store.ts                grants.json
grants/launches.ts             the launch registry: liveness, pruning, live counts
```

## proxy/

```
proxy/index.ts                 public surface
proxy/daemon.ts                the proxy process entry
proxy/start.ts                 start, reuse and stop of a repository's proxy
proxy/idle.ts                  the idle exit
proxy/files.ts                 proxy input and record types
proxy/settings.ts              the egress policy from the input
proxy/client.ts                the launcher's client to a proxy
proxy/server.ts                the proxy server, CONNECT dispatch and the resolved-address check
proxy/routes.ts                /healthz and /denials
proxy/auth.ts                  the repository token and the guest proxy URL
proxy/policy.ts                CONNECT decisions and restricted addresses
proxy/runtime.ts               rules, derived hosts and live grants
proxy/tunnel.ts                end-to-end tunnels with the SNI check
proxy/sni.ts                   ClientHello completeness and server name parsing
proxy/dial.ts                  the resolving dialer with the private-address filter
proxy/intercept.ts             TLS termination for rule hosts
proxy/terminate.ts             credential injection on terminated streams
proxy/rules.ts                 rule matching, header rewrite and response scrub
proxy/request-target.ts        authority parsing, request target and path checks on terminated hosts
proxy/denials.ts               denial records and replies
proxy/denial-page.ts           the 403 page over TLS
proxy/replies.ts               every raw HTTP reply and the JSON replies
proxy/parent.ts                the parent proxy route
proxy/trust.ts                 the trust bundle
proxy/tls-ca.ts                the launcher CA and leaf certificates
proxy/sign-in.ts               the proxy's host MCP sign-in
proxy/single-flight.ts         one pending promise per key
proxy/access-log.ts            the capped JSON-line logs
proxy/child-env.ts             the minimal environment of the proxy and its children
proxy/secrets/index.ts         the secret resolver
proxy/secrets/cache.ts         the secret cache
proxy/secrets/env.ts           env secrets from the proxy input
proxy/secrets/file.ts          file secrets
proxy/secrets/command.ts       command secrets
proxy/secrets/pi-auth.ts       host pi auth secrets
proxy/secrets/mcp-oauth.ts     MCP OAuth tokens from host pi and the sign-in replies
proxy/secrets/errors.ts        unavailable secrets and local replies
```

## shared/

```
shared/index.ts                public surface
shared/errors.ts               LauncherError and error messages
shared/command-runner.ts       the CommandRunner interface and the real runner
shared/hash.ts                 hashes and the 12-hex short hash
shared/json-file.ts            JSON file reading and writing
shared/atomic-write.ts         atomic and random-hex file writes
shared/file-lock.ts            the lock primitives
shared/liveness.ts             the liveness rule: pid, boot time and process start
shared/process-start.ts        a process's start time (ps on macOS, /proc on Linux), telling a failed tool from a process without one
shared/paths.ts                state, config and policy paths, launcher root
shared/state-layout.ts         every path under the state dir
shared/repo-state.ts           per-repository record files: repo.json with its mount root, created folders, leftovers
shared/regular-file.ts         safe reads of regular files
shared/placeholder.ts          the placeholder format and the JWT shape
shared/secret-name.ts          secret-looking names, auth-like headers, URL userinfo and credential-shaped values
shared/pi-env.ts               pi variable names the launcher sets
shared/mcp-auth-key.ts         host pi's mcp-auth.json parser, mcp-login.json under a file lock, and sign-in dirs
shared/tool-config.ts          the tool config format dispatcher and the JSON pointer reader
shared/npmrc.ts                the .npmrc parser and value reader
shared/ini.ts                  the ini parser and section.name[n] reader
shared/maven-xml.ts            the XML tokenizer, the Maven settings model, the server secret reader and the XML writer
shared/settle.ts               settleAll
```

## tests/

```
tests/support/expect-no-leak.ts      asserts no secret reaches a spec, exec, env, stdin or render file
tests/support/fake-backend.ts        the fake backend
tests/support/fake-engine.ts         an in-memory engine HTTP server
tests/support/fake-runner.ts         the scripted CommandRunner
tests/support/fake-clock.ts          a controllable clock
tests/support/sandbox-config.ts      config builders
tests/support/temp-dir.ts            temp dir helpers
tests/support/git.ts                 git for tests, isolated from the developer's git config
tests/support/fakes.test.ts          the fakes' own contract
tests/shared/atomic-write.test.ts    atomic writes
tests/shared/command-runner.test.ts  the real runner
tests/shared/errors.test.ts          error messages
tests/shared/file-lock.test.ts       locks, takeover and liveness
tests/shared/liveness.test.ts        the liveness rule
tests/shared/hash.test.ts            hashes
tests/shared/json-file.test.ts       JSON files
tests/shared/paths.test.ts           paths
tests/shared/placeholder.test.ts     placeholders
tests/shared/pi-env.test.ts          the variables the launcher sets
tests/shared/mcp-auth-key.test.ts    mcp-login.json updates and sign-in dirs
tests/shared/state-layout.test.ts    the state layout
tests/shared/tool-config.test.ts     tool config parsers
tests/config/fixtures.ts             layer files in temp dirs
tests/config/load.test.ts            loading the layers
tests/config/merge-security.test.ts  final keys across layers
tests/config/security-keys.test.ts   credential and image keys
tests/config/egress-entry.test.ts    the egress grammar
tests/config/parent-proxy.test.ts    the parent proxy parser
tests/config/mounts.test.ts          mount keys
tests/config/sessions.test.ts        sessions.host
tests/config/schema.test.ts          schema and key spec agree
tests/config/validate.test.ts        validation messages
tests/workspace/discover.test.ts     discovery and layout refusals
tests/workspace/workspace-mode.test.ts  workspace mode
tests/workspace/guard.test.ts        the workspace guard
tests/workspace/mounts.test.ts       the protected path table
tests/workspace/paths.test.ts        path ordering
tests/workspace/roots.test.ts        workspaceRoots
tests/workspace/pi-session-dir.test.ts  slug and host session dir choice
tests/workspace/git-integrity.test.ts  worktree pointers, commondir checks and the git notices after a session
tests/workspace/created-dirs.test.ts  created folder removal
tests/backend/conformance.ts         the backend conformance suite
tests/backend/colima.conformance.test.ts  the suite on the in-memory engine
tests/backend/fake-backend.conformance.test.ts  the suite on the fake backend
tests/backend/colima.test.ts         Colima adapter specifics
tests/backend/colima-vm.test.ts      VM start
tests/backend/colima-shares.test.ts  VM shares
tests/backend/colima-size.test.ts    VM size
tests/container/spec.test.ts         the container spec
tests/container/git-overlay.test.ts  the git overlay
tests/container/lifecycle.test.ts    one container per launch, its removal and housekeeping
tests/container/run-pi.test.ts       running pi and signals
tests/image/build.test.ts            base builds
tests/image/build-network.test.ts    build proxy arguments
tests/image/layer.test.ts            the image layer
tests/image/sandbox-image.test.ts    image selection and removal
tests/image/prune.test.ts            image collection: age check, in-use images, the current layer, build-lock skip
tests/image/entrypoint.test.ts       the entrypoint, run for real
tests/image/bash-env.test.ts         the missing-command hint, run for real
tests/hostpi/fixtures.ts             host pi file fixtures
tests/hostpi/derive.test.ts          derivation and placeholders
tests/hostpi/tools.test.ts           the tool derivers
tests/hostpi/files.test.ts           host pi file reading
tests/hostpi/mcp-auth.test.ts        MCP sign-in state
tests/hostpi/provider-hosts.test.ts  the provider host table
tests/hostpi/provider-hosts-sample.json  a sample provider host table
tests/provision/fixtures.ts          provisioning fixtures
tests/provision/render.test.ts       the render dir
tests/provision/merge-settings.test.ts  the settings sync
tests/provision/host-sessions.test.ts  host session sweep and probe
tests/grants/store.test.ts           grants
tests/grants/launches.test.ts        the launch registry
tests/proxy/harness.ts               proxy test harness
tests/proxy/proxy-client.ts          CONNECT and TLS client helpers
tests/proxy/policy.test.ts           CONNECT decisions, SNI and private ranges
tests/proxy/server.test.ts           the proxy server
tests/proxy/terminate.test.ts        credential injection
tests/proxy/rules.test.ts            rule matching and scrub
tests/proxy/secrets.test.ts          secret sources
tests/proxy/mcp-oauth.test.ts        MCP OAuth and sign-in
tests/proxy/sign-in.test.ts          the proxy's sign-in: records and shutdown races
tests/proxy/start.test.ts            proxy start, reuse, stop and idle exit
tests/proxy/parent.test.ts           the parent proxy
tests/proxy/denial-page.test.ts      the denial page
tests/proxy/tls-ca.test.ts           the CA and leaves
tests/proxy/trust.test.ts            the trust bundle
tests/proxy/sni.test.ts              ClientHello parsing
tests/proxy/hello.test.ts            ClientHello reading and dial timeout
tests/proxy/dial.test.ts             the dialer's restricted-address rules
tests/proxy/keep-alive.test.ts       upstream connection reuse
tests/proxy/request-target.test.ts   request target checks
tests/proxy/child-env.test.ts        the minimal environment
tests/cli/harness.ts                 the CLI test harness
tests/cli/commands.test.ts           the pi sandbox commands
tests/cli/doctor.test.ts             the doctor
tests/cli/egress.test.ts             egress grants
tests/cli/errors.test.ts             error output
tests/cli/host-pi.test.ts            host pi selection
tests/cli/install.test.ts            install.sh, run for real
tests/cli/uninstall.test.ts          uninstall.sh, run for real
tests/cli/intercept.test.ts          intercepted commands
tests/cli/launch.test.ts             the launch
tests/cli/launch-flow.test.ts        the signal guard, side-by-side stages and the VM shares of a launch
tests/cli/launch-git.test.ts         the git layout check at launch
tests/cli/launch-host-sessions.test.ts  host sessions at launch
tests/cli/launch-sessions.test.ts    session end and the sweep
tests/cli/sweep.test.ts              the sweep of unused repositories and of the state dir
tests/cli/launch-wiring.test.ts      launch wiring and no leaks
tests/cli/launch-workspace.test.ts   workspace launches
tests/cli/mcp-sign-in.test.ts        the launch-start MCP sign-in
tests/cli/sandbox-proxy.test.ts      the proxy input
tests/cli/terminal.test.ts           the host terminal
tests/cli/volumes.test.ts            volumes in the sweep, reset and status
tests/live/colima.live.test.ts       the conformance suite, volume ownership, read-only folder binds on the share (any letter case) and the image hint on the real engine
tests/live/colima-relay.live.test.ts  the relay on the real engine
tests/live/custom-provider.live.test.ts  a custom provider through the proxy
tests/live/mcp-host-login.live.test.ts  the host-owned MCP sign-in
tests/live/no-garbage.live.test.ts   nothing left after the last session
tests/live/parent-proxy.live.test.ts  a parent proxy chain
tests/live/secret-sweep.live.test.ts  no secret inside a real sandbox
tests/live/harness/engine.ts         live engine access
tests/live/harness/names.ts          live test names
tests/live/harness/resolve-preload.mjs  module resolution preload
tests/live/harness/sandbox.ts        a live sandbox with checked cleanup, and a held pi -p session whose container probes run in
tests/live/harness/scenario.ts       live scenarios
tests/live/harness/sweep.ts          live leftovers sweep
tests/live/fixtures/https-fixture.ts  an HTTPS server
tests/live/fixtures/inspecting-proxy.ts  a TLS-inspecting parent proxy
tests/live/fixtures/llm-fixture.ts   a model server
tests/live/fixtures/mcp-fixture.ts   an MCP server
tests/live/fixtures/provider.json    a custom provider
tests/live/fixtures/test-ca.ts       a test CA
```
