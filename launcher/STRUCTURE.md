# pinata structure

One line per file. Layer rules and behaviour are in [ARCHITECTURE.md](ARCHITECTURE.md). Each folder with code has an `index.ts` that is its only public surface.

## Top level

```
README.md                      for users: install with pinata, quick start, everyday use, what is protected, troubleshooting
CONFIGURATION.md               every config key, the one config file, credentials, corporate proxies, sharing the file across a team
ARCHITECTURE.md                how it works, the files it writes
STRUCTURE.md                   this file
THREAT-MODEL.md                assets, trust boundaries, what each feature weakens, known gaps
REMOVED-DEFAULTS.md            the egress presets and config keys earlier versions shipped, and how to add them back
tsconfig.build.json            emits dist/ (gitignored) for the published bin
examples/config.json           a sample config file for a team to start from
schema/sandbox-config.schema.json  the config keys
```

## bin/

```
bin/pi.js              the package bin: runs the built dist/
bin/pi-dev.js          checkout entry: runs the .ts sources, not published
bin/pinata.js                  the pinata bin: runs the built dist/
bin/pinata-dev.js              checkout entry of pinata: runs the .ts sources, not published
```

## cli/

```
cli/main.ts                    builds the real dependencies, the /dev/tty opener of pinata init included, and runs pinata or the pi link by the name it was started under
cli/run.ts                     the pi link: intercept or launch, and the pinata: error rendering
cli/deps.ts                    the dependencies every command gets, and the shared terminal helpers (TTY and colour checks, a line sink)
cli/index.ts                   public surface
cli/launch.ts                  the pi pipeline with its stages and progress lines, the proxy route and the install's services under the ground lock inside the preparation lock, the file cache watch while pi runs, and withSandbox for the doctor
cli/context.ts                 the launch context: the folder to mount, the guard and the workspaceRoot required for the sandbox before the search and the host check (checkHostRoot) for --no-sandbox, config, discovery, the git dir check after it and the mounted root
cli/vm.ts                      VM start (only with a share plan, the workspaceRoot shares when stopped), the start from the config alone for pinata restart, the one reconcile of shares and size, trust store, the automatic VM size and the host limits (one clamp), the memory check against the automatic size when vm.memoryGiB is unset, the VM paths a launch needs, the workspaceRoot share list and its nesting check, the VM's busy check from cli/busy.ts
cli/clipboard.ts               the host clipboard of a launch: pbcopy for copies, osascript for a Ctrl+V file path or PNG
cli/launch-notices.ts          the launch notice texts, the host-file flag notice and the proxy stage detail
cli/terminal.ts                the host terminal: streams, size read at use, resize
cli/prompt/types.ts            the prompt, spec, key, terminal session and ui types of pinata init
cli/prompt/terminal.ts         finding the terminal (/dev/tty) and its restore, the ui options (glyphs, colour), the timers
cli/prompt/keys.ts             key decoding, ctrl checks, the key listener and dropping keys typed ahead
cli/prompt/style.ts            glyphs (rich and ASCII), tones and painting, text width, truncation and wrapping, control characters removed
cli/prompt/frame.ts            the live frame redrawn in place
cli/prompt/line-editor.ts      the line editor
cli/prompt/rules.ts            the input rules both prompt sets share: number checks, warn once, initial choice
cli/prompt/task.ts             the task runner both prompt sets share (raw mode, ctrl-c, settling once; each set only draws) and the still-working heartbeat
cli/prompt/complete.ts         path completion
cli/prompt/rich.ts             the rich prompt set
cli/prompt/plain.ts            the plain prompt set
cli/setup/types.ts             the setup's facts, answers, plan, outcome, io, effects, apply event and front end types
cli/setup/document.ts          the config file read with its indent, owned-key edits keeping key order, the diff and the checked atomic write
cli/setup/folders.ts           the candidate project folders, the repository scan, the storage form of a root, the wizard's refused-folder messages for a typed folder and the hub's folder row
cli/setup/plan.ts              the first-run steps, owned-key problems, initial answers, the edited config, the VM action, the plan and the VM size field bounds
cli/setup/detect.ts            the host, VM, sessions, free disk and folders gathered in parallel within a budget
cli/setup/screens.ts           every sentence of the setup screens, rich and plain, as functions of the facts and the plan, and one text per apply event
cli/setup/flow.ts              runSetup: the intro, detection, the three first-run steps, the review hub with its section editors, cancel and the outros
cli/setup/review.ts            the review summary: the rows of the three settings with their tags and problems, the file changes and the VM action, as lines for the hub and for --yes
cli/setup/apply.ts             applyPlan: the file write and the VM step as typed events, and the two front ends: the wizard's (progress, failure screen with Try again, success screen) and the lines of --yes
cli/launches.ts                begin and finish a launch (registered under the folder's preparation lock, removing its container), the folder's sandbox removed after its last session under the preparation lock (waiting for it unless another session of the folder is registered), a failure after the registration ending the launch, and the orphan sweep
cli/busy.ts                    busyLaunches, the live launches of this state dir, and vmSessions, the VM's busy count that adds the running agent containers of other installs and names them
cli/ground.ts                  the ground lock with its waiting line, the install's services started under it, the idle teardown of services, relay, network and proxy and the idle proxy stop (both wait for the lock unless a launch of this state dir is registered)
cli/prepare.ts                 the repository's preparation lock with its waiting line, its if-free form for the opportunistic removals, its wait-unless-another-session form for the folder's last session, and the setup commands run in the agent container; the install's agent lock (withAgentLock) around the shared pi folder
cli/sweep.ts                   removeRepoSandbox (agent containers, created folders, host sessions), the sweep of ended launches' containers, forgetting a folder that is gone, the orphan sweep with the idle ground stop and build leftovers, and the daily collection with the managed `pinata-*` objects of older builds that have no install label, shared volumes kept, and the state entries the layout does not name in the default state dir
cli/derive.ts                  the host side of a launch: host pi files, derivation (host tools exclude the sandbox roots), the CAs the image trusts, notices
cli/sandbox-proxy.ts           the install's proxy input and token, opened under the ground lock, and the denial summary at exit with a reason and fix per kind (also the doctor's rule hints and blocked warnings)
cli/mcp-sign-in.ts             the launch-start MCP sign-in on the host
cli/host-sessions.ts           host sessions for a launch: choice, preparation, sweeps, share probe
cli/intercept.ts               pi install, uninstall, remove, mcp, every update, config, auth, help, --list-models, --export and --version run on the host
cli/host-routes.ts             which command lines start no session: help, version, auth, config without -l, --list-models, --export
cli/host-pi.ts                 the one host pi (pi's managed install, else npm's global pi, not linked in, outside the workspace root and every folder a sandbox has run in), spawning it for host jobs (spawnHostJob), the missing-pi line (missingPiText, built from the parts of missingPi the doctor shows) and --no-sandbox (runHostPi)
cli/notices.ts                 notices printed once per install, their hashes kept in seen.json
cli/versions.ts                pinata version, the tested pi version and image pi version, the version compare
cli/commands/status.ts         pinata status, with each configured service and its state, the shared pi folder and, in one place, what older launchers left
cli/commands/config.ts         pinata config, with the effective write-back keys of each file and their source
cli/commands/egress.ts         pinata egress allow, revoke and list
cli/commands/restart.ts        pinata restart: live-session refusal, the VM started, the y/N for data the next pi cannot rebuild, then every folder released and under the agent, render, ground and registry locks the ground, volumes, managed images and host records removed, the VM restarted, and every line it prints in one table
cli/commands/stop.ts           pinata stop: the orphan sweep, which stops the ground and the proxy when idle, then the VM when no session runs in it
cli/commands/uninstall.ts      releaseSandbox for pinata uninstall: live-session refusal, each folder released, then under the ground and launch registry locks a second session count and the install's services, relay, network, proxy and volumes and the managed images, host-side release, with the lines it prints
cli/release.ts                 what the uninstall and pinata restart share: every known or engine-labelled folder released under its preparation lock when free, the install's volumes and managed images removed, and the ground and registry locks with the second session count
cli/commands/list.ts           pinata list: the VM's state and size and, when it runs, every agent container in it with its folder, without starting it
cli/commands/init.ts           pinata init: --yes, CI and terminal checks, builds the UI and effects, and picks the front end (the wizard, rich or plain, or the lines of --yes)
cli/commands/doctor.ts         pinata doctor: stages, probes and host checks as checks by section, the vm size and file cache checks, the denials matched to each rule, the blocked warnings, captured notices and the progress line
cli/commands/doctor-probes.ts  the doctor's checks inside the container, each credential rule named for its login or host; the credential sweep skips the config's own `env.set` values and names the secret-named ones; a rule whose credential was denied warns, one the proxy refused says why, a certificate not yet valid names the VM clock
cli/commands/doctor-host.ts    the doctor's checks on the host
cli/commands/doctor-checks.ts  the check data model: result types and builders (with the brief phrase and the neutral skip the default view reads), the section and check order, the verdict
cli/commands/doctor-report.ts  the pure text renderer of the checks: the name column padded to the longest name, reasons and hints, notices, the result line naming the failed and warned checks, ~, colour
cli/commands/doctor-view.ts    which rows the report prints: every check with --verbose, else the merged groups carrying their members' reasons, the checks quiet when ok left out unless they carry a reason, a failing configured rule's id, the passing rules collapsed into logins or credential hosts
cli/commands/doctor-tls.ts     the tls inspection checks: the node handshake to pi.dev on the host and in the container, the keychain lookup of the root CA, the outcomes
cli/commands/tls-probe.ts      the typed TLS handshake script those checks run as their own node process: request on stdin, chain and verdicts on stdout
cli/commands/help.ts           usage
cli/commands/options.ts        the option check of the sandbox commands and egress
cli/pinata/run.ts              pinata: the one command table, install, update and uninstall and the sandbox commands, with their flags
cli/pinata/host.ts             the package name, the host pi requirement (no pi stops install and update before they change anything), the preflight (root, Node, colima installed with brew when missing), the busy refusal, the checkout or npm-copy check and the package sources in pi's settings.json
cli/pinata/install.ts          pinata install: host pi requirement, --config check, pi install of the package, the link, the PATH blocks, the config file, then pinata init
cli/pinata/update.ts           pinata update: checkout refusal, host pi requirement, preflight, npm install -g of the package, then the new copy's pinata install --yes
cli/pinata/uninstall.ts        pinata uninstall: busy refusal, releaseSandbox, the colima profile, the link, pi remove, the PATH blocks, the guarded state dir, npm uninstall -g, the kept lines
cli/pinata/shim.ts             ~/.local/bin/pi: what may be replaced, the link, the recorded managed link and its restore; ~/.local/bin/pinata of a checkout
cli/pinata/path-block.ts       the marked PATH block in ~/.zshrc, ~/.bashrc and ~/.bash_profile, added or removed
```

