# pi-sandbox configuration

Every setting of the sandbox, how two config files combine, and how credentials reach the proxy. For installing and everyday use, see [README.md](README.md). For what each setting weakens, see [THREAT-MODEL.md](THREAT-MODEL.md).

## Where the config lives

The sandbox reads two JSON files, called *layers*. Both use the same keys.

| layer | path | written by |
| --- | --- | --- |
| policy | `/Library/Application Support/pi-sandbox/policy.json` (`/etc/pi-sandbox/policy.json` on Linux) | your administrator |
| user | `~/.pi/agent/pi-sandbox/config.json` (`pi-sandbox/config.json` under `PI_CODING_AGENT_DIR` when set) | you |

A missing file is simply skipped. The launcher reads both files at every launch and never writes them. Nothing in the project folder configures the sandbox.

The user config used to live in `~/.config/pi-sandbox/config.json`. That file is no longer read: while it exists and the new one does not, every launch and `pi sandbox doctor` name both paths. Move it yourself; the launcher never touches the old folder.

`pi sandbox config` prints the result and the layer each key comes from. Add `--json` for machine-readable output.

The keys are described in [schema/sandbox-config.schema.json](schema/sandbox-config.schema.json). A `$schema` key is allowed, so your editor can point at that file for completion.

An invalid value or an unknown key stops the launch. The message names the key, and the hint names the file to fix.

The message also shows the value for `fallback`, `egress.presets`, `image.dockerfile`, `image.packages`, `tls.extraCa` files, `workspaceRoots.roots`, `mounts.sharedCaches` and `env.allow`. Host, credential and `npmGlobal` values are never shown.

## When changes apply

Each launch gets a new container, so most changes apply at the next `pi`. Each folder also has one proxy on your Mac, shared by every pi session there. Some settings live in that proxy.

- **Grants** from `pi sandbox egress allow` and `revoke` apply at once, also to running sessions.
- **Network settings** reach running sessions when you start a new `pi` in that folder. These are `egress.allow`, `egress.deny`, `egress.presets`, `egress.privateHosts` and `egress.grants`, and the derived hosts, private model gateways included. Editing the file alone changes nothing for them.
- **Credential rules, `env` secrets, the parent proxy and `tls.extraCa`** wait until every pi of the folder has exited. An `env` secret is a credential rule whose secret comes from a variable of your shell.

When other sessions run, a new launch says which case applies:

```
the network allow and deny settings changed and now apply to every pi running in this folder
the credential, parent proxy or CA settings changed; the pi sessions running in this folder keep the earlier ones until they all exit (egress allow and deny changes apply now)
```

Connections that are already open stay until they close.

## All keys

| key | what it does | default |
| --- | --- | --- |
| `fallback` | `host` lets `pi --no-sandbox` run host pi. `refuse` turns that off. | `"host"` |
| `egress.presets` | Sets of package registry hosts to allow. | `["npm", "pypi", "github"]` |
| `egress.allow` | More hosts the sandbox may reach. | `[]` |
| `egress.deny` | Hosts that are never reachable. | `[]` |
| `egress.privateHosts` | Names that may resolve to private addresses. | `[]` |
| `egress.grants` | Whether `pi sandbox egress allow` may add hosts. | `true` |
| `egress.parentProxy` | `env` uses your `HTTPS_PROXY`. `none` ignores it. | `"env"` |
| `image.packages` | Debian packages to add to the image. | none |
| `image.npmGlobal` | npm packages to install globally, as `name@version`. | none |
| `image.dockerfile` | A file of Dockerfile lines to add to the image. | none |
| `image.reference` and `image.digest` | A prebuilt image to pull instead of building one. | none |
| `credentials.derive.enabled` | Whether credentials are read from your host files. | `true` |
| `credentials.derive.hosts` | Read credentials only for these hosts. | every host |
| `credentials.rules` | Credentials you define by hand. | `[]` |
| `tls.extraCa` | Extra CA certificates to trust. | `[]` |
| `mounts.autoOverlays` | Give build output folders their own volume. | `true` |
| `mounts.sharedCaches` | Folders under `~` shared by all your sandboxes. | `[]` |
| `env.allow` | Variables from your shell passed into each run. | terminal variables |
| `resources.cpus` | CPU limit of the container. | no limit (the whole VM) |
| `resources.memoryGiB` | Memory limit of the container, in GiB. | no limit (the whole VM) |
| `sessions.host` | Keep sessions in host pi's own session folder. | `true` |
| `workspaceRoots` | Folders pi may start in, as `{ "roots": [...] }`. | anywhere |

