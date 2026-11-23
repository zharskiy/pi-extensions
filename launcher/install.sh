#!/bin/sh
set -eu
unset CDPATH
min_colima=0.8.0
min_node=22.19.0
min_macos=13
managed_kind='"kind"[[:space:]]*:[[:space:]]*"pi-managed-install"'
managed_schema='"schemaVersion"[[:space:]]*:[[:space:]]*1([^0-9.]|$)'
managed_layout='"layout"[[:space:]]*:[[:space:]]*"releases-v1"'
pi_package="@earendil-works/pi-coding-agent"
managed_package="node_modules/$pi_package/package.json"
link_hops=40

usage() {
  echo "usage: install.sh"
}

fail() {
  printf '%s\n' "pi-sandbox install: $1" >&2
  exit 1
}

fail_with() {
  printf '%s\n' "pi-sandbox install: $2" >&2
  exit "$1"
}

on_terminal=0

if [ -t 1 ] && [ -t 2 ]; then
  on_terminal=1
fi

header_style=""
rule_style=""
plain_style=""
rule_text="----------------------------------------------------------------"

if [ "$on_terminal" -eq 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  header_style=$(printf '\033[1m')
  rule_style=$(printf '\033[2m')
  plain_style=$(printf '\033[0m')
  rule_text="────────────────────────────────────────────────────────────────"
fi

last_step=""

step() {
  if [ "$on_terminal" -eq 0 ]; then
    printf '%s\n' "[$1/6] $2"
    return 0
  fi

  if [ "$1" != "$last_step" ]; then
    printf '\n%s%s%s\n' "$rule_style" "$rule_text" "$plain_style"
  else
    printf '\n'
  fi

  last_step=$1
  printf '%s%s%s\n' "$header_style" "[$1/6] $2" "$plain_style"
}

streamed() {
  if [ "$on_terminal" -eq 1 ]; then
    "$@"
    return
  fi

  { streamed_status=$( { { if "$@" 2>&1 3>&- 4>&-; then echo 0 >&3; else echo "$?" >&3; fi; } | sed 's/^/      /' >&4; } 3>&1 ); } 4>&1
  return "$streamed_status"
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
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac
}

script_dir=$(cd "$(dirname "$0")" && pwd)
checkout=$(dirname "$script_dir")

. "$script_dir/bin/path-block.sh"
. "$script_dir/bin/paths.sh"
. "$script_dir/bin/shim.sh"

parse_args "$@"

replaced_link="$state_dir/replaced-pi-link"

from_checkout=0
if [ -f "$checkout/package.json" ] && [ -e "$checkout/.git" ] && grep -q "\"name\": \"$package_name\"" "$checkout/package.json"; then
  from_checkout=1
fi

version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$checkout/package.json" 2>/dev/null | head -n 1)
[ -n "$version" ] || fail "cannot read the package version from $checkout/package.json"

[ "$(id -u)" -ne 0 ] || fail "run install.sh as your own user, not as root or with sudo"

os=$(uname -s)
chip=$(uname -m)

case "$os" in
  Darwin)
    macos=$(sw_vers -productVersion)
    [ "${macos%%.*}" -ge "$min_macos" ] 2>/dev/null || fail "macOS $macos is too old, the sandbox VM (vz with virtiofs) needs macOS $min_macos or newer"
    command -v brew >/dev/null 2>&1 || fail "Homebrew is missing, install it from https://brew.sh and run this again"
    preflight="macOS $macos on $chip, Homebrew present"
    ;;
  *)
    fail "unsupported system $os, pi-sandbox supports macOS only"
    ;;
esac

command -v node >/dev/null 2>&1 || fail "node is missing, install Node $min_node or newer (brew install node)"
command -v npm >/dev/null 2>&1 || fail "npm is missing, install Node $min_node or newer (brew install node)"
node_version=$(node -p 'process.versions.node')
version_at_least "$node_version" "$min_node" || fail "node $node_version is too old, install Node $min_node or newer"

step 1 "preflight: $preflight, node $node_version"

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

npm_pi=""