## config/

```
config/index.ts                public surface
config/types.ts                the config, config file and rule types
config/defaults.ts             the default config and image reference
config/load.ts                 loads the config file and lays it over the defaults
config/merge.ts                the config file over the defaults, env.allow added to the default list, env.set replaced whole, the source of each key
config/validate.ts             the key spec of the config file (with a map node for env.set), with the writeBack value specs and ceiling, the resources bounds and resources within vm, the services entries and their path, user and shared-volume checks, agent and service memory within vm.memoryGiB or, through defaultVmMemoryProblem, the automatic size
config/shape.ts                the key spec shapes and the problem finder validate.ts checks the config file with
config/write-back.ts           the effective write-back table: the built-in list with writeBack.exclude and writeBack.add, and each key's source
config/dotted.ts               dotted key read, set and remove (own keys only)
config/egress-entry.ts         the host entry grammar, entry parsing and host matching
config/egress-allow.ts         pi.dev and the allow list
config/parent-proxy.ts         the parent proxy read from HTTPS_PROXY and NO_PROXY
```

## workspace/

```
workspace/index.ts             public surface
workspace/types.ts             the workspace shape
workspace/discover.ts          the folder to mount (the git root, else the cwd), its git dir and common dir from the files, and the overlay search of the launch repository
workspace/overlay-scan.ts      the budgeted search of the launch repository for overlay folders, not descending into overlaid build output
workspace/walk.ts              the budgeted level-by-level directory walk
workspace/paths.ts             path ordering by depth and code unit
workspace/overlay-markers.ts   which marker file gives which build output folder
workspace/guard.ts             the refusal of protected folders (home, pi and pinata dirs, credential, system and image dirs) and the host session dir check
workspace/mounts.ts            the protected path table
workspace/roots.ts             the workspaceRoot checks (unset, missing, the home or above it, the guard's protected paths and system dirs, outside the root, a git dir or common dir outside the root; the host launch runs only the inside-the-root ones) and the checked root the VM shares
workspace/binds.ts             the mounts.binds sources on the host: resolved, must exist, the root guard, and the folder the VM must share
workspace/pi-session-dir.ts    pi's session slug and the host session dir choice
workspace/created.ts           removal of recorded created folders
workspace/sandbox-reach.ts     the roots a sandbox can write (sandboxWriteRoots: the checked workspace root, the folders one has run in and the roots those runs mounted) and whether a path lies in them
workspace/git/layout.ts        the nearest folder with a .git entry, and the git dir and common dir read from the files
```