The sections below explain each group.

## Network access

The sandbox reaches a host only when one of these lists names it:

- `pi.dev`, where pi reads its model list. It is always allowed on port 443, without a credential.
- The hosts of `egress.presets`.
- `egress.allow`.
- The hosts of your credentials, derived or from `credentials.rules`.
- Your grants.

`egress.deny` wins over all of them, `pi.dev` included.

### Presets

| preset | hosts |
| --- | --- |
| `npm` | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| `pypi` | `pypi.org`, `files.pythonhosted.org` |
| `github` | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| `maven` | `repo.maven.apache.org`, `repo1.maven.org` |
| `gradle` | `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`, `downloads.gradle.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `cargo` | `crates.io`, `index.crates.io`, `static.crates.io` |

Setting `egress.presets` replaces the default list. `[]` turns every preset off.

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

A model gateway needs no entry when your host `models.json` names it in a `baseUrl` (a provider's or a model's) and that provider has a derived credential rule. Such a host and port may resolve to a private network address: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 or fc00::/7. Loopback, link-local (the cloud metadata address 169.254.169.254 included), 198.18.0.0/15 and the other reserved ranges stay refused for it; list the name in `egress.privateHosts` if it really needs one of those. This covers only `models.json` in pi's agent folder on your Mac, never a file in the project, and never an MCP server's `url` from `mcp.json`. `credentials.derive.enabled: false`, a `credentials.derive.hosts` list that leaves the host out, or a rule of your own for the host turn it off for that host, and a policy that locks egress (`egress.grants: false`) turns it off entirely.

### Grants

A *grant* is a host you allow from the command line, without editing a file:

```console
$ pi sandbox egress allow docs.example.com
allowed docs.example.com for /Users/you/code/my-app
$ pi sandbox egress allow git.example.com:8443 --user
allowed git.example.com:8443 for every repository
```

- A grant without `--user` is for the current folder. With `--user` it is for every folder.
- It takes one host name and an optional port. The port defaults to 443.
- It refuses wildcards, IP addresses, `localhost` and port 80.
- It refuses a host that `egress.deny` names, since a grant cannot override a deny.
- It is refused when `egress.grants` is `false`.

`pi sandbox egress revoke <host>` removes the grant for every port of that host. Name a port to remove only that one.

`revoke` works in one scope: the current folder, or every folder with `--user`. `pi sandbox egress list` shows your grants, and `list --denied` shows what the folder's running proxy blocked.

When a folder is deleted, the launcher forgets its grants.

### Blocked hosts

A blocked request gets a 403 page that says what to do. When pi exits, the launcher prints one line per blocked host, ending in a hint:

| why it was blocked | hint |
| --- | --- |
| not on any allow list | `run pi sandbox egress allow <host> on the host from <folder>`, or with grants off `ask your administrator to add <host> to egress.allow` |
| it resolves to a private, loopback, link-local or reserved address | the proxy's reason with the address, then `add <host> to egress.privateHosts in <your config file>`, or with egress locked by the policy `ask your administrator to add <host> to egress.privateHosts` |
| `egress.deny` names it | `denied by policy` |
| plain HTTP | `plain HTTP is not proxied; use https` |
| the host did not answer | `it could not be reached: <reason>` |
| a credential could not be fetched | `it could not authenticate: <reason>` |
| a provider login on the host is missing or expired | `log in again with pi --no-sandbox and /login`, or with `fallback` set to `refuse` `log in again with host pi` |

Any other case prints the proxy's own reason.

`pi sandbox doctor` puts the same reason and hint under the `rule` check of a credential host the proxy refused. Every other host blocked during its run becomes a `blocked <host:port>` warning in the network section, with the same reason and hint, instead of a line printed when it exits; a run that stops before its probes reports none.

## Image

The sandbox image is Debian bookworm with Node 24, git, search tools, curl, jq, python3, gh and glab. It installs the same pi version as your host pi, from npm. When host pi changes version, the next launch rebuilds the image.

These keys add one layer on top of that image:

- `image.packages`: Debian package names, optionally as `name=version`.
- `image.npmGlobal`: npm packages as `name@version`. URLs, paths and git sources are refused.
- `image.dockerfile`: an absolute or `~/` path to a file of Dockerfile lines, without `FROM`. The lines run as root during the build, so treat the file as code you run.

The layer is rebuilt only when these inputs change.

`image.reference` and `image.digest` go together. With both set, the launcher pulls that image by its digest (`sha256:` and 64 hex digits) instead of building its own. The registry must allow anonymous pulls. The layer above still builds on top.

Image builds reach the network straight from the VM, outside the allow-list. The launcher starts them, not the agent.

## Build output and caches

### Build output overlays

With `mounts.autoOverlays` on, these folders get a volume of their own when a matching file sits in the same folder:

| lockfile in the same folder | folder |
| --- | --- |
| `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb` | `node_modules` |
| `uv.lock`, `poetry.lock`, `Pipfile.lock` | `.venv` |
| `Cargo.lock` | `target` |
| `settings.gradle`, `settings.gradle.kts` | `.gradle` |

This keeps Linux builds apart from your Mac's. Inside, the host copy is hidden, so run your install command once there. Maven `target/` and Gradle `build/` are not overlaid and are shared with your Mac.

If there are more than 512 such folders, nothing is overlaid and a notice says so. A repository too large to search gets no overlays and a notice. A plain folder that large is refused. Set `mounts.autoOverlays` to `false` to use your Mac's copies.

If an overlay folder is missing, the launcher creates it empty on your Mac. It removes it again, if still empty, after the folder's last session. `pi sandbox reset` removes the overlay volumes.

### Shared caches

Your home inside the sandbox lives in memory, so tool caches are lost when pi exits. `mounts.sharedCaches` keeps chosen folders in volumes that all your sandboxes share:

```json
{ "mounts": { "sharedCaches": ["~/.npm", "~/.cache/pip"] } }
```

- Each entry starts with `~/` and appears at the same path inside the sandbox.
- Your Mac's folder of that name is never mounted. The volume starts empty.
- No entry may appear twice or lie inside another.
- These are refused, with every folder under them: `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.colima`, `~/.kube`, `~/.config` and `~/.local/bin`.

Every sandbox can write to these volumes, so a bad package written in one folder reaches the others. Use them for package caches only.

The volumes stay until you uninstall. `pi sandbox reset` and the daily cleanup do not remove them.

## Variables passed into the sandbox

`env.allow` names the variables of your shell that reach each pi run. The default list is `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `COLORFGBG` and `LANG`. Your entries add to it.

