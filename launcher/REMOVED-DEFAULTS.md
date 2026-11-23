# Removed defaults

The launcher used to ship network access that not every project needs, forwarded a variable that broke the sandbox's locale, built the sandbox's trust at container start, put the proxy's token in the sandbox, and gave each folder its own proxy, network and grants. They are gone. This page lists what was removed and how to add each one back in your config file (`pi-sandbox/config.json` under pi's agent dir, see [CONFIGURATION.md](CONFIGURATION.md)).

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

## `LANG` in `env.allow`

`LANG` is no longer in the default `env.allow` list. The image sets `LANG=C.UTF-8` instead, because a host value such as `en_US.UTF-8` names a locale the image does not have, and perl and other programs then print `Setting locale failed`. To keep your Mac's value, add `LANG` to `env.allow` and generate that locale with `image.dockerfile`, see [Variables passed into the sandbox](CONFIGURATION.md#variables-passed-into-the-sandbox).

## Trust built at container start

The sandbox CAs (the launcher's CA and `tls.extraCa`) are now part of the image layer, so these container-start pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| The bind of the bundle at `/etc/pi-sandbox/ca.pem`, from `<state>/vm/trust-<hash>-<id>.pem` | The CAs are files under `/usr/local/share/ca-certificates/pi-sandbox/` and in `/etc/ssl/certs/ca-certificates.crt`. Read that file where a tool wants a bundle. |
| `/tmp/pi-sandbox/ca-bundle.pem`, which the entrypoint wrote, and the CA variables pointing at it | `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `NODE_EXTRA_CA_CERTS` all point at `/etc/ssl/certs/ca-certificates.crt`, which holds the same certificates. |
| `/tmp/pi-sandbox/truststore.p12`, which the entrypoint built for the `java` on `PATH`, and the `javax.net.ssl.trustStore` flags in `JAVA_TOOL_OPTIONS` (set by the launcher and by `bash-env.sh`) | Every JDK in the image has the CAs in its own `cacerts`. A JDK installed with `image.dockerfile` is covered, because the layer's last step runs after it. For a JDK installed later, run `/usr/local/lib/pi-sandbox/trust-jdk.sh <its folder>` as its owner. |
| `PI_SANDBOX_TRUST_HASH` | Nothing to restore: each launch creates its container, so no container outlives a CA change. The name is no longer reserved in `env.allow` and `env.set`. |

The first launch after the update rebuilds the image once (`preparing pi sandbox, one time`): the base image and the layer, or only the layer when `image.digest` pins the base.

## The proxy token inside the sandbox

The proxy's token no longer enters the sandbox container. The relay holds it and sends it ahead of every connection, so the proxy is `http://pi-sandbox-proxy:3128` inside, with no user or password. These pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| The token as the password in `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their lowercase forms | They are `http://pi-sandbox-proxy:3128`. Nothing to restore: the proxy ignores a `Proxy-Authorization` header and never forwards it. |
| `PI_SANDBOX_PROXY_HOST`, `PI_SANDBOX_PROXY_PORT`, `PI_SANDBOX_PROXY_TOKEN` | The proxy is always `pi-sandbox-proxy` port `3128`. A script that read them can use those values, or set them with `env.set`: `"PI_SANDBOX_PROXY_HOST": "pi-sandbox-proxy", "PI_SANDBOX_PROXY_PORT": "3128"`. The token has no replacement. |
| `JAVA_TOOL_OPTIONS` with the proxy host, port, user and password and the `jdk.http.auth.*.disabledSchemes` flags | Every JDK in the image, one from `image.dockerfile` included, has the proxy in its own `net.properties`, and no JVM prints `Picked up JAVA_TOOL_OPTIONS` any more. For a JDK installed later, run `/usr/local/lib/pi-sandbox/trust-jdk.sh <its folder>` as its owner, which writes the proxy and the CAs into that JDK, from `setup` when the JDK lives in a volume ([a JDK in a volume](CONFIGURATION.md#a-jdk-in-a-volume)). The name is no longer reserved in `env.allow` and `env.set`. |
| The Maven proxy's `<username>` and `<password>`, and the entrypoint step that wrote the proxy port into `~/.m2/settings.xml` | The rendered settings name `pi-sandbox-proxy` port `3128` and are linked as they are. Nothing to restore. |
| `entrypoint.sh` and `bash-env.sh` in the base image | They are copied by the layer, so a base pinned with `image.digest` still gets this launcher's scripts. Nothing to restore. |

## One proxy, network and grant list per folder

Each folder used to get its own proxy, token, relay, internal network and grants. There is now one of each per state dir, shared by every session in every folder (see [THREAT-MODEL.md](THREAT-MODEL.md#5-known-gaps), "Sessions share one network" and "Sessions share one proxy"). These pieces are gone:

| Removed | Now, and how to get it back |
| --- | --- |
| A proxy, token and relay per folder (`pi-sandbox-relay-<id>`) | One proxy and token under the state dir and one relay, `pi-sandbox-relay-<install id>`, where the install id is a short hash of the state dir. The latest launch sets the egress rules for every session, with a notice when other sessions run. Two folders cannot run with different `egress` lists at the same time. |
| An internal network per folder (`pi-sandbox-<id>`) | One internal network, `pi-sandbox-network-<install id>`, for every session's container of the state dir, its relay and its services pod. It is created so that the VM has no address on it, which needs Docker Engine 28 or later in the VM; with an older engine the launch says to update colima and recreate the VM. An existing network of that name is used as it is when it carries the launcher's managed label (`pi-sandbox.managed`); one without it fails the launch. Old per-folder networks and relays are not removed by the launcher (see below). |
| Grants per folder, and `pi sandbox egress allow --user` for every folder | Every grant is for every folder and every session. `--user` is refused as an unknown option. Old per-folder grants in `grants.json` are not read: allow those hosts again. |

## Notices about the old config folder and the policy file

Launches and `pi sandbox doctor` used to name a config left in `~/.config/pi-sandbox/` and an administrator policy file that still existed. Neither is read, nothing says so any more, and the launcher never touches `~/.config/pi-sandbox/`. Move your settings into `pi-sandbox/config.json` under pi's agent dir yourself.

## Removed config keys

A config that still sets one of these keys is refused: the key `is not a known key`. The table says what replaces it.

| Key | Now |
| --- | --- |
| `fallback` | Always `"host"`: `--no-sandbox` is always allowed. |
| `egress.grants` | Always on. |
| `egress.parentProxy` | Always follows the proxy environment variables. |
| `egress.presets` | Gone. Use `egress.allow`. |
| `mounts.sharedCaches` | Renamed. List the folders in `mounts.volumes`. |
| Administrator policy file | Gone. There is one config file: built-in defaults plus yours. A policy file that still exists is not read, and nothing says so. |

A `tls.extraCa` entry `{ "hostStore": true }`, which read the CAs of the macOS System keychain, is refused with `must set one of sha256, file`. Name each CA with `{ "sha256": … }` or `{ "file": … }` ([corporate proxy and TLS inspection](CONFIGURATION.md#corporate-proxy-and-tls-inspection)).

## Objects left by an older launcher

This launcher does not see the sessions of an earlier launcher build: it keeps its launches in a different place, and lists and changes only engine objects that carry its install label, which an older launcher did not set. Update the launcher with no pi session running.

The daily collection removes what an older build left in the sandbox VM: every stopped container, volume and network whose name starts with `pi-sandbox-`, that carries the `pi-sandbox.managed=true` label and that has no install label at all (the networks `pi-sandbox-machine` and `pi-sandbox-<id>`, the relays, the pod, the services, and the agent and cache volumes). It tries each volume and network and the engine refuses the ones still in use, so a container that still runs stays, with its volumes and network, until a later day's collection after it stops. Objects labelled by another install, and objects without the managed label, are never touched. An old agent volume holds the in-sandbox settings of that build, and they go with it.

Shared volumes (`pi-sandbox-shared-*`) of an older build are never removed by the daily collection, nor by `pi sandbox reset --services` or the uninstall, which remove only volumes with this install's label. Remove them with the engine's own tools, or delete and recreate the sandbox VM.

An old shared volume can have the same name as a new `mounts.volumes` entry, since the name is built from the same state dir hash. The launcher then mounts and reuses it, with its content, but never lists or removes it.

## Files left in the state folder

The launcher does not remove the files earlier versions left in its state folder: the CA bundles `ca/trust.pem`, `vm/trust.pem` and `vm/trust-*.pem` and the render dirs `repos/*/render/` (these go with their repository's state). Nothing reads them. With no sandbox running, remove them from the state folder (`~/.pi/agent/pi-sandbox/state` by default): `rm -f ca/trust.pem vm/trust*.pem` and `rm -rf repos/*/render`.

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

Your sandbox home lives in memory, so package caches are lost when pi exits. Listing them in `mounts.volumes` keeps them in volumes that all your sandboxes share, which makes installs in each repository cheaper:

```json
{ "mounts": { "volumes": ["~/.npm", "~/.cache/pip"] } }
```

The volumes start empty and never use your Mac's folders. Every sandbox can write to them, so keep them to package caches. See [Volumes](CONFIGURATION.md#volumes).
