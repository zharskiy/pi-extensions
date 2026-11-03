# Sandboxed pi: developer experience research

Research date: 2026-11-02

Scope: what a developer on macOS (Linux second, Windows nice-to-have) sees when typing `pi` in a project and getting a sandboxed agent. Target: no container commands, no visible image builds, instant-feeling start, project dir shared read-write. pi version in view: @earendil-works/pi-coding-agent 1.5.0.

Local measurements in this file were taken on 2026-11-02 on an Apple M6 Mac, macOS 27.2 (build 26B123). Docker Desktop was installed but not running, so no container timings were measured locally.

## Baseline facts about pi that shape the sandbox

- pi has no built-in permission system and "runs with the permissions of the user and process that launched it"; its README points to `docs/containerization.md` with four methods: plain Docker (whole pi process in a container), Docker Sandboxes (managed sandbox, proxy substitutes the provider credential), OpenShell (whole pi process in a policy sandbox), Gondolin extension (pi on host, tools in a micro-VM). https://github.com/earendil-works/pi (fetched 2026-11-02; formerly badlogic/pi-mono)
- Plain Docker recipe: `node:24-bookworm-slim` + bash, ca-certificates, git, ripgrep, `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, `docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD:/workspace" -v pi-agent-home:/root/.pi/agent`.
  - It does not set TERM, does not handle OAuth `/login`, does not map UID. https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md
- OpenShell recipe: `openshell sandbox create --name pi-sandbox --from pi -- pi`; a remote gateway does not bind-mount the folder (clone inside, or `openshell sandbox upload/download`). Same doc.
- Gondolin recipe: Node 23.6+, QEMU from the OS package manager, `pi -e ~/.pi/agent/extensions/gondolin`; cwd at `/workspace` in the VM; overrides read/write/edit/bash/grep/find/ls; env-var keys are visible inside, "not a credential boundary". Same doc.
  - Community variant pasky/pi-gondolin downloads a ~200 MB guest image on first run. https://github.com/pasky/pi-gondolin
- pi 1.5.0 removed its example sandbox extension on @anthropic-ai/sandbox-runtime (Seatbelt / bubblewrap); only the Gondolin example remains (`CHANGELOG.md:117` in the installed package). https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/ ; community fork: https://github.com/carderne/pi-sandbox
- pi's runtime needs (agent-safehouse investigation, https://agent-safehouse.dev/docs/agent-investigations/pi): config root `~/.pi/agent` (override `PI_CODING_AGENT_DIR`), credentials in `~/.pi/agent/auth.json` (0600); writes `$TMPDIR/pi-bash-<hex>.log`; reads `~/.aws`, `~/.config/gcloud`; watches `<cwd>/.git/HEAD`; network to providers, `registry.npmjs.org`, `github.com`, `api.github.com`, `pi.dev`; honors `HTTP_PROXY`/`HTTPS_PROXY`; OAuth localhost callbacks on 127.0.0.1:51121 (Google Antigravity), :8085 (Gemini CLI), :1455 (OpenAI Codex), none for Anthropic and Copilot; child processes `rg`, `fd`, `tar`, `npm`, `git`, `open`/`xdg-open`, `pbcopy`, `wl-paste`/`xclip`, `$VISUAL`/`$EDITOR`, `gh`.
- pi terminal needs (same source): raw ANSI to stdout, Kitty keyboard protocol (key release), Kitty and iTerm2 inline images, OSC 52 clipboard, OSC 8 hyperlinks; capability detection from `TERM`, `COLORTERM`, `TERM_PROGRAM`, `COLORFGBG`, `WAYLAND_DISPLAY`, `DISPLAY`.
- Local: `pi --version` took 0.128 s wall on the host (warm cache). Node startup `node -e 0` about 22-31 ms. Any launcher overhead beyond ~100-200 ms will be noticed relative to that.
- Install facts: Node 22.19+, `pi update` updates pi, curl/PowerShell installers, npm, Nix. https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md

## A. Launcher shapes

### A1. How comparable tools launch

- Docker Sandboxes (`sbx`): `cd project && sbx run claude` boots a microVM per sandbox and starts the agent; sandbox named after the dir (`claude-my-project`); first run asks for a global network policy preset (Balanced recommended); Claude starts with `--dangerously-skip-permissions`.
  - Install `brew install docker/tap/sbx`, `sbx login` (Docker OAuth). https://guidebook.devops.uis.cam.ac.uk/tutorials/using-docker-sbx-for-claude-code/ (page dated 2026-09-04).
  - The Docker Desktop-integrated `docker sandbox` is deprecated in favor of standalone `sbx`. https://docs.docker.com/ai/sandboxes/docker-desktop
- sbx lifecycle: `sbx ls`, `sbx stop` (pause), `sbx rm`, `sbx` alone opens a dashboard; cwd mounted read-write by default ("direct mode"), or clone mode for a private in-sandbox clone; "first run takes a little longer while the agent image is pulled. Subsequent runs reuse the cached image and start in seconds." https://docs.docker.com/ai/sandboxes/get-started/
- So sbx is shape (2): long-lived per-project sandbox that the CLI re-attaches to, with the agent as image CMD. Custom agents go through "kits" (v2 extends a built-in agent; v3 sets launch command in the workload Dockerfile). https://docs.docker.com/ai/sandboxes/faq/
- Claude Code `sandbox` setting: does not containerize the agent; wraps each Bash/PowerShell/Monitor command with Seatbelt (macOS) or bubblewrap (Linux, WSL2) via @anthropic-ai/sandbox-runtime; file tools, MCP servers, hooks run outside. Native Windows runs commands unsandboxed.
  - Off by default. https://code.claude.com/docs/en/sandboxing
- Codex CLI: per-command Seatbelt on macOS "out of the box", bubblewrap on Linux/WSL2 (first `bwrap` on PATH, bundled fallback needing unprivileged userns; AppArmor `bwrap-userns-restrict` on some Ubuntu), native Windows sandbox in PowerShell; modes read-only / workspace-write (default) / danger-full-access. https://learn.chatgpt.com/docs/sandboxing
- Gemini CLI `--sandbox`: either `sandbox-exec` with 6 built-in Seatbelt profiles (`SEATBELT_PROFILE`, default `permissive-open`: writes limited to project dir, broad reads and network) or the whole CLI re-exec'd in Docker/Podman (`ghcr.io/google/gemini-cli:latest`), cwd "mounted at the exact same absolute path as it is on your host machine", `SANDBOX_MOUNTS`, `SANDBOX_SET_UID_GID`, custom `.gemini/sandbox.Dockerfile` (auto-build only from source).
  - The page notes Gemini CLI was replaced by Antigravity CLI on 2026-06-18. https://geminicli.com/docs/cli/sandbox/