Some names are refused when the config loads:

- Names that look like secrets: they contain `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL` or `JWT`, in any case.
- The proxy variables, in any case.
- Variables the launcher sets inside, such as `PI_CODING_AGENT_DIR` or `NODE_EXTRA_CA_CERTS`.

A value that looks like a credential stays on your Mac. That means a `Bearer`, `Basic` or `Token` prefix, a JWT, or a URL with a user name or password. The launch then prints `env.allow: <NAME> holds a credential, so it stays on the host`.

Inside, `PI_SANDBOX=1` tells scripts they run in the sandbox. `NO_PROXY` holds `localhost,127.0.0.1,::1`, so local test servers are reached directly.

## Credentials

### Derived credentials

With `credentials.derive.enabled` on, the launcher reads these at every launch:

- Each provider in host pi's `auth.json`, and provider API keys set as variables in your shell. The proxy reads such a key on your Mac. It is never copied inside.
- Each `apiKey` and secret header in `models.json`.
- Each enabled HTTP server in `mcp.json`.
- The gh and glab hosts, with their tokens.
- Registry credentials in `~/.npmrc`, `~/.m2/settings.xml` and `pip.conf`. For pip the first of `~/.config/pip/pip.conf`, `~/Library/Application Support/pip/pip.conf` and `~/.pip/pip.conf` is used.
- Your git `user.name` and `user.email`.

