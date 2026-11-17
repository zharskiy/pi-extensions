# Organisation rollout examples

Starting points for a company that installs pi, the extensions and the `pi-sandbox` launcher on its Macs with one command. The guide is [INSTALL.md](../../../INSTALL.md) at the root of the repository; these files put it into practice. Every `example.com` name and every placeholder step is yours to replace.

Deploy the four files together into one directory, for example `/usr/local/libexec/example-corp/`: `company-install.sh` reads `config.json` and `settings.json` beside it, `company-update.sh` runs `company-install.sh` beside it, and `settings.json` names `company-update.sh` by that full path.

| file | what it is |
| --- | --- |
| [company-install.sh](company-install.sh) | The company install script: a sign-in placeholder, default settings added to `settings.json` (only the keys the user does not have, plus the enforced `selfUpdateCommand`, written atomically), then the bootstrap of the pinned release, checked against its `SHA256SUMS`, with the roots and the org config. The bootstrap installs pi when it is missing; a company with its own pi step puts it where the script's comment says and passes `--skip-pi`. Every failure ends with one `company-install: <step>: …` line and a code from the exit code table. |
| [company-update.sh](company-update.sh) | The target of pi's `selfUpdateCommand` (`/usr/local/libexec/example-corp/company-update.sh`): updates pi with pi's own installer, then runs `company-install.sh`. |
| [config.json](config.json) | An org launcher config for `--config`: internal gateway, registry and git hosts, the public npm registry the sandbox installs the extensions from, a denied paste site, the company CA, two credential rules, a shared npm cache and a memory limit. Workspace roots are left out: they come from `--root` per user. |
| [settings.json](settings.json) | A fragment of pi's user `settings.json`, added by `company-install.sh` key by key: `selfUpdateCommand` pointing at `company-update.sh`, and two display settings. It has no `packages` entry: the installer writes that. |

Keep `PINATA_VERSION` in `company-install.sh` and `config.json` in the same repository and change them in one commit: the installer validates the config with the version it installs.

Validate `config.json` in your CI against [schema/sandbox-config.schema.json](../../schema/sandbox-config.schema.json); the keys are explained in [CONFIGURATION.md](../../CONFIGURATION.md).

## Running it on a schedule

The install command is also the update command. To rerun it at every login and once a day, install a launchd agent for the user, for example `~/Library/LaunchAgents/com.example.pi-install.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.pi-install</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/usr/local/libexec/example-corp/company-install.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>/tmp/com.example.pi-install.log</string>
</dict>
</plist>
```

Load it as the user with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.pi-install.plist`. A launchd agent runs as the user, which the installer requires; a LaunchDaemon runs as root and exits 69. `PATH` must reach `node`, `npm` and `brew`. Exit 75 means pi was open and nothing changed; the next run tries again.
