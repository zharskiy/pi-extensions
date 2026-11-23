# pi-sandbox

Run the pi coding agent on your Mac as you always do, with the agent kept in a sandbox.

Part of [pi-extensions](../README.md).

## What it does

`pi-sandbox` installs itself as `pi`. You keep typing `cd <folder> && pi`, and your providers, MCP servers, settings, packages and skills work as before, with the exceptions listed under [What is different inside the sandbox](#what-is-different-inside-the-sandbox) (a symlinked skill, for one, stays out).

Pi runs in a Linux container inside a small virtual machine (Colima). The container sees the repository, or plain folder, you started pi in, and nothing else of your home.

The container never holds your real keys. Its only way out is a proxy on your Mac. The proxy lets through only the hosts on an allow-list, and adds your credentials on the way out.

```mermaid
flowchart LR
  subgraph mac["Your Mac"]
    proxy["proxy: allow-list, adds credentials"]
    subgraph vm["Colima VM"]
      box["container: pi and its tools"]
    end
  end
  box -- "every request" --> proxy
  proxy -- "allowed hosts only" --> net["providers, registries, the web"]
```

## Install

You need:

- macOS 13 or newer.
- [Homebrew](https://brew.sh).
- Colima 0.8.0 or newer. The script installs it with Homebrew if it is missing.
- Node 22.19 or newer, with npm.
- git.
- pi, installed with pi's own installer or with `npm install -g @earendil-works/pi-coding-agent`. The launcher runs the managed install in `~/.pi/agent` on the host (for provider credentials, host commands and `--no-sandbox`), or, without one, the pi in npm's global packages (`npm root -g`). A pi found only on `PATH` or in a project's `node_modules` is not used, nor an npm global pi linked in from outside npm's global folder (`npm link`), or one that lies in a folder a sandbox has run in, or in the folder you start pi in (or its git root) when a sandbox could run there. A git checkout no sandbox has used, such as `/opt/homebrew` or `~/.nvm`, does not count.

```bash
curl -fsSL https://pi.dev/install.sh | sh
npm install -g --omit=peer pi-extensions-mz
"$(npm root -g)/pi-extensions-mz/launcher/install.sh"
```

Without either install, `install.sh` stops before it changes anything and says to install pi one of these ways and run it again.

The script puts `~/.local/bin` first on `PATH` in your shell startup files, then runs `pi sandbox init`, which asks which folders hold your projects, shows the VM size it picked for this Mac, and creates the VM when you choose Apply. Open a new terminal afterwards.

In a terminal, Homebrew, npm, `pi sandbox init` and the smoke `pi sandbox doctor` print as if you ran them yourself, and each step starts after a blank line and a rule. Piped or redirected, their output is indented under plain `[n/6]` lines.

If `~/.local/bin/pi` is pi's own managed install, the script replaces that link. An existing pi-sandbox link or wrapper is replaced too. Any other file there stops the install.

To change the folders or the VM size later, run `pi sandbox init` again. It plans the same VM shares as a launch, the folders of `mounts.binds` included.

### Set up the sandbox

`pi sandbox init` sets up the sandbox in three short steps, then shows a review: the project folders, the VM size and the settings write-back. Nothing is saved until you choose Apply. A first run looks like this (in plain mode; a normal terminal draws the same as a menu you move through with the arrow keys):

```
pi sandbox setup
This Mac: 12 CPUs, 32 GiB memory, 412 GiB free disk
Sandbox VM: not created yet
Nothing is saved until you choose Apply.

Which folders hold your projects?   step 1 of 3
  1) [x] ~/Projects (14 git repositories)
  2) [x] ~/work (3 git repositories, you are here)
  3) [ ] ~/src (no git repository found)
Folders [1 2]:

VM size   step 2 of 3
  1) Automatic (8 CPUs, 10 GiB memory, 60 GiB disk)
  2) Custom...
Choose [1]:

Copy settings changed in the sandbox back to your pi?   step 3 of 3 (Y/n):

Review
  Project folders: ~/Projects, ~/work (chosen)
  VM size: 8 CPUs, 10 GiB memory, 60 GiB disk (automatic)
  Settings write-back: on (default)
  1) Apply
  ...
Saved ~/.pi/agent/pi-sandbox/config.json
Created the VM in 54s: 8 CPUs, 10 GiB memory, 60 GiB disk
Done. The sandbox is ready.
```

- **Project folders.** The list holds the usual project folders of your home (`~/Projects`, `~/Developer`, `~/code` and the like) and the top folder of where you are, with the number of git repositories in each; those with repositories start checked, and you can add any other folder. Adding a folder inside a checked one narrows the choice: the new folder is checked and the wider one unchecked, with a line saying so; adding a folder that holds a checked one is refused until you uncheck that one. Pi starts only inside a chosen folder, and the VM shares only these folders (writable), pi's session folder `~/.pi/agent/sessions` (writable) and the launcher's `state/vm` folder (read-only, the rendered files). With no folder chosen, the VM shares your whole home, writable, so a container escape reaches all of `~`; setup asks before it allows that.
- **VM size.** Automatic follows this Mac: its CPU count from 2 to 8, half its memory from 4 to 10 GiB, and a 60 GiB disk. Custom asks for each value; the disk can only grow.
- **Settings write-back.** On by default: preference changes made inside the sandbox are copied to your pi on this Mac (see [Settings written back](CONFIGURATION.md#settings-written-back)).

Run again, `pi sandbox init` opens the review with your current settings; a config without `workspaceRoots` (you chose to share your whole home, or wrote the file by hand) asks the three steps again first. It writes only `workspaceRoots`, `vm.cpus`, `vm.memoryGiB`, `vm.diskGiB` and `writeBack.enabled` in `~/.pi/agent/pi-sandbox/config.json`, and keeps every other key, their order, the line endings and a symlinked file's link; the file is re-indented to its own first indent, and a key written twice keeps its last value. The review shows the re-indent before you apply. Apply creates the VM, or restarts it with the new size or folders when no pi session runs; while sessions run, it keeps the VM as it is and the first pi you start after they all exit restarts it. Before Apply, ctrl-c or Cancel writes nothing and exits with status 130. During the VM step after Apply the config is already saved: ctrl-c twice stops waiting (also exit 130) while colima goes on, and running `pi sandbox init` again, or the next pi start, finishes the VM step.

`PI_SANDBOX_PLAIN=1` asks the same questions as numbered lines that you answer by typing, with no menu to move through, no spinner and no colour: for screen readers and plain terminals. A dumb or unset `TERM` gets plain mode too, read line by line without any cursor control (and so without Tab completion of paths).

Without a terminal (CI, a provisioning script, `ssh host install.sh`), `pi sandbox init` refuses, and `pi sandbox init --yes` asks nothing: it keeps the settings in the file and applies them to the VM, printing the same lines as the plain setup: the review of the settings, the file changes and the VM action first, then the progress and the result. `install.sh` uses `--yes` when it finds no terminal or `CI` is set. To name the project folders there, set `PI_SANDBOX_ROOTS`, which `--yes` writes to a config without `workspaceRoots`:

```bash
PI_SANDBOX_ROOTS="$HOME/Projects:/Volumes/Work" "$(npm root -g)/pi-extensions-mz/launcher/install.sh"
```

A config whose `workspaceRoots` name other folders stops `--yes` (order, a trailing `/` and `~` against the full path do not matter). So does a config with any invalid key: `--yes` prints the error like every other command, writes nothing and exits 1, and never fixes a value for you. When colima does not answer in time, `--yes` saves the config, says the VM could not be checked and exits 0; the next pi start applies the size and the shares. For the VM size, set `vm` in the config first (see [VM size](CONFIGURATION.md#vm-size)). When the VM does not share the first root yet, the install's smoke check runs only the host checks and says the sandbox part runs at the first pi launch. See [Workspace roots](CONFIGURATION.md#workspace-roots).

<details>
<summary>Install from a checkout</summary>

```bash
curl -fsSL https://pi.dev/install.sh | sh
git clone https://github.com/zharskiy/pi-extensions.git
cd pi-extensions
npm install
launcher/install.sh
```

Install pi first here too, with pi's own installer or `npm install -g`: the launcher runs the managed install, else npm's global pi, never the pi in the checkout's `node_modules` or a pi on `PATH`. The script writes a wrapper script at `~/.local/bin/pi` that runs this checkout. Without either, the launch, `pi sandbox doctor`, `--no-sandbox` and the host commands say so in one line, with the same remedy.

</details>

## Quick start

1. Start pi in a project:

   ```bash
   cd ~/code/my-app && pi
   ```

   When the install script's smoke check ran, it already built the sandbox image, so pi starts in seconds; when it was skipped, the first launch builds it. Behind a proxy that inspects TLS the smoke check fails until [`tls.extraCa`](CONFIGURATION.md#corporate-proxy-and-tls-inspection) names the proxy's CA, which `pi sandbox doctor` prints. When the image must be rebuilt, for example after a pi update, the launch prints `preparing pi sandbox, one time` and takes a few minutes.

2. Work as usual. A tool that reaches a host that is not allowed gets an error page saying what to do.

3. Exit pi. The launcher names each host it blocked:

   ```
   pi-sandbox: docs.example.com was blocked in the sandbox; run pi sandbox egress allow docs.example.com on the host
   ```

4. To let pi reach that host, allow it. The grant applies to every session, at once, also to running ones.

   ```console
   $ pi sandbox egress allow docs.example.com
   allowed docs.example.com
   ```

5. If something does not work, run `pi sandbox doctor`. It reports each check by area (host, sandbox, network, credentials, leak sweep), puts the reasons and a `hint:` under each problem, lists the launch notices at the end and closes with one `result:` line. The credential rules that pass share one line; `--verbose` lists each.

## Everyday use

In the table, *host pi* is pi's managed install on your Mac, or without one the pi in npm's global packages. A *grant* is a host you allowed. *Overlay* and *agent* volumes are storage the VM keeps for the folder's build output and pi's own files.

| command | what it does |
| --- | --- |
| `pi [args...]` | run pi in the sandbox for this repository; pi's exit code is the launcher's |
| `pi --no-sandbox [args...]` | run host pi, outside the sandbox |
| `pi install\|remove <source>` | with host pi on the host (-l passes through into the sandbox) |
| `pi mcp add\|remove\|login\|logout ...` | with host pi on the host |
| `pi auth ...` | with host pi on the host, against the logins the proxy uses |
| `pi [command] --help` | pi's help, with host pi on the host |
| `pi --list-models [search]` | with host pi on the host |
| `pi --export <file> [out]` | with host pi on the host |
| `pi --version` | the pi version the sandbox runs, without starting a sandbox |
| `pi update [target]` | update host pi, its packages or its model catalogs, with host pi on the host |
| `pi config` | the user resource config, with host pi on the host (-l passes through into the sandbox) |
| `pi sandbox init [--yes]` | set up or change the project folders, VM size and settings write-back, then apply them to the sandbox VM; --yes asks nothing and applies the current settings |
| `pi sandbox status` | runtime, services, container, proxy, image, launches, grants, overlays, volumes |
| `pi sandbox config [--json]` | the effective config and whether each key comes from the config file or the default |
| `pi sandbox egress allow <host[:port]>` | allow a host for every session until revoked |
| `pi sandbox egress revoke <host[:port]>` | remove a grant |
| `pi sandbox egress list [--denied]` | the grants, or the hosts the proxy blocked |
| `pi sandbox reset [--services]` | remove this folder's sandbox with its overlay and agent volumes, once none of its sessions runs; --services instead removes the sandbox's services and their data, once no pi session runs |
| `pi sandbox stop` | stop the services and the sandbox VM when no pi session runs |
| `pi sandbox doctor [--verbose]` | prepare the sandbox like pi and report each check by area, with a hint per problem; --verbose lists every credential rule |
| `pi sandbox --version`, `pi sandbox help` | version and usage |

`pi uninstall <source>` also runs with host pi on the host. Host pi loads no extension for `pi --help` and `pi --list-models`, so help omits the flags extensions register and the list omits providers only an extension registers; `pi list`, `pi mcp list` and `pi config -l` run in the sandbox, and `pi --version` asks pi inside when `image.reference` and `image.digest` pin the image. `egress allow` uses port 443 unless you name one, and refuses wildcards, IP addresses and port 80 ([rules](CONFIGURATION.md#network-access)).

`pi update` runs the host pi's own update from an empty folder, and the next launch rebuilds the image. A local path as the source (`./ext`, `~/ext`) is made absolute against your folder first. Every other `pi update` form (`--all`, `--extensions`, `--extension <source>`, `<source>`, `--models`, `--force`) runs host pi from an empty folder, so it updates the host's packages and the host pi, never a copy inside the sandbox; when the target includes pi itself it names the pi version the sandbox follows. Without a host pi it says how to get one. To update the launcher itself, run `npm install -g --omit=peer pi-extensions-mz` (or `git pull` in a checkout).

After a reboot or `pi sandbox stop`, the next `pi` starts the VM again. A failure prints `pi-sandbox: <message>`, often with a `hint:` line.

## What is different inside the sandbox

- **Log in on the host.** Provider `/login` does not work inside. Run `pi auth login <provider>`, or `pi --no-sandbox`, then `/login`.
- **Packages and MCP servers change on the host.** The sandbox picks up `pi install` and `pi mcp add` at its next launch. Npm and git packages inside follow the versions installed on your Mac: after `pi update` (or any other change on the host) the next launch says `sandbox packages follow the host: reinstalling <n> packages` and pi inside installs those versions. An npm source without a version or with a range or tag (`npm:x`, `npm:x@^1`, `npm:x@latest`) is pinned to the host's version; an exact pin, an alias (`npm:x@npm:other@2`) and a git, URL or file spec stay as you wrote them. A git source is pinned to the host checkout's commit only when that commit is on the remote (a remote branch or tag); with local commits or after an upstream force-push it stays unpinned, and a `#ref` source is never pinned. When another session of the folder is running, git checkouts are not refreshed and the launch says `sandbox packages follow the host: git packages refresh at the next launch (another session is running)`. A launch that finds the folder's record of package versions missing or unreadable, the folder's first launch for one, clones every git package again. The reinstall needs the registry or git host in `egress.allow`; without it pi reports the package as failed to install instead of running an old copy.
- **Skills come as copies, and links stay out.** The sandbox gets a copy of `~/.pi/agent/skills` and of `~/.agents/skills` (and of the agents, prompts, themes and extensions in `~/.pi/agent`), refreshed at every launch, without secret-looking files, files over 8 MiB and private keys. The copy follows no symlink: a linked skill dir or file, or a linked `~/.agents/skills`, is missing inside, and the first launch that finds it names it (`render: missing in the sandbox, because the launcher follows no symlinks: …`). Make it a real directory to carry it. One link needs nothing: a skill dir directly in `~/.pi/agent/skills` that links to a skill dir directly in `~/.agents/skills`, as `npx skills add` makes, when `~/.agents/skills` is a real directory. That skill arrives through `~/.agents/skills`. Every other link is named, a nested one or one inside `~/.agents/skills` included. The line is printed once per folder for the same set of links, so a skill still missing later says nothing more.
- **Resource paths in `settings.json` are rewritten.** An `extensions`, `skills`, `prompts` or `themes` entry inside the repository becomes its absolute path, one anywhere inside `~/.pi/agent` (pi's package checkouts under `git/` and `npm/` included) or `~/.agents/skills` points at the same path inside the sandbox, and any other path is left out with a line naming it. Relative patterns (`!old-*`, `-skills/x`) and `builtin:` entries stay as written.
- **No Docker.** `docker compose` and Testcontainers do not work. Declare a database in [`services`](CONFIGURATION.md#services), or [run one inside](CONFIGURATION.md#databases-and-other-services).
- **Only https leaves, and your Mac's `localhost` is out of reach.** Servers you start inside answer on `127.0.0.1`.
- **Java goes through the proxy.** `~/.m2/settings.xml` points Maven at `pi-sandbox-proxy:3128`, with no credentials, and every JDK in the image has the proxy in its `net.properties`. A JDK installed later needs `trust-jdk.sh` ([a JDK in a volume](CONFIGURATION.md#a-jdk-in-a-volume)).
- **Home lives in memory.** `/home/pi` and `/tmp` are emptied when pi exits. Pi's own files survive in the folder's agent volume. To keep a tool cache or other data, list its folder in `mounts.volumes`.
- **Build output has its own copy.** `node_modules`, `.venv`, `target` and `.gradle` get their own volume when a matching lockfile sits beside them ([list](CONFIGURATION.md#build-output-overlays)). Run your install command, such as `npm install`, once inside.
- **Large builds keep your Mac's open files in check.** The VM holds one file open on your Mac for each file it has cached from your folders. While pi runs, the launcher drops that cache when the count nears your Mac's limit, so a build over a very large tree does not run your Mac out of file descriptors ([File cache](CONFIGURATION.md#file-cache)).
- **Leftovers of older builds go away on their own.** Once a day the launcher removes the stopped containers, unused volumes and free networks that an older launcher build left in the VM: named `pi-sandbox-*`, marked as the launcher's own, and without the install label it sets now. A running one stays until it stops, and the engine keeps a volume or network still in use. Shared volumes (`pi-sandbox-shared-*`) are never removed this way. An older build's agent volume holds the pi settings that build kept inside the sandbox, and they go with it. Files in the launcher's default state folder (not one `PI_SANDBOX_STATE_DIR` names) that this build does not use go too, once they are a day old; running an older build after a newer one removes the newer build's files the same way.
- **Sessions are shared.** `/resume` on your Mac lists sandbox sessions.
- **Copy reaches your Mac's clipboard.** What pi copies inside (OSC 52) is also put on the macOS clipboard with `pbcopy`, so it works in terminals that ignore OSC 52. The output still reaches your terminal unchanged.
- **Pasted screenshots work.** Dragging or pasting the path of a PNG, JPEG, GIF or WebP file (up to 20 MiB) that the sandbox cannot see copies it to `/tmp/pi-paste/` inside and pastes that path instead. If the file cannot be read (macOS blocks the terminal from Desktop or Downloads until you allow it under System Settings → Privacy & Security → Files and Folders) or is not there, the path is pasted as it is and your terminal shows a notification saying why. That needs a terminal that shows OSC 9 notifications: iTerm2 does, with "Send escape sequence-generated alerts" on in the profile; terminals without OSC 9 support, Terminal.app among them, show nothing.
- **Ctrl+V pastes a copied image.** With a PNG on the clipboard (a screenshot copied with Cmd+Ctrl+Shift+4, say), Ctrl+V copies it to `/tmp/pi-paste/` inside and pastes its path. A single image file copied in Finder is copied in the same way; with text, several files or another file, Ctrl+V reaches pi as it is.

All three are on a Mac only; `terminal.clipboard: false` turns them off.
- **Some settings come back to your Mac.** When you change the default model, provider or thinking level, the enabled models, the theme or a few display and queue preferences inside (in `settings.json`), or the settings of the subagents, style, notifications and session-limits extensions and the prune interval (their `pi-*.json` files; the prune interval only as one of the values `/prune` offers or off), the launcher copies the change to your Mac when pi exits, or at the next launch after a crash, and prints one line per change. A value of the wrong type, or a theme name that is not a plain file name, is not copied and a line says so; if a settings file is missing from the sandbox, nothing in it is removed on your Mac. If you changed the same setting on your Mac meanwhile, your Mac's value wins and a line says so. `writeBack` in the config can take keys off this list, add plain preferences or turn it off ([Settings written back](CONFIGURATION.md#settings-written-back)). Nothing else comes back, whatever the config says: packages, extensions, skills, commands, paths, proxy settings, logins, `models.json`, `mcp.json` and agent files change only on your Mac.
- **A new share restarts the VM once.** The first launch in a folder outside your home restarts the VM to share it, and the share is kept for later launches. With `workspaceRoots` set, the VM shares only those folders, so the restart happens when the list changes; a stopped VM starts with the new list directly. If other pi sessions run, also from another agent dir, a launch whose folder the VM does not share yet stops and asks you to exit them first; when the current shares already cover the launch, it goes ahead and says the VM changes at the next launch with no other pi session running.

### Where pi can start

Pi starts in a repository or in a plain folder. A folder with several repositories is checked repository by repository. Bare repositories in it are read-only: clone and fetch work, push does not.

Pi does not start in your home folder, `/`, system folders or credential folders such as `~/.ssh`. It refuses git files that git did not write. A plain folder is refused when it holds over 128 repositories or 50,000 directories.

If your home folder is a git repository, pi starts under it only inside a repository of its own.

All checks are in [baseline guarantees](THREAT-MODEL.md#3-baseline-guarantees), under "Workspace guard" and "Workspace mode".

## What it protects and what it does not

It protects:

- **Your files.** Pi sees the repository or plain folder, and its git data. The rest of your home, `~/.ssh` and `~/.pi` stay hidden.
- **Your secrets.** Every key inside is a *placeholder*, a stand-in value. The proxy swaps it for the real one, only toward the host it belongs to.
- **Your network.** Only listed hosts are reachable. Private and loopback addresses are refused. The sandbox has no address of the VM to reach, and the proxy token stays outside it: only the sandbox's relay holds it.
- **Your git hooks.** `.git/hooks` is read-only inside.

It does not protect:

- **Use of your credentials.** The agent cannot read them, but can use them: push with your gh token, call your provider, publish a package.
- **The folder.** The agent can change any file in it, `.git/config` included. When pi exits, the launcher names changed git files. Review them before you run git there.
- **Data sent to allowed hosts.** Anything can leave through them.
- **Earlier sessions.** Host pi's sessions of this folder are readable inside, with any secret a tool printed in them. `sessions.host: false` keeps them apart.
- **Your clipboard.** The agent can put text there for you to paste somewhere else, an image on it enters the sandbox when you press Ctrl+V, and an image whose path you paste is copied in. `terminal.clipboard: false` turns these off.
- **The rest of the VM.** Without `workspaceRoots`, the Colima VM can read and write your whole home; only the container is limited. With [`workspaceRoots`](CONFIGURATION.md#workspace-roots) set, the VM sees only those folders, pi's session folder and a read-only launcher folder.

The full list is in [known gaps](THREAT-MODEL.md#5-known-gaps).

## Configuration

Your settings go in `~/.pi/agent/pi-sandbox/config.json` (inside pi's agent folder, so under `PI_CODING_AGENT_DIR` when you set it). This one file is the whole configuration, for every folder you start pi in: it belongs to you, and a team can share a copy of it as is. There are no profiles, and nothing in the project folder configures the sandbox ([what follows from that](CONFIGURATION.md#one-config-for-every-session)). Removed keys and defaults, and what to do when you update the launcher, are in [REMOVED-DEFAULTS.md](REMOVED-DEFAULTS.md). A Java developer might use:

```json
{
  "egress": { "allow": ["registry.npmjs.org", "repo1.maven.org", "plugins.gradle.org", "registry.corp.example"] },
  "image": { "packages": ["openjdk-17-jdk-headless", "maven"] }
}
```

- `egress.allow`: the hosts the sandbox may reach besides `pi.dev` and your providers. It is empty by default, so package registries such as `registry.npmjs.org` are reachable only once you list them or allow them with `pi sandbox egress allow`.
- `image.packages` and `image.npmGlobal`: Debian and npm packages to add to the image. The launcher's CA and your `tls.extraCa` CAs are built into the image's system store and into every JDK the image holds (its `cacerts`, and its `net.properties` points Java at the sandbox proxy), so the image is rebuilt when a CA changes.
- `mounts.volumes`: folders such as `~/.npm` or `/opt/data`, kept in volumes that every session shares, in any folder. Your Mac's own folder is not mounted. A cache such as `~/.m2/repository` may sit beside a file the launcher puts there (`~/.m2/settings.xml`, which points Maven at the sandbox proxy).
- `mounts.binds`: files or folders of your Mac mounted read-only inside, such as `{ "source": "~/reference", "target": "/etc/reference" }`. A source outside the folders the VM shares adds a read-only share, which restarts the VM once.
- `setup`: commands run inside before pi starts, at every launch, such as `[["npm", "ci"]]`. A failing command stops the launch. See [Setup commands](CONFIGURATION.md#setup-commands) before you add one.
- `services`: long-running processes such as a database, in containers of their own next to pi, reached on `localhost:<port>` for each port you declare. Every pi session of one launcher state folder (one per agent dir by default) shares one set of them and their data; they start with the first session and stop when the last one ends. See [Services](CONFIGURATION.md#services) for what follows from that.
- `vm`: the CPUs, memory and disk of the VM, applied at the next launch with no other pi session running, or at once by `pi sandbox init` when none runs. `resources` limits one container inside the VM instead: CPUs, memory, processes (`pids`, 4096 by default), open files and the size of `/dev/shm`.
- `env.set`: variables with a fixed value in every sandbox process, such as `{ "CI": "1" }`. Names the launcher sets are refused. The agent sees every value, so no secrets.
- `writeBack`: which settings changed inside come back to your Mac, inside limits the launcher keeps.

Inside, `PI_SANDBOX_STATUS` names a JSON file that tells the agent what the sandbox gives it: the proxy, the limits, volumes, binds, setup and services ([Sandbox status file](CONFIGURATION.md#sandbox-status-file)). [Recipes](CONFIGURATION.md#recipes) show common combinations, such as seeding a volume, git SSH remotes and a JDK in a volume.

`pi sandbox config` shows the result. Every key, credentials and corporate proxies are in [CONFIGURATION.md](CONFIGURATION.md), and [examples/config.json](examples/config.json) is a starting point for a team's shared file.

## Troubleshooting

Start with `pi sandbox doctor`, which names the failing check.

| symptom | what to do |
| --- | --- |
| A host `was blocked in the sandbox` | Follow the hint in that line. `pi sandbox doctor` puts the same hint under the `rule` check of a credential host the proxy refused, for example the address a host resolved to and the `egress.privateHosts` entry that allows it, and reports any other host blocked during its run as a `blocked <host:port>` warning. |
| The doctor's `trust` or `rule` check fails with `CERT_NOT_YET_VALID` | The VM's clock is more than an hour behind the host's. Run `pi sandbox stop` once no pi session runs, then `pi sandbox doctor` again, which starts the VM afresh. |
| A provider login is missing or expired | Run `pi --no-sandbox`, then `/login`. |
| Pi says `the sandbox VM does not exist` | Run `pi sandbox init`, which creates the VM with its size, shares and VM type. A bare `colima start` would create it with colima's defaults instead. |
| Pi says `the sandbox VM engine is unreachable` | Run `colima start --profile pi-sandbox --activate=false` when the profile exists, else `pi sandbox init`. |
| The VM is running but its engine does not answer | Run `colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false`. |
| A folder is not shared with the VM | Exit your other pi sessions and run `pi` again. |
| An HTTP 502 about a certificate | Run `pi sandbox doctor` and add the `{ "sha256": … }` line it prints to [`tls.extraCa`](CONFIGURATION.md#corporate-proxy-and-tls-inspection). |
| `unable to get local issuer certificate` or `self-signed certificate in certificate chain` while installing dependencies | Your network inspects TLS. Run `pi sandbox doctor`: its `tls inspection` check names the CA that signs pi.dev and prints the `{ "sha256": … }` line for [`tls.extraCa`](CONFIGURATION.md#corporate-proxy-and-tls-inspection), or, when that CA is in no macOS keychain, the issuer to ask your IT for, to add as `{ "file": … }`. |
| A launch prints `preparing pi sandbox, one time` and takes minutes | That launch builds the image, which carries the sandbox CAs; it is built again only when what it is built from changes: the base image and then the layer, or only the layer when `image.digest` pins the base. Later launches reuse it. |
| A command `is not in the sandbox image` | Add it to `image.packages` or `image.npmGlobal`. |
| `sudo`, `doas` or `systemctl` says `there is no root in the sandbox` | Add packages to `image.packages`, which installs them as root when the image is built, and list a server the agent needs under `services`, which runs it in a container of its own, see [Services](CONFIGURATION.md#services). |
| Perl or another program prints `Setting locale failed` | `env.allow` lists `LANG` and the image lacks that locale. Drop `LANG` to keep the image's `C.UTF-8`, or generate the locale with `image.dockerfile`, see [Variables passed into the sandbox](CONFIGURATION.md#variables-passed-into-the-sandbox). |
| The npm registry lacks your host pi version | Install a published pi version on your Mac. |
| A running session missed a config change | See [when changes apply](CONFIGURATION.md#when-changes-apply). |

## Uninstall

Exit every pi session, then run the script from where you installed:

```bash
"$(npm root -g)/pi-extensions-mz/launcher/uninstall.sh"   # npm install
launcher/uninstall.sh                                     # checkout
```

It deletes the `pi-sandbox` Colima profile, the launcher's state (`~/.pi/agent/pi-sandbox/state`), the `pi` link, the npm package and the `PATH` lines. It restores pi's managed link if `install.sh` replaced it.

Your repositories, `~/.pi` with its sessions, and your config `~/.pi/agent/pi-sandbox/config.json` stay. Colima stays installed. Remove it with `brew uninstall colima` if nothing else uses it.

## More

How it works and every file it writes: [ARCHITECTURE.md](ARCHITECTURE.md). Where the code is: [STRUCTURE.md](STRUCTURE.md).

To work on the launcher, run `npm run check` from the repository root. `node launcher/bin/pi-sandbox-dev.js` runs a checkout. `PI_SANDBOX_LIVE=1 npm run test:live` tests against real Colima.
