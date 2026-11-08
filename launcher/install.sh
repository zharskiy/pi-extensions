#!/bin/sh
set -eu

package_name=pi-extensions-mz
colima_profile=pi-sandbox
min_colima=0.8.0
min_node=22.19.0
marker_begin="# pi-sandbox begin"
marker_end="# pi-sandbox end"
wrapper_marker="launcher/bin/pi-sandbox"
bin_dir="$HOME/.local/bin"
policy_file="${PI_SANDBOX_POLICY_FILE:-/Library/Application Support/pi-sandbox/policy.json}"
user_config="${PI_SANDBOX_USER_CONFIG:-$HOME/.config/pi-sandbox/config.json}"
state_dir="${PI_SANDBOX_STATE_DIR:-$HOME/.local/state/pi-sandbox}"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
replaced_link="$state_dir/replaced-pi-link"
managed_kind='"kind"[[:space:]]*:[[:space:]]*"pi-managed-install"'
managed_schema='"schemaVersion"[[:space:]]*:[[:space:]]*1([^0-9.]|$)'
managed_layout='"layout"[[:space:]]*:[[:space:]]*"releases-v1"'
managed_package="node_modules/@earendil-works/pi-coding-agent/package.json"
link_hops=40

profile=""
dry_run=0
cpus=4
memory=8
disk=60
version=""
org_source=""
org_sha256=""

usage() {
  echo "usage: install.sh [--profile solo|team|enterprise] [--org <https url or absolute path> [--org-sha256 <hex>]] [--cpu N] [--memory GiB] [--disk GiB] [--version X.Y.Z] [--bin-dir DIR] [--dry-run]"
}

fail() {
  echo "pi-sandbox install: $1" >&2
  exit 1
}

step() {
  echo "[$1/8] $2"
}

act() {
  if [ "$dry_run" -eq 0 ]; then
    "$@"
  fi
}

verb() {
  if [ "$dry_run" -eq 1 ]; then
    echo "would $1"
  else
    echo "$2"
  fi
}

version_at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    split(have, h, "."); split(want, w, ".");
    exit !((h[1] * 1000000 + h[2] * 1000 + h[3]) >= (w[1] * 1000000 + w[2] * 1000 + w[3]))
  }'
}

parse_args() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  case "$1" in
    --profile) profile="${2:-}"; shift 2 ;;
    --cpu) cpus="${2:-}"; shift 2 ;;
    --memory) memory="${2:-}"; shift 2 ;;
    --disk) disk="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --org) org_source="${2:-}"; shift 2 ;;
    --org-sha256) org_sha256="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --bin-dir) bin_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac

  parse_args "$@"
}

parse_args "$@"

shim_dir="$bin_dir"

if [ -d "$bin_dir" ]; then
  shim_dir=$(cd -P "$bin_dir" && pwd)
fi

shim="$shim_dir/pi"

if [ -z "$profile" ]; then
  if [ -f "$policy_file" ]; then
    profile=enterprise
  else
    profile=solo
  fi
fi

case "$profile" in
  solo|team|enterprise) ;;
  *) fail "unknown profile $profile, use solo, team or enterprise" ;;
esac

case "$org_source" in
  ""|https://*|/*) ;;
  *) fail "--org needs an https URL or an absolute path, got $org_source" ;;
esac

if [ -n "$org_sha256" ]; then
  [ -n "$org_source" ] || fail "--org-sha256 needs --org"
  printf '%s' "$org_sha256" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "--org-sha256 needs 64 hex digits"
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
checkout=$(dirname "$script_dir")

from_checkout=0
if [ -f "$checkout/package.json" ] && [ -e "$checkout/.git" ] && grep -q "\"name\": \"$package_name\"" "$checkout/package.json"; then
  from_checkout=1
fi

if [ -z "$version" ] && [ -f "$checkout/package.json" ]; then
  version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$checkout/package.json" | head -n 1)
fi

if [ -z "$version" ]; then
  version=latest
fi

os=$(uname -s)
chip=$(uname -m)

