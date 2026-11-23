# Launcher without bundled tools

> Status: planned. Date: 2026-11-23. Nothing here is built yet; the footprint was read from the code on branch `fix/launcher-large-build-failures`.

## Aim

The sandbox image should carry only what every project needs: git, search tools, curl, jq, python3 and pi. A forge CLI and its credentials belong in the user's config, not in the launcher. After this plan the launcher knows nothing about glab: it installs no glab, reads no glab config and renders no glab files. A user who wants glab adds it with the config keys that exist today.

## Precedent

The GitHub CLI went first. The `gh` package, the derivation from gh's `hosts.yml`, the `derived:gh:*` rules, `GH_TOKEN`, the rendered `gh-hosts.yml`, the `!gh auth git-credential` helper and `GH_CONFIG_DIR` were removed together, with no compatibility layer and no runtime notice. [launcher/REMOVED-DEFAULTS.md](../../launcher/REMOVED-DEFAULTS.md#the-github-cli) shows how to get them back with `image.packages`, `env.set`, `credentials.rules` and `setup`. The same shape fits glab.

## glab's footprint today

- `launcher/image/Dockerfile`: a pinned download of glab's `.deb` from gitlab.com, `GLAB_VERSION` with the checksums `GLAB_SHA256_AMD64` and `GLAB_SHA256_ARM64`, checked with `sha256sum` and installed with `dpkg -i`.
- `launcher/hostpi/tools/glab.ts`: finds glab's config on the Mac (`GLAB_CONFIG_DIR`, else `XDG_CONFIG_HOME`, else the platform folder), finds `glab` on `PATH` outside the sandbox roots, asks it for a token per host, and makes `derived:glab:<host>:token` rules for the host and its API host. `glabEnv` sets `GITLAB_TOKEN` and `GITLAB_HOST` when the only host is gitlab.com. It is called from `hostpi/derive-tools.ts`, and `GlabHost` lives in `hostpi/types.ts`.
- `launcher/provision/render.ts`: `glabConfig` renders `tools/glab-config.yml` (token placeholder, user, `api_host`, `api_protocol`, `git_protocol: https`, `use_keyring: false`); `gitConfig` adds `!glab auth git-credential` and the SSH-to-HTTPS rewrites for each glab host.
- `launcher/image/entrypoint.sh`: `copy_tool glab-config.yml .config/glab-cli/config.yml 0600`.
- Env names: `GLAB_CONFIG_DIR` and `XDG_CONFIG_HOME` in `PASSED` in `launcher/proxy/child-env.ts` (passed to host secret commands); `GITLAB_TOKEN` and `GITLAB_HOST` in `LAUNCHER_SET_VARIABLES` in `launcher/shared/pi-env.ts` and in both reserved lists of `launcher/schema/sandbox-config.schema.json`.
- Tests that name glab: `tests/hostpi/tools.test.ts`, `tests/hostpi/derive.test.ts`, `tests/provision/render.test.ts`, `tests/image/entrypoint.test.ts`, `tests/container/spec.test.ts`, `tests/proxy/child-env.test.ts`, `tests/shared/pi-env.test.ts`, `tests/config/validate.test.ts`, `tests/config/security-keys.test.ts`, `tests/cli/launch-wiring.test.ts`.
- Docs: `launcher/README.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `THREAT-MODEL.md`, and the root `ARCHITECTURE.md` and `STRUCTURE.md`.

## What the config must express

- **The binary.** Debian bookworm has no glab package, so `image.packages` cannot install it. `image.dockerfile` can repeat today's pinned download and checksum. Expressible, but the user owns the version and the checksums.
- **The token.** A `credentials.rules` entry per host and API host, sharing a placeholder, with `["<glab>", "config", "get", "token", "--host", "<host>"]` as the secret command. Expressible. A custom config folder goes in the command through `/usr/bin/env GLAB_CONFIG_DIR=…`.
- **gitlab.com in the environment.** `GITLAB_TOKEN` and `GITLAB_HOST` through `env.set`, once they leave the reserved lists. Expressible.
- **glab's config inside.** Self-managed hosts with their own `api_host`, `api_protocol` or an OAuth user need `config.yml` with a placeholder per host, written from `setup` with `sh -c` and `chmod 600`. Expressible but awkward.
- **git over HTTPS.** The credential helper and the `insteadOf` rewrites through `git config --global` in `setup`, as the gh recipe does. Expressible.

Real gaps, which the config cannot express:

- Discovery. Today the hosts come from the Mac's glab config and the binary from `PATH`; afterwards the user writes both, and a team config needs glab at one path on every Mac.
- The guard that never runs a glab inside a folder a sandbox can write. A configured secret command is trusted as written.
- The notices for a host without a token or a glab that does not answer in time. A configured command that fails shows only the proxy's rule failure.

## Open questions

- Remove glab now, or wait until someone else uses the launcher with GitLab? The owner is the one user today.
- Should `REMOVED-DEFAULTS.md` ship a ready `image.dockerfile` snippet with today's version and checksums, knowing it goes stale?
- Is the lost guard on the secret command's path worth a general feature (refuse a rule command inside the sandbox roots) that covers every configured rule, gh and glab alike?
- Should `setup` get a way to write a file with mode 0600 directly, so tool configs do not need `sh -c`?
- Does `credentials.derive` keep any meaning once only provider, MCP, npm, pip and Maven credentials are derived, or should it be renamed?
