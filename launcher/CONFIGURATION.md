# pinata configuration

Every setting of the sandbox, where its one config file lives, and how credentials reach the proxy. For installing and everyday use, see [README.md](README.md). For what each setting weakens, see [THREAT-MODEL.md](THREAT-MODEL.md).

## Where the config lives

The sandbox reads one JSON file: `~/.pi/agent/pinata/config.json` (`pinata/config.json` under `PI_CODING_AGENT_DIR` when set). It belongs to you, the user who runs pinata; there is no other config file and no setting above yours. `PINATA_USER_CONFIG` moves the file to another path ([environment variables](#environment-variables-pinata-reads)). A key you set replaces its default; `env.allow` adds to the default terminal variables.

Without the file the defaults apply. Pinata reads it at every launch and writes it only in `pinata init`, which changes only the keys it asks about: `workspaceRoot`, `vm.cpus`, `vm.memoryGiB`, `vm.diskGiB` and `writeBack.enabled`. It keeps every other key and their order, and the file's indentation where it can. Nothing in the project folder configures the sandbox; see [One config for every session](#one-config-for-every-session).

`pinata config` prints the result and, for each key, whether it comes from the file (`config`) or the default.

The keys are described in [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json). A `$schema` key is allowed, so your editor can point at that file for completion.

An invalid value or an unknown key stops the launch. The message names the key, and the hint names the file to fix.

The message also shows the value for `image.dockerfile`, `image.packages`, `tls.extraCa` files, `workspaceRoot`, `mounts.volumes` targets, `mounts.binds` sources and targets, `services[].volumes[].target`, `services[].tmpfs` and `env.allow`. Host, credential and `npmGlobal` values are never shown.

## When changes apply

Each launch gets a new container, so most changes apply at the next `pi`. Your Mac also runs one proxy per pinata state folder (`PINATA_STATE_DIR`, one per agent dir by default; pinata makes the value absolute and real, so one folder is one install however you spell it), shared by every pi session of that folder, in every project folder. Some settings live in that proxy.

- **Grants** from `pinata egress allow` and `revoke` apply at once, also to running sessions.
- **Network settings** reach running sessions when you start a new `pi`, in any folder. These are `egress.allow`, `egress.deny` and `egress.privateHosts`. Editing the file alone changes nothing for them.
- **Credential rules, `env` secrets, the parent proxy and `tls.extraCa`** wait until every pi of pinata's state folder has exited.
- **`vm`** size applies at the next launch with no other pi session running, which restarts the VM, or at once through `pinata init` when no pi session runs. `vm.releaseFileCache` applies from the next `pi`.
- **`workspaceRoot`** limits where pi starts from the next launch. The VM's shares follow at the next launch with no other pi session running, which restarts the VM, or at once through `pinata init` when no pi session runs (see [below](#workspace-root)).
- **`writeBack`** applies from the next launch. Nothing is copied back from sessions started under the old list, not even from one still running, and a line says so (see [below](#settings-written-back)). An `env` secret is a credential rule whose secret comes from a variable of your shell.
- **`image`, `env.set`, `resources`, `mounts.volumes` and `setup`** apply to the next launch's new container; sessions already running keep what they started with.
- **`mounts.binds`** apply at the next launch. A source the VM does not share yet restarts the VM when no other pi session runs, and is refused while one does (see [below](#read-only-binds)).
- **`services`** restart at the next launch with no other pi session of pinata's state folder running. While one runs, the old services stay and a line says so (see [below](#services)).

When other sessions run, a new launch says which case applies:

```
the network allow and deny settings changed and now apply to every pi running in the sandbox
the credential, parent proxy or CA settings changed; the pi sessions running in the sandbox keep the earlier ones until they all exit (egress allow and deny changes apply now)
```

The latest launch sets the network settings for every session, so two folders cannot run with different `egress` lists at the same time.

Connections that are already open stay until they close.

## One config for every session

The file applies to every pi you start in the sandbox, in every folder. There are no profiles, no per-project config, and no project file that adds to it. So:

- `setup` and `services` run in every repository pi starts in. Write each `setup` command so it does nothing, quickly, in a repository it does not apply to, for example by testing for a file first; every session waits for the services' `ready`.
- A volume in `mounts.volumes` is one volume shared by every repository. Nothing in it stays apart per repository.
- `egress`, `credentials`, `tls`, `env`, `resources`, `mounts.binds`, the image and your grants are the same in every folder.

## All keys

| key | what it does | default |
| --- | --- | --- |
| `egress.allow` | The hosts the sandbox may reach, besides `pi.dev` and your credential hosts. | `[]` |
| `egress.deny` | Hosts that are never reachable. | `[]` |
| `egress.privateHosts` | Names that may resolve to private addresses. | `[]` |
| `image.packages` | Debian packages to add to the image. | none |
| `image.npmGlobal` | npm packages to install globally, as `name@version`. | none |
| `image.dockerfile` | A file of Dockerfile lines to add to the image. | none |
| `image.reference` and `image.digest` | A prebuilt image to pull instead of building one. | none |
| `credentials.derive.enabled` | Whether credentials are read from your host files. | `true` |
| `credentials.derive.hosts` | Read credentials only for these hosts. | every host |
| `credentials.rules` | Credentials you define by hand. | `[]` |
| `tls.extraCa` | Extra CA certificates to trust. | `[]` |
| `mounts.volumes` | Folders kept in volumes shared by all your sandboxes, each optionally filled once from a folder of your Mac ([below](#volumes)). | `[]` |
| `mounts.binds` | Host files or folders mounted read-only inside ([below](#read-only-binds)). | `[]` |
| `setup` | Commands run in the sandbox at every launch, before pi starts ([below](#setup-commands)). | `[]` |
| `services` | Long-running processes started before pi, reachable on `localhost` on the ports they declare and shared by every session that uses the same pinata state folder ([below](#services)). | `[]` |
| `env.allow` | Variables from your shell passed into each run. | terminal variables |
| `env.set` | Variables set to a fixed value in each sandbox container ([below](#fixed-variables)). | none |
| `resources.cpus` | CPU limit of each sandbox container, inside the VM. | no limit (the whole VM) |
| `resources.memoryGiB` | Memory limit of each sandbox container, in GiB, inside the VM. | no limit (the whole VM) |
| `resources.pids` | Most processes and threads one sandbox container may run ([below](#container-limits)). | `4096` |
| `resources.openFiles` | Open files limit of each process in a sandbox container, soft and hard. | the engine's default |
| `resources.shmMiB` | Size of `/dev/shm` in each sandbox container, in MiB. | the engine's default |
| `vm.cpus`, `vm.memoryGiB`, `vm.diskGiB` | The size of the VM itself, which every container shares ([below](#vm-size)). | the size the VM was created with; set by `pinata init` |
| `vm.releaseFileCache` | While pi runs, drop the VM's file cache before your Mac runs short of open files ([below](#file-cache)). | `true` |
| `writeBack` | Which settings changed inside come back to your Mac ([below](#settings-written-back)); `pinata init` sets `writeBack.enabled`. | the built-in list |
| `sessions.host` | Keep sessions in host pi's own session folder. Off, they stay in the one pi folder every folder's sandbox shares, and `pinata restart` deletes them with it, without asking. | `true` |
| `terminal.clipboard` | On a Mac, put what pi inside copies (OSC 52) on the clipboard with `pbcopy`, copy a pasted image path into the sandbox, and paste a clipboard PNG or a single copied image file on Ctrl+V. | `true` |
| `workspaceRoot` | The folder that holds your projects: pi starts only inside it, and, with the bind sources, it is the only project folder the VM shares ([below](#workspace-root)); set by `pinata init`. Required to launch. | not set: pi does not start |

The sections below explain each group.

## Network access

The sandbox reaches a host only when one of these lists names it:

- `pi.dev`, where pi reads its model list. It is always allowed on port 443, without a credential.
- `egress.allow`.
- The hosts of your credentials, derived or from `credentials.rules`.
- Your grants.

`egress.deny` wins over all of them, `pi.dev` included.

No package registry is allowed by default: list the ones you use, such as `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, or `github.com` and `codeload.github.com`, in `egress.allow`. The hosts of common registries:

| Registry | Hosts |
| --- | --- |
| npm | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |
| GitHub | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| Maven | `repo.maven.apache.org`, `repo1.maven.org` |
| Gradle | `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`, `downloads.gradle.org` |
| Go | `proxy.golang.org`, `sum.golang.org` |
| Cargo | `crates.io`, `index.crates.io`, `static.crates.io` |

### Allow, deny and private hosts

An `egress.allow` entry has one of three forms:

- `host` allows that name on port 443.
- `host:port` allows that name on that port.
- `*.corp.example` allows names exactly one label deeper, such as `git.corp.example`. It does not allow `corp.example` or `a.b.corp.example`.

Names may contain `_`. IP addresses and `localhost` are refused. Port 80 is refused too, since plain HTTP never leaves the sandbox.

An `egress.deny` entry reaches further:

- `paste.example.com` denies that name and every name under it.
- `*.example.com` denies every name under `example.com`, but not `example.com` itself.
- An entry without a port denies every port.

The proxy refuses a name that resolves only to private, loopback, link-local or reserved addresses. If an internal host needs that, list it in `egress.privateHosts`. Entries are names or `*.domain`, without a port.

### Grants

A *grant* is a host you allow from the command line, without editing a file:

```console
$ pinata egress allow docs.example.com
✔ Allowed docs.example.com
$ pinata egress allow git.example.com:8443
✔ Allowed git.example.com:8443
```

- A grant is for every folder and every session. It applies at once, also to running sessions, and stays until you revoke it.
- It takes one host name and an optional port. The port defaults to 443.
- It refuses wildcards, IP addresses, `localhost` and port 80.
- It refuses a host that `egress.deny` names, since a grant cannot override a deny.

`pinata egress revoke <host>` removes the grant for every port of that host. Name a port to remove only that one.

`pinata egress list` shows your grants, and `list --denied` shows what the running proxy blocked. The proxy serves every session, so that list holds the hosts other sessions tried too, in any folder.

### Blocked hosts

A blocked request gets a 403 page that says what to do. When pi exits, pinata prints one line per host blocked while it ran, ending in a hint. The proxy serves every session, so these lines can name hosts that another session tried, in any folder:

| why it was blocked | hint |
| --- | --- |
| not on any allow list | `run pinata egress allow <host> on the host` |
| it resolves to a private, loopback, link-local or reserved address | the proxy's reason with the address, then `add <host> to egress.privateHosts in <your config file>` |
| it is an IP address or a loopback name (`localhost`) in such a range | the proxy's reason, then `IP addresses and loopback names are never reachable from the sandbox; use a host name`, since `egress.privateHosts` takes neither |
| `egress.deny` names it | `denied by egress.deny` |
| plain HTTP | `plain HTTP is not proxied; use https` |
| the host did not answer | `it could not be reached: <reason>` |
| a credential could not be fetched | `it could not authenticate: <reason>` |
| a provider login on the host is missing or expired | `log in again with pi --no-sandbox and /login` |

Any other case prints the proxy's own reason.

`pinata doctor` puts the same reason and hint under the check of a credential host the proxy refused. Every other host blocked during its run becomes a `blocked <host:port>` warning in the network section, with the same reason and hint, instead of a line printed when it exits; a run that stops before its probes reports none.

## Image

The sandbox image is Debian bookworm with Node 24, git, search tools, curl, jq, python3 and glab. There is no GitHub CLI: [The GitHub CLI](#the-github-cli) shows how to add `gh` and its token. It installs the same pi version as your host pi, from npm. When host pi changes version, the next launch rebuilds the image.

These keys add one layer on top of that image:

- `image.packages`: Debian package names, optionally as `name=version`.
- `image.npmGlobal`: npm packages as `name@version`. URLs, paths and git sources are refused.
- `image.dockerfile`: an absolute or `~/` path to a file of Dockerfile lines, without `FROM`. The lines run as root during the build, so treat the file as code you run.

The layer is rebuilt only when these inputs change.

`image.reference` and `image.digest` go together. With both set, pinata pulls that image by its digest (`sha256:` and 64 hex digits) instead of building its own. The registry must allow anonymous pulls. The layer above still builds on top.

The base image build reaches the network straight from the VM, outside the allow-list, through your [parent proxy](#parent-proxy) when one is set. So does the layer when `image.packages`, `image.npmGlobal` or `image.dockerfile` is set; without them it builds with no network. Pinata starts these builds, not the agent.

## Build output and caches

### Build output

`node_modules`, `.venv`, `target`, `.gradle` and every other build output folder are ordinary folders in the shared tree: the sandbox reads and writes the copy on your Mac. What an install or a build inside makes is built for Linux, so native modules and binaries from inside may not run on your Mac, nor yours inside. A build that writes very many files there is safe through the [file cache release](#file-cache).

`mounts.autoOverlays` is not a known key: a config that still holds it stops the launch with `config: mounts.autoOverlays is not a known key`. Delete the key from the config.

Volumes named `pinata-cache-…` left in the VM from build output volumes stay there until `pinata restart`, which deletes the VM with every volume in it. To remove only those volumes:

```sh
docker --context colima-pinata volume ls -q --filter label=pinata.cache-path | xargs docker --context colima-pinata volume rm
```

Docker keeps a volume that a running session uses.

### Volumes

Your home inside the sandbox lives in memory, so tool caches are lost when pi exits. `mounts.volumes` keeps chosen folders in volumes:

```json
{
  "mounts": {
    "volumes": [
      "~/.npm",
      "~/.cache/pip",
      { "target": "~/.m2/repository", "name": "maven", "source": "~/.m2/repository" }
    ]
  }
}
```

- An entry is a target, or an object with `target`, optional `name` and optional `source`.
- A target is an absolute path or starts with `~/`, which is the sandbox home `/home/pi`. Write a path in the home with `~/`, not `/home/pi/`.
- Every entry is a user volume: one volume that every sandbox of yours mounts, whatever the folder. No entry is kept apart per repository.
- The volume is known by its `name` when set, otherwise by the target as written. Without a `name`, changing the target starts a new, empty volume. A `name` is lowercase letters, digits, `.`, `-` and `_`, and two entries may not share it. An entry whose `name` is the name of a [service volume](#services) mounts that same volume.
- Your Mac's folder of that name is never mounted. The volume starts empty, unless the entry has a `source`.
- `source` is a folder of your Mac, an absolute path or one starting with `~/`, that pinata copies into the volume ([below](#copy-a-folder-into-a-volume)).
- An entry may share a folder with a file pinata puts in your home, such as `~/.m2/repository` beside the rendered `~/.m2/settings.xml`. The sandbox waits until each volume, and the home folders above it, belong to the sandbox user before it writes there, and a launch whose hand-over fails stops.
- The [target rules](#mount-targets) apply.

Every sandbox can write to a user volume, so a bad package written in one folder reaches the others. Use user volumes for package caches only.

A user volume stays until `pinata restart` or the uninstall, which delete it with the VM; the daily cleanup never removes it.

### Copy a folder into a volume

An entry with a `source` gets a copy of that folder of your Mac, made once:

- The source is checked when pi starts, with the rules of a [bind source](#read-only-binds): not your home or a folder above it, nothing the sandbox protects, not pinata's or pi's folders, and nothing that overlaps the workspace root or pi's session folder. A refused source stops the launch with an error that names `mounts.volumes[<n>].source`.
- At launch, after the container is up and its volumes belong to the sandbox user, and before `setup` and pi, pinata looks for the file `.pinata-seeded` at the top of the volume (a link at that name does not count). When it is missing, pinata prints `pinata: copying <source> into the volume at <target>, one time`, copies the folder, writes `.pinata-seeded` last, holding the source's real path, and prints `pinata: copied <source> into the volume at <target>`. When the marker names another folder, as after you change `source`, pinata copies nothing and prints `pinata: warning: the volume at <target> holds a copy of <other folder>, so <source> is not copied into it; delete <target>/.pinata-seeded in the sandbox to copy it`.
- Pinata writes the archive itself and streams it into `tar` in the sandbox, which writes as the sandbox user. Files are owned by `1000:1000` and keep their permission bits and modification times; setuid, setgid and sticky bits are dropped, and every folder gets read, write and search for its owner. Links are copied as links and never followed. Sockets, fifos, devices, macOS `._*` files, extended attributes, ACLs and file flags are left out. Hard links arrive as separate files.
- The copy reads only inside the source's real path. Pinata resolves the source again before the copy; when it now leads to another folder, nothing is copied and the warning below names both paths. Every file is opened so that a link anywhere in its path makes the open fail, and a folder that turns into a link during the copy is left out, so nothing outside the source is read.
- An entry that cannot be read (no permission, gone since the folder was listed, or turned into a link) is left out and the copy goes on; the closing line then ends with `; <n> entries could not be read and were left out`. A file that changes size while it is read is cut or padded with zeros to the size it had when it was opened, and the line ends with `; <n> files changed while they were read`. The marker is written all the same, so delete it to copy again.
- Files already in the volume stay. A file, folder or link at the same path as one in the source is replaced; a link there is removed, not written through. Nothing else is deleted.
- Two launches never copy into one volume at once: the second waits, prints `pinata: waiting for another pi session to finish copying into <target>`, then finds the marker and copies nothing.
- A copy that fails never stops the launch: a source that is missing, not a folder or resolving elsewhere, `tar` in the sandbox exiting non-zero, an archive that did not reach its end, a marker that could not be written, or a copy interrupted part-way prints `pinata: warning: <source> was not copied into the volume at <target> (<reason>); the next launch tries again`, writes no marker, and pi starts.
- On your Mac the copy writes only its lock file, `locks/seed-<hash>.lock` under pinata's state folder; nothing flows back from the volume. Later changes to the source do not reach the volume. Delete `.pinata-seeded` (a plain file) inside the sandbox to copy again at the next launch.
- `pinata doctor` and services never copy.

### Read-only binds

`mounts.binds` mounts a file or folder of your Mac inside the sandbox, always read-only:

```json
{ "mounts": { "binds": [{ "source": "~/reference/schemas", "target": "/etc/schemas" }] } }
```

- `source` is an absolute path or starts with `~/`. It must exist, and it is checked on your Mac before anything starts, with the rules of the [workspace root](#workspace-root): not your home or a folder above it, nothing under `~/.ssh`, `~/.aws`, `~/.config` and the other folders the sandbox protects, not pinata's or pi's folders. An error names `mounts.binds[<n>].source`.
- The VM must see the source. A folder source, or the folder of a file source, that lies inside a folder the VM already shares needs nothing more. Otherwise the VM shares it, read-only. A source that holds a folder the VM shares, such as a folder above a workspace root, is refused, since the VM cannot share nested folders.
- A source whose real path is a folder the launch mounts writable, lies inside one or holds one is refused (`… overlaps <path>, which the sandbox already mounts`). Those folders are the workspace root, which holds the repository and its git folders, and pi's session folder. Bind a folder or file apart from them.
- Right before the container is created, each source is checked again. A short window between this check and the engine resolving the source stays open; binds are read-only (see [THREAT-MODEL.md](THREAT-MODEL.md)). A source that became a link, changed from file to folder or the other way round, or now resolves elsewhere stops the launch with `… changed while pi was starting, refusing`; run pi again.
- A new share needs a VM restart. A launch with no other pi session running restarts the VM once, with a line that says so. While other sessions run, the launch is refused and names the path the VM does not share yet; end the other sessions and start pi again. `pinata init` plans the same shares, bind sources included.
- The [target rules](#mount-targets) apply.

### Mount targets

Every target of `mounts.volumes` and `mounts.binds` follows these rules, checked when the config loads and again against the full list of the container's mounts:

| target | allowed |
| --- | --- |
| a path in `~` such as `~/.npm` or `~/.m2/repository` | yes |
| `~` itself (`/home/pi`), `/home`, `/tmp` or `/` | no, the sandbox mounts its home and `/tmp` there |
| a path in `/tmp`, such as `/tmp/cache` | yes |
| `/tmp/pinata-handover`, `/tmp/pinata-ready`, `/tmp/pinata-forward` and anything inside them | no, pinata and the entrypoint signal each other through these files |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/libx32`, `/boot`, `/dev`, `/proc`, `/sys`, `/run`, `/var/run`, `/var/lock`, `/root`, `/opt/pinata`, `/etc/ssl`, anything inside them or a folder above them (`/`, `/opt`, `/etc`, `/var`) | no, the sandbox image and pinata's root commands need them |
| `/etc/ld.so.preload`, `/etc/ld.so.cache`, `/etc/ld.so.conf`, `/etc/ld.so.conf.d`, `/etc/passwd`, `/etc/group`, `/etc/shadow`, `/etc/gshadow`, `/etc/nsswitch.conf`, `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` and anything inside them | no, they steer every program, root's included |
| other paths, such as `/etc/<app>/conf.d`, `/opt/data`, `/srv/cache`, `/var/lib/<app>`, `/var/log/<app>`, `/data` or `/logs` | yes |
| `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.colima`, `~/.kube`, `~/.config`, `~/.local/bin` and anything inside them | no |
| a path with an empty, `.` or `..` part | no |
| a target listed twice, or one inside another target | no |
| a target inside, or above, the folder you start pi in, its git dirs or pi's session folder | no, the launch stops with a `mounts:` error |

The rules read a target as text, after normalisation; pinata does not resolve it inside the image. A symbolic link in the image at or above a target leads the mount to where the link points, which can be a reserved tree: Debian's own `/etc/localtime` and the entries of `/etc/alternatives`, for example, point into `/usr`. Only your config names targets and only the image, which your `image.dockerfile` lines or your pinned image change, holds such links, so this stays within what you already control. Pick targets that are plain folders in the image.

## Setup commands

`setup` runs commands inside the sandbox at every launch, in order, after the container is up and its volumes belong to the sandbox user, and before pi starts:

```json
{ "setup": [["npm", "ci", "--prefer-offline"], ["sh", "-c", "test -e .venv/.done || (uv sync && touch .venv/.done)"]] }
```

- Each command is a list of arguments, run without a shell; use `["sh", "-c", "..."]` for one.
- It runs as the sandbox user with the same variables as pi, in the repository root, and prints to your terminal. It gets no input: a command that reads stdin sees its end at once.
- Ctrl-C stops it and the launch.
- A command that exits with another code than 0 stops the launch with `setup: <command> exited with code <n>, so pi did not start`.
- `pinata doctor` does not run it.
- Sessions of one folder prepare one at a time, `setup` included. A second `pi` in the same folder prints `waiting for another pi session of this folder to finish preparing` until the first is done.

Some things to know:

- A command that starts a background process holding its output, such as a server started with `&`, keeps the launch waiting until that process exits. Redirect its output, or better, do not start servers here.
- Long-running work does not belong in `setup`; it runs before every pi.
- `setup` runs at every launch, so it must be fast when there is nothing to do. Check a marker first, as in the example.
- A command stopped half-way leaves what it wrote. Write the marker last, so a stopped run is done again next time.

## Services

`services` declares long-running processes, such as a database, that pinata starts before pi in containers of their own. Every pi session in the sandbox shares one set of them. The agent reaches each declared port on `localhost`:

```json
{
  "services": [
    {
      "name": "db",
      "image": "registry.example.com/db:16",
      "command": ["db-server", "--listen", "0.0.0.0:5432", "--data", "/data"],
      "user": "999:999",
      "env": { "DB_MODE": "local" },
      "ports": [5432],
      "volumes": [{ "name": "db-data", "target": "/data" }],
      "tmpfs": ["/run/db"],
      "ready": { "command": ["db-ready", "--port", "5432"], "timeoutSeconds": 60 },
      "memoryGiB": 1
    }
  ]
}
```

| key | what it does | default |
| --- | --- | --- |
| `name` | Lower-case letters, digits and `-`, starting with a letter, at most 31 characters; unique. | required |
| `image` | The image to run. | the sandbox image |
| `command` | The arguments to run, without a shell; they replace the image's entrypoint. The agent reads them in the [status file](#sandbox-status-file), so put no secret here; pass it in `env`. | required |
| `user` | A numeric `uid:gid`, each 1 to 2147483647; uid 0 and gid 0 are refused. | `1000:1000` |
| `env` | Variables of the service, taken as written. | none |
| `ports` | TCP ports, 1 to 65535, that the agent reaches on `localhost`. A port may appear only once across all services. | none |
| `volumes` | `{ "name", "target" }` volumes, kept across launches and shared by every session. | none |
| `tmpfs` | Writable folders in memory, besides `/tmp`, which every service has. | none |
| `ready.command` | A command run in the service as its user until it exits with 0; pi starts after that. | none: ready once started |
| `ready.timeoutSeconds` | How long to wait for `ready.command`, 1 to 3600. | `60` |
| `memoryGiB`, `shmMiB` | The memory limit and the `/dev/shm` size of the service. | the engine's default |

Paths are absolute, normalised, not `/`, not inside each other and without `:` or `,`, which the container engine reads as separators. The agent's reserved paths do not apply. Two services that mount one volume must run as the same user, and a volume the agent shares through `mounts.volumes` (below) only with services that run as `1000:1000`.

How it works:

- At a launch, after the image is ready and before the agent's container starts, pinata makes sure the services run. When none run yet, it starts one holder container, the pod, and then each service in order, printing `pinata: starting service <name>`. The services share the pod's network. Without services nothing changes.
- The pod sits on the sandbox network under the name `pinata-services`. In the agent's container, a small forwarder listens on `127.0.0.1` and `::1` for each declared port and passes the connection on to `pinata-services` on the same port. So a service must listen on an address of the pod's network, such as `0.0.0.0`, not on `127.0.0.1`.
- A port the forwarder cannot listen on stops the launch with `the sandbox could not forward the services' ports: port <n> on <address>: <reason>`.
- A service waits for its `ready.command`, checked about twice a second. A service that exits first stops the launch with `service <name> exited with code <n> before it was ready`, and one that is not ready in time with `service <name> was not ready within <n> s`; both show its last 40 log lines and name `services[<i>]`. Ctrl-C stops the wait.
- A service gets only its own `env`: no workspace, home, credentials or variables of yours. It runs with no capabilities, no privilege escalation, a read-only root file system, `/tmp` and the `tmpfs` folders writable, and at most 4096 processes.
- Before the first service starts, the pod hands each volume's root folder to the service's `user`.
- A later session, in any folder, reuses the running services, checks again that each is ready, and starts again only those that exited, unless the services changed (below). Services are never restarted in place.
- When the last pi session of pinata's state folder ends, the services stop together, each with 30 seconds to exit, and then the pod is removed. `pinata stop` and the uninstall stop them too when no session runs. When another pi command holds the lock for that work, the end of a session waits and prints `waiting for another pinata command to finish before cleaning up; Ctrl-C skips the cleanup`; Ctrl-C ends the wait.Volumes stay.
- `pinata restart` deletes the services with the rest of the sandbox VM, and their volumes with them, without asking. It refuses while a pi session runs in the sandbox VM.
- `pinata status` lists each service with its state and ports. `pinata doctor` starts no service.

Some things to know:

- Services start with the first session, so a slow `ready` delays that `pi`. A later session waits only for a service that had exited and starts again.
- Every session reaches the same services and the same data, in any folder. Two repositories that need different data in one database need different database names or users.
- A service volume is one volume per pinata state folder, like a `mounts.volumes` entry. Its name is the `name` you give it.
- The agent sees a service volume only through a `mounts.volumes` entry with the same `name`. Such a volume is shared: every service that mounts it must run as `1000:1000`, the sandbox user's ids, and the config is refused otherwise. The agent owns its files and can write, replace or delete anything the service keeps there.
- Data a service must keep needs a `volumes` entry. A path the image declares as `VOLUME` gets an anonymous volume that is removed with the service's container, when the last session ends and when an exited service starts again, so a database whose image declares its data folder as `VOLUME` starts empty each time without one.
- A changed `services` list, or a changed sandbox image, applies when no other pi session of pinata's state folder runs. Until then the old services keep running and a launch prints `pinata: the services in the config changed; they restart once every pi session has ended`. A service of the old set that stopped is started again as it was; one that cannot start stops the launch with `service <name> is stopped and could not be started`. A change to `ports` alone applies to the next launch's container at once.
- Each agent container is on the same network as the pod, so any session can also reach a service at `pinata-services:<port>` on a port the config does not declare.
- A service without `memoryGiB` is not counted when pinata compares `resources.memoryGiB` and the services with the VM's memory, and can use the whole VM. Without `vm.memoryGiB` that memory is the automatic size of [the VM](#vm-size) on this Mac, and a launch or `pinata doctor` refuses a sum above it with a `config:` error.
- A service's only way out is the proxy at `pinata-proxy:3128`, which it can reach whatever its `env` says. Its tools use it when its `env` points them there, for example `HTTPS_PROXY=http://pinata-proxy:3128`. The same egress policy applies as to the agent.
- A service gets no CPU or open-file limit, so a busy service can slow every session.
- An `image` other than the sandbox image is pulled by the VM's container engine directly, not through the proxy, and runs with the trust you give its author when you write it in the config.

## VM size

```json
{ "vm": { "cpus": 4, "memoryGiB": 8, "diskGiB": 80 } }
```

Every key is optional; `pinata init` sets them when you choose Custom, and removes them when you choose Automatic. Without `vm` the VM keeps the size it was created with, by default this Mac's CPU count from 2 to 8, half its memory from 4 to 10 GiB, and a 60 GiB disk. `cpus` is 1 to 64, `memoryGiB` 2 to 256 and `diskGiB` 20 to 2048, whole numbers. On this Mac `cpus` may not be more than its CPU count and `memoryGiB` not more than its memory less 2 GiB: a launch and `pinata init` refuse with a `config:` error before they stop or start the VM, and `pinata doctor` fails its `vm size` check without starting anything. The file itself stays valid, so the same config works on a larger Mac. Without `vm.memoryGiB`, a launch and `pinata doctor` compare `resources.memoryGiB` and the services' `memoryGiB` with the automatic memory size of this Mac, not with the memory of the VM as it runs, so a VM created larger by hand can still be refused; set `vm.memoryGiB` to its size and the comparison uses that instead.

`vm` sizes the VM, which runs every sandbox container of every folder. `resources` limits one container inside it. A `resources` value above the matching `vm` value is a config error, since no container could get it.

### Container limits

```json
{ "resources": { "pids": 8192, "openFiles": 65536, "shmMiB": 1024 } }
```

Three more `resources` keys limit one container, whole numbers only. They apply when the container is created, so a change applies from the next `pi`.

- `pids` caps the processes and threads of the container together. It is 256 to 4194304 and `4096` when unset. A build or test run that starts many workers, or a JVM with many threads, can need more: past the cap, new processes fail with `fork: Resource temporarily unavailable` or `unable to create native thread`.
- `openFiles` sets the open files limit (`ulimit -n`) of every process in the container, soft and hard the same. It is 1024 to 1048576. Unset, pinata sends nothing and the container engine's default applies.
- `shmMiB` sets the size of `/dev/shm`. It is 1 to 262144. Unset, pinata sends nothing and the engine's default applies, which is 64 MiB; browsers and some test runners need more. `/dev/shm` counts against the container's memory, and pinata does not compare it with `resources.memoryGiB`.

At a launch with no other pi session running, a VM whose size differs is restarted with the values that differ, and a line says so. While other sessions run, the launch goes on and a line says the size changes at the next launch with none running. Colima cannot shrink a disk: a `diskGiB` below the current disk is reported at each launch and ignored. A stopped VM starts at the new size directly. `pinata doctor` compares the VM with `vm` and never restarts it. `pinata init` creates a new VM with `vm` where set and the automatic size otherwise, and applies a changed size at once when no pi session runs.

### File cache

Your Mac's process behind the VM keeps one open file for each file the VM has cached from your Mac's folders. A very large build or test run can push that up to what macOS allows, and then files fail to open, in the sandbox and on your Mac. With `vm.releaseFileCache` on, pinata checks that count every 10 seconds while pi runs. When it reaches half your Mac's per-process limit (`kern.maxfilesperproc`) or a quarter of its system-wide limit (`kern.maxfiles`), whichever is lower, it drops the VM's file cache, at most once every 30 seconds per pi session. A count that takes longer than 10 seconds counts as past the limit. Files stay as they are; the VM reads them again when they are used.

It skips a check while another launch is changing the VM, and does nothing when it cannot find the VM's process. It finds that process as the holder of the VM's disk file, `disk`, or `diffdisk`, as Lima older than 2.1 names it, or its data disk. When several processes hold them, it watches the one with the most open files and looks again every 5 minutes. When looking again times out, it keeps watching the process it found before while that process runs. When pi exits during a release, pinata waits for the release to finish. Set `vm.releaseFileCache` to `false` to turn it off.

The `file cache` line of `pinata doctor`, there also when the sandbox does not start, prints by default when it warns or skips for a reason it names (the VM is not running, or likely stopped), not when it is ok or skipped off macOS or on a backend that does not count; `pinata doctor --verbose` always prints it. It shows the count and the limit, and warns when the count is past it, when the release cannot find the VM's process, when looking for it timed out or could not run, or when it cannot read the limit. With `vm.releaseFileCache` off, it warns only when the count is past the limit. It only reads; it never drops the cache. `resources.openFiles` does not change any of this: it limits each process inside the container, not your Mac's process behind the VM.

`pinata install` raises `kern.maxfiles` to at least 1048576 and keeps it there at boot ([Install](README.md#install)); `pinata doctor` says to run it when the value is lower, and so does `pi`, once for each low value. That fixes the system-wide table: with the default (122880 on many Macs) the VM's cached files and the files of your other apps can fill it together, and then a file fails to open anywhere on the Mac. It does not raise `kern.maxfilesperproc`, and pinata never does: macOS frees the VM process's files when it holds about nine tenths of that limit, so a higher limit lets the cache grow further before the drop, and the per-process ceiling the VM hits stays where it is. A single build that opens more files than that per-process limit still fails; the release above keeps the count under it between such peaks.

## Settings written back

When pi inside changes a setting on the list, pinata copies the change to your Mac when pi exits (see [Some settings come back to your Mac](README.md#what-is-different-inside-the-sandbox)). By default the list is:

- `settings.json`: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `theme`, `hideThinkingBlock`, `quietStartup`, `collapseChangelog`, `doubleEscapeAction`, `treeFilterMode`, `steeringMode`, `followUpMode`, each with a check of its value.
- `pi-subagents.json`, `pi-style.json`, `pi-notifications.json`, `pi-session-limits.json`: the top-level keys their extensions read, any JSON value.
- `pi-prune.json`: `days`, only one of `0` (off), `7`, `30`, `60`, `90`, `180` and `365`, the choices of `/prune`.

`writeBack` changes the list:

```json
{
  "writeBack": {
    "enabled": true,
    "exclude": { "settings.json": ["theme"] },
    "add": {
      "settings.json": {
        "editorPaddingX": { "type": "integer", "min": 0, "max": 8 },
        "defaultThinkingLevel": { "type": "enum", "values": ["off", "low", "high"] }
      },
      "pi-footer.json": { "layout": { "type": "json" } }
    }
  }
}
```

- `enabled: false` copies nothing back. `settings.json` and the five built-in `pi-*.json` files are still copied into the sandbox, since pi there reads them; a file you added is not, and its earlier copy is removed from the sandbox at the next launch.
- `exclude` names built-in keys, per file, to stop copying. A key that is not on the built-in list is an error.
- `add` names keys, per file, with the check a value must pass. A built-in key gets your check instead of its own, for example when pi adds a value the built-in list does not know yet. A new `pi-<name>.json` file is copied whole from your Mac into the sandbox at each launch, like the built-in ones, and its listed keys come back. Every key in that file is readable inside the sandbox, not only the ones you list, so do not add a file that holds secrets. Once you take the file out of `add`, the next launch removes its copy from the sandbox.
- A key both excluded and added is an error.

The checks are `string` (optional `maxLength`, at most 512), `boolean`, `integer` and `number` (optional `min`, `max`), `enum` (`values`, a list of strings, numbers or booleans), `stringList` (optional `maxItems`), `fileName` (a plain file name, as for `theme`), `anyOf` (`of`, a list of checks, nested at most 4 levels deep) and `json` (any value). A value that fails its check is not copied and a line says so. There is no regular expression check.

Some things no config can add, since your Mac would run or trust them:

- Files other than `settings.json` and `pi-<lowercase letters, digits, dashes>.json` in the agent folder; never `auth.json`, `models.json`, `mcp.json`, `mcp-auth.json` or `trust.json`.
- In `settings.json`: `packages`, `extensions`, `skills`, `prompts`, `themes`, `npmCommand`, `selfUpdateCommand`, `shellPath`, `shellCommandPrefix`, `externalEditor`, `httpProxy`, `sessionDir`, `defaultProjectTrust`, `modelOverrides`, `sessionShareDestination`, `defaultTools`, `enableAnalytics`, `enableInstallTelemetry`, `trackingId` and `deviceId`, and any key with the `json` check. `theme` keeps the `fileName` check, since pi turns it into a path.
- In `pi-subagents.json`: `disabledPlugins`.

Size limits (1 MiB for `settings.json`, 64 KiB for a `pi-*.json`), the conflict rule (your Mac wins) and the printed lines stay as they are.

Choose an added key with care: a sandboxed agent can set it to any value its check allows, and your Mac's pi reads that value. Add only plain preferences, and give each the narrowest check that fits.

Every launch uses the list it started with. After you change `writeBack`, the next launch copies nothing back from earlier sessions, including one still running, so a change made under the old list is never judged by the new one; it prints `pinata: the write-back list changed; nothing is written back from sessions started under the old list`. `pinata config` lists the keys of each file and whether they come from the default or your config.

## Workspace root

```json
{ "workspaceRoot": "~/work" }
```

`workspaceRoot` is one folder, an absolute path or one starting with `~/`. It is required for the sandbox: while it is unset, `pi` stops with `config: workspaceRoot is not set, so pi has no folder it may start in` and a hint to run `pinata init` or set the key, and `pinata doctor` fails its `vm shares` check for the same reason and leaves the VM stopped. `pi --no-sandbox` runs without it, as no VM is involved. A root that does not exist stops `pi`, `pi --no-sandbox` and the doctor with `config: workspaceRoot: <root> does not exist` and a hint to create the folder, mount its volume or point the key at another folder. With it:

- **Pi starts only inside the root.** A launch, with or without the sandbox, is refused when the repository lies outside it: `<folder> is outside the workspace root (workspaceRoot: <root>)`, and when its git dir or common dir (a worktree's main `.git`, say) does: `git: the git dir <dir> of <folder> is outside the workspace root (workspaceRoot: <root>)`. `pi --no-sandbox` checks only that the repository is inside the root: a git dir outside it, or a root that is your home or holds it, is allowed there, as nothing is shared.
- **The sandbox sees the whole root.** Wherever pi starts in it, the container mounts the root read-write at its own path, every project and git dir in it included; see [THREAT-MODEL.md](THREAT-MODEL.md#3-baseline-guarantees). Keep only your own projects in it.
- **The VM shares only the root**, writable, plus pi's session folder `<agent dir>/sessions` (writable), pinata's `<state>/vm` folder (read-only, the rendered agent files) and the folders of [`mounts.binds`](#read-only-binds) sources outside the root (read-only). Your home is never shared whole.
- **The VM restarts when its shares differ.** At the first launch after you set or change the root, pinata restarts the VM with exactly this list and says so, naming the new list and what it adds and drops. While other pi sessions run, a launch the current shares already cover goes ahead and the VM is changed at the next launch with no session running; a launch they do not cover stops and asks you to exit the others. `pinata doctor` warns while the shares differ.

The root may not be your home or a folder that holds it: `~` is refused when the config loads, and a path that resolves to your home or above it (`/Users`, `/`, `~/..`) is refused at launch, before the VM is touched, with `config: workspaceRoot: <root> is the home dir or holds it, which would share all of it with the sandbox VM`. Choose the folder in your home that holds your projects, or a folder elsewhere such as `/Volumes/Projects`. The root is also refused when it holds `,`, `:`, a newline or another control character, or is, holds or lies inside a path the VM could use to take over the host: `~/.pi`, the agent dir, pinata's state dir, the user config file and its folder, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.colima`, `~/.kube`, `~/.config`, `~/.local/bin`, `~/Library`, `/etc`, `/usr`, `/opt`, `/System`, `/Library`, `/bin` or `/sbin`. `/private` and `/var` are refused when the root is or holds them (the macOS temp folder lies inside them). `pinata init`, `--yes` included, accepts a root that does not exist yet, prints `workspaceRoot: <root> is missing, so it is not shared until it exists` and leaves it out of the VM's shares; a launch then stops until the folder exists. The VM's shares must not nest: when `<agent dir>/sessions` or `<state>/vm` resolves into the root, or the root into them, the launch stops with a `config: workspaceRoot:` error before the VM is touched.

The VM's shares follow the config of whichever agent dir launches pi, since every agent dir uses the same `pinata` VM. Two agent dirs with different roots therefore make the VM restart when you switch between them while no pi session runs; while a session of either runs, a launch counts it as a live session.

`pinata init` chooses the root with you and applies it to the VM at once, restarting it when no pi session runs. In a script, or on a machine without a terminal, set `PINATA_ROOT` and run `pinata init --yes` (or `pinata install`, which does): it writes the root into a config without `workspaceRoot`, stops when the config names another root, and stops when neither the config nor `PINATA_ROOT` names one (see [Set up the sandbox](README.md#set-up-the-sandbox)).

## Variables passed into the sandbox

`env.allow` names the variables of your shell that reach each pi run. The default list is `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION` and `COLORFGBG`. Your entries only extend it: the list cannot shrink, and `pinata config` shows its source as `default+config`.

The image sets `LANG=C.UTF-8`, a UTF-8 locale that Debian always ships, so the sandbox has a valid locale whatever your Mac uses. A `LANG` in `env.allow` replaces it with your shell's value; the image has no other locale, so generate yours with `image.dockerfile` (for example `RUN apt-get update && apt-get install -y locales && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen`), or perl and other programs print `Setting locale failed`.

Some names are refused when the config loads:

- Names that look like secrets: they contain `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL` or `JWT`, in any case.
- The proxy variables, in any case.
- Variables pinata sets inside, such as `PI_CODING_AGENT_DIR` or `NODE_EXTRA_CA_CERTS`.

A value that looks like a credential stays on your Mac. That means a `Bearer`, `Basic` or `Token` prefix, a JWT, or a URL with a user name or password. The launch then prints `env.allow: <NAME> holds a credential, so it stays on the host`.

Inside, `PINATA=1` tells scripts they run in the sandbox, and `PINATA_STATUS` names the [sandbox status file](#sandbox-status-file). `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY`, in both cases, point at the proxy, `http://pinata-proxy:3128`, and `NO_PROXY` holds `localhost,127.0.0.1,::1,pinata-proxy`, so local test servers and services are reached directly.

### Fixed variables

```json
{ "env": { "set": { "CI": "1", "GRADLE_OPTS": "-Xmx2g" } } }
```

`env.set` maps variable names to values that every process in the sandbox container sees: pi, its tools and anything they start. A value is a string, taken as written: `$HOME` or `~` stays as those characters. It may not contain a NUL character. They are set when the container is created, so a change applies from the next `pi`.

A name pinata sets is refused when the config loads, with `config: env.set["<NAME>"] is set by pinata and cannot be set`. That is the same list `env.allow` refuses: the proxy variables in any case, `NODE_USE_ENV_PROXY`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `NODE_EXTRA_CA_CERTS` and the other CA variables, `BASH_ENV`, `HOME`, `PATH`, `PWD`, `GITLAB_TOKEN`, `GITLAB_HOST`, `GIT_TERMINAL_PROMPT` and the `PI_*` variables pinata sets, `PINATA_STATUS` among them. A name must look like a variable name: letters, digits and `_`, not starting with a digit. Unlike `env.allow`, names that look like secrets are accepted, since the value is yours and written in the file; still, keep secrets out of it and use [credentials](#credentials). Every `env.set` value is visible to the agent and everything it runs, so a real secret never goes there. `pinata doctor` does not check an `env.set` variable whose value inside is the one in the file; its credential sweep names the secret-looking ones it skipped (`env.set values not checked: …`), so a secret written here is not caught by the doctor.

A name in both `env.allow` and `env.set` takes the `env.set` value; your shell's value is not passed. A name the image sets, such as `LANG`, takes the `env.set` value.

Your `env.set` replaces the default, which sets nothing, as a whole map; `pinata config` shows its source as `config`, or `default` without it.

`GIT_OPTIONAL_LOCKS=0` is a default of pinata's, not a fixed value: it is not refused, and an `env.set` value for it replaces pinata's, as does a host value `env.allow` forwards (see [Git settings](#git-settings)).

## Git settings

Git on your Mac and git in the sandbox work on the same `.git` folder. A plain `git status` rewrites `.git/index` when it finds changed file times, and the other side's next write can then fail on `index.lock`. Pinata sets three things on both sides so that a status only reads:

| Setting | On the Mac | In the sandbox |
|---|---|---|
| `GIT_OPTIONAL_LOCKS=0` | exported in pinata's block in your shell profile | the container environment, unless `env.set` names it |
| `core.checkStat=minimal` | your global git config, through pinata's file | the rendered `~/.gitconfig` |
| `core.trustctime=false` | your global git config, through pinata's file | the rendered `~/.gitconfig` |

On the Mac, `pinata install` (and so `pinata update`) writes them and `pinata uninstall` removes them; `pinata uninstall --sandbox` keeps them. Everything pinata writes lies between a `# pinata begin` and a `# pinata end` line, and the uninstall removes only that.

- The shell profile: the export is the second line of the block that puts `~/.local/bin` on `PATH`, in `~/.zshrc` and in `~/.bashrc` and `~/.bash_profile` when they exist. The block sits at the end of the file, so it overrides a `GIT_OPTIONAL_LOCKS` you export earlier in the file; one you export after the block wins. Only git started from a terminal sees it.
- The global git config: a block at the start of the file with `[includeIf "gitdir:/"]` and `path = "<package>/launcher/cli/pinata/gitconfig"`, a file in the installed package that holds the two `core` keys. `gitdir:/` matches every repository, worktree and bare repository; outside a repository the keys do not apply, and they matter only with an index. Git takes the last value it reads, so a value you set yourself for either key, before or after the install, wins. The keys reach every git on the Mac, apps started from the Dock included. When the package is removed, git ignores the missing file without an error.
- The file is `GIT_CONFIG_GLOBAL` when it is set and not empty, else `$XDG_CONFIG_HOME/git/config` (`~/.config/git/config` when `XDG_CONFIG_HOME` is unset or empty) when that exists, else `~/.gitconfig`, created when missing. Git reads the XDG file before `~/.gitconfig`, so the block comes before every global value of yours, in either file, and `git config --global`, which writes `~/.gitconfig` when both exist, sets a value that wins. A block an earlier install left in another of these files is removed, so there is one. One that is not a regular file, such as `GIT_CONFIG_GLOBAL=/dev/null`, is left alone with a line saying so. The uninstall cuts the block from each of `GIT_CONFIG_GLOBAL`, the XDG file and `~/.gitconfig`; a block in a file that an earlier `GIT_CONFIG_GLOBAL` named stays, so cut it out by hand. A file that held only the block stays, empty.
- A file whose markers do not pair or repeat is left as it is, with a line saying so, and gets no block. A marker line that ends in a carriage return counts, and a byte-order mark at the start of a file stays first.
- A linked file is edited through the link, as `git config --global` does: the new text goes into a temporary file beside the link's target, with the target's mode, which then replaces the target, so the link stays. A link to a missing file is left alone, and a file pinata cannot write, such as one linked into a read-only folder, is left as it is; each gets a line saying so, and the install or uninstall goes on.

In the sandbox, the rendered `~/.gitconfig` starts with the two `core` keys, before the identity and the glab hosts, and is written at every launch. It is git's global scope, so a repository's own `.git/config` value for either key outranks it, as do `GIT_CONFIG_COUNT` entries you set in `env.set` and `setup` lines that set the keys again.

## Credentials

### Derived credentials

With `credentials.derive.enabled` on, pinata reads these at every launch:

- Each provider in host pi's `auth.json`, and provider API keys set as variables in your shell. The proxy reads such a key on your Mac. It is never copied inside.
- Each `apiKey` and secret header in `models.json`.
- Each enabled HTTP server in `mcp.json`.
- The glab hosts, with their tokens. A host without a token is named in a notice, except one with no `user` either (never logged in to, like glab's default `gitlab.com` entry) while another glab host has a token.
- Registry credentials in `~/.npmrc`, `~/.m2/settings.xml` and `pip.conf`. For pip the first of `~/.config/pip/pip.conf`, `~/Library/Application Support/pip/pip.conf` and `~/.pip/pip.conf` is used.
- Your git `user.name` and `user.email`.

Inside, the matching files hold placeholders only. So `glab`, `git push` to your glab hosts, npm, pip and Maven work as on your Mac, while the proxy fetches the real value on your Mac.

A registry, mirror or index without a credential and without an `egress.allow` entry prints a notice. It names the entry to add.

A derived glab token reaches everything it can on its host and its API host.

To narrow what is derived, list the hosts you want in `credentials.derive.hosts`. `*.domain` entries work. Set `credentials.derive.enabled` to `false` to derive nothing.

Some credentials are not derived, for example uv's config and tokens that a project file reads from a variable. The list is in [known gaps](THREAT-MODEL.md#5-known-gaps).

### Rules you write

`credentials.rules` adds credentials by hand. This rule sends a token from a host command to an internal gateway:

```json
{
  "credentials": {
    "rules": [
      {
        "id": "llm-gateway",
        "host": "gateway.example.internal",
        "header": "authorization",
        "template": "Bearer {secret}",
        "secret": { "command": ["/usr/local/bin/example-sso", "token", "--audience", "gateway"] }
      }
    ]
  }
}
```

| field | meaning |
| --- | --- |
| `id` | A unique name: letters, digits, `.`, `-` and `_`. |
| `host` | The host name the rule applies to. The host becomes reachable. |
| `port` | Optional. The default is 443. |
| `pathPrefix` | Optional. Only paths that start with it, such as `/npm/`. |
| `placeholder` | Optional. A stand-in value starting with `pinata-` that you put in a tool's config inside. |
| `header` | Optional. A header the proxy sets on every matching request. |
| `template` | Optional. The header value, with `{secret}` where the secret goes. Needs `header`. |
| `secret` | Where the real value comes from (below). |

A rule needs a `placeholder` or a `header`. With only a placeholder, the proxy swaps it for the secret in authorization headers. Your rules win over derived rules for the same host.

The `secret` takes one of these forms:

| form | the secret is |
| --- | --- |
| `{ "env": "NAME" }` | a variable of the shell that runs `pi`, read at launch |
| `{ "file": "/path", "pointer": "/a/b" }` | a value at a JSON pointer in a host file |
| `{ "file": "/path", "format": "npmrc", "key": "…" }` | a value in a tool config, with `format` one of `json`, `npmrc`, `ini`, `maven-servers` |
| `{ "command": ["cmd", "arg"] }` | the output of a host command, such as a keychain or password manager tool |
| `{ "piAuth": "<provider>" }` | host pi's credential for that provider; add `"bearer": true` for its bearer token |
| `{ "mcpOAuth": { "server": "<name>", "url": "https://…" } }` | the OAuth token of an MCP server you signed in to with `pi mcp login` |

The `env` form and the `file` form with `format` accept `"urlPassword": true` or `"urlUsername": true`. The value is then a URL, and the secret is its password or its user name. The `file` form with `pointer` refuses them.

A `command` prints the secret, or JSON `{ "token": "…", "expiresAt": "<ISO 8601 time>" }`. Its result is kept for 300 seconds, or until 30 seconds before `expiresAt`.

A run that takes longer than 30 seconds fails. It runs with a minimal environment, so a tool that needs a session variable fails. The command first runs when the proxy needs it, not when the config loads.

### Secrets of stdio MCP servers

A stdio MCP server's env values and flag values become placeholders in two cases. The first is a secret-like name: one with token, secret, password or apikey in it, or ending in `key`. The second is a secret-like value: `Bearer …`, a JWT, or a URL with a user name or password.

Nothing swaps these placeholders until a `credentials.rules` entry covers the host the server calls. A secret under a plain name, or a purely numeric one, is copied as it is. Give it a clearer name or a rule.

### MCP sign-in

MCP servers sign in on your Mac. Host pi keeps the tokens in `~/.pi/agent/mcp-auth.json`, and the proxy adds them to requests.

- **At launch.** If a token is missing or expired and cannot be refreshed, pinata runs `pi mcp login <name>` on your Mac first. This happens only when pi runs in a terminal. After a failed sign-in it is skipped for a day.
- **During a session.** When a token expires or is rejected, the proxy opens the sign-in in your browser. It does so at most once per server per minute, and waits 10 minutes after a failed sign-in or a rejected token. Pi inside is told to retry.
- **Never signed in.** Requests go out without a token, so servers that need no sign-in work.
- **Project-only servers.** A server defined only in a project's `.pi/mcp.json` gets no token. Add it with `pi mcp add` instead.

## Corporate proxy and TLS inspection

### Parent proxy

Pinata's proxy forwards through your company proxy when the shell that runs `pi` sets one. It reads `HTTPS_PROXY`, else `https_proxy`, and `NO_PROXY`, else `no_proxy`, from the shell that runs `pi`. It does not read the macOS system proxy or a PAC file.

- Only an `http://` proxy URL works. For anything else the launch prints a warning and connects directly.
- Unset `HTTPS_PROXY` and `https_proxy` for `pi` to connect directly.
- NTLM and Kerberos proxies need a local relay such as `px` or `cntlm`.

Image builds use the same proxy. A proxy address on `localhost` is pointed at your Mac. A proxy URL with a user name or password is refused for builds, since it would be written into the image. Use a proxy without credentials, or a prebuilt image with no extra layer.

### Extra CA certificates

If a proxy on your network inspects TLS, add its CA certificate. An entry takes one of two forms:

```json
{
  "tls": {
    "extraCa": [
      { "sha256": "3F:A1:...:9C" },
      { "file": "~/corp-ca.pem" }
    ]
  }
}
```

- `{ "sha256": "<fingerprint>" }` names a CA in the macOS System or login keychain by its SHA-256 fingerprint: 64 hex digits, colons and case optional. Pinata reads both keychains with `security find-certificate -a -p` and takes the certificate whose fingerprint matches; a keychain it cannot read is skipped. The fingerprint is the same on every Mac that has the CA, so a team can share the line. On a host other than macOS use `file`.
- `{ "file": "<path>" }` reads a PEM file, absolute or under `~`. Use it for a CA that is not in a keychain.

Every certificate must be a CA (or a self-signed root without the CA flag) and within its validity dates. A launch stops when a fingerprint is in neither keychain, a file is missing, a certificate is not a CA, or it has expired; the message names the entry and the certificate's subject.

The CAs are trusted by pinata's proxy, during the image build and inside the container. The image layer, built at every change of these CAs, adds them with pinata's CA to the system store, `/etc/ssl/certs/ca-certificates.crt`, which `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `NODE_EXTRA_CA_CERTS` point at. For every JDK in the image, found by its `bin/keytool`, it imports them into the JDK's `cacerts` and writes the proxy into its `net.properties` (`http.proxyHost` and `https.proxyHost` `pinata-proxy`, port `3128`, `http.nonProxyHosts` `localhost|127.*|[::1]|pinata-proxy`), so Java tools need no proxy flags; a JDK missing one of these files is skipped with a line in the build output. A JDK installed later, such as one in a volume, gets the same with `/usr/local/lib/pinata/trust-jdk.sh <jdk home>` (see [a JDK in a volume](#a-jdk-in-a-volume)). The layer needs `update-ca-certificates` (Debian's `ca-certificates` package) in the base image, `image.reference` included; without it the build stops with `the sandbox layer needs update-ca-certificates`.

Behind Zscaler or another inspecting proxy:

1. Run `pinata doctor`. When it sees TLS interception its `tls inspection` check fails and prints the line to add, `{ "sha256": "<fp>" }`, with the fingerprint of the root CA it found in the System or login keychain. When the root is in neither, it names the issuer instead, even when the proxy sends the root itself: get that CA as PEM from your IT and add `{ "file": "<path>" }`.
2. Copy that line into `tls.extraCa` in `~/.pi/agent/pinata/config.json`.
3. Quit every pi in the sandbox and launch again.

What trusting the CA means:

- A CA certificate is public. Mounting it into the sandbox leaks nothing.
- Trusting it lets whoever holds its key read the sandbox's TLS traffic, as the corporate proxy already does for every program on your Mac.
- Pinata's proxy trusts these CAs for credential-rule hosts too, so the inspecting proxy sees the real tokens pinata injects, exactly as it does when pi runs on the host.
- Only pinata's own config file can add a CA. No project file can.

Pinata also installs them in the VM's trust store, so the VM's container engine pulls images through the inspecting proxy. That restarts the engine, so it waits for a launch with no other pi session running; until then a notice says so. The engine gets up to a minute to come back. If an image pull still fails with an x509 error, the CA is not declared yet: run `pinata doctor` and add the line it prints.

## Databases and other services

The sandbox has no container engine and cannot reach your Mac's `localhost`. So `docker compose` and Testcontainers do not work inside. Declare the server in [`services`](#services), or run it inside the sandbox yourself:

1. Add it to `image.packages` in your config, for example `postgresql` and `redis-server`.
2. Start it with its data under `/tmp`:

   ```bash
   PATH=/usr/lib/postgresql/15/bin:$PATH        # Debian bookworm's PostgreSQL
   initdb -D /tmp/pg --no-locale -E UTF8 -U postgres && pg_ctl -D /tmp/pg -o "-k /tmp" -l /tmp/pg.log start >/dev/null 2>&1
   redis-server --dir /tmp --daemonize yes --logfile /tmp/redis.log >/dev/null 2>&1
   ```

   When pi's agent starts the server from a tool call, redirect its output as above. A daemon that keeps the tool call's stdout or stderr open makes the call wait until the daemon exits.

3. Point your tests at `127.0.0.1`.

`/tmp` lives in memory. The data counts against the container's memory and is gone when pi exits.

## Sandbox status file

Pinata renders `tools/status.json` into the repo's render folder (read-only in the container) and sets `PINATA_STATUS` to its guest path, `/opt/pinata/render/tools/status.json`. It tells the agent what the sandbox gives it, derived only from the configuration: `version` (1); `proxy` (`url`, plus `denials` and `health`, two URLs that answer a plain GET from inside the sandbox); `resources` (the configured `cpus`, `memoryGiB`, `pids`, `openFiles`, `shmMiB` that are set); `volumes` (guest `target` of each `mounts.volumes` entry); `binds` (guest `target` of each `mounts.binds` entry, never the host source); `setup` (the configured commands); and `services`. It holds nothing per launch, no tokens and no host paths. `PINATA_STATUS` is a name pinata sets, so `env.set` and `env.allow` refuse it.

Each `services` entry is `{ "name", "command", "ready", "ports" }`, with `ready` the `ready.command` when one is set and `ports` the ports the agent reaches on `localhost`. The agent reads these, so a secret belongs in the service's `env`, never in `command` or `ready.command`.

## Sharing one config across a team

A team shares the config by giving everyone the same file: copy it to `~/.pi/agent/pinata/config.json` on each Mac. It is still each user's own file, and each user can change it. [examples/config.json](examples/config.json) is a starting point. It does the following:

- Allows an internal gateway, registry and git hosts. It also lists them as private hosts, since they resolve to internal addresses.
- Denies a paste site.
- Adds the company CA.
- Adds a credential for the gateway, from a host command, and one for the registry, from a variable.
- Leaves credential derivation on, so `glab`, npm, pip and Maven work as on the host.
- Points npm at the internal registry with `env.set`, sets `CI`, and raises the memory, process and `/dev/shm` limits of the container.
- Keeps the npm cache, a fixtures folder and the database's logs in volumes that every session shares.
- Copies a fixtures folder of your Mac into its volume once (see [below](#seed-a-volume-from-a-folder-of-your-mac)).
- Runs a database service on port 5432, whose log volume the agent also mounts (see [below](#read-the-logs-of-a-service)).

Replace the `*.example.internal` names with your own hosts and the service with your own, and add the package registries your team uses to `egress.allow`. A Mac without the fixtures folder starts with an empty fixtures volume and a warning.

`pi install`, `pi mcp …`, every `pi update` and `pi config` without `-l` run host pi on the host. They run before the config is read.

## Recipes

Each recipe is a part of the one config file; merge it with the keys you already have.

### Seed a volume from a folder of your Mac

A volume starts empty. To start the sandbox's Maven repository from the one on your Mac, give its volume a `source`:

```json
{
  "mounts": {
    "volumes": [{ "target": "~/.m2/repository", "name": "maven", "source": "~/.m2/repository" }]
  }
}
```

The first launch copies `~/.m2/repository` into the volume, artifacts you built locally included, and later launches find the marker and copy nothing. Name `~/.m2/repository`, not `~/.m2`, so `settings.xml` and its credentials stay on your Mac; pinata renders the sandbox's own `~/.m2/settings.xml`. Every session, in any folder, shares the one copy. Delete `~/.m2/repository/.pinata-seeded` inside the sandbox to copy again at the next launch. See [Copy a folder into a volume](#copy-a-folder-into-a-volume).

### Shared package caches

Package caches in user volumes outlive each session and are shared by all your sandboxes, so an install in one repository reuses what another one downloaded:

```json
{ "mounts": { "volumes": ["~/.npm", "~/.cache/pip"] } }
```

The volumes start empty and never use your Mac's folders. Every sandbox can write to them, so keep them to package caches. See [Volumes](#volumes).

### The GitHub CLI

The image has no `gh`, and pinata reads no gh config. Plain git over HTTPS to github.com has no credential in the sandbox: a clone of a public repository works once `github.com` is reachable, a push or a private clone fails, since `GIT_TERMINAL_PROMPT` is `0` and git cannot ask. An SSH remote fails too, since the sandbox has no SSH keys.

This config gives gh and git over HTTPS for github.com: the `gh` package from Debian's own sources, `GH_TOKEN` set to a placeholder, one credential rule per host (`github.com`, `api.github.com` and `uploads.github.com`) sharing that placeholder, whose secret is `gh auth token --hostname github.com` on your Mac, and git's credential helper and HTTPS rewrites set from `setup`. Use your own placeholder: `pinata-` and 24 lowercase hex digits, such as `pinata-` followed by the output of `openssl rand -hex 12`. `pinata doctor` reports a `GH_TOKEN` of any other shape as a value that is not a placeholder. Replace `/opt/homebrew/bin/gh` with what `command -v gh` prints on your Mac. The command runs on your Mac with a short list of variables, so give an absolute path.

```json
{
  "image": { "packages": ["gh"] },
  "env": { "set": { "GH_TOKEN": "pinata-6a1f0c2e9b7d4a3851e0f2c4" } },
  "credentials": {
    "rules": [
      { "id": "github", "host": "github.com", "placeholder": "pinata-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } },
      { "id": "github-api", "host": "api.github.com", "placeholder": "pinata-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } },
      { "id": "github-uploads", "host": "uploads.github.com", "placeholder": "pinata-6a1f0c2e9b7d4a3851e0f2c4", "secret": { "command": ["/opt/homebrew/bin/gh", "auth", "token", "--hostname", "github.com"] } }
    ]
  },
  "setup": [
    ["git", "config", "--global", "credential.https://github.com.helper", "!gh auth git-credential"],
    ["git", "config", "--global", "--add", "url.https://github.com/.insteadOf", "git@github.com:"],
    ["git", "config", "--global", "--add", "url.https://github.com/.insteadOf", "ssh://git@github.com/"]
  ]
}
```

- `gh` reads `GH_TOKEN` inside and sends the placeholder; `gh auth git-credential` gives git the user `x-access-token` and the same placeholder; the proxy puts the real token in its place on the hosts the rules name. A rule also makes its host reachable.
- `setup` runs at every launch, after the home is in place, so the lines land in that launch's `~/.gitconfig`. It replaces nothing the rendered config sets.
- For git alone, without `gh` in the image, use the helper `!f() { echo username=x-access-token; echo password=pinata-6a1f0c2e9b7d4a3851e0f2c4; }; f` instead, and leave out `image.packages` and `GH_TOKEN`.
- Archives and release downloads go through other hosts, such as `codeload.github.com` and `objects.githubusercontent.com`; list them in `egress.allow` if you need them.
- For a gh config folder other than the default, put it in the rule's command, as `["/usr/bin/env", "GH_CONFIG_DIR=<folder>", "<gh>", …]`.
- For a GitHub Enterprise host, add rules for it (and for `api.<host>` on `.ghe.com`) with its own placeholder and `--hostname <host>`, the `setup` lines with its name, and `GH_HOST` or `GH_ENTERPRISE_TOKEN` in `env.set`. `GH_ENTERPRISE_TOKEN` is one value for every enterprise host, so two enterprise hosts with different tokens need a `hosts.yml` inside, written from `setup` (`sh -c` with a `printf` into `~/.config/gh/hosts.yml`), with each host's placeholder.

The config names your gh hosts and your gh binary itself, so a config shared by a team needs gh at the same path on every Mac. Pinata does not check where that gh lies; an absolute path outside your projects keeps a sandbox from changing it.

### Git remotes with SSH URLs

The sandbox has no SSH keys. The rendered git config already rewrites `git@<host>:` and `ssh://git@<host>/` to HTTPS for your glab hosts. For another host, github.com among them ([the GitHub CLI](#the-github-cli)), rewrite with git's own variables in `env.set`, and give the proxy the credential:

```json
{
  "env": {
    "set": {
      "GIT_CONFIG_COUNT": "2",
      "GIT_CONFIG_KEY_0": "url.https://git.example.internal/.insteadOf",
      "GIT_CONFIG_VALUE_0": "git@git.example.internal:",
      "GIT_CONFIG_KEY_1": "url.https://git.example.internal/.insteadOf",
      "GIT_CONFIG_VALUE_1": "ssh://git@git.example.internal/"
    }
  },
  "credentials": {
    "rules": [
      {
        "id": "git-example",
        "host": "git.example.internal",
        "header": "authorization",
        "template": "Basic {secret}",
        "secret": { "command": ["/bin/sh", "-c", "printf '%s' \"git:$(/usr/bin/security find-generic-password -s git-example -w)\" | /usr/bin/base64"] }
      }
    ]
  }
}
```

The command prints `user:token` in base64, as Basic authentication wants it; use the user name your server expects and your own secret store. The rule makes the host reachable; add it to `egress.privateHosts` when it resolves to an internal address. The token stays on your Mac.

### Read the logs of a service

A service volume and an entry of `mounts.volumes` with the same `name` are one volume, so the agent can read what the service writes there:

```json
{
  "mounts": { "volumes": [{ "target": "/var/log/db", "name": "db-logs" }] },
  "services": [
    {
      "name": "db",
      "image": "registry.example.internal/db:16",
      "command": ["db-server", "--listen", "0.0.0.0:5432", "--log-dir", "/logs"],
      "ports": [5432],
      "volumes": [{ "name": "db-logs", "target": "/logs" }]
    }
  ]
}
```

The service runs as `1000:1000`, the sandbox user's ids, so the agent owns the files and can change them. The config is refused if a service that mounts `db-logs` sets another `user`.

### A JDK in a volume

The image layer gives every JDK in the image the sandbox CAs and the proxy. A JDK you install later, such as one kept in a user volume, gets the same from `trust-jdk.sh`, run from `setup` as the sandbox user, which owns the volume:

```json
{
  "mounts": { "volumes": ["/opt/jdks"] },
  "setup": [
    ["sh", "-c", "for home in /opt/jdks/*/; do [ -d \"$home\" ] || continue; /usr/local/lib/pinata/trust-jdk.sh \"$home\"; done"]
  ]
}
```

For each folder named, the script imports the sandbox CAs into the JDK's `cacerts` (and removes ones the sandbox no longer has), merges the proxy lines into its `net.properties`, and prints `pinata trust: <home> trusts the sandbox CAs and uses the sandbox proxy`. It leaves files that already match as they are, so it can run at every launch. A folder without `bin/keytool`, `lib/security/cacerts` (or `jre/lib/security/cacerts`) or `conf/net.properties` (or `jre/lib/net.properties` or `lib/net.properties`) fails with `pinata trust: <home> has no <file>`, which stops the launch, so keep only JDKs in that volume. The script ignores `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS` while it runs.

### A private HTTPS package server

Point a tool at your server with its own variable in `env.set`, and let the proxy reach it:

```json
{
  "egress": { "allow": ["packages.example.internal"], "privateHosts": ["packages.example.internal"] },
  "env": {
    "set": {
      "PIP_INDEX_URL": "https://packages.example.internal/pypi/simple/",
      "NPM_CONFIG_REGISTRY": "https://packages.example.internal/npm/"
    }
  }
}
```

The URL must be `https://`: the proxy answers plain HTTP with 403, and `egress.allow` refuses port 80. Keep credentials out of the URL, since every `env.set` value is visible to the agent; when the server needs one, a [credential rule](#rules-you-write) for its host replaces the `egress.allow` entry.

### Several toolchain versions and a headless browser

The image has one Node and one Python. For more:

- Add Debian packages with `image.packages`, such as `chromium` for a headless browser, or install with `image.dockerfile`. Everything in the image is the same for every repository.
- Keep a version manager's install folder in a user volume, such as `"~/.local/share/mise"`, so versions are downloaded once for all repositories, and list the hosts it downloads from in `egress.allow`.
- Give the browser room with `resources.shmMiB`, such as `1024`, and `resources.memoryGiB`.

## Environment variables pinata reads

| variable | effect |
| --- | --- |
| `PINATA_USER_CONFIG` | Path of the config file. |
| `PINATA_STATE_DIR` | Pinata's state folder. The default is `pinata/state` in host pi's agent folder. A relative value is made absolute against your folder and resolved to its real path, so one folder is one install however it is spelled. The daily removal of state files this build does not use runs only in the default folder, never in one this variable names. |
| `PI_CODING_AGENT_DIR` | Host pi's agent folder. The default is `~/.pi/agent`. The config file and the state follow it, so two shells with different values use separate configs, CAs and state. |
| `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy` | The parent proxy. |
| `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME` | Where the glab config is read. A path inside the repository is ignored. |
| Provider API key variables | Derived as credentials. The proxy reads them on your Mac. |
| The names in `env.allow` | Passed into each pi run. |
| `COLIMA_HOME` | Ignored. Pinata always uses `~/.colima/pinata`. |
| `PINATA_ROOT` | Read by `pinata init`: the folder that holds your projects (a relative path counts from the current folder). On a first run the interactive setup offers it first; `--yes` writes it to a config without `workspaceRoot`, and refuses your home or a folder that holds it. |
| `PINATA_PLAIN` | When set, `pinata init` asks its questions as numbered lines that you answer by typing, with no menu, no spinner and no colour, for screen readers and plain terminals. |
| `CI` | When set, `pinata init` without `--yes` refuses instead of asking, and never opens `/dev/tty`. |