Inside, the matching files hold placeholders only. So `gh`, `glab`, `git push`, npm, pip and Maven work as on your Mac, while the proxy fetches the real value on your Mac.

A registry, mirror or index without a credential and without an `egress.allow` entry prints a notice. It names the entry to add.

A derived gh or glab token reaches everything it can on its host. For github.com that is `github.com`, `api.github.com` and `uploads.github.com`.

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
| `placeholder` | Optional. A stand-in value starting with `pi-sandbox-` that you put in a tool's config inside. |
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

- **At launch.** If a token is missing or expired and cannot be refreshed, the launcher runs `pi mcp login <name>` on your Mac first. This happens only when pi runs in a terminal. After a failed sign-in it is skipped for a day.
- **During a session.** When a token expires or is rejected, the proxy opens the sign-in in your browser. It does so at most once per server per minute, and waits 10 minutes after a failed sign-in or a rejected token. Pi inside is told to retry.
- **Never signed in.** Requests go out without a token, so servers that need no sign-in work.
- **Project-only servers.** A server defined only in a project's `.pi/mcp.json` gets no token. Add it with `pi mcp add` instead.

## Corporate proxy and TLS inspection

### Parent proxy

With `egress.parentProxy` set to `env`, the default, the launcher's proxy forwards through your company proxy. It reads `HTTPS_PROXY`, else `https_proxy`, and `NO_PROXY`, else `no_proxy`, from the shell that runs `pi`. It does not read the macOS system proxy or a PAC file.

- Only an `http://` proxy URL works. For anything else the launch prints a warning and connects directly.
- Set `egress.parentProxy` to `none` to ignore `HTTPS_PROXY` and connect directly.
- NTLM and Kerberos proxies need a local relay such as `px` or `cntlm`.

Image builds use the same proxy. A proxy address on `localhost` is pointed at your Mac. A proxy URL with a user name or password is refused for builds, since it would be written into the image. Use a proxy without credentials, or a prebuilt image with no extra layer.

### Extra CA certificates

If a proxy on your network inspects TLS, add its CA certificate:

```json
{ "tls": { "extraCa": [{ "file": "/Users/you/corp-ca.pem" }] } }
```

`{ "hostStore": true }` instead reads the CAs of the macOS System keychain. The CAs are trusted by the launcher's proxy, inside the container and during the image build.

They do not reach the VM's container engine. If the proxy inspects Docker Hub, the first image pull fails with an x509 error, and the error says so. Two fixes work:

- Install the CA in the VM:
  1. Add a `provision` entry with `mode: system` to `~/.colima/pi-sandbox/colima.yaml`.
  2. In its script, copy the CA into `/usr/local/share/ca-certificates/` and run `update-ca-certificates`.
  3. End the script by restarting docker.
  4. Restart the profile while no pi runs.
- Or use `image.reference` and `image.digest` with a registry the proxy does not inspect.

## Databases and other services

The sandbox has no container engine and cannot reach your Mac's `localhost`. So `docker compose` and Testcontainers do not work inside. Run the server inside the sandbox instead.

1. Add it to `image.packages` in your user config, for example `postgresql` and `redis-server`.
2. Start it with its data under `/tmp`:

   ```bash
   PATH=/usr/lib/postgresql/15/bin:$PATH        # Debian bookworm's PostgreSQL
   initdb -D /tmp/pg --no-locale -E UTF8 -U postgres && pg_ctl -D /tmp/pg -o "-k /tmp" -l /tmp/pg.log start
   redis-server --dir /tmp --daemonize yes
   ```

3. Point your tests at `127.0.0.1`.

