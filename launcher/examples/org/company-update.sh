#!/bin/sh
# Example target of pi's selfUpdateCommand (see settings.json beside this file):
#   "selfUpdateCommand": ["/usr/local/libexec/example-corp/company-update.sh", "{version}"]
# pi runs it from `pi update` only when pi.dev (or the mirror in PI_INSTALLER_API_BASE) reports a
# newer pi, with {version} replaced by that release. It replaces pi's own managed update, so it
# must update pi itself. Run as the user, never as root.

set -eu

wanted=${1:?usage: company-update.sh <pi version>}
here=$(cd "$(dirname "$0")" && pwd)

say() {
  printf '%s\n' "company-update: $*" >&2
}

# Optional policy: refuse versions your company has not approved yet, for example by reading an
# allow-list from https://config.example.com/pi/approved-versions.txt.
approved() {
  return 0
}

if ! approved "$wanted"; then
  say "pi $wanted is not approved yet; staying on the installed version"
  exit 1
fi

# pi's own installer updates the managed install to the latest release (pi's installer takes no
# version). It runs without a terminal, so it asks nothing and edits no shell startup file.
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl -fsSL -o "$installer" "${PI_INSTALLER_URL:-https://pi.dev/install.sh}"
node -e '
  const { spawn } = require("node:child_process");
  const child = spawn("sh", [process.argv[1]], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code));
' "$installer"

# Then the company install command, so the extensions, the launcher and its config follow the
# company pin. The launcher rebuilds the sandbox image for the new pi at the next launch.
status=0
sh "$here/company-install.sh" || status=$?

if [ "$status" -eq 75 ]; then
  say "pi was updated; pinata waits until no pi session runs (run company-install.sh then)"
  exit 0
fi

exit "$status"
