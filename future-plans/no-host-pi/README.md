# No pi on the host

> Status: open, to be decided. Date: 2026-11-11. Branch the inventory was taken on: `chore/update-pi-1.5.2`, including its `launcher/cli/host-routes.ts` host routing. A plan to decide from: it records what the two pi instances do today, lays out how each host-pi job could be done without a host pi, and recommends an order. Nothing here is decided. Findings come from reading code and pi 1.5.2's own docs and `dist/`; nobody ran pi to confirm them.

## 1. The problem

The launcher (`launcher/`) runs pi in a container, yet a second pi on the host does a set of jobs for it: it prints credentials for the proxy, signs in to MCP servers, runs the config commands the developer types, supplies the provider host table and decides the image's pi version. The two have to be kept in step. The owner's experience: a pi release means updating the host pi so the image follows, a package is installed twice (once on the host, once in each folder's agent volume), and settings changed inside the sandbox do not survive.

Who has two pis:

- **A normal install** (`npm install -g pi-extensions-mz`, then `install.sh`). The package declares pi only as a `peerDependencies: "*"` (root `package.json`; no `dependencies`), and `install.sh` installs with `--legacy-peer-deps=false` (`launcher/install.sh:320`) so npm brings the peer, then fails if none arrived (`require_host_pi`, line 287). The user installs no pi by hand, but a pi is on disk next to the launcher and runs every host job. A user who already had pi's managed install keeps using it: `resolveJobPi` prefers it (`launcher/cli/host-pi.ts:31-32`), and `install.sh` takes over its `~/.local/bin/pi` link. So these users have a host pi they manage and an image pi that follows it.
- **The dev setup in this repository** (`launcher/bin/pi-sandbox-dev.js`, pi in the repo's own `node_modules`). `bundledOutside` (`host-pi.ts:10-18`) uses the bundled pi only when its package dir lies outside the repository and its git common dir, since otherwise sandbox-writable code would run on the host. Here it lies inside, so only a managed install can serve host jobs. Without one, credentials, MCP sign-in, the provider table and every intercepted command fail. That is where "two instances I have to keep in step" comes from.

"No pi on the host" can mean two things, and they cost very different amounts:

- **A. The launcher always brings its own pinned pi; managed installs are ignored.** One pi on disk, not one the user manages. Medium cost, little threat-model change.
- **B. Genuinely no pi on the host.** Every job moves into a container or into the launcher. Large cost, changes the threat model.

Section 6 proposes a third cut (C) that reaches B in shippable steps and keeps the host agent dir as the store of record.

## 2. Inventory of host-pi jobs

The backbone of the plan. "Needs" is what the job needs from the host that a container does not have.

| # | job | code | needs from the host | without a host pi today |
| --- | --- | --- | --- | --- |
| 1 | Credentials for the proxy: `pi auth print-api-key` / `print-bearer-token --min-expiry 5m`, cached 240 s, `PI_CODING_AGENT_DIR` = host agent dir | `launcher/proxy/secrets/pi-auth.ts:6-35`; command from `cli/sandbox-proxy.ts:42` into `proxy/daemon.ts:102`; `{piAuth}` refs from `hostpi/derive-auth.ts:82,111` and `derive-models.ts:127` | the credential store (`auth.json`, `models.json`), OAuth refresh with a write back to `auth.json`, `!command` keys run with host tools (pi's own example is the macOS keychain CLI, `providers.md:73-79`), network to token endpoints | every provider request goes out without a key (`unavailable`, `pi-auth.ts:22-24`) |
| 2 | MCP sign-in: `pi mcp login <server> --timeout 300` from an empty dir, at launch and from the proxy when a token expires | `proxy/sign-in.ts:114-129`, `cli/mcp-sign-in.ts`, argv in `shared/mcp-auth-key.ts:69-76` | host browser, a loopback callback on the Mac, write to `mcp-auth.json` | servers needing OAuth get no token |
| 3 | Intercepted config commands: `install\|uninstall\|remove <source>` (empty dir), `mcp add\|remove` (in the cwd), `mcp login\|logout` (empty dir) | `cli/intercept.ts:196-233` | host `settings.json`, `mcp.json`, the host package install under `~/.pi/agent/npm` and `git/` | fail with "no pi on the host" |
| 4 | Self update: bare `pi update` runs the managed install's update, else prints that pi follows the launcher | `intercept.ts:245-269` | the managed install | prints the message |
| 5 | Provider host table: `hostpi/provider-hosts.mjs` loads the host pi's `pi-ai` package in a Node process, cached per pi version under `<state>/provider-hosts/<version>.json` | `cli/launch.ts:111-113` → `cli/derive.ts:29-38` → `hostpi/provider-hosts.ts:87-94` | nothing but the package files | `MISSING_PI` notice; built-in providers get no credential rules |
| 6 | Image pi version: host pi version becomes the `PI_VERSION` build arg | `launch.ts:147`, `imagePiVersion` in `cli/versions.ts:37` | nothing | falls back to `testedPiVersion()`, the devDependency floor |
| 7 | `--no-sandbox`: run pi unsandboxed, refused under `fallback: refuse` (default `host`, `config/defaults.ts:15`) | `cli/host-pi.ts:42-68` | everything; it is host pi | "no pi on the host" |
| 8 | Provider login | branch: `auth …` routes to host pi (`cli/host-routes.ts:47`), README tells users `pi auth login <provider>` or `pi --no-sandbox` then `/login` (`launcher/README.md:127,194`) | host browser, a fixed loopback callback, write to `auth.json` | no login path |
| 9 | Doctor: pi version and place, warns when older than the tested version, reads the provider table | `cli/commands/doctor-host.ts:35-55,183-195` | nothing | `fail` line |
| 10 | Proxy restart when the pi command or version changes (pi command is part of the proxy input hash) | `launcher/ARCHITECTURE.md`, Network | nothing | n/a |

Commands this branch moves to the host (`cli/host-routes.ts`, `intercept.ts:271-291`), each of which the plan has to place:

| command | today on the branch | needs |
| --- | --- | --- |
| `--version`, `-v` | no pi spawned; prints `imagePiVersion`; with a pinned image, pi inside answers | nothing |
| `--help`, `-h`, `--list-models [search]` | host pi in an empty dir with `--no-extensions --no-skills --no-prompt-templates --no-themes --offline` (`host-routes.ts:7,37-38`) | `--list-models` needs the user's `models.json` and which providers have credentials |
| `<install\|remove\|uninstall\|update\|list\|config> --help`, bare `mcp`, `mcp help`, `mcp … --help` | host pi in an empty dir, without the no-resource flags | nothing |
| every `auth …` | host pi, empty dir, host agent dir, exit code passed through | as jobs 1 and 8 |
| `--export <file> [out]` | host pi in the real cwd | the session file and an output dir |
| `pi list` | stays in the sandbox: a trusted project's `npmCommand` would run on the host | n/a |

Not host pi: the gh, glab, npm, pip, Maven and git derivers and the keychain calls run host commands but never pi.

## 3. How the two are kept in step

Host job pi version → `PI_VERSION` build arg → `launcher/image/Dockerfile:41-44` installs that pi from npm → the image inputs hash includes it, so a host pi update rebuilds the image at the next launch. The proxy restarts at the next launch that is alone in the repository; the provider table is re-read per version. A running container keeps its old image. If npm lacks that version the build fails (README troubleshooting). "Tested" is the devDependency floor (`versions.ts:25-35`); the doctor warns only when host pi is older, a newer one is followed silently. The manual step after a pi release is `pi update` (managed) or reinstalling the launcher (bundled). Nothing happens automatically.

## 4. What is already split between the two

- **Host packages are not copied into the sandbox.** The render dir copies only `agents`, `prompts`, `skills`, `themes`, `extensions`, `AGENTS.md`, `SYSTEM.md`, `keybindings.json` (`provision/render.ts:19-28`). The filtered host `settings.json` replaces the volume copy each launch (`provision/sync.ts`, `merge-settings.ts`), and the sandbox pi reinstalls whatever `packages` lists into `npm/` or `git/` of the folder's agent volume (`container/volumes.ts:71-76`, one volume per host user and repository root). The host install made by `pi install` is used only by host pi itself.
- **`pi update --extensions|--models|--all|<source>` runs inside the sandbox** (pinned by `launcher/tests/cli/intercept.test.ts:338`): it updates one folder's volume copies and its `models-store.json`. The current docs no longer describe it. `update --all`'s self-update part hits the image's stub (`PI_SELF_UPDATE_COMMAND`, `Dockerfile:54,69`); nobody checked that it ends cleanly.
- History moved towards host pi, not away: `d5b6e95` ran install/remove inside with a write-back to host settings; `7259303` routed bare `update` to the host and preferred the managed install ("The launcher no longer needs a second pi next to it"); `8562639` removed the write-back and moved install/remove to the host; `d9ce389` dropped the `update --extensions` mention. No earlier "no host pi" discussion exists in `future-plans/`, `researches/` or the launcher docs.

**Security argument for the plan.** Host commands that build a pi runtime load the user's global extensions and packages on the host. The owner's own `~/.pi/agent/settings.json` lists this repository as a local-path package (`"../../../../Volumes/Projects/pi-extensions"`), which a sandbox working in this repository can rewrite; `pi install` refuses such paths only at install time (THREAT-MODEL section 4, `pi auth, help…` row, says so). On the branch, top-level `--help` and `--list-models` now pass `--no-extensions`; subcommand help and `auth login` do not, and `--no-sandbox` loads them by design. The hot path is not exposed: in pi 1.5.2 `runAuthCommand` (`dist/main.js:135-176`) handles `print-*` with a bare `ModelRuntime` before any extension loads. Every host-pi job is a place where this class of problem can come back; fewer host-pi jobs is a smaller surface.

## 5. Extension settings and state

The owner's requirement: extension settings changed inside the sandbox must be preserved. Today they are preserved only per folder, and one of them not at all.

Mounts: the repository and git dirs are read-write host binds; the host session dir `~/.pi/agent/sessions/<slug>/` is a read-write bind (`sessions.host` defaults on, `config/defaults.ts:30`); the container agent dir `/home/pi/.pi/agent` is a named volume per folder; `/tmp` and `/home/pi` are tmpfs. The entrypoint (`image/entrypoint.sh:17-26`) links every render entry into the volume's agent dir, so `auth.json`, `models.json`, `mcp.json`, `agents`, `prompts`, `skills`, `themes`, `extensions`, `AGENTS.md`, `SYSTEM.md` and `keybindings.json` are read-only links inside. `hostpi/files.ts:13-18` reads only `auth.json`, `models.json`, `mcp.json` and `settings.json` from the host: no `pi-*.json` extension settings file reaches the sandbox.

| what | written to | where it lands with the sandbox |
| --- | --- | --- |
| style (`/style`) | `<agentDir>/pi-style.json` (`extensions/style/core/settings.ts:12,24-33`) | folder volume only; the host value is not carried in, the sandbox value never leaves the folder, `pi sandbox reset` removes it |
| subagents, `/agents setup` user scope | `<agentDir>/pi-subagents.json` (`core/agent-setup/write.ts:44`) | same, per folder |
| subagents, project scope | `<cwd>/.pi/pi-subagents.json` | host, through the repository bind |
| session-limits, notifications | read only: `pi-session-limits.json`, `pi-notifications.json` | the host files are invisible inside; only defaults or a project `.pi/` file apply |
| model-default | `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels` in `<agentDir>/settings.json` (`platform/pi-adapter/runtime/default-model.ts:33-61`) | written to the volume, then erased at the next launch by the settings sync; a second launch in the same folder rewrites the file under the first. The extension's purpose does nothing across launches. |
| mcp-import, user scope | `<agentDir>/mcp.json` (`extensions/mcp-import/core/import-flow.ts:54,79`) | a read-only link, so the write should fail (inferred); its reads of the user's home config find nothing (tmpfs home) |
| mcp-import, project scope | `<cwd>/.pi/mcp.json` | host |
| `/agents create`, user agent file | `<agentDir>/agents/` | a read-only link, so the write should fail (inferred) |
| session JSONL custom entries (session-limits, spending, context, transcript, adapter), subagent run folders | under the session | host with `sessions.host` on, else volume |
| handoff documents | OS temp | lost with the container (THREAT-MODEL section 5) |
| worktrees, `<cwd>/.pi/.gitignore` | `<cwd>/.pi/` | host |

Nothing is written back from the volume (`launcher/ARCHITECTURE.md`, Provisioning: "Nothing from the volume is written back to the host"; THREAT-MODEL section 4, `pi install|remove` row). `3ee46d2` once wrote back only the package source the user typed (`hostpi/write-back.ts`), and before `8562639` `mergeTopLevel` did a three-way merge of host, volume and last-synced base, under which model-default's picks survived. `8562639` removed both on purpose ("host keys win at launch, mcp.json is rendered read-only").

What the threat model allows today:

- Host to sandbox, an allow-listed copy of the `pi-*.json` files at each launch: crosses no boundary.
- A keyed merge that keeps model-default's four keys from the volume: inside the boundary, but reverses `8562639`.
- Sandbox to host, a copy of the `pi-*.json` files: needs the "nothing from the volume reaches host config" sentences and Files written changed. Can be bounded (fixed file names, size cap, `lstat` regular file, JSON parse on the host, atomic write under the launch lock). The launcher cannot validate against the extensions' schemas without duplicating them, since it imports nothing from `platform/` or `extensions/`. One real caveat: `pi-subagents.json` `agents.*.model` and `skills` steer what a later host pi run uses.
- Not consistent with it: mounting the host agent dir or its files read-write into the agent container; writing back `settings.json` whole (`packages`, `extensions`, `shellPath`, `shellCommandPrefix`, `npmCommand` lead to host code execution), `mcp.json` or `auth.json` (`!command` values run on the host). A per-key allow-list on `settings.json` is undecided.

Why this matters here: the write-back restrictions exist because a host pi later reads those files and runs code from them. With no pi on the host, the host agent dir stops being an execution surface for pi and becomes a store, except for what the launcher itself still executes from it (`!command` values, section 6.1). That changes what is safe to write back; it also means user settings need a home every folder's sandbox shares, and a home shared across folders is a channel between folders (section 6.4).

Not determined: whether pi inside treats the project as trusted (decides whether a project `.pi/pi-*.json` is read there); whether pi's own `/settings` writes into `settings.json` need the same handling (they are erased by the same sync); the two read-only-link failures above.

## 6. Building blocks

Every job in section 2 is solved by some mix of these five. Section 7 applies them.

### 6.1 The launcher resolves plain keys itself

`piAuth` is used for three kinds of value: an `auth.json` `api_key`, an `auth.json` OAuth entry (refresh), and a `models.json` `apiKey`. Pi's key syntax is a literal, `$NAME` interpolation, or `!command` output (`docs/models-configuration.md:17`). The launcher already has `file` (JSON pointer), `env` and `command` secret sources, and `hostpi/headers.ts:134-135` already maps a `!` header value to `{ command: ["sh", "-c", …] }`. So literals, `$NAME` and `!command` keys can leave pi entirely: the derivation picks the matching source instead of `piAuth`. Only OAuth entries still need pi. Cost: small. The hard part is parity with pi's semantics (shell, cwd, caching, how `$NAME` composes); the launcher command source caches 300 s against pi's 240 s. `!command` keeps running on the host, as today, and has to: a keychain or password-manager CLI does not exist in a Linux container.

Re-implementing OAuth refresh in the launcher is not an option: refresh endpoints and client ids are per provider, which breaks the no-provider-knowledge rule as well as the no-pi-imports layering, and it races with any other writer of `auth.json` (pi locks it with `proper-lockfile`, `dist/core/auth-storage.js:7,50,93`).

### 6.2 Helper containers

A helper is a short-lived container from the sandbox image, created by the launcher on the host through the existing `Backend`, never with the folder, the agent volume or any agent-writable mount. Three kinds, by mount set:

- **Tool container:** nothing mounted, no network, an empty tmpfs agent dir. For help, `--version` with a pinned image, the provider table.
- **Credential container:** the host agent dir's `auth.json` and `mcp-auth.json` bound read-write as single files, `models.json` and `mcp.json` read-only, nothing else of `~/.pi`. `PI_CODING_AGENT_DIR` points at a tmpfs dir that holds those binds, so `auth.json.lock` lives in the container. Network: the default bridge with the parent proxy and `tls.extraCa`, as the image build already gets them, since host pi today has unrestricted egress for refresh too. For OAuth `print-bearer-token`, `pi auth …` and `pi mcp login|logout`.
- **Config container:** binds `settings.json` and `mcp.json` read-write, and a local package source read-only when one is named. For `install|remove`, `mcp add|remove`.

Why single-file binds are acceptable here when the launcher rejects them elsewhere: the rejection is about the agent writing a host file through a letter-case variant in a writable parent; no agent process exists in a helper. Pi writes `auth.json` in place with `writeFileSync` (`auth-storage.js:42,72,148`), so the bind keeps working; a host editor that replaces the file by rename would detach a bind, which matters only for a long-lived helper. The home is already shared with the VM (README: the VM sees the whole home), so no new VM share is needed. Missing bind sources fail the create, so the launcher creates `mcp-auth.json` as `{}` (mode 600) first; that is a new entry in Files written.

How the proxy reaches the engine: `proxy/` imports only `config`, `grants`, `shared`. Two ways:

- Point `piCommand` at a hidden launcher entry (`pi-sandbox __helper auth print-bearer-token …`) that runs the credential container. The proxy keeps running a host command through `CommandRunner`, as now; no folder-graph change. Costs a Node start per fetch.
- Add `backend` to `proxy`'s imports. Faster, but the process that faces container traffic gains the power to create containers, and `test/architecture.test.ts` changes. I would take the first.

Cost: a container start plus a pi start per fetch, not measured; with the 240 s cache that is one fetch per OAuth provider every four minutes, on the first request after expiry. The VM is up whenever a sandbox runs, so the proxy always has an engine. A help or `--version` call from a stopped VM pays the VM start (tens of seconds) that host pi never paid.

### 6.3 Login callbacks

Pi's OAuth sign-ins listen on a loopback port (MCP: `http://127.0.0.1:<port>/callback`, a free port unless `callbackPort` is set, `docs/mcp.md:146`; provider logins use fixed ports per provider). Inside a helper that loopback is the container's. Options, cheapest first:

- **Paste-back.** Pi documents it for both: "a terminal also accepts the pasted redirect URL" for `pi mcp login` (`docs/cli.md:351`), and "paste the final redirect URL or authorization code back into Pi" for provider logins on a headless machine (`docs/providers.md:14`); `pi auth login --no-browser` uses the provider's device-code method where there is one (`cli.md:312`). Works with a TTY into the helper, no network change. The user copies a URL from a failed `127.0.0.1` page. The launcher can open the authorization URL on the Mac itself if pi prints it (not verified that it does when the open fails).
- **Forward the callback.** The launcher listens on the Mac's loopback port and forwards into the helper, or the helper runs with the VM's host network and Colima's port forwarding carries the VM loopback to the Mac. Neither is validated: whether pi binds `127.0.0.1` or `localhost`, whether Colima forwards a VM loopback listener, and the port must be known before pi starts (fixed for providers, random for MCP unless configured).
- **Proxy-started MCP sign-in.** Today the proxy starts a detached `pi mcp login` with no terminal and relies on host pi opening the browser and catching the callback. With paste-back only, the proxy cannot do that; it would answer the existing local `503` with "run `pi mcp login <name>`". With a forwarded callback it could keep auto-opening, the launcher opening the URL the helper printed.

### 6.4 The store of record

Where the user's pi config lives once no host pi edits it. Three options:

| option | store | shared across folders | what a hostile agent in folder A can do to folder B | `--no-sandbox` |
| --- | --- | --- | --- | --- |
| S1. Host agent dir stays the record; nothing written back (today) | `~/.pi/agent` | whatever the user and launcher commands write | nothing | unaffected |
| S2. A per-user settings volume mounted read-write into every sandbox | VM volume | everything | rewrite `settings.json` `packages` and `extensions`: code that B's sandbox then runs; the same write channel `mounts.sharedCaches` is off by default for | host pi cannot see it |
| S3. Host agent dir stays the record for code-bearing config; a bounded write-back of data-only preferences | `~/.pi/agent` | the `pi-*.json` files and an allow-list of `settings.json` keys (model-default's four, maybe pi's `/settings` data keys) | steer B's model choice, thinking level, enabled models, subagent models and preloaded skills, style. Data only: no package, extension, shell or command key. Cost and quality effects, no code. | a host pi would read the written-back `pi-subagents.json` models and skills: the caveat in section 5 |

S2 is out: it turns one folder's compromise into code in every folder's sandbox. S3 meets the owner's requirement across folders. Its write-back runs at session end (or each launch) under the launch lock, with the bounds of section 5; conflicts between two folders' sessions are last-writer-wins per file or per key. A per-folder variant of S3 (merge only within the folder's volume, the pre-`8562639` behaviour) preserves settings per folder without a cross-folder channel; it is the cheaper first step and does not need a host-pi decision.

What stays host-only and is never written back in any option: `auth.json`, `mcp-auth.json`, `models.json`, `mcp.json` (their `!command` values run on the host through the launcher's command source), `settings.json` code keys, and the `agents`, `prompts`, `skills`, `themes`, `extensions` dirs. mcp-import's user scope and `/agents create`'s user file then need a host route (`pi mcp add` through the config container; the user's own write tool on the host) or are documented as project-scope only inside.

### 6.5 Packages and catalogues across folders

Once the sandbox is the only pi, the host package install has no reader. Each folder's volume installs and updates its own copy, and `pi update --extensions` reaches one folder. Options:

- **Per folder (today).** No cross-folder channel. Cost: an install per folder, updates per folder. A `pi sandbox update-packages` that updates every known folder's volume, one helper per volume, would remove the per-folder chore.
- **A shared package volume per user, read-only in sandboxes,** filled by a package container from the host `settings.json` `packages`. One install, no write channel. Not validated: pi installs missing packages at start and expects to write `npm/` and `git/`; whether it tolerates a read-only copy is unknown.
- **A shared writable volume.** A write channel between folders, rejected for the reason `mounts.sharedCaches` is off by default.

`models-store.json` is a catalogue cache from `pi.dev`; per folder is fine.

## 7. Job by job

| # | job | replacement | cost | threat-model effect |
| --- | --- | --- | --- | --- |
| 5 | provider host table | run `provider-hosts.mjs` in a tool container (script on stdin, package path inside the image), cached per image pi version; works for pinned images too. Baking it at build time is the alternative, but a pinned image would still need the run. | small | `pi-ai` code no longer runs on the host; the output still decides credential hosts, and comes from a container with no agent-writable input. The `hostpi/*.mjs` exception becomes an image-side asset. |
| 6 | image pi version | the launcher's own pin (the devDependency floor, already the fallback), with an optional `image.piVersion` (final under policy) for running a newer pi without a launcher release | small | none; the proxy input hash no longer depends on a host pi |
| 1 | credentials | 6.1 for literal, `$NAME` and `!command` keys; credential container (6.2) for OAuth | small for keys, medium for OAuth | "Host pi helper" boundary replaced by the credential container; `!command` still runs on the host, now through the launcher's command source |
| 2 | MCP sign-in | credential container with paste-back; proxy-started sign-in becomes a 503 instruction until a callback forward exists | medium; UX regression for proxy-started sign-ins | `mcp-auth.json` written by pi in the credential container instead of host pi; the "MCP sign-in on the host" row shrinks to nothing until a forward exists |
| 8 | provider login | `pi auth login` in the credential container with a TTY; paste-back or `--no-browser` | medium | real tokens pass through a helper container, never the agent's |
| 3 | `install\|remove` | config container, offline, writing `settings.json` only; or the launcher edits `packages` itself (it did before `8562639`), losing pi's validation. The host package install ends either way. | medium | the host npm install, with its lifecycle scripts, disappears; the in-repository refusal stays, since the sandbox of that repository loads the path anyway |
| 3 | `mcp add\|remove`, `mcp login\|logout` | config container (add, remove; pi's shell MCP commands load no extensions, `docs/mcp.md:92`); credential container (login, logout) | small once 6.2 exists | `mcp add` no longer runs in the real cwd on the host |
| 4 | `pi update` | always prints that pi follows the launcher, or with `image.piVersion` how to change it | trivial | none |
| 7 | `--no-sandbox` | section 8 | | |
| 9 | doctor | reports the launcher's pi pin and the image; names a managed install as present and ignored | small | none |
| 10 | proxy restart | follows the pin and the helper command only | trivial | none |
| branch | `--version` | prints the pin; pinned image unchanged | trivial | none |
| branch | `--help`, subcommand help, `mcp` help | tool container with the no-resource flags | small; slow from a stopped VM | user extensions never load on the host for help |
| branch | `--list-models` | a sandbox launch (shows what the sandbox pi sees, extension providers included, refuses in the home), or a tool container with the user-level derived placeholder files | small either way | none on the host |
| branch | `auth …` | credential container; `print-*` writes a real secret to the user's terminal, as the user asked | as job 1 | as job 1 |
| branch | `--export` | tool container with the session file copied in and the HTML copied out | small | the helper sees one file, not the cwd |

`pi list` stays in the sandbox.

## 8. `--no-sandbox` and `fallback`

Without a host pi there is nothing for `--no-sandbox` to run. Options:

- **Drop it.** `fallback` becomes meaningless; accept it with a warning for a release, then remove. The host-sessions "host parsing" row loses its main case (a sandboxed session resumed unsandboxed). Users who want unsandboxed pi run their own pi, which the launcher then neither finds nor knows.
- **Keep it only with a managed install.** "No pi on the host" becomes the default, not a requirement; `--no-sandbox` and nothing else uses the managed install. The security caveats stay for that one path, and S3's write-back caveat (section 6.4) applies.
- **A container with the folder and real credentials.** Not unsandboxed, and it breaks "no credential bytes inside". Rejected.

I would take the second for one release, then the first: it lets the owner keep an escape hatch while every other job moves.

## 9. Threat model, row by row

Rows of `launcher/THREAT-MODEL.md` that change under the recommended path:

| row | today | after |
| --- | --- | --- |
| §2 Host pi helper | managed or bundled pi on the host prints credentials, signs in, reads the provider table, runs the commands that start no session | replaced by **Helper containers**: image pi, launcher-created, never the folder or agent volume; the credential container binds four agent-dir files; the tool container nothing. Trusted as the image is: built by the launcher from npm, not writable by the agent. |
| §3 Workspace guard, "the host agent dir is never mounted" | holds for every container | holds for agent containers; helpers bind named files of it |
| §3 MCP OAuth tokens | host pi writes `mcp-auth.json`, the launcher reads it | pi in the credential container writes it; unchanged for the agent |
| §4 Host pi helper (`!command` on the host) | host pi runs them | the launcher's command source runs them; same exposure, same "only the developer's own host files" mitigation |
| §4 `pi install\|remove` on the host | host pi changes host settings and installs the package on the host | config container changes `settings.json`; no host package install |
| §4 `pi auth`, help, `--list-models`, `--export` on the host | host pi, user extensions load for some | helpers; nothing loads user extensions on the host |
| §4 MCP sign-in on the host | a sandbox request can open a host browser tab | with paste-back only, it cannot; the row returns if a callback forward is added |
| §4 Host sessions, host parsing | `--no-sandbox` resumes agent-written sessions unsandboxed | only while `--no-sandbox` remains |
| new: preference write-back (S3) | none | a sandbox can change data-only preferences of every folder; bounded by fixed names, size, regular-file and JSON checks, an allow-list of keys |
| new: callback forward (if taken) | none | a Mac loopback listener during a sign-in, reachable by any local process, as host pi's is today |

Unchanged: the container, the proxy (if it reaches helpers through a launcher command), the per-repository networks, the baseline "no credential bytes inside".

## 10. Migration

For a user with a managed install and a populated `~/.pi/agent`:

- **`auth.json`, `mcp-auth.json`, `models.json`, `mcp.json`:** stay where they are; the credential and config containers bind them. No move, so a user who still runs a host pi elsewhere shares the same store (pi's lock coordinates only within one machine view; a host pi and a helper writing `auth.json` at once is not covered).
- **Sessions:** stay; `sessions.host` keeps mounting them.
- **`settings.json`:** stays the record. `npm/` and `git/` package installs become unused; the doctor can name them and their size, the user deletes them.
- **`pi-*.json` extension settings:** with S3 they start being read into sandboxes. A host file the user set long ago suddenly applies inside; the first launch should name what it carried in. Per-folder values in existing volumes are lost unless the first write-back takes them (which folder wins is arbitrary).
- **The managed install** (`~/.pi/agent/install`, `bin/pi`): ignored. `install.sh` today records the replaced link and `uninstall.sh` restores it, which would bring a host pi back on uninstall; that stays right.
- **`pi update`:** changes meaning; the launcher release notes and `pi update`'s message have to say so.
- **`--no-sandbox`, `fallback`:** per section 8.
- **Package split** (step 8 below): users reinstall under a new package name once; `install.sh` and `uninstall.sh` learn both names for a release.

## 11. Recommended path

Each step ships alone, with docs and `npm run check` green, and leaves the launcher working with or without a host pi.

1. **Per-folder preference merge.** Keep model-default's four keys (and the `pi-*.json` files, already per folder) from the volume across the settings sync. Hard part: deciding the key list and reversing part of `8562639` on purpose. Needs no host-pi decision; meets the owner's requirement within a folder.
2. **Helper container primitive and the provider table from the image.** Backend support for a launcher-created one-shot container with a fixed mount set; first use: `provider-hosts.mjs` in a tool container. Hard part: lifecycle and cleanup of helpers in the sweep, and the VM-start latency.
3. **Image pi version from the launcher.** Pin by default, optional `image.piVersion`. Hard part: the owner's release cadence, since each pi release then wants a launcher release.
4. **Plain keys resolved by the launcher.** `piAuth` only for OAuth. Hard part: matching pi's `$NAME` and `!command` semantics exactly; a live test against each key form.
5. **Commands that start no session go to helpers:** help, `--version`, `--list-models`, `--export`. Hard part: speed from a stopped VM; deciding where `--list-models` runs.
6. **Credential container** for OAuth bearer tokens, `pi auth …`, `pi mcp login|logout`, with paste-back; proxy-started MCP sign-in becomes a 503 instruction. Hard part: the login UX and providers whose login lives in an extension (`print-*` loads none, so they have no `piAuth` today either; login is not verified).
7. **Config container** for `install|remove`, `mcp add|remove`; the host package install ends; `--no-sandbox` stays only with a managed install. Hard part: whether `pi install` can write settings without fetching the package offline.
8. **Package split and cross-folder preferences.** The launcher becomes its own package with no pi peer, so a normal install has no pi on disk; S3's write-back of data-only preferences turns on once no host pi reads them. Hard part: the rename and the write-back bounds.

Later, if wanted: a callback forward that brings back proxy-started sign-ins; a shared read-only package volume.

## 12. Open questions for the owner

1. Reading A, B or the stepped C? A is cheaper but keeps a pi on disk and does not help the dev setup unless the launcher's pi lives outside the repository.
2. Release cadence: the launcher pins pi (each pi release wants a launcher release), or `image.piVersion` lets users and policies move ahead? I would ship both, pin by default.
3. `--no-sandbox`: keep with a managed install, drop, or drop after a release? I would keep for one release.
4. Preferences: per folder only (step 1), or shared across folders (S3), knowing one folder can then steer every folder's model and subagent choices? Which `settings.json` keys are data?
5. Proxy-started MCP sign-in: accept the 503 instruction, or fund the callback forward?
6. `install` in a config container (pi validates) or as a launcher JSON edit (no network, no validation)?
7. Packages per folder, or a shared read-only volume once validated?
8. Is a VM start acceptable for `pi --help` and `pi --version` with a pinned image, or should those keep a no-VM path (a cached help text per pi version)?

## 13. Not verified

- Whether pi prints the authorization URL when it cannot open a browser, and whether paste-back works through a TTY into a helper container.
- Whether pi binds the OAuth callback on `127.0.0.1` or `localhost`, and whether Colima forwards a VM loopback listener to the Mac.
- Whether `pi auth login` or subcommand help builds a runtime that loads extensions; whether extension-registered providers have any OAuth path in a credential container.
- Whether `mcp-auth.json` is written in place like `auth.json`; the effect of `proper-lockfile` across a file bind.
- Helper container start time and the latency it adds to the first request after a cache expiry.
- Whether pi inside works with a read-only `npm/` and `git/`; whether `pi install` can write settings offline.
- Whether `pi update --all` ends cleanly at the image's self-update stub.
- Whether a repeat `npm install -g` upgrades an already satisfied `*` peer.
- Whether pi inside treats the project as trusted, and whether its `/settings` writes need the same merge as model-default's.
- The two read-only-link write failures in section 5 (mcp-import user scope, `/agents create`).
- How ambient cloud credentials (provider SDKs reading cloud profiles) reach the proxy today, and whether a credential container changes that.
