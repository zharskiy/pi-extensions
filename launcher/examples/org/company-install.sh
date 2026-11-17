#!/bin/sh
# Example company install script: sign-in, default settings, then pinata with the sandbox launcher.
# Run it as the user who will use pi, never as root. Deploy it together with config.json,
# settings.json and company-update.sh into one directory, for example
# /usr/local/libexec/example-corp/. Replace every example.com name and every placeholder step
# with your own. See INSTALL.md at the root of the repository.
#
# Every failure ends with one "company-install: <step>: ..." line and a code from the exit code
# table in INSTALL.md, so the caller (a login hook, launchd, your MDM) can act on the code.

set -eu

# The one version pin. Change it together with config.json in the same commit.
PINATA_VERSION=0.5.0 # x-release-please-version

release="https://github.com/zharskiy/pi-extensions/releases/download/v$PINATA_VERSION"
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
step=start
dir=""

# Workspace roots differ per user, so they come from the environment with a default here.
roots=${PI_SANDBOX_ROOTS:-$HOME/work}

say() {
  printf '%s\n' "company-install: $*" >&2
}

fail() {
  code=$1
  shift
  say "$step: $*"
  exit "$code"
}

finish() {
  status=$?
  trap - EXIT

  if [ -n "$dir" ]; then
    rm -rf "$dir" 2>/dev/null || :
  fi

  case $status in
    0|64|69|70|73|75|78|79|130|143) exit "$status" ;;
  esac

  say "$step: failed unexpectedly (exit $status)"
  exit 70
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

here=$(cd "$(dirname "$0")" && pwd) || fail 70 "cannot find the directory of this script"
org_config="$here/config.json"
settings_fragment="$here/settings.json"

# pi itself: the bootstrap below installs pi with pi's own installer when it is missing, without a
# terminal, and leaves an existing managed pi alone. If your company installs pi in a step of its
# own (pi's installer from a mirror, a pinned pi release), put that step here and add --skip-pi to
# the bootstrap's options, so a missing pi fails with 69 instead of being installed.

# Your existing sign-in or credential step (SSO, provider keys, a token helper).
sign_in() {
  step=sign-in
  say "sign-in: placeholder, put your own step here"
}

# Default settings. Adds the fragment's keys the user does not have yet, so the user's own choices
# survive every run; only the keys in "enforced" are always set. The packages entry the installer
# writes is never touched: the fragment must not contain one. The write is atomic: a temporary
# file beside settings.json, renamed over it.
seed_settings() {
  step=settings
  command -v node >/dev/null 2>&1 || fail 69 "node is missing; install Node 22.19 or newer and run this again"
  mkdir -p "$agent_dir" || fail 70 "cannot create $agent_dir"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [file, fragmentFile] = process.argv.slice(1);
    const enforced = ["selfUpdateCommand"];
    const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
    const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
    const fragment = JSON.parse(fs.readFileSync(fragmentFile, "utf8"));
    const added = Object.entries(fragment).filter(([key]) => enforced.includes(key) || !(key in current));
    const merged = { ...current, ...Object.fromEntries(added) };

    if (JSON.stringify(merged) === JSON.stringify(current)) {
      process.exit(0);
    }

    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;

    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode, flag: "wx" });
    fs.renameSync(temporary, target);
  ' "$agent_dir/settings.json" "$settings_fragment" || fail 70 "merging $settings_fragment into $agent_dir/settings.json failed"

  # Extension settings are whole files; copy them only when the user has none yet, for example:
  # [ -f "$agent_dir/pi-style.json" ] || printf '%s\n' '{ "style": "concise" }' > "$agent_dir/pi-style.json"
}

# The bootstrap of the pinned release, checked against the release's SHA256SUMS.
fetch_bootstrap() {
  step=download
  command -v curl >/dev/null 2>&1 || fail 69 "curl is missing"
  dir=$(mktemp -d) || fail 70 "cannot create a temporary directory"
  curl -fsSL -o "$dir/install.sh" "$release/install.sh" || fail 70 "downloading $release/install.sh failed (curl exit $?); check the network and run this again"
  curl -fsSL -o "$dir/SHA256SUMS" "$release/SHA256SUMS" || fail 70 "downloading $release/SHA256SUMS failed (curl exit $?); check the network and run this again"

  step=checksum
  (cd "$dir" && grep ' install.sh$' SHA256SUMS | shasum -a 256 -c - >/dev/null 2>&1) || fail 70 "install.sh does not match SHA256SUMS of v$PINATA_VERSION, not running it; report this to your security team"
}

# One option per line; the roots are split at ":".
bootstrap_options() {
  printf '%s\n' --package-version "$PINATA_VERSION" --config "$org_config" --config-conflict keep
  printf '%s' "$roots" | awk 'BEGIN { RS = ":" } length($0) { print "--root"; print $0 }'

  # Mirrors, if you have them:
  #   printf '%s\n' --package "https://files.example.com/pi/zharskiy-pinata-$PINATA_VERSION.tgz"
  #   printf '%s\n' --extensions-source "git:git.example.com/mirrors/pi-extensions@v$PINATA_VERSION"
  # and, for pi's installer and pi update:
  #   export PI_INSTALLER_API_BASE=https://mirror.example.com/pi/api/installer/releases
}

sign_in
seed_settings
fetch_bootstrap

step=bootstrap
options=$(bootstrap_options) || fail 70 "building the bootstrap options failed"
status=0
(IFS='
'; set -f; exec sh "$dir/install.sh" $options) || status=$?

case $status in
  0)
    say "done; open a new terminal and run pi in a repository under $roots"
    ;;
  64)
    fail 64 "the command line is wrong for pinata $PINATA_VERSION; fix this script (an option newer than the pinned version needs a newer pin)"
    ;;
  69)
    fail 69 "a prerequisite is missing (see the line above): install it and run this again"
    ;;
  70)
    fail 70 "a step failed and the install is incomplete (see above); running this again is safe"
    ;;
  73)
    fail 73 "$HOME/.local/bin/pi is a file the installer did not create; move it away and run this again"
    ;;
  75)
    fail 75 "pi is running, nothing was changed; this runs again at the next login"
    ;;
  78)
    fail 78 "the configuration was rejected (see above): fix config.json in the company repository, or decide on the user's edited config.json"
    ;;
  79)
    fail 79 "installed, but the sandbox check failed: run 'pi sandbox doctor' in a repository and send its output to the help desk"
    ;;
  130|143)
    fail "$status" "interrupted"
    ;;
  *)
    fail 70 "the bootstrap exited with $status, which this script does not know; treat it as a failure"
    ;;
esac