case "$os" in
  Darwin)
    macos=$(sw_vers -productVersion)
    command -v brew >/dev/null 2>&1 || fail "Homebrew is missing, install it from https://brew.sh and run this again"
    preflight="macOS $macos on $chip, Homebrew present"
    ;;
  Linux)
    [ -S /var/run/docker.sock ] || fail "Linux needs a running Docker Engine at /var/run/docker.sock (development only)"
    preflight="Linux on $chip with the Docker Engine socket, development only"
    ;;
  *)
    fail "unsupported system $os, pi-sandbox supports macOS (and Linux for development)"
    ;;
esac

command -v node >/dev/null 2>&1 || fail "node is missing, install Node $min_node or newer (brew install node)"
command -v npm >/dev/null 2>&1 || fail "npm is missing, install Node $min_node or newer (brew install node)"
node_version=$(node -p 'process.versions.node')
version_at_least "$node_version" "$min_node" || fail "node $node_version is too old, install Node $min_node or newer"

step 1 "preflight: $preflight, node $node_version, profile $profile"

if [ "$os" = Darwin ]; then
  if command -v colima >/dev/null 2>&1; then
    step 2 "runtime: colima is present"
  else
    act brew install colima >/dev/null
    step 2 "runtime: $(verb "brew install colima" "installed colima with Homebrew")"
  fi

  if [ "$dry_run" -eq 0 ]; then
    colima_version=$(colima version 2>/dev/null | sed -n 's/^colima version v\{0,1\}\([0-9.]*\).*/\1/p' | head -n 1)
    version_at_least "${colima_version:-0}" "$min_colima" || fail "colima ${colima_version:-unknown} is older than $min_colima, run brew upgrade colima"
  fi

  if colima status --profile "$colima_profile" >/dev/null 2>&1; then
    step 3 "colima: profile $colima_profile is running (colima stop --profile $colima_profile and run this again to apply new resources)"
  else
    act colima start --profile "$colima_profile" --vm-type vz --mount-type virtiofs --ssh-agent \
      --cpu "$cpus" --memory "$memory" --disk "$disk" --mount "$HOME:w" >/dev/null
    step 3 "colima: $(verb "start profile $colima_profile (vz, virtiofs, ssh agent, $cpus CPUs, ${memory} GiB, ${disk} GiB, $HOME writable)" "started profile $colima_profile (vz, virtiofs, ssh agent, $cpus CPUs, ${memory} GiB, ${disk} GiB, $HOME writable)")"
  fi
else
  step 2 "runtime: using the Docker Engine socket"
  step 3 "colima: not used on Linux"
fi

step 4 "image: prepared and verified by the smoke check in step 7"

host_pi=$(command -v pi 2>/dev/null || true)

is_ours() {
  if [ -L "$shim" ]; then
    case "$(readlink "$shim")" in
      */pi-sandbox|*/pi-sandbox.js) return 0 ;;
    esac
  fi

  [ -f "$shim" ] && grep -q "$wrapper_marker" "$shim"
}

link_target=""

resolve_link() {
  if [ ! -L "$1" ]; then
    link_target="$1"
    return 0
  fi

  if [ "$2" -le 0 ]; then
    return 1
  fi

  hop=$(readlink "$1")

  case "$hop" in
    /*) next="$hop" ;;
    *) next="${1%/*}/$hop" ;;
  esac

  resolve_link "$next" $(($2 - 1))
}

has_marker() {
  [ -f "$1" ] && grep -Eq "$managed_kind" "$1" && grep -Eq "$managed_schema" "$1" && grep -Eq "$managed_layout" "$1"
}

is_safe_release() {
  case "$1" in
    ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) return 1 ;;
  esac
}

is_managed_root() {
  [ -x "$1/bin/pi" ] && has_marker "$1/install/managed-install.json" || return 1
  release=$(cat "$1/install/current-version" 2>/dev/null) || return 1
  is_safe_release "$release" && [ -f "$1/install/releases/$release/$managed_package" ]
}

managed_root=""

is_managed_pi() {
  [ -L "$shim" ] || return 1
  resolve_link "$shim" "$link_hops" || return 1

  case "$link_target" in
    */bin/pi) ;;
    *) return 1 ;;
  esac

  candidate_root=$(cd -P "${link_target%/bin/pi}" 2>/dev/null && pwd) || return 1
  is_managed_root "$candidate_root" || return 1
  managed_root="$candidate_root"
}

refuse() {
  if [ "$dry_run" -eq 0 ]; then
    fail "$1, move it away or pass --bin-dir and run this again"
  fi

  echo "pi-sandbox install: would refuse, $1 (move it away or pass --bin-dir)"
}