- devcontainer CLI: `devcontainer up` then `devcontainer exec`; upstream forwards the host SSH agent socket by default. https://github.com/crunchloop/devcontainer/issues/28 .
  - A fork documents that exec starts at 80x24 until first redraw and ignores resizes, fixed by forwarding SIGWINCH into the exec resize channel. https://github.com/crunchloop/devcontainer/pull/83
- distrobox/toolbox: make a container feel like the host by sharing `$HOME`, same user, host networking; `distrobox-host-exec` runs host commands from inside.
  - Isolation is explicitly not a goal ("Complete isolation is not possible"). https://github.com/89luca89/distrobox/ .
  - Lesson: the UX trick is same path + same UID + same HOME, which is exactly what a sandbox must not copy wholesale (HOME carries credentials).
- `nix develop`: no isolation at all, only toolchain provisioning; relevant only as a toolchain source inside an image.

### A2. Warm versus cold start

- Firecracker: ~125 ms to application code, <5 MiB overhead, up to 150 microVMs/s per host (Linux/KVM only). https://fly.io/learn/firecracker-vs-gvisor/
- gVisor: no VM boot, process-level start (milliseconds, no published figure found); pays per syscall, I/O-heavy work reported 10-30% slower (unverified figure). https://northflank.com/blog/firecracker-vs-gvisor
- Apple `container`: Apple claims sub-second start per container (one lightweight VM per container, custom kernel, ext4 block devices). https://www.infoq.com/news/2025/06/apple-container-linux .
  - Independent reviews disagree: Better Stack calls startup "the weak point", DEV review says "comparable". https://betterstack.com/community/guides/linux/apple-container-machines/ ; https://dev.to/andrew-ooo/apple-container-review-a-native-docker-alternative-for-mac-3bo3