## backend/

```
backend/index.ts               public surface
backend/types.ts               the Backend contract with its VM
backend/labels.ts              every pinata.* label key, the container roles, isSession and isOlderBuild (a `pinata-*` name with the managed label and no install label)
backend/image-reference.ts     image reference parsing
backend/install.ts             the install id, the install's network and relay names, and the services alias
backend/exec-capture.ts        a non-tty exec with collected output
backend/vm-size.ts             the VM size against the vm config: what differs, a disk below the current one, the size text
backend/vm-decision.ts         the one VM decision from what the VM has and what is wanted: create, nothing, on next start, restart or defer while busy, for a launch and the setup
backend/colima/backend.ts      the Colima backend
backend/colima/profile.ts      the pinata profile, its socket, the VM's name for the host, the one colima start argv and its stop-and-start hint text, and the running-sessions, leftover-container and deferred-until-idle texts
backend/colima/engine-client.ts  the engine HTTP client over the socket, with its timeouts
backend/colima/container-body.ts  container create bodies from a spec, with the capability, privilege, process, open files and /dev/shm limits
backend/colima/exec-session.ts exec streams with backpressure, ended quietly when the host output closes
backend/colima/images.ts       image pull, build (with the output tail of a failed build) and removal
backend/colima/volumes.ts      volume operations, with the listing of older builds' volumes
backend/colima/networks.ts     the install's network: inspect, the managed check, creation (internal, no IPv6, isolated gateway, with its engine version check), the subnet, removal, and the listing and removal by name of older builds' networks
backend/colima/relay.ts        the install's one relay: joins the install's network as pinata-proxy on port 3128 and forwards to the proxy's host port, labelled with the hash of its inputs (the network's subnet included) and replaced when they change
backend/colima/relay-script.ts the relay's node script: serves only clients inside the install network's subnet, one upstream connection per client, the preamble first
backend/colima/vm.ts           VM start (at the vm config size when stopped), size, inspect, apply for the setup, the launch reconcile of shares and size in one restart, and stop
backend/colima/size.ts         the VM size colima reports (status --json, colima.yaml), the size flags of a start, the cold-start size and the shrink notice
backend/colima/shares.ts       VM shares: coverage, the shares a launch adds, the mount list of a restart and its check
backend/colima/vm-trust.ts     the tls.extraCa certificates in the VM's trust store, engine restart when idle
backend/colima/file-cache.ts   the VM's file cache watch: open files of the VM's Mac process found by its disk names, the host limit, the drop_caches release, and the read-only reading the doctor shows
backend/colima/colima-yaml.ts  the lima.yaml and colima.yaml mounts reader and the colima.yaml size reader
```