agent_root=$(cd -P "$agent_dir" 2>/dev/null && pwd) || agent_root="$agent_dir"

if { [ -e "$shim" ] || [ -L "$shim" ]; } && ! is_ours && ! is_managed_pi; then
  refuse "$shim exists and is not the pi-sandbox launcher"
fi

if [ -n "$managed_root" ] && [ "$managed_root" != "$agent_root" ]; then
  refuse "$shim is pi's managed install at $managed_root, outside the host agent dir $agent_dir; the launcher uses only the managed install in the agent dir"
  managed_root=""
fi

recorded_shim=""

if [ -f "$replaced_link" ]; then
  recorded_shim=$(sed -n 1p "$replaced_link")
fi

if [ -n "$managed_root" ] && [ -n "$recorded_shim" ] && [ "$recorded_shim" != "$shim" ]; then
  fail "$replaced_link records the replaced pi link of $recorded_shim, not $shim; run uninstall.sh --bin-dir $(dirname "$recorded_shim") first"
fi

act mkdir -p "$bin_dir"

if [ -n "$managed_root" ] && [ "$dry_run" -eq 0 ]; then
  mkdir -p "$state_dir"
  printf '%s\n%s\n' "$shim" "$(readlink "$shim")" > "$replaced_link"
fi

if [ "$from_checkout" -eq 1 ]; then
  if [ "$dry_run" -eq 0 ]; then
    rm -f "$shim"
    quoted_entry=$(printf '%s' "$checkout/launcher/bin/pi-sandbox-dev.js" | sed "s/'/'\\\\''/g")
    printf '#!/bin/sh\nexec node '\''%s'\'' "$@"\n' "$quoted_entry" > "$shim"
    chmod 0755 "$shim"
  fi
  installed="$(verb "write" "wrote") $shim running $checkout/launcher/bin/pi-sandbox-dev.js"
else
  act npm install -g --legacy-peer-deps=false "$package_name@$version" >/dev/null
  npm_bin="$(npm prefix -g)/bin/pi-sandbox"
  act ln -sfn "$npm_bin" "$shim"
  installed="$(verb "install" "installed") $package_name@$version and link $shim to $npm_bin"
fi

bundled_pi_package="node_modules/@earendil-works/pi-coding-agent/package.json"

has_bundled_pi() {
  if [ "$#" -eq 0 ]; then
    return 1
  fi

  if [ -f "$1/$bundled_pi_package" ]; then
    return 0
  fi

  shift
  has_bundled_pi "$@"
}

bundled_pi_present() {
  if [ "$from_checkout" -eq 1 ]; then
    has_bundled_pi "$checkout"
  else
    npm_root=$(npm root -g)
    has_bundled_pi "$npm_root/$package_name" "$(dirname "$npm_root")"
  fi
}

if [ "$dry_run" -eq 0 ] && ! is_managed_root "$agent_dir" && ! bundled_pi_present; then
  if [ "$from_checkout" -eq 1 ]; then
    fail "no managed pi in $agent_dir and pi is missing next to the launcher in $checkout, run npm install there and run this again"
  fi

  fail "no managed pi in $agent_dir and pi is missing next to the launcher, npm skipped the peer dependency; run npm install -g --legacy-peer-deps=false $package_name@$version and run this again"
fi

snippet_files=""

snippet_body="export PATH=\"$bin_dir:\$PATH\""

current_snippet() {
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin { inside = 1; next }
    $0 == end { inside = 0; closed = 1; next }
    inside { print }
    END { if (!closed) exit 1 }
  ' "$1"
}

has_block() {
  [ -f "$1" ] && grep -qxF "$marker_begin" "$1" && grep -qxF "$marker_end" "$1"
}

without_block() {
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$1" > "$1.pi-sandbox.tmp"
  cat "$1.pi-sandbox.tmp" > "$1"
  rm -f "$1.pi-sandbox.tmp"
}

add_snippet() {
  if has_block "$1" && [ "$(current_snippet "$1")" = "$snippet_body" ]; then
    return 0
  fi

  if [ "$dry_run" -eq 0 ]; then
    if has_block "$1"; then
      without_block "$1"
    fi

    printf '\n%s\n%s\n%s\n' "$marker_begin" "$snippet_body" "$marker_end" >> "$1"
  fi

  snippet_files="$snippet_files $1"
}

