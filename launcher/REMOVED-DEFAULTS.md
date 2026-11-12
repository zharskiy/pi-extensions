# Removed defaults

The launcher used to ship tools and network access that not every project needs. They are gone. This page lists what was removed and how to add each one back in your config file (`pi-sandbox/config.json` under pi's agent dir, see [CONFIGURATION.md](CONFIGURATION.md)).

## Image packages

The image keeps only what pi and the launcher need: the Node 24 base image, `git`, `ca-certificates`, `socat`, `procps`, `openssh-client`, `less`, `ncurses-term`, `ripgrep` and `fd-find` (as `fd`), plus pi itself.

These Debian packages were removed. Add any of them back with `image.packages`.

| Package | What it was for |
| --- | --- |
| `curl` | HTTP downloads from the shell. Also needed by the glab install step below. |
| `netcat-openbsd` | `nc`, raw TCP checks. `pi sandbox doctor` falls back to `socat`, which stays. |
| `jq` | Reading and editing JSON from the shell. |
| `python3` | Python scripts and tools. |
| `python3-venv` | `python3 -m venv` for project environments. |
| `make` | Makefiles. Also used by native npm modules that build with node-gyp. |
| `unzip` | Unpacking `.zip` archives. |
| `xz-utils` | Unpacking `.tar.xz` archives. |
| `gh` | The GitHub CLI (Debian bookworm's package). |

## glab

The GitLab CLI was installed from a pinned upstream `.deb`. To get it back, put these lines in a file, point `image.dockerfile` at it, and add `curl` to `image.packages` (the package step runs before your Dockerfile lines):

```dockerfile
ARG GLAB_VERSION=1.128.0
ARG GLAB_SHA256_AMD64=b42db1c339cb66df2dbdaf190b8c4e359cb2ea3f7ac53e46302b04777f2cf405
ARG GLAB_SHA256_ARM64=88e68a179fc25c3751e7950aa4b1b47b184cade590b70d9ca4aafff6648c655e

RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) sum="${GLAB_SHA256_AMD64}" ;; \
      arm64) sum="${GLAB_SHA256_ARM64}" ;; \
      *) echo "no glab package for $arch" >&2; exit 1 ;; \
    esac \
 && deb="/tmp/glab_${GLAB_VERSION}_linux_${arch}.deb" \
 && curl -fsSL -o "$deb" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.deb" \
 && echo "$sum  $deb" | sha256sum -c - \
 && dpkg -i "$deb" \
 && rm -f "$deb"
```

Image builds reach the network from the VM, outside `egress.allow`, so gitlab.com does not need to be allowed for this step.

## gh and glab credentials

The launcher still reads your host's gh and glab logins. When it finds them it writes placeholder configs for `gh` and `glab` in the sandbox, and the proxy swaps the placeholder for the real token. These files do nothing until you install the tool.

`git fetch` and `git push` over HTTPS to those hosts work without gh or glab in the image. The sandbox gitconfig has a small credential helper that hands git the placeholder directly, and SSH remotes of those hosts are rewritten to HTTPS.

## Egress presets

`egress.presets` is gone. `egress.allow` is empty by default. The old default was `npm`, `pypi` and `github`. The hosts of each preset were:

| Preset | Hosts |
| --- | --- |
| `npm` | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| `pypi` | `pypi.org`, `files.pythonhosted.org` |
| `github` | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| `maven` | `repo.maven.apache.org`, `repo1.maven.org` |
| `gradle` | `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`, `downloads.gradle.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `cargo` | `crates.io`, `index.crates.io`, `static.crates.io` |

List the hosts you need in `egress.allow`.

## Removed config keys

A config that still sets one of these keys is refused with a message that says what replaces it.

| Key | Now |
| --- | --- |
| `fallback` | Always `"host"`: `--no-sandbox` is always allowed. |
| `egress.grants` | Always on. |
| `egress.parentProxy` | Always follows the proxy environment variables. |
| `egress.presets` | Gone. Use `egress.allow`. |
| Administrator policy file | Gone. There is one config file: built-in defaults plus yours. A policy file that still exists is not read; each launch and `pi sandbox doctor` say so. |

## Getting the old defaults back

This config restores the old image tools and the old default hosts. Save the glab snippet above as `~/.pi/agent/pi-sandbox/glab.Dockerfile`, or drop `image.dockerfile` if you do not need glab.

```json
{
  "image": {
    "packages": ["curl", "netcat-openbsd", "jq", "python3", "python3-venv", "make", "unzip", "xz-utils", "gh"],
    "dockerfile": "~/.pi/agent/pi-sandbox/glab.Dockerfile"
  },
  "egress": {
    "allow": [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "repo.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "release-assets.githubusercontent.com"
    ]
  }
}
```

## Tip: shared package caches

Your sandbox home lives in memory, so package caches are lost when pi exits. Listing them in `mounts.sharedCaches` keeps them in volumes that all your sandboxes share, which makes installs in each repository cheaper:

```json
{ "mounts": { "sharedCaches": ["~/.npm", "~/.cache/pip"] } }
```

The volumes start empty and never use your Mac's folders. Every sandbox can write to them, so keep them to package caches. See [Shared caches](CONFIGURATION.md#shared-caches).