## container/

```
container/index.ts             public surface
container/spec.ts              the container spec: mounts (the workspace root read-write), the install's network, the forwarder's service ports and host, service volumes left out of the hand-over, env (env.set under pinata's variables, the hand-over wait flag), the env.allow names env.set leaves forwarded, labels, the mount table check (no target twice, no mount over the image's paths)
container/volumes.ts           the volume plan: agent, overlay and mounts.volumes names, targets and labels; userVolume names a volume shared by every folder of the state dir
container/names.ts             container and volume names (agent, cache and shared volumes, with isSharedVolumeName), the pod and service container names; the install's agent volume name and isLegacyAgentVolume for the per-repository ones of older launchers
container/services.ts          ensureServices and stopServices for the install: one pod on the install's network under the services alias, the service specs, the volume hand-over to each service user, the ready wait with its log tail, decide (fresh, refresh or keep by services hash) and the stop of all services at once; serviceVolumes, the service volumes the config names
container/lifecycle.ts         startLaunchContainer and removeLaunchContainer: one container per launch, mount points, volume hand-over (chownRoots, also for the pod) (fatal when the entrypoint waits for it, a warning otherwise), the wait for the entrypoint's ready marker and the forwarder's status, the exited-during-startup error
container/run-pi.ts            pi through exec, the pty only for a terminal, signals and resize, the terminal bridges
container/clipboard.ts         the clipboard bridges: OSC 52 copies teed to pbcopy, pasted image paths and Ctrl+V images or image files copied into /tmp/pi-paste, an OSC 9 notice when an image import fails, held by the copy tee until pi's output is between escape sequences
container/host-paths.ts        visibleInside: whether the sandbox sees a host path at the same path
```

## image/

```
image/index.ts                 public surface
image/Dockerfile               the sandbox image
image/entrypoint.sh            the wait for the volume hand-over, render links (~/.agents/skills included), the read-only auth.json copy, the Maven settings link, the services forwarder started and awaited, the ready marker, idle; links and copies placed through a temporary name and a rename, so containers starting at once share the pi folder safely
image/bash-env.sh              the missing-command hint, and the no-root hint for sudo, doas and systemctl
image/forwarder.mjs            the services forwarder kept in the image: each service port on 127.0.0.1 and ::1 to the services alias, its result in a status file
image/sandbox-image.ts         ensureSandboxImage under the build lock: pull or build, then the layer; build leftovers
image/build.ts                 the base image build (Dockerfile and extra CAs in its context) and pinned pull
image/context.ts               build contexts under <state>/build/
image/layer.ts                 the always-built image layer: the sandbox CAs, the entrypoint, bash hint and forwarder, the user's packages and Dockerfile, the JDK trust step; tagged by the hash of its context
image/trust.ts                 the layer's trust inputs: one CA per file, the JDK net.properties lines, the image paths
image/trust-jdk.sh             the trust script kept in the image: imports the sandbox CAs into every JDK's cacerts (or the JDKs given) and points its net.properties at the proxy
image/record.ts                the image record: base image and current layer
image/prune.ts                 the one rule that removes stale layer tags and untagged pinata images, skipped while a build holds build.lock
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
hostpi/locate.ts               finds pi's managed install in the host agent dir and the pi of npm install -g in npm's global root, keeping only paths the caller's accept predicate takes
hostpi/path-search.ts          PATH lookup outside the sandbox roots and the executable check
hostpi/mcp-auth.ts             MCP servers and their host sign-in state
hostpi/json.ts                 small JSON helpers
hostpi/tools/files.ts          shared helpers of the tool derivers
hostpi/tools/glab.ts           glab hosts and tokens; no no-token notice for a host never logged in to while another has a token
hostpi/tools/npmrc.ts          ~/.npmrc credentials
hostpi/tools/pip.ts            pip.conf in the home locations
hostpi/tools/maven.ts          ~/.m2/settings.xml servers (passwords and httpHeaders), mirrors, profiles, activeProfiles, pluginGroups
hostpi/tools/git.ts            git user name and email
```

## provision/

```
provision/index.ts             public surface
provision/types.ts             render and sync types
provision/render.ts            the render dir, its tool files and its host sources (agent dir entries and ~/.agents/skills); one render dir per install under the render lock
provision/status.ts            the sandbox status file tools/status.json from the config-derived RenderInput.status (proxy, resources, volumes, binds, setup, services with their ports)
provision/tree.ts              filtered copy of host sources, following no link, with one notice for what was left out and one for skipped links
provision/pool.ts              bounded parallel work
provision/sync.ts              the agent files sync under sync.lock: write-back to the host, then settings.json and pi-*.json into the volume, and the baseline, one baseline and package stamp per install, kept for the files a failed refresh left untouched
provision/write-back.ts        the write-back table compiled into value checks inside the ceiling, the allowlist hash of the baseline, the three-way merge per key and its lines (no I/O)
provision/merge-settings.ts    the sandbox copy of the host settings: dropped keys, package sources, resource entries placed for the container, and their notices
provision/package-source.ts    package sources and their URL credentials
provision/host-packages.ts     npm and git package sources pinned to the versions the host installed, read from host files (unversioned, range and tag npm sources; git commits on the remote)
provision/package-refresh.ts   the record of the last pins and the removal of outdated git checkouts from the volume, deferred while another session runs
provision/package-install.ts   the install of missing extensions in the launch's container before pi starts: `pi list`, `pi --help`, the notices, the record of sources it left missing
provision/volume.ts            files in the agent volume through exec: read with a size cap, write, remove, remove package dirs
provision/host-sessions.ts     host session dir preparation, sweep and share probe
```