is_npm_pi() {
  npm_root=$(cd "$HOME" && npm root -g 2>/dev/null) || return 1
  [ -f "$npm_root/$pi_package/package.json" ] && npm_pi="$npm_root/$pi_package"
}

require_host_pi() {
  is_managed_root "$agent_dir" || is_npm_pi ||
    fail "no managed pi in $agent_dir and no pi in npm's global packages (a pi found only on PATH or in a project's node_modules is not used): the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable; install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) or with npm install -g @earendil-works/pi-coding-agent, and run this again"
}

require_host_pi

if command -v colima >/dev/null 2>&1; then
  step 2 "runtime: colima is present"
else
  step 2 "runtime: installing colima with Homebrew"
  streamed brew install colima
fi

colima_version=$(colima version 2>/dev/null | sed -n 's/^colima version v\{0,1\}\([0-9.]*\).*/\1/p' | head -n 1)
version_at_least "${colima_version:-0}" "$min_colima" || fail "colima ${colima_version:-unknown} is older than $min_colima, run brew upgrade colima"

host_pi=$(command -v pi 2>/dev/null || true)

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

agent_root=$(cd -P "$agent_dir" 2>/dev/null && pwd) || agent_root="$agent_dir"

if { [ -e "$shim" ] || [ -L "$shim" ]; } && ! is_ours && ! is_managed_pi; then
  fail "$shim exists and is not the pi-sandbox launcher, move it away and run this again"
fi

if [ -n "$managed_root" ] && [ "$managed_root" != "$agent_root" ]; then
  fail "$shim is pi's managed install at $managed_root, outside the host agent dir $agent_dir; the launcher uses only the managed install in the agent dir, move it away and run this again"
fi

record_replaced_link() {
  if [ -n "$managed_root" ]; then
    mkdir -p "$state_dir"
    printf '%s\n' "$(readlink "$shim")" > "$replaced_link"
  fi
}

mkdir -p "$bin_dir"

if [ "$from_checkout" -eq 1 ]; then
  record_replaced_link
  rm -f "$shim"
  quoted_entry=$(printf '%s' "$checkout/launcher/bin/pi-sandbox-dev.js" | sed "s/'/'\\\\''/g")
  printf '#!/bin/sh\nexec node '\''%s'\'' "$@"\n' "$quoted_entry" > "$shim"
  chmod 0755 "$shim"
  installed="wrote $shim running $checkout/launcher/bin/pi-sandbox-dev.js"
else
  step 3 "launcher: installing $package_name@$version with npm"
  streamed npm install -g --omit=peer "$package_name@$version"
  npm_bin="$(npm prefix -g)/bin/pi-sandbox"
  record_replaced_link
  ln -sfn "$npm_bin" "$shim"
  installed="installed $package_name@$version and linked $shim to $npm_bin"
fi

snippet_files=""

snippet_broken=""

login_shell=${SHELL:-zsh}
login_shell=${login_shell##*/}


add_snippet() {
  if path_block_present "$1" && ! path_block_intact "$1"; then
    snippet_broken="$snippet_broken; $(path_block_broken_note "$1")"
    return 0
  fi

  if path_block_present "$1" && [ "$(path_block_body "$1")" = "$2" ]; then
    return 0
  fi

  if path_block_present "$1"; then
    path_block_strip "$1"
  fi

  mkdir -p "$(dirname "$1")"
  printf '\n%s\n%s\n%s\n' "$marker_begin" "$2" "$marker_end" >> "$1"

  snippet_files="$snippet_files $1"
}

sh_line=$(path_block_line "$bin_dir")

add_snippet "$HOME/.zshrc" "$sh_line"

if [ -f "$HOME/.bashrc" ]; then
  add_snippet "$HOME/.bashrc" "$sh_line"
fi

if [ -f "$HOME/.bash_profile" ]; then
  add_snippet "$HOME/.bash_profile" "$sh_line"
fi

if [ "$login_shell" = fish ] || [ -d "$HOME/.config/fish" ]; then
  add_snippet "$fish_file" "$(path_block_fish_line "$bin_dir")"
fi

if [ -n "$snippet_files" ]; then
  snippet="added the PATH snippet to$snippet_files"
elif [ -n "$snippet_broken" ]; then
  snippet="no PATH snippet added"
else
  snippet="PATH snippet already present"
fi

shadowed=""
case "$login_shell" in
  zsh|bash|fish)
    if [ -n "$managed_root" ]; then
      shadowed="; the managed pi at $managed_root/bin/pi stays the host pi for host jobs and pi --no-sandbox (uninstall.sh restores the link)"
    elif [ -n "$npm_pi" ]; then
      shadowed="; $bin_dir comes first on PATH, and a pi from npm's global packages was found at $npm_pi: pi sandbox doctor shows which host pi is used"
    elif [ -n "$host_pi" ] && [ "$host_pi" != "$shim" ]; then
      shadowed=", $host_pi is now shadowed"
    fi
    ;;
  *)
    shadowed="; your login shell $login_shell is not configured: put $bin_dir first on PATH in its startup file, or pi keeps running ${host_pi:-whatever pi it finds} outside the sandbox"
    ;;