add_snippet "$HOME/.zshrc"

if [ -f "$HOME/.bashrc" ]; then
  add_snippet "$HOME/.bashrc"
fi

if [ "$os" = Darwin ] && [ -f "$HOME/.bash_profile" ]; then
  add_snippet "$HOME/.bash_profile"
fi

if [ -n "$snippet_files" ]; then
  snippet="$(verb "add" "added") the PATH snippet to$snippet_files"
else
  snippet="PATH snippet already present"
fi

shadowed=""
if [ -n "$managed_root" ]; then
  shadowed="; the managed pi at $managed_root/bin/pi stays the host pi for host jobs and pi --no-sandbox (uninstall.sh restores the link)"
elif [ -n "$host_pi" ] && [ "$host_pi" != "$shim" ]; then
  shadowed=", $host_pi is now shadowed (reach it with pi --no-sandbox when policy allows)"
fi

step 5 "launcher: $installed, $snippet$shadowed"

if [ -f "$user_config" ]; then
  step 6 "config: $user_config exists, left as it is"
else
  if [ "$dry_run" -eq 0 ]; then
    mkdir -p "$(dirname "$user_config")"
    printf '{\n  "profile": "%s"\n}\n' "$profile" > "$user_config"
  fi
  step 6 "config: $(verb "write" "wrote") $user_config with profile $profile"
fi

if [ -n "$org_source" ]; then
  if [ "$dry_run" -eq 0 ]; then
    mkdir -p "$(dirname "$user_config")"
    PI_SANDBOX_ORG_SOURCE="$org_source" PI_SANDBOX_ORG_SHA256="$org_sha256" node -e '
      const { existsSync, readFileSync, writeFileSync } = require("node:fs");
      const file = process.argv[1];
      const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const sha256 = process.env.PI_SANDBOX_ORG_SHA256.toLowerCase();
      config.org = { source: process.env.PI_SANDBOX_ORG_SOURCE, ...(sha256 === "" ? {} : { sha256 }) };
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    ' "$user_config"
  fi
  step 6 "config: $(verb "set" "set") org in $user_config to $org_source${org_sha256:+ pinned to sha256 $org_sha256}"
fi

smoke_parent="$HOME/.cache"
smoke_output=""

smoke() {
  mkdir -p "$smoke_parent" || return 1

  smoke_dir=$(mktemp -d "$smoke_parent/pi-sandbox-smoke.XXXXXX") || return 1
  smoke_status=0

  smoke_real=$(cd "$smoke_dir" && pwd -P) || return 1
  smoke_sessions="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
  smoke_slug="--$(printf '%s' "$smoke_real" | sed 's|^/||; s|[/\\:]|-|g')--"
  git -C "$smoke_dir" init -q || smoke_status=1

  if [ "$smoke_status" -eq 0 ]; then
    smoke_output=$(cd "$smoke_dir" && PATH="$bin_dir:$PATH" PI_SANDBOX_SESSIONS_HOST=off "$shim" sandbox doctor 2>&1) || smoke_status=1
    (cd "$smoke_dir" && PATH="$bin_dir:$PATH" PI_SANDBOX_SESSIONS_HOST=off "$shim" sandbox reset --volumes >/dev/null 2>&1) || true
  fi

  rmdir "$smoke_sessions/$smoke_slug" 2>/dev/null || true
  rm -rf "$smoke_dir"

  return "$smoke_status"
}

if [ "$dry_run" -eq 1 ]; then
  step 7 "smoke: would run $shim sandbox doctor in a temporary git repository under $smoke_parent"
elif ! command -v git >/dev/null 2>&1; then
  step 7 "smoke: skipped, git is missing; run pi sandbox doctor inside a repository"
elif smoke; then
  step 7 "smoke: $shim sandbox doctor passed in a temporary git repository"
else
  printf '%s\n' "$smoke_output" >&2
  fail "smoke check failed, run $shim sandbox doctor inside a repository to see which check"
fi

if [ -n "$snippet_files" ]; then
  step 8 "next, in a new shell: cd <repo> && pi"
else
  step 8 "next: cd <repo> && pi"
fi