## grants/

```
grants/index.ts                public surface
grants/types.ts                grant and launch types
grants/store.ts                grants.json
grants/launches.ts             the launch registry of the state dir under its launch lock: liveness, pruning, live launches, othersLive
```

## proxy/

```
proxy/index.ts                 public surface
proxy/daemon.ts                the proxy process entry
proxy/start.ts                 start, reuse and stop of the install's proxy (an unhealthy one kept while others use it), and its token
proxy/idle.ts                  the idle exit
proxy/files.ts                 proxy input, live egress settings and record types
proxy/client.ts                pinata's client to a proxy
proxy/server.ts                the proxy server behind the preamble gate, CONNECT dispatch and the resolved-address check
proxy/preamble.ts              the preamble line: the gate on the raw socket and the host-side connect that sends it
proxy/routes.ts                /healthz and /denials
proxy/policy.ts                CONNECT decisions and restricted addresses
proxy/runtime.ts               rules, the live egress.json settings and live grants
proxy/tunnel.ts                end-to-end tunnels with the SNI check
proxy/sni.ts                   ClientHello completeness and server name parsing
proxy/dial.ts                  the resolving dialer with the private-address filter and the 10 s bound on lookups and connects
proxy/intercept.ts             TLS termination for rule hosts
proxy/terminate.ts             credential injection on terminated streams, the upstream TLS handshake bounded
proxy/rules.ts                 rule matching, header rewrite and response scrub
proxy/request-target.ts        authority parsing, request target and path checks on terminated hosts
proxy/denials.ts               denial records (with the credential rule id) and replies
proxy/denial-page.ts           the 403 page over TLS
proxy/replies.ts               every raw HTTP reply and the JSON replies
proxy/parent.ts                the parent proxy route
proxy/trust.ts                 the sandbox CAs: tls.extraCa by keychain fingerprint or PEM file into ca/extra.pem, CA and expiry checks
proxy/tls-ca.ts                pinata's CA and leaf certificates, both dated an hour back
proxy/sign-in.ts               the proxy's host MCP sign-in
proxy/single-flight.ts         one pending promise per key
proxy/access-log.ts            the capped JSON-line logs
proxy/child-env.ts             the minimal environment of the proxy and its children
proxy/secrets/index.ts         the secret resolver
proxy/secrets/cache.ts         the secret cache
proxy/secrets/env.ts           env secrets from the proxy input
proxy/secrets/file.ts          file secrets
proxy/secrets/command.ts       command secrets
proxy/secrets/pi-auth.ts       host pi auth secrets; a failed command is a missing or expired login
proxy/secrets/mcp-oauth.ts     MCP OAuth tokens from host pi and the sign-in replies
proxy/secrets/errors.ts        unavailable secrets, missing logins and local replies
```

## shared/

```
shared/index.ts                public surface
shared/errors.ts               LauncherError and error messages
shared/command-runner.ts       the CommandRunner interface and the real runner
shared/hash.ts                 hashes and the 12-hex short hash
shared/json-file.ts            JSON file reading and writing
shared/atomic-write.ts         atomic, create-only and random-hex file writes
shared/file-lock.ts            the lock primitives with their once-only waiting callback and abort signal, the take-only-if-free form and the form that retries every 250 ms until a skip test holds
shared/liveness.ts             the liveness rule: pid, boot time and process start
shared/process-start.ts        a process's start time (ps on macOS, /proc on Linux), telling a failed tool from a process without one
shared/paths.ts                host agent dir, pinata's folder <agent dir>/pinata/ (config.json, state/, with PINATA_STATE_DIR made absolute and real), `launcher/` root, path containment and the outermost of a path list
shared/state-layout.ts         every path under the state dir, and the named and open paths the daily collection keeps
shared/repo-state.ts           per-repository record files: repo.json with its mount root and the workspace root the launch mounted, created folders, leftovers, forgetRepo
shared/regular-file.ts         safe reads of regular files
shared/placeholder.ts          the placeholder format and the JWT shape
shared/secret-name.ts          secret-looking names, auth-like headers, URL userinfo and credential-shaped values
shared/pi-env.ts               pi variable names pinata sets, refused in env.allow and env.set, and the hosts the guest reaches without the proxy
shared/pem.ts                  the PEM certificate blocks of a text
shared/mcp-auth-key.ts         host pi's mcp-auth.json parser, mcp-login.json under a file lock, and sign-in dirs
shared/tool-config.ts          the tool config format dispatcher and the JSON pointer reader
shared/npmrc.ts                the .npmrc parser and value reader
shared/ini.ts                  the ini parser and section.name[n] reader
shared/maven-xml.ts            the XML tokenizer, the Maven settings model, the server secret reader and the XML writer
shared/settle.ts               settleAll
shared/terminal-text.ts        control, bidi and line separator characters shown as \uXXXX escapes, and the last non-empty line of command output
shared/write-back-table.ts     the built-in write-back table as value specs (`pi-prune.json` `days` an enum of the picker intervals), the host-only settings keys and the ceiling no config passes
```