esac

step 3 "launcher: $installed, $snippet$snippet_broken$shadowed"

step 4 "setup: running pi sandbox init"

setup_status=0

if [ -z "${CI:-}" ] && ( : </dev/tty ) 2>/dev/null; then
  "$shim" sandbox init </dev/tty || setup_status=$?
else
  streamed "$shim" sandbox init --yes || setup_status=$?
fi

case "$setup_status" in
  0) step 4 "setup: done" ;;
  130) fail_with 130 "setup cancelled; the launcher is installed, run pi sandbox init to finish" ;;
  *) fail_with "$setup_status" "setup failed, see above; the launcher is installed, run pi sandbox init to try again" ;;
esac

smoke_root=$("$shim" __vm-shares) || exit "$?"
smoke_root=$(printf '%s\n' "$smoke_root" | head -n 1)
smoke_parent=$smoke_root
smoke_where="a temporary git repository in $smoke_parent"

if [ "$smoke_root" = "$HOME" ]; then
  smoke_parent="$HOME/.cache"
  smoke_where="a temporary git repository"
fi

sandbox_skipped_exit=3
smoke_skipped=0

smoke() {
  mkdir -p "$smoke_parent" || return 1

  smoke_dir=$(mktemp -d "$smoke_parent/pi-sandbox-smoke.XXXXXX") || return 1
  smoke_status=0

  git -C "$smoke_dir" init -q || smoke_status=1

  if [ "$smoke_status" -eq 0 ]; then
    (cd "$smoke_dir" && export PATH="$bin_dir:$PATH" && streamed "$shim" __smoke-doctor) || smoke_status=$?
    (cd "$smoke_dir" && PATH="$bin_dir:$PATH" "$shim" sandbox reset >/dev/null 2>&1) || true
  fi

  if [ "$smoke_status" -eq "$sandbox_skipped_exit" ]; then
    smoke_skipped=1
    smoke_status=0
  fi

  rm -rf "$smoke_dir"

  return "$smoke_status"
}

if ! command -v git >/dev/null 2>&1; then
  step 5 "smoke: skipped, git is missing; run pi sandbox doctor inside a repository"
elif [ -z "$smoke_parent" ]; then
  step 5 "smoke: skipped, none of the workspace roots exists; run pi sandbox doctor inside a repository in one of them"
else
  step 5 "smoke: running $shim sandbox doctor in $smoke_where; the first image build takes a few minutes"

  if smoke; then
    if [ "$smoke_skipped" -eq 1 ]; then
      step 5 "smoke: $shim sandbox doctor passed the host checks; the sandbox part was skipped because the VM does not share $smoke_parent yet, and runs at the first pi launch"
    else
      step 5 "smoke: $shim sandbox doctor passed"
    fi
  else
    fail "smoke check failed, see the doctor report above, or run $shim sandbox doctor inside a repository"
  fi
fi

if [ -n "$snippet_files" ]; then
  step 6 "next, in a new shell: cd <repo> && pi"
else
  step 6 "next: cd <repo> && pi"
fi