- OrbStack: ~2 s engine start (secondary claim, https://frontend.sliplane.io/blog/orbstack-vs-docker); `docker run --rm hello-world` ~0.3-0.8 s versus Docker Desktop 4-8 s (unverified estimate in a comparison page, https://www.pkgpulse.com/blog/podman-vs-docker-desktop-vs-orbstack-container-tools-macos-2026).
- Docker Desktop: warm restart of the engine ~15-20 s (v4.38.0, thin methodology). https://thepromptshelf.dev/blog/orbstack-vs-docker-desktop-2026/
- Lima: sample `limactl start` log reaches READY at ~29 s (driver/hardware unstated). https://github.com/lima-vm/lima/releases . Colima: no measured number found.
- Gondolin: "boots in under a second" on macOS and Linux (project claim via secondary summaries, no benchmark). https://deepwiki.com/earendil-works/gondolin
- Docker Sandboxes: "start in seconds" on reuse, no published number; `sbx version` alone ~500 ms (issue #451). https://github.com/docker/sbx-releases/issues/451
- Seatbelt, measured locally: `/usr/bin/true` 1.15 ms bare vs 4.87 ms under `sandbox-exec -f profile`; `node -e 0` showed no measurable added cost (noise 22-31 ms). So OS sandbox start is effectively free.
- Conclusion: only two shapes feel instant on macOS. (a) OS sandbox on the host (~5 ms). (b) `exec` into an already-running container or microVM (expected tens to low hundreds of ms; not measured here, see Not verified).
  - Any shape that boots a VM engine on the critical path (Docker Desktop 15-20 s, Lima ~29 s) must keep the engine and the per-project container warm and hide first boot behind a one-time "preparing sandbox" message.
- Warm per-project container lifecycle to design: create on first `pi` in a project (name = hash of repo root), keep running with idle timeout (sbx uses explicit `stop`), recreate when image digest or policy hash changes, garbage-collect after N days unused.

### A3. OS sandbox only (Seatbelt / bubblewrap + Landlock)

- UX cost: near zero start, native file speed, native terminal, host toolchain, host git and ssh agent all "just work" for allowed paths.
  - But per-command friction is real and documented by Claude Code: `docker` incompatible; `watchman` incompatible (`jest --no-watchman`); Go CLIs (`gh`, `gcloud`, `terraform`) fail TLS verification under Seatbelt; `open`/`osascript` fail (-600) unless `allowAppleEvents`, which "removes code-execution isolation"; Chromium/Electron/rootless Podman need userns; git over SSH fails on macOS (switch to HTTPS or exclude `git push *`); localhost servers need `allowLocalBinding`; Ubuntu 24.04+ AppArmor blocks bwrap userns without a profile; non-TCP (UDP, QUIC, ping) cannot leave. https://code.claude.com/docs/en/sandboxing
- Security cost: reads are broad by default ("most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`" unless denied); the agent process itself (and for pi, all its tools and extensions) shares the host kernel and host user; `sandbox-exec` is deprecated by Apple and may be removed (https://awesome.ecosyste.ms/projects/github.com%2Fminhtuannguyen%2Fmac_sandbox); macOS hard-blocks nested `sandbox-exec`, so a wrapper conflicts with any inner Seatbelt use (https://skillselion.com/skills/codewithcheese/xclaude/debug-sandbox).
  - Claude Code also protects `.git/hooks`, `.gitconfig`, shell rc files and its own settings from writes even inside cwd, because they are code that runs unsandboxed later. Same Claude doc.
- Native Windows: no Seatbelt/bwrap equivalent in srt (alpha, needs elevated setup). https://github.com/anthropics/sandbox-runtime

## B. The terminal through the boundary

- The PTY carries raw bytes, so anything that is pure escape sequences in both directions works through `docker exec -it`, `container exec -t`, ssh and sbx: 24-bit color, OSC 52 clipboard writes, OSC 8 links, OSC 9/777 and BEL notifications, Kitty keyboard protocol queries/replies, kitty/iTerm2 images sent inline as base64.
  - What breaks is everything that depends on environment, ioctl or the host filesystem.
- TERM: Docker sets `TERM=xterm` for `run -t` and `exec -t`, hardcoded, not the client's value; moby #42323 asks to pass through (e.g. `xterm-kitty`) and a maintainer favored the fixed default. https://github.com/moby/moby/issues/42323 ; https://git.coopcloud.tech/p4u1/docker-cli/commit/ace1c458e28874ee33c1fc6c751ef6937b2f8762 .
  - Fix: shim passes `-e TERM -e COLORTERM -e TERM_PROGRAM -e TERM_PROGRAM_VERSION -e LC_TERMINAL -e COLORFGBG -e KITTY_WINDOW_ID -e LANG` and the image ships `ncurses-term` so `xterm-kitty`, `xterm-ghostty`, `wezterm` terminfo exist (otherwise fall back to `xterm-256color`).
- Because pi detects image protocols and truecolor from `TERM_PROGRAM`/`COLORTERM`, missing passthrough silently degrades pi to 256 colors and no images, not an error.
- Resize: Docker CLI sends initial size and forwards SIGWINCH; the long-standing failure is initial 80x24 until the first resize. https://github.com/moby/moby/issues/33794 . sbx had both bugs: `sbx exec -it` gave no window size (#63, https://github.com/docker/sbx-releases/issues/63) and kit `agent.run` sessions stuck at 80x24 (#220, opened 2026-06-09, fixed in v0.33.0, confirmed on Windows only, https://github.com/docker/sbx-releases/issues/220).
  - A pi kit on sbx would use exactly the `agent.run` path that broke.
- Kitty graphics through tmux need `allow-passthrough on` in the tmux that runs inside the container. https://docs.rs/crate/little-kitty/latest . Do not put tmux inside the sandbox by default.
- Image protocols: inline (base64 in the stream) works; kitty file/shared-memory transmission (`t=f`, `t=t`, `t=s`) cannot, since the terminal on the host cannot see container paths. Not verified which mode pi uses.
- Clipboard read / image paste: pi shells out to `pbpaste`/`wl-paste`/`xclip`, which do not exist or cannot reach the host clipboard in a Linux container. sbx needed a dedicated bridge: "Image paste is off by default", `sbx settings set clipboard.imagePaste true`; text paste works "because the terminal sends it directly". https://docs.docker.com/ai/sandboxes/faq/ . pi in a container needs a clipboard bridge for image paste; OSC 52 covers copy.
- Docker Sandboxes and Claude Code: Claude Code works in sbx (docs show `/btw`, Shift+Tab plan mode); the resize regressions above were the reported TUI defects. No report found of color or keyboard protocol breakage.
- Signals: Ctrl-C is a byte in the PTY, delivered fine. pi's bash tool kills process groups with SIGKILL; this happens inside the container, fine.
  - If the shim dies (terminal closed), `docker exec` does not kill the in-container process reliably; the shim must forward SIGHUP/SIGTERM and the container entrypoint should be an init (`--init`/tini) so orphans are reaped (general Docker behavior, Not verified for sbx/Apple container).

## C. Files

- Mechanisms on macOS: virtiofs (Docker Desktop VZ and Docker VMM, Lima vz default on macOS 13.5+ with Lima 1.0, Apple container bind mounts, sbx), gRPC-FUSE (Docker Desktop legacy), Mutagen-based "synchronized file shares" (Docker Desktop, paid: Pro/Team/Business, ext4 cache in the VM with two-way sync, GA in 4.27, 2024-02). https://lima-vm.io/docs/config/vmtype/ ; https://www.docker.com/blog/announcing-synchronized-file-shares/ .
  - OrbStack uses virtiofs plus its own dynamic caching, vendor claim 75-95% of native, yarn install at 77% of native for 1614 packages / 807 MiB. https://orbstack.dev/blog/fast-filesystem
- Independent npm install numbers (M4 Pro, macOS 15.1.1, published 2025-01-04, updated 2025-06-01), bind mount only, seconds: Linux native Docker 5.29; Lima 8.99; Docker Desktop VZ+virtiofs 9.53; Docker VMM 8.47; Docker Desktop VZ + synchronized file shares 3.88; OrbStack 4.22; macOS native about 3.4.
  - With node_modules in a named volume all setups land at 3.2-4.1. https://www.paolomainardi.com/posts/docker-performance-macos-2025/
- Apple container: bind mounts are virtiofs; one user reports native ~2-3x faster than virtioblk volumes, which are ~3x faster than virtiofs bind mounts for builds (forum, May 2026). https://github.com/apple/container/discussions/1516
- Docker Sandboxes, worst documented case: Maven build 2:30 native vs ~13 min on the virtiofs workdir vs 2:39 from in-sandbox `/tmp` (M2 Pro, macOS 26.3.1, sbx 0.24.1, opened 2026-04-09, still open, "still a major problem" 2026-10-04).
  - Docker's answer is clone/branch mode with an in-sandbox shallow clone and a git daemon to sync back. https://github.com/docker/sbx-releases/issues/31 .
  - Also #662 (slow file copies, persists with `DOCKER_SANDBOXES_ENABLE_VIRTIOFS_CACHE=0`). https://github.com/docker/sbx-releases/issues/662 .
  - Andrew Lock (2026-04-07) calls the slowdown "crippling" even for simple projects. https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox/
- Correctness: sbx enables virtiofs caching by default and tells users to disable it on "Git index corruption or unexpected file content". https://docs.docker.com/ai/sandboxes/troubleshooting/ .
  - Docker Desktop has open virtiofs bugs: nested bind mounts empty in 4.67.0 (https://github.com/docker/desktop-feedback/issues/268), Docker VMM EBADF on `utime()` and zero-byte files after host churn (https://github.com/docker/desktop-feedback/issues/806), volumes nested in bind mounts detached ~1 s after start under Docker VMM (https://github.com/docker/desktop-feedback/issues/607).
- Practical pattern for pi: bind-mount the repo at the same absolute path as on the host (as Gemini does) so paths in pi sessions, error messages, OSC 8 links and `code -g file:line` round-trip; put `node_modules`, `.venv`, `target`, build outputs on per-project named volumes layered over the bind mount (mixed blessing: host tools then see empty dirs, and Docker VMM issue #607 above hits exactly this nesting).
- File watchers: virtiofs on macOS does not reliably deliver host-side changes as inotify inside the guest (Docker Desktop and OrbStack add event forwarding of their own; Not verified per runtime). pi itself watches `<cwd>/.git/HEAD` for the branch display; a missed event only leaves a stale branch label.
- UID/GID: Docker Desktop, OrbStack and Apple container on macOS present bind-mounted files with ownership mapped so a root or arbitrary container user can write and host files stay owned by the macOS user (Not verified for Apple container).
  - On Linux there is no translation: run the container as the host UID:GID (`--user $(id -u):$(id -g)`, Gemini's `SANDBOX_SET_UID_GID`) or rootless Podman with `--userns=keep-id`, else files created by pi end up root-owned in the repo.
- Symlinks: a symlink in the repo pointing outside the mount dangles inside the sandbox; that is the desired security property, but pnpm stores, `npm link`, monorepo links to sibling checkouts and dotfile-managed configs break.
  - Shim should warn once with the list of external targets and offer an explicit read-only extra mount (`sbx run claude ~/proj ~/shared-library:ro` is the precedent).
- Git layout: mount the repo top-level (`git rev-parse --show-toplevel`), not cwd, so `.git` is inside.
  - If the project is itself a linked worktree, `.git` is a file pointing at `<main>/.git/worktrees/<name>`, and the common dir is outside the mount; git fails inside. sbx hits this: a manually created worktree used as sandbox cannot commit "because the agent cannot reach the parent repository" (Andrew Lock post).
  - Fix: also mount `git rev-parse --git-common-dir` (read-write, since commits write objects there), at the same absolute path.
- pi's own worktrees under `<cwd>/.pi/worktrees` are inside the mount, but `git worktree add` writes metadata into `.git/worktrees/` and the new worktree's `.git` file stores an absolute path to the main `.git`; with same-path mounting those paths are valid on host and in the sandbox.
  - With `/workspace` remapping (pi's Docker recipe, Gondolin, pi-gondolin) they are not, and host git sees broken worktrees. Strong argument for same-path mounts.
- `.git` as attack surface: a writable `.git/hooks`, `.git/config` (`core.fsmonitor`, `core.hooksPath`, `credential.helper`, aliases), `.gitattributes` filters and `.envrc`/`.vscode/tasks.json` let the sandboxed agent plant code that the developer's host git or editor executes later.
  - Claude Code denies writes to `.git/hooks` and `.gitconfig` even inside cwd (Claude sandboxing doc).
  - For a container: overlay `.git/hooks` and `.git/config` read-only (bind mount the files ro on top of the rw repo) and have the host shim set `core.hooksPath` checks, or accept and document.
  - This is the main residual host-escape path in every "shared repo" design.
- Read-only toolchain image plus writable cwd: run the container with `--read-only` root, tmpfs for `/tmp` and `$HOME`, the repo bind mount rw, named cache volumes rw, `~/.pi/agent` state on a per-user volume (or a dedicated subdir of the host agent dir), image layers immutable.
  - Apple container and sbx both size the root disk (sbx root 20 GB default, `DOCKER_SANDBOXES_ROOT_SIZE`; inner Docker 10 GB). https://docs.docker.com/ai/sandboxes/troubleshooting/

## D. Identity and auxiliary credentials

- SSH agent on macOS: Docker Desktop and OrbStack expose the host agent at the magic path `/run/host-services/ssh-auth.sock` (mount it, set `SSH_AUTH_SOCK`); OrbStack notes `-v $SSH_AUTH_SOCK:/agent.sock` works except for 1Password's agent. https://docs.orbstack.dev/docker/ ; https://github.com/docker/docs/pull/10184/files .
  - Apple container: `container run --ssh` forwards the agent (guest path reported as `/run/host-services/ssh-auth.sock` symlinked to `/var/host-services/ssh-auth.sock`, third-party docs, Not verified against Apple docs). https://instagit.com/apple/container/how-to-use-ssh-agent-forwarding-with-containers-ssh-flag/ . sbx: `ssh.agentForwardingEnabled`, `ssh.agentSocketPath`, needs `socat` in custom templates, `SSH_AUTH_SOCK` is exported even when the relay is not wired; SSH egress needs `sbx policy allow network "host:22"`; GPG/S-MIME keys unavailable; 1Password ssh-agent signing failed on Windows (Andrew Lock). https://docs.docker.com/ai/sandboxes/troubleshooting/
- Agent forwarding means the sandbox can use (not read) every key loaded in the agent for the session. No key material enters; this is the sole credential-related capability that crosses the boundary. The strict alternative, a policy choice, is https git through the proxy with injected headers and no agent socket. A policy-respecting design forwards a filtered agent (only the git host's key, or confirm-on-use keys) or does git push from the host.
- git over HTTPS: host credential helpers (osxkeychain, GCM) do not exist inside; the enterprise choice is a credential-injecting egress proxy like sbx (`sbx secret set github --command 'gh auth token'`, token "stays on your host") and OpenShell providers ("Agents never see real credentials", injected only toward approved endpoints). https://docs.docker.com/ai/sandboxes/get-started/ ; https://github.com/NVIDIA/OpenShell
- `gh`: needs `GH_TOKEN`; inject the header at the proxy, no token inside. Under Seatbelt, Go binaries like `gh` fail TLS verification (Claude doc), a point for the container shape.
- npm/pip private registries: `.npmrc`/`pip.conf` tokens live in the host HOME; copy only registry config (not tokens) into the sandbox and inject `Authorization` at the proxy; no `.npmrc` token inside.
  - Claude Code on the web shows the ordering trap: setup scripts run before the key-injecting proxy is connected, so private installs cannot happen there. https://wmedia.es/en/tips/claude-code-cloud-setup-script (2026-10-15, third party)
- Corporate CA / TLS inspection (Zscaler): must be solved on day one or nothing works. sbx: install root CA as `.crt` + `update-ca-certificates` via a kit or `sbx cp`; "Don't point `SSL_CERT_FILE` at only your internal CA" (breaks its credential proxy); nested `docker build` does not inherit trust (`PROXY_CA_CERT_B64`, issue #322). https://docs.docker.com/ai/sandboxes/troubleshooting/ ; https://github.com/docker/sbx-releases/issues/322 .
  - Upstream proxy settings for HTTP/SOCKS5/PAC: https://collabnix.com/docker-sandboxes-upstream-proxy-sbx-settings/ .
  - Node specifically needs `NODE_EXTRA_CA_CERTS` (pi is Node), Python `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`, git `http.sslCAInfo`.
  - The shim should export the macOS System keychain roots (`security find-certificate -a -p /Library/Keychains/System.keychain`) into the sandbox bundle at start.
- SSO/OAuth for pi providers: `/login` flows open a browser and some wait on 127.0.0.1:1455/8085/51121.
  - Inside a container `open` does not exist and the callback port is in the guest.
  - Enterprise path (R2 absolute, no token inside): no `/login` inside. `pi login` on the host (shim subcommand) mints or refreshes the SSO token the proxy uses; `auth.json` in the image holds placeholders and nothing is written to the agent-state volume. sbx likewise keeps Claude's OAuth token on the host. https://docs.docker.com/ai/sandboxes/get-started/
  - Publishing the callback port and bridging `open` is only for a non-enterprise profile that accepts a token inside.
- MCP server secrets: stdio MCP servers run inside and often need an API key. The proxy does per-host credential injection for allowed hosts (placeholder in the container, real header added by the proxy; OpenShell documents it as per-endpoint credential binding, Docker Sandboxes as credential swapping), so an MCP server is configured with a placeholder and never sees the real key. Servers whose protocol cannot be proxied this way (non-HTTP) are not supported in the enterprise profile.
- Must solve for "just type pi": provider auth (pi's own), corporate CA + proxy env, git push for the dominant remote type (ssh agent on macOS is cheap with Docker Desktop/OrbStack/Apple container), `HTTP(S)_PROXY`/`NO_PROXY` passthrough.
  - Can defer: commit signing (GPG unsupported even in sbx), `gh` beyond proxy header injection, private pip/npm header injection (start with registry config only, no tokens), cloud CLIs (`~/.aws`, gcloud), SSO for internal services.

## E. Image and toolchain without the developer noticing

- Base image: a company image pulled once, pinned by digest, contains pi, node, git, rg, fd, ca-certificates, ncurses-term, socat, common language runtimes; pi itself installed in the image (not `pi update` inside, which would drift from the digest).
- Per-project toolchain: devcontainer.json/Dockerfile in repo (build once per content hash, in background, show "preparing sandbox (first time)"), or mise/asdf/Nix inside the base image driven by `.tool-versions`/`mise.toml`/`flake.nix` with installs into a cache volume.
  - Gemini auto-builds `.gemini/sandbox.Dockerfile` only from source; npm installs need a prebuilt image (https://geminicli.com/docs/cli/sandbox/), showing that silent builds are hard to get right. sbx kits take effect only when the sandbox is recreated (Cambridge guide).
- Cache volumes: per-user named volumes for `~/.npm`, `~/.cache/pip`, `~/.cargo/registry`, `~/.cache/go-build`, mise installs; shared across projects, never across users.
  - Claude Code on the web snapshots the disk after a setup script under ~5 min and starts later sessions from the snapshot (third-party, https://wmedia.es/en/tips/claude-code-cloud-setup-script).
- Silent update: shim checks the pinned digest from policy at most daily, pulls in background, switches on next start; warm containers on the old digest finish their session then get recreated.
- Offline: if the image is present, start must not touch the network (no `pull` on the hot path, no registry HEAD); pi itself needs the provider network anyway, so offline is mostly "fail fast with a clear message".
- Disk: sbx defaults root 20 GB + inner Docker 10 GB per sandbox (troubleshooting doc); Docker Desktop/OrbStack VM disks grow and rarely shrink; the shim needs `pi sandbox gc`.
- Runtime install and licensing an IT department will weigh:
  - Docker Desktop: Business $24/user/month annual (https://www.docker.com/pricing); free tier only for small companies (<250 staff and <$10M revenue, third-party summary). Has Settings Management via MDM (see F). Most likely already approved in enterprises.
  - OrbStack: commercial use needs a per-user license, one license covers up to 5 devices; ~$8/user/month (third-party aggregators). https://docs.orbstack.dev/licensing . Listed in Kandji's MDM app library. No admin policy lock-down found.
  - Colima/Lima: free, open source, Homebrew; no vendor support or admin lock-down.
  - Apple `container`: Apache-2.0, free, Apple silicon, "supported on macOS 26", older releases not supported; versions are "product versions, not semantic versions". https://github.com/apple/container . macOS 15 runs with reduced networking (third party).
  - Docker Sandboxes `sbx`: CLI and local compute free incl. commercial; org governance (central network/filesystem/MCP policy) is a separate paid subscription; macOS 14+ Apple silicon, Windows 11 x64 with Hypervisor Platform, Linux needs KVM; does not require Docker Desktop. https://docs.docker.com/ai/sandboxes/faq/ ; https://docs.docker.com/ai/sandboxes/install/ .
    - Enterprise users found licensing unclear. https://forums.docker.com/t/docker-sandbox-pricing-unclear/151790
  - OpenShell: Apache-2.0; needs Docker, Podman or host virtualization; Linux and macOS Apple silicon; Windows via WSL2 (experimental) or MXC. https://github.com/NVIDIA/OpenShell

## F. Policy delivery a developer cannot loosen

- Claude Code: `/Library/Application Support/ClaudeCode/managed-settings.json` plus `managed-settings.d/*.json` drop-ins merged alphabetically; MDM plist domain `com.anthropic.claudecode`; server-managed settings; only one delivery mechanism is used when several exist.
  - Recommended lock: `sandbox.enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `allowManagedDomainsOnly`, `allowManagedReadPathsOnly`. https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/sandboxing
- Codex: `/etc/codex/requirements.toml` (Unix), `%ProgramData%\OpenAI\Codex\requirements.toml`; macOS MDM domain `com.openai.codex`, keys `requirements_toml_base64` and `config_toml_base64`; requirements are non-overridable, managed defaults are starting values; cloud requirements also exist (precedence documented inconsistently). https://developers.openai.com/codex/enterprise/managed-configuration
- Docker Desktop: `/Library/Application Support/com.docker.docker/admin-settings.json` (Windows `C:\ProgramData\DockerDesktop\admin-settings.json`, Linux `/usr/share/docker-desktop/admin-settings.json`), each setting has `locked`; requires enforced sign-in into a Docker Business org, otherwise the file is ignored; admin-settings.json is lowest priority under Docker Home (cloud) policies. https://docs.docker.com/enterprise/security/hardened-desktop/settings-management/configure-json-file/ .
  - Sign-in enforcement is delivered by `registry.json` or MDM (from memory, Not verified in this session).
- Docker Sandboxes: with org governance, "only organization allow rules grant access", local deny rules still apply; ad hoc `sbx policy allow` rules are global per machine. https://docs.docker.com/ai/sandboxes/faq/ ; Cambridge guide.
  - Agent cannot widen its own policy; developer can from a second terminal unless governance is on.
- OpenShell: policy fixed at sandbox creation (Landlock for filesystem), a formal "prover" flags risky policy changes for human review. https://github.com/NVIDIA/OpenShell
- Pattern for pi: (1) policy file in a root-owned system path (`/Library/Application Support/<vendor>/pi-sandbox.json`, `/etc/<vendor>/`) or an MDM plist domain, read by the host shim, never by anything inside the sandbox; (2) optionally a signed policy fetched from a company URL, cached, signature checked with a key pinned in the MDM file; (3) the sandbox receives the effective policy read-only (mounted ro) and the egress proxy enforcing it runs on the host or in a separate container the agent cannot touch; (4) project-level config may only tighten.
  - Layers and settings: the README's decision 8 names three layers (system/MDM, user `sandbox.json`, project `.pi/sandbox.json`); security settings can only be tightened by lower layers, convenience settings (toolchain image, cache volumes, idle timeout, published ports) any layer may set; `pi sandbox config` shows the merge and which layer set each value, and a loosening edit is refused naming the locking layer.
  - A user-writable `~/.pi/agent` setting can never be the enforcement point because the shim runs as the user; the honest guarantee is "the agent cannot loosen it", while "the developer cannot loosen it" additionally needs MDM to protect the shim binary and the runtime settings (Docker Settings Management or sbx governance).

## G. Quality of life

- Shell completion: generated by the host shim; must not start the sandbox to complete.
- Host-side subcommands: `login` and OAuth (browser, localhost callback; mints or refreshes the SSO token the proxy uses), `pi update` (in the sandbox shape, updating means a new image digest, so the shim should intercept and explain), `pi install` of packages (pi packages are code that runs in the agent process: install inside the sandbox into the persisted agent dir, network via policy), `pi config`.
  - The shim needs an explicit allowlist of host-side subcommands; everything else goes into the sandbox.
- Host install: pi itself is installed only in the image. The host installs the launcher package, which provides the `pi` command and must be first on PATH; an existing host pi is not required and is unused while the launcher is active (`pi --no-sandbox` only when policy allows). Host-side `pi login` is implemented by the launcher with pi's auth library, not a full pi install (which login flows `@earendil-works/pi-ai` exports for reuse: Not verified). This repo's extensions live in the image, so the image is rebuilt when the extensions package changes; the launcher pins the digest and updates in the background.
- Editor: `$VISUAL`/`$EDITOR` for `/editor` runs inside the sandbox, so the image needs a terminal editor (vim/nano) or a bridge that opens the host editor and waits; VS Code `code` CLI only works from VS Code's own remote terminals; a small host RPC (socket mounted into the sandbox) for `open <url>`, `code -g path:line`, notifications and clipboard read is the cleanest single bridge, and same-path mounts make the paths valid on the host.
- OAuth callbacks: enterprise path does login on the host, so no port is published. A non-enterprise profile may publish 127.0.0.1:1455/8085/51121 only during `/login`. Never bind them on 0.0.0.0.
- Notifications: OSC 9/777 and BEL reach the host terminal through the PTY with no work; desktop notifications via `osascript` need the host bridge.
- Subagents' worktrees in `<cwd>/.pi/worktrees`: inside the shared repo mount, fine, provided the mount is the repo top-level and paths are identical (see C). `<cwd>/.pi/.gitignore` is written there too.
- Handoff files in the OS temp dir (`pi-handoff/<session id>/...`): inside the container `$TMPDIR` is container-local; fine for in-process subagents (same container) and for later sessions only if `/tmp` survives between runs (it does in a long-lived container, not with `--rm` or tmpfs).
  - If the developer or a host editor should open them, set `TMPDIR` to a per-project dir on a volume or shared path.
  - `pi-bash-<hex>.log` files also land there with no cleanup (agent-safehouse).
- Session files under `~/.pi/agent/sessions` contain absolute cwd paths; with same-path mounting, sessions created in the sandbox resume on the host and vice versa.

## H. Concrete comparables

- Docker Sandboxes (sbx) for Claude Code/Codex/Gemini/Copilot/opencode: one command per project, microVM per sandbox, Balanced network preset, credential proxy, free locally.
  - Friction from tracker and posts: virtiofs I/O (13 min vs 2:30 build, #31; #662), git index corruption advice, 80x24 PTY bugs (#63, #220), sandboxes unresponsive after the Mac runs a while (#163, https://github.com/docker/sbx-releases/issues/163), `sbx version` ~500 ms (#451), Copilot CLI with GitHub business account fails (#17, https://github.com/docker/sbx-releases/issues/17), Balanced blocks internal registries with bare 403, kits apply only on recreate, schema version mismatches, two logins (Docker + agent), `.sbx/` folder untracked in branch mode, 4 GB memory cap in the old Docker Desktop variant (sbx defaults to 50% of host RAM). No published startup times.
- OpenShell (NVIDIA): `openshell sandbox create --name demo`, or `-- <agent>`; default image minimal Ubuntu; gateway required; Landlock filesystem policy locked at creation; per-request credential injection; formal policy prover.
  - The community image catalog was retired and bare names like `base`, `ollama`, `pi` are no longer expanded by `--from` (so pi's own doc command `--from pi` is likely stale). https://github.com/NVIDIA/OpenShell-Community ; no startup figures found.
- Claude Code sandbox (srt, per command): zero start cost, but the long troubleshooting list in A3; enterprise-lockable through managed settings.
- Anthropic srt as a wrapper: `srt "<cmd>"`, config `~/.srt-settings.json`, Seatbelt via `sandbox-exec` on macOS, bubblewrap + socat on Linux, Windows alpha. https://github.com/anthropics/sandbox-runtime .
  - Wrapping all of pi with srt means pi's own network (providers) goes through srt's proxy allowlist, and its file writes to `~/.pi/agent` must be allowed.
- sandbox-exec wrapper scripts for Claude: paulsmith/claude-sandbox (template profile per project, https://github.com/paulsmith/claude-sandbox), kohkimakimoto/claude-sandbox (`sandbox.toml`, writes restricted, no network lockdown, `[unboxexec]` escape list), agent-sandbox (also restricts reads; notes most wrappers allow full read and network, https://zff.dev/hamann/agent-sandbox), agent-safehouse (least-privilege profile generator, https://agent-safehouse.dev/).
  - Common friction: deprecated API, nested Seatbelt blocked, broad reads.
- Claude Code on the web: Anthropic-managed cloud VM, setup script as root on Ubuntu 24.04, disk snapshot after setup, proxy-injected registry keys after setup; not local, so no file sharing problem but no local repo either. https://code.claude.com/docs/en/claude-code-on-the-web
- Cursor background agents: remote VMs; no primary data found this session (Not verified).
- pi-gondolin / pi Gondolin example: closest to "pi on host, tools in VM"; keeps pi's TUI, auth and OAuth on the host (no terminal or login problem), QEMU micro-VM, `/workspace` remap (worktree path issue in C), extension tools outside the VM.

## Linux and Windows deltas

Linux (second priority):

- No VM needed for a container: rootless Podman or Docker Engine starts a container in well under a second, and bind mounts are native speed (Linux native Docker bind mount npm install 5.29 s vs 5.32 s native in the Mainardi test, i.e. no penalty).
- The file-share problem disappears; the UID problem appears (run as host UID:GID, or Podman `--userns=keep-id`).
- OS-sandbox fallback is bubblewrap: Ubuntu 24.04+ AppArmor blocks unprivileged userns for `bwrap` without a profile (Claude and Codex docs both call this out).
- ssh agent: bind-mount `$SSH_AUTH_SOCK` directly; no magic host-services path needed.
- Docker Sandboxes needs KVM access on Linux; OpenShell supports Linux natively; Firecracker and gVisor are realistic only here.
- Docker Desktop for Linux runs a VM anyway and reintroduces the macOS file-share costs; prefer Docker Engine or Podman.

Windows (nice to have):

- Claude Code: "On native Windows, Claude Code runs commands unsandboxed"; WSL2 uses bubblewrap. https://code.claude.com/docs/en/sandboxing
- Codex: native Windows sandbox in PowerShell, Linux sandbox under WSL2. https://learn.chatgpt.com/docs/sandboxing
- sbx: Windows 11 x64 with Windows Hypervisor Platform, installed by winget; resize redraw problems on Windows were reported around v0.32 and fixed by v0.33 (issue #220).
- OpenShell: WSL2 experimental, native via Microsoft MXC.
- Practical shape: the shim runs in WSL2 and behaves as on Linux; repos must live in the WSL2 filesystem, not `/mnt/c`, or the 9p/DrvFs share is the slow path (general WSL2 behavior, Not verified for current builds).
- Terminal: Windows Terminal supports truecolor and OSC 52 but not kitty graphics (Not verified for current release); pi falls back to no images.

## Derived: what the shim does on each `pi` (synthesis of A-H)

Hot path, target under 200 ms when warm:

1. Resolve the project: `git rev-parse --show-toplevel` and `--git-common-dir` from cwd; fall back to cwd outside git. If policy sets the optional `workspaceRoots: { roots: [...], outside: refuse | warn }`, refuse or warn when the top-level is not under a declared root.
2. Read the effective policy: MDM/system file first, then user file, then project file (tighten only); compute a policy hash.
3. Detect the backend once and cache the answer: Docker API socket (Docker Desktop, OrbStack, Colima), Apple `container` on macOS 26+, else OS-sandbox fallback.
4. Look up the per-project container by label (repo path hash); verify image digest and policy hash labels match.
5. If running: `exec -it` with terminal env, working dir = host cwd (same absolute path), initial size, and SIGWINCH forwarding.
6. If stopped: start it (no create), then exec. If missing or stale: create, then exec.
7. Forward signals; on exit, return pi's exit code; leave the container running for the idle timer.

Cold path, first run on a machine (one visible line, never a build log):

1. Runtime missing: print exactly which runtime the company policy expects and how IT installs it; never auto-install a VM runtime.
2. Image missing: pull the pinned digest with a single progress line ("preparing pi sandbox, one time, 1.2 GB").
3. Create the per-user cache volumes and the agent-state volume.
4. Export the corporate CA bundle from the System keychain into the agent-state volume.
5. If no credential exists on the host for the configured source: run `pi login` on the host side (obtains or refreshes the credential for the configured source and stores it host-side only), then continue. Nothing is written to the agent-state volume and there is no `/login` inside.

Background, never on the hot path:

- Daily digest check and background pull; recreate on next start.
- Idle stop after N minutes; remove after N days unused; `pi sandbox gc` for disk.
- Per-project toolchain image build when devcontainer/Dockerfile/mise/flake content hash changes; until it is ready, run on the base image and say so once.

Failure modes the developer will actually hit, and the message they need:

| Symptom | Root cause | Shim behavior |
|---|---|---|
| "self-signed certificate in chain" from npm, pip, pi provider calls | TLS-inspecting proxy, CA not in sandbox | auto-export System keychain roots; set `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, git `http.sslCAInfo` |
| bare 403 from internal registry | egress allowlist (sbx Balanced shows the same ambiguity) | proxy returns a policy-denied body naming the host and the policy source |
| `git push` hangs or "Permission denied (publickey)" | no agent socket, or SSH egress not allowed | check agent socket at start; print which policy rule blocks `:22` |
| TUI drawn in an 80x24 box | initial size not propagated | always pass size on exec, re-send on first SIGWINCH |
| no images, 256 colors | `TERM_PROGRAM`/`COLORTERM` not passed | env passthrough list; terminfo in image |
| image paste does nothing | `pbpaste` absent in Linux guest | host bridge for clipboard read |
| `npm install`/build several times slower | virtiofs metadata latency | dependency dirs on volumes; report backend file-share mode in `pi sandbox status` |
| host git sees broken worktree | `/workspace` path remap | same-path mounts only |
| files owned by root in repo (Linux) | no UID mapping | run as host UID:GID or rootless userns keep-id |
| `/login` browser never returns | `/login` attempted inside; callback port in guest | do `pi login` on the host (enterprise path has no login inside) |

## Comparison of launcher shapes

| Shape | Cold start | Warm start | TUI fidelity | File-share perf (macOS) | ssh/git story | macOS version | Enterprise acceptability | License cost |
|---|---|---|---|---|---|---|---|---|
| Host OS sandbox only (Seatbelt/bwrap via srt-style wrapper) | ~5 ms (measured) | same | native, perfect | native | host agent works for HTTPS; SSH blocked by Seatbelt unless excluded; Go TLS issues | any current; `sandbox-exec` deprecated | high (no new runtime), but weak isolation and Windows gap | free |
| Shim + warm per-project container, Docker Desktop | engine 15-20 s+, image pull once | exec into running container, expected sub-second (Not verified) | good with env passthrough + terminfo; image paste needs bridge | virtiofs ~2.8x native npm; sync shares ~1.1x (paid) | `/run/host-services/ssh-auth.sock` | 13+ (Docker Desktop support window) | high, already deployed; Settings Management via MDM | $24/user/mo Business above SMB threshold |
| Same on OrbStack | ~2 s engine (claim) | expected sub-second | same as above | ~1.2x native npm, best measured | same magic socket; 1Password caveat | 13+ (Not verified) | medium; per-user license, MDM app via Kandji, no admin lock | ~$8/user/mo (third party) |
| Same on Colima/Lima | ~29 s sample Lima start | expected sub-second | same as above | ~2.6x native npm (Lima) | Lima agent forwarding (Not verified) | 13+ for vz | medium-low; free, no vendor support or lock | free |
| Shim + Apple `container` | per-container VM, "sub-second" claimed, disputed | exec into running container (Not verified) | same PTY model; TERM handling Not verified | virtiofs bind mounts reported slow for builds; volumes faster | `--ssh` flag | macOS 26+ only, Apple silicon | medium; Apple, free, but young (product versions, CLI churn) | free |
| Shim + Docker Sandboxes microVM (`sbx`) | image pull + microVM, "seconds" | `sbx run` reattach, "seconds" (~0.5 s CLI overhead) | Claude Code fine; 80x24 PTY bugs in kit path fixed v0.33 | worst documented: up to ~5x slower builds; clone mode as workaround | agent forwarding setting, `:22` allow rule, credential proxy for HTTPS | 14+ Apple silicon | medium-high; Docker brand, governance paid, licensing unclear to some | free locally; governance paid |
| Shim + OpenShell | gateway + sandbox create (no figures) | reattach (no figures) | Not verified | local bind mount Not verified; remote gateway has no mount | credential providers inject per endpoint | Apple silicon | medium; NVIDIA, Apache-2.0, fast-moving, catalog retired | free |

## Recommendation for "type pi and it works"

1. Ship a `pi` shim (the launcher) that is the only thing on PATH; the real pi lives in a pinned image, and the shim owns a small allowlist of host-side subcommands (`login`, `sandbox status|gc|reset`, completion).
2. Default backend: warm per-project container through the Docker API (works unchanged on Docker Desktop, OrbStack, Colima), with Apple `container` as a second backend on macOS 26+; keep the backend behind one interface so sbx or OpenShell can be added when their file I/O and kit TTY path mature.
3. Container per repo top-level, named by path hash, kept running with an idle timeout; `pi` = `exec -it` into it, so warm start is one exec; first run shows one "preparing sandbox" line while pulling the image.
4. Mount the repo top-level and the git common dir at identical absolute paths; deps and caches on named volumes; root filesystem read-only; `.git/hooks` and `.git/config` overlaid read-only.
5. Pass terminal env as an explicit allowlist and nothing else, never the host `process.env` (`TERM`, `COLORTERM`, `TERM_PROGRAM*`, `LC_TERMINAL`, `COLORFGBG`, `LANG`; the reason Gondolin's env passthrough default is rejected), ship full terminfo, forward initial size explicitly and SIGWINCH, use an init process.
6. One host bridge socket for `open`, OAuth callback relay, clipboard image read, editor-open and desktop notifications.
7. Day-one credentials: provider auth never enters the container; the image's `models.json` carries placeholder keys and the host proxy swaps them for the gateway host only; MCP, git https and registry credentials get the same per-host header injection, corporate CA bundle exported from the System keychain plus `NODE_EXTRA_CA_CERTS`/proxy env, ssh agent via the runtime's host-services socket (the sole capability that crosses: use, not read; strict alternative is https git through the proxy, no agent socket); defer signing, cloud CLIs and private-registry token injection.
8. Policy in an MDM-managed root-owned file read only by the shim; egress allowlist enforced by a host-side or sidecar proxy, never inside the agent container; projects may only tighten.
9. Fallback when no container runtime is present: srt-style OS sandbox around the whole pi process, clearly labeled weaker, so `pi` never refuses to start unless policy says `failIfUnavailable`.
10. Measure before committing: exec latency, `git status` and `npm install` on a large repo per backend on the company's standard Mac; file-share speed, not boot time, decides the experience.

## Not verified

- Warm `docker exec -it` / `container exec -t` latency into a running container on Docker Desktop, OrbStack, Colima, Apple container (no runtime was running locally; Docker Desktop installed but stopped). Expected tens to low hundreds of ms.
- Cold start numbers for Colima, Apple container (independent), sbx microVM, OpenShell, Gondolin; all published figures are vendor claims or single anecdotes.
- Which kitty graphics transmission mode pi uses (inline base64 vs file); whether pi's Kitty keyboard protocol negotiation survives every runtime's exec path.
- Inotify propagation of host edits into the guest for each runtime (OrbStack, Docker Desktop, Apple container, sbx).
- UID/GID presentation of bind mounts under Apple `container` and sbx.
- Which login flows `@earendil-works/pi-ai` exports for reuse by a launcher without a full pi install.
- Apple `container` `--ssh` guest socket path (third-party sources disagree) and its TERM default.
- Lima's ssh agent forwarding into containers (Colima `--ssh-agent`).
- Docker `registry.json` sign-in enforcement details (stated from memory).
- OrbStack official pricing, MDM configuration keys, and any admin lock-down feature.
- Docker's <250 employees / <$10M free-tier threshold (third-party summary of Docker terms).
- Whether sbx supports pi as a first-class agent or only through a custom kit, and whether OpenShell still has a `pi` image now that the catalog is retired.
- Cursor background agents' environment model and startup times.
- gVisor startup figure and the 10-30% I/O penalty.
- Whether `docker exec` reliably terminates the in-container pi process when the host terminal closes (SIGHUP propagation).
- WSL2 `/mnt/c` share performance on current Windows builds, and Windows Terminal kitty graphics support.
- Docker Desktop and OrbStack minimum macOS versions in the comparison table (taken as 13+ from general knowledge).
- Whether Docker Desktop and OrbStack forward host file events into containers on virtiofs mounts reliably enough for watch-mode test runners.
- Measured local Seatbelt overhead covers process start only, not per-syscall cost for file-heavy commands.