## tests/

```
tests/support/expect-no-leak.ts      asserts no secret reaches a spec, exec, env, stdin or render file
tests/support/fake-backend.ts        the fake backend
tests/support/fake-engine.ts         an in-memory engine HTTP server
tests/support/fake-runner.ts         the scripted CommandRunner
tests/support/fake-clock.ts          a controllable clock
tests/support/sandbox-config.ts      config builders
tests/support/temp-dir.ts            temp dir helpers and exists
tests/support/git.ts                 git for tests, isolated from the developer's git config
tests/support/fakes.test.ts          the fakes' own contract
tests/shared/atomic-write.test.ts    atomic writes
tests/shared/command-runner.test.ts  the real runner
tests/shared/errors.test.ts          error messages
tests/shared/file-lock.test.ts       locks, takeover, liveness, the take-only-if-free form and the wait-unless form
tests/shared/liveness.test.ts        the liveness rule
tests/shared/hash.test.ts            hashes
tests/shared/json-file.test.ts       JSON files
tests/shared/paths.test.ts           paths and the spelling of PINATA_STATE_DIR
tests/shared/placeholder.test.ts     placeholders
tests/shared/pi-env.test.ts          the variables pinata sets
tests/shared/mcp-auth-key.test.ts    mcp-login.json updates and sign-in dirs
tests/shared/state-layout.test.ts    the state layout
tests/shared/tool-config.test.ts     tool config parsers
tests/config/fixtures.ts             config files in temp dirs
tests/config/load.test.ts            loading the config file and examples/config.json
tests/config/merge.test.ts           the config over the defaults, key by key, with sources
tests/config/dotted.test.ts          dotted key read, set and remove
tests/config/security-keys.test.ts   credential and image keys
tests/config/egress-entry.test.ts    the egress grammar
tests/config/parent-proxy.test.ts    the parent proxy parser
tests/config/mounts.test.ts          mounts.volumes, mounts.binds and setup keys, with the target refusals
tests/config/services.test.ts        the services key: names, users, paths, volumes shared between services, ready, memory against the VM, and types, defaults, validator and schema agreeing
tests/config/sessions.test.ts        sessions.host
tests/config/terminal.test.ts        terminal.clipboard
tests/config/schema.test.ts          schema and key spec agree, bounds included
tests/config/validate.test.ts        validation messages
tests/config/write-back.test.ts      writeBack: defaults, exclude, add, override, enabled, the ceiling and the value specs
tests/config/vm.test.ts              vm bounds and resources within vm
tests/workspace/discover.test.ts     discovery: the git root, the git dir and common dir from the files, the overlay search
tests/workspace/guard.test.ts        the workspace guard
tests/workspace/mounts.test.ts       the protected path table
tests/workspace/paths.test.ts        path ordering
tests/workspace/roots.test.ts        workspaceRoot: the unset and launch refusals, the checked root, the home, protected and system dirs, links
tests/workspace/sandbox-reach.test.ts  the roots a sandbox can write: the workspace root and the recorded folders
tests/workspace/binds.test.ts        mounts.binds sources: resolution, the folder to share, the refusals
tests/workspace/pi-session-dir.test.ts  slug and host session dir choice
tests/workspace/created-dirs.test.ts  created folder removal
tests/backend/conformance.ts         the backend conformance suite
tests/backend/colima.conformance.test.ts  the suite on the in-memory engine
tests/backend/fake-backend.conformance.test.ts  the suite on the fake backend
tests/backend/colima.test.ts         Colima adapter specifics
tests/backend/container-body.test.ts  the agent's create body byte for byte, and a joiner's body
tests/backend/labels.test.ts         container roles, containers without a role and the role predicates
tests/backend/relay-script.test.ts   the relay script: drops a client outside the subnet before any upstream connection opens, serves a client inside it, preamble first
tests/backend/colima-vm.test.ts      VM start
tests/backend/colima-shares.test.ts  VM shares, the workspaceRoot reconcile (foreign sessions, one-boot start, nested shares, unreadable lima.yaml)
tests/backend/colima-size.test.ts    VM size and the restart to the vm config size
tests/backend/colima-apply.test.ts   VM inspect, apply (create, defer, restart), the launch reconcile of shares and size together, and the cold start at the vm config size
tests/backend/colima-file-cache.test.ts  the file cache watch: limit, VM process lookup by either disk name, among several holders and every 5 minutes, a failed lookup kept apart from none found, the read-only reading, timed-out count, release command, rate limit, busy VM lock, stop waiting for a release
tests/backend/colima-trust.test.ts   the tls.extraCa certificates in the VM trust store
tests/backend/vm-decision.test.ts    each outcome of vmDecision and whenBusy
tests/container/spec.test.ts         the container spec
tests/container/services.test.ts     the services: one pod for the install and the service specs, hand-over, pull, reuse, crashed and changed services, readiness failures with the log tail, cancel, the stop of all services at once and serviceVolumes
tests/container/lifecycle.test.ts    one container per launch, its removal and housekeeping
tests/container/run-pi.test.ts       running pi, signals and the terminal bridges
tests/container/clipboard.test.ts    the copy tee with its held notices, the pasted image path, Ctrl+V and the failed-import notices
tests/image/build.test.ts            base builds
tests/image/build-network.test.ts    build proxy arguments
tests/image/layer.test.ts            the image layer: always built, its context and tag, the trust steps, the build proxy
tests/image/sandbox-image.test.ts    image selection and removal
tests/image/prune.test.ts            image collection: age check, in-use images, the current layer, build-lock skip
tests/image/entrypoint.test.ts       the entrypoint, run for real, JDK trust left to the image
tests/image/bash-env.test.ts         the missing-command and no-root hints, run for real
tests/image/trust-jdk.test.ts        trust-jdk.sh, run for real
tests/image/forwarder.test.ts        the services forwarder, run for real: both loopbacks, one upstream per connection, a port it cannot listen on
tests/hostpi/fixtures.ts             host pi file fixtures
tests/hostpi/derive.test.ts          derivation and placeholders
tests/hostpi/tools.test.ts           the tool derivers
tests/hostpi/files.test.ts           host pi file reading
tests/hostpi/mcp-auth.test.ts        MCP sign-in state
tests/hostpi/provider-hosts.test.ts  the provider host table
tests/hostpi/provider-hosts-sample.json  a sample provider host table
tests/provision/fixtures.ts          provisioning fixtures
tests/provision/volume.test.ts       agent volume file reads through exec
tests/provision/render.test.ts       the render dir
tests/provision/merge-settings.test.ts  the settings sync
tests/provision/write-back.test.ts   the write-back allowlist, value spec checks, the ceiling, baseline hash, merge and lines
tests/provision/sync.test.ts         write-back and sync against a fake volume, with a configured allowlist
tests/provision/package-refresh.test.ts  packages pinned to the host versions and the refresh of outdated checkouts
tests/provision/package-install.test.ts  the `pi list` parser, what counts as missing, the install, its notices and timeouts
tests/provision/host-sessions.test.ts  host session sweep and probe
tests/grants/store.test.ts           grants
tests/grants/launches.test.ts        the launch registry
tests/proxy/harness.ts               proxy test harness
tests/proxy/proxy-client.ts          CONNECT and TLS client helpers
tests/proxy/policy.test.ts           CONNECT decisions, SNI and private ranges
tests/proxy/server.test.ts           the proxy server and its preamble
tests/proxy/preamble.test.ts         the preamble gate: split lines, the limit, the timeout, a wrong token
tests/proxy/runtime.test.ts          live egress settings
tests/proxy/terminate.test.ts        credential injection and the upstream handshake timeout
tests/proxy/rules.test.ts            rule matching and scrub
tests/proxy/secrets.test.ts          secret sources
tests/proxy/mcp-oauth.test.ts        MCP OAuth and sign-in
tests/proxy/sign-in.test.ts          the proxy's sign-in: records and shutdown races
tests/proxy/start.test.ts            the install's proxy: start, reuse, stop and idle exit
tests/proxy/parent.test.ts           the parent proxy
tests/proxy/denial-page.test.ts      the denial page
tests/proxy/tls-ca.test.ts           the CA and leaves
tests/proxy/intercept.test.ts        TLS termination: a client that closes during the handshake or before its hello, and one that is served
tests/proxy/trust.test.ts            the sandbox CAs and the removal of old bundles
tests/proxy/sni.test.ts              ClientHello parsing
tests/proxy/hello.test.ts            ClientHello reading and dial timeout
tests/proxy/dial.test.ts             the dialer's restricted-address rules and stalled lookups
tests/proxy/keep-alive.test.ts       upstream connection reuse
tests/proxy/request-target.test.ts   request target checks
tests/proxy/child-env.test.ts        the minimal environment
tests/cli/harness.ts                 the CLI test harness, the managed pi layout (also for the live harness) and the doctor report parser
tests/cli/commands.test.ts           the pinata sandbox commands
tests/cli/launch-packages.test.ts    the extension install before pi starts: inside the agent lock after the sync, the notices, offline, and the git refresh deferred while another project's launch runs
tests/cli/launch-services.test.ts    a launch with services: the order pod, services, agent, the install's network, the forwarder's ports, the status file and pinata status
tests/cli/services-stop.test.ts      the services stopped by the sweep and pinata stop, and left alone while a session runs
tests/cli/installs.test.ts           two installs on one engine: each brings up, tears down and sweeps only its own objects, and the VM stop counts both
tests/cli/ground-lock.test.ts        the ground lock: its waiting line, the services under it, the idle teardown of services, relay, network and proxy, and the wait for the lock at the end of a session and in stop
tests/cli/doctor.test.ts             the doctor, its file cache check among them, also when the sandbox does not start and with the release off, and its default view end to end
tests/cli/doctor-probes.test.ts      the doctor's mcp-auth sweep on a sandbox file it cannot read, the connected-server count on pi mcp list's format, and the credential sweep's proxy token finding and its skipped `env.set` values
tests/cli/doctor-report.test.ts      the doctor report renderer: the default view's merged groups and hidden checks, a group with a failing member, collapsing, --verbose, the result line's names, the name column, partial reports, ~, colour (the whole-report goldens are in doctor.test.ts)
tests/cli/doctor-tls.test.ts         the tls inspection check against a local TLS server signed by a test CA behind a parent proxy: not inspected, trusted via extras, root in a keychain, root not found, network failure
tests/cli/egress.test.ts             egress grants
tests/cli/errors.test.ts             error output
tests/cli/host-pi.test.ts            host pi selection
tests/cli/setup-fixtures.ts          host facts, folder candidates, the automatic size, a running VM and config documents for the setup tests
tests/cli/setup-detect.test.ts       detectHost: the budget, an inspect failure, free disk and sessions
tests/cli/setup-screens.test.ts      the setup screen texts
tests/cli/setup-flow.test.ts         pinata init's flow end to end over fake terminals, rich, ASCII and plain
tests/cli/setup-apply.test.ts        applyPlan: stopping waiting for the VM step, and the lines --yes prints to stdout and stderr, the review first
tests/cli/setup-document.test.ts     the config document: read, owned-key edits, the diff
tests/cli/setup-folders.test.ts      the project folder candidates and the repository scan
tests/cli/setup-plan.test.ts         the first-run steps, owned-key problems, initial answers and the plan
tests/cli/vm-size.test.ts            the automatic VM size
tests/cli/prompt/fake-tty.ts         a fake terminal with key and paste helpers for the prompt tests
tests/cli/prompt/screen.ts           an emulated screen that applies the prompt output's escape sequences
tests/cli/prompt/terminal.test.ts    finding the terminal, modes, glyphs and colour, notes
tests/cli/prompt/keys.test.ts        key decoding
tests/cli/prompt/type-ahead.test.ts  keys typed ahead in one chunk
tests/cli/prompt/style.test.ts       text width, truncation, control characters and ASCII
tests/cli/prompt/line-editor.test.ts  the line editor
tests/cli/prompt/rules.test.ts       the shared input rules
tests/cli/prompt/task.test.ts        the task runner
tests/cli/prompt/complete.test.ts    path completion
tests/cli/prompt/select.test.ts      select
tests/cli/prompt/confirm.test.ts     confirm
tests/cli/prompt/number.test.ts      number
tests/cli/prompt/text.test.ts        the path prompt
tests/cli/prompt/plain.test.ts       the plain prompt set
tests/cli/init.test.ts               pinata init: the no-terminal and CI refusals, /dev/tty, --yes with PINATA_ROOT and without a root, signals and exit codes
tests/cli/uninstall.test.ts          releaseSandbox
tests/cli/list.test.ts               pinata list
tests/cli/pinata/support.ts          a pinata run over the CLI harness: npm prefix, package folder, host pi install and remove writing settings.json
tests/cli/pinata/install.test.ts     pinata install
tests/cli/pinata/update.test.ts      pinata update
tests/cli/pinata/uninstall.test.ts   pinata uninstall
tests/cli/intercept.test.ts          intercepted commands, host routes and the command lines that still launch
tests/cli/launch.test.ts             the launch
tests/cli/launch-flow.test.ts        the signal guard, side-by-side stages and the VM shares of a launch
tests/cli/launch-clipboard.test.ts   the osascript clipboard read (PNG or one file path) behind Ctrl+V and its gate
tests/cli/launch-host-sessions.test.ts  host sessions at launch
tests/cli/launch-sessions.test.ts    session end and the sweep
tests/cli/launch-write-back.test.ts  settings written back to the host at launch and at exit, with the allowlist the launch started with
tests/cli/sweep.test.ts              the sweep of unused repositories and of the state dir
tests/cli/sweep-state.test.ts        the daily removal of state entries the layout does not name
tests/cli/launch-wiring.test.ts      launch wiring, no leaks, and the file cache watch around pi
tests/cli/launch-workspace.test.ts   the workspace root bound read-write, the git dir outside it refused, a plain folder without overlays, the overlay notices
tests/cli/launch-mounts.test.ts      binds at launch (VM needs and shares, the read-only mount, refusals before the engine) and setup (order, env, failure, doctor skip)
tests/cli/prepare.test.ts            the preparation lock (waiting line, dead holder, abort) and runSetup
tests/cli/mcp-sign-in.test.ts        the launch-start MCP sign-in
tests/cli/sandbox-proxy.test.ts      the proxy input
tests/cli/terminal.test.ts           the host terminal
tests/cli/notices.test.ts            notices printed once per install
tests/cli/volumes.test.ts            volumes in the sweep and status
tests/cli/restart.test.ts            pinata restart: the session refusals, the stopped VM, the y/N and its refusal without a terminal, every volume kind, images and records removed, another install's volumes kept, the old flags and name
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
tests/live/harness/sandbox.ts        a live sandbox whose cleanup removes the install's objects by label and checks the result, and a held pi -p session whose container probes run in
tests/live/harness/scenario.ts       live scenarios
tests/live/harness/sweep.ts          live leftovers sweep
tests/live/fixtures/https-fixture.ts  an HTTPS server
tests/live/fixtures/inspecting-proxy.ts  a TLS-inspecting parent proxy
tests/live/fixtures/llm-fixture.ts   a model server
tests/live/fixtures/mcp-fixture.ts   an MCP server
tests/live/fixtures/provider.json    a custom provider
tests/live/fixtures/test-ca.ts       a test CA
```
