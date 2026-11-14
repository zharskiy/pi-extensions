# Removed defaults

The launcher used to ship network access that not every project needs. It is gone. This page lists what was removed and how to add each one back in your config file (`pi-sandbox/config.json` under pi's agent dir, see [CONFIGURATION.md](CONFIGURATION.md)).

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

This config restores the old default hosts.

```json
{
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