`/tmp` lives in memory. The data counts against the container's memory and is gone when pi exits.

## For administrators

The policy file is `/Library/Application Support/pi-sandbox/policy.json`. It takes the same keys as the user config. The launcher reads it at every launch.

Make the file writable by root only. The launcher does not check its owner, and whoever can write it sets the limits. `PI_SANDBOX_POLICY_FILE` names another policy file only while the standard one does not exist, so it never overrides yours.

### How the policy and the user config combine

- **A key the policy sets is final.** The user's value is ignored with a warning, and `pi sandbox config` lists it.
- **Each key counts on its own.** If both matter, set `resources.cpus` and `resources.memoryGiB` each in the policy file. `workspaceRoots` counts as one key.
- **Lists add up.** `egress.allow`, `egress.deny`, `egress.privateHosts`, `image.packages`, `image.npmGlobal`, `credentials.rules` and `env.allow` collect the entries of both files. A user can add entries and remove none.
- **Deny wins.** `egress.deny` wins over every allow, grant and credential host.
- **Rule ids are yours.** A user rule with an `id` the policy uses is ignored.

The user sees this warning at launch, once per folder:

```
pi-sandbox: warning: config keys ignored: user egress.allow (egress is locked: the policy config sets egress.grants to false); see pi sandbox config
```

### Common settings

- `egress.grants: false` locks egress. `pi sandbox egress allow` is refused, and the user's `egress.allow` and `egress.privateHosts` are ignored. The user's `egress.presets` still apply unless the policy sets them.
- Even with egress locked, the hosts of `credentials.rules` from either file stay reachable, and so do derived credential hosts. A model gateway from the user's host `models.json` no longer gets private network addresses automatically, though: list it in the policy's `egress.privateHosts`.
- `credentials.derive.enabled` or `credentials.derive.hosts` limits the derived hosts.
- `fallback: "refuse"` turns `pi --no-sandbox` off.
- `workspaceRoots`, as `{ "roots": ["/Users/you/work"] }`, refuses a launch outside those folders.
- `egress.presets: []` turns the registry presets off for good.
- `tls`, `sessions`, `resources`, `egress.parentProxy` and `mounts.sharedCaches` can be set in the policy file like any other key.

`pi install`, `pi mcp …` and `pi update` run host pi on the host, whatever the policy says. They run before the config is read.

### Sample policy

[examples/policy.json](examples/policy.json) is a starting point. It does the following:

- Refuses `pi --no-sandbox`.
- Turns grants off, which drops the user's `egress.allow` and `egress.privateHosts`. The user's `egress.presets` still apply, since the policy does not set them.
- Allows an internal gateway, registry and git host. It also lists them as private hosts, since they resolve to internal addresses.
- Denies a paste site.
- Adds the company CA.
- Adds a credential for the gateway, from a host command, and one for the registry, from a variable.
- Keeps credential derivation on, so `gh`, `glab`, npm, pip and Maven work as on the host.

Under that policy, the Java user config in the [README](README.md#configuration) loses its `egress.allow` entry.

## Environment variables the launcher reads

| variable | effect |
| --- | --- |
| `PI_SANDBOX_USER_CONFIG` | Path of the user config. |
| `PI_SANDBOX_STATE_DIR` | The launcher's state folder. The default is `pi-sandbox/state` in host pi's agent folder. |
| `PI_SANDBOX_POLICY_FILE` | A policy file, used only while the standard one does not exist. |
| `PI_CODING_AGENT_DIR` | Host pi's agent folder. The default is `~/.pi/agent`. The user config and the state follow it, so two shells with different values use separate configs, CAs and state. |
| `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy` | The parent proxy, with `egress.parentProxy` set to `env`. |
| `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME` | Where the gh and glab configs are read. A path inside the repository is ignored. |
| Provider API key variables | Derived as credentials. The proxy reads them on your Mac. |
| The names in `env.allow` | Passed into each pi run. |
| `COLIMA_HOME` | Ignored. The launcher always uses `~/.colima/pi-sandbox`. |
