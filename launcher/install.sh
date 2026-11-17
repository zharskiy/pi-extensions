#!/bin/sh
set -eu
unset CDPATH
COLIMA_HOME="$HOME/.colima"
export COLIMA_HOME

package_name=@zharskiy/pinata
colima_profile=pi-sandbox
min_colima=0.8.0
min_node=22.19.0
min_macos=13
wrapper_marker="launcher/bin/pi-sandbox"
bin_dir="$HOME/.local/bin"
managed_kind='"kind"[[:space:]]*:[[:space:]]*"pi-managed-install"'
managed_schema='"schemaVersion"[[:space:]]*:[[:space:]]*1([^0-9.]|$)'
managed_layout='"layout"[[:space:]]*:[[:space:]]*"releases-v1"'
managed_package="node_modules/@earendil-works/pi-coding-agent/package.json"
link_hops=40
legacy_name=pi-extensions-mz

max_cpus=8
max_memory=10
cpus=""
memory=""
sizing=""
disk=60
nl='
'
roots=""
installer_api=1
config_file=""
conflict=keep
with_extensions=0
no_extensions=0
extensions_source=""
no_smoke=0
dry_run=0
show_version=0

usage() {
  printf '%s\n' "usage: install.sh [--cpu N] [--memory GiB] [--disk GiB] [--root DIR]..." \
    "                  [--config FILE] [--config-conflict keep|replace|fail]" \
    "                  [--with-extensions | --no-extensions] [--extensions-source SPEC]" \
    "                  [--no-smoke] [--dry-run] [--version] [-h|--help]"
}

fail_with() {
  printf '%s\n' "pi-sandbox install: $2" >&2
  exit "$1"
}

current_step=options

finish() {
  finish_status=$?
  trap - EXIT

  case "$finish_status" in
    0|64|69|70|73|75|78|79|130|143) exit "$finish_status" ;;
  esac

  printf '%s\n' "pi-sandbox install: $current_step: failed unexpectedly (exit $finish_status)" >&2
  exit 70
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usage_fail() {
  usage >&2
  fail_with 64 "options: $1 ($package_name ${version:-unknown}, installer api $installer_api)"
}

clamp() {
  value=$1

  if [ -z "$value" ] || [ "$value" -gt "$3" ]; then
    value=$3
  fi

  if [ "$value" -lt "$2" ]; then
    value=$2
  fi

  echo "$value"
}

size_to_host() {
  host_cpus=$(sysctl -n hw.ncpu 2>/dev/null || true)
  host_bytes=$(sysctl -n hw.memsize 2>/dev/null || true)

  if [ -n "$host_cpus$host_bytes" ] && { [ -z "$cpus" ] || [ -z "$memory" ]; }; then
    sizing=", sized to this Mac"
  fi

  if [ -z "$cpus" ]; then
    cpus=$(clamp "$host_cpus" 2 "$max_cpus")
  fi

  if [ -z "$memory" ]; then
    memory=$(clamp "${host_bytes:+$((host_bytes / 2147483648))}" 4 "$max_memory")
  fi
}

step() {
  printf '%s\n' "[$1/9] $2"
}

streamed() {
  { streamed_status=$( { { if "$@" 2>&1 3>&- 4>&- </dev/null; then echo 0 >&3; else echo "$?" >&3; fi; } | sed 's/^/      /' >&4; } 3>&1 ); } 4>&1
  return "$streamed_status"
}

version_at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    split(have, h, "."); split(want, w, ".");
    exit !((h[1] * 1000000 + h[2] * 1000 + h[3]) >= (w[1] * 1000000 + w[2] * 1000 + w[3]))
  }'
}

needs_value() {
  if [ "$1" -lt 2 ]; then
    usage_fail "$2 needs a value"
  fi
}

needs_text() {
  if [ -z "$2" ]; then
    usage_fail "$1 needs a non-empty value"
  fi
}

needs_conflict() {
  case "$1" in
    keep|replace|fail) ;;
    *) usage_fail "--config-conflict must be keep, replace or fail, not $1" ;;
  esac
}

needs_source() {
  case "$1" in
    npm:?*|git:?*|https://?*|ssh://?*) ;;
    *) usage_fail "--extensions-source $1 is not a pi package source (npm:<name>@<version> or git:<host>/<owner>/<repo>@<ref>)" ;;
  esac
}

add_root() {
  if [ -n "$1" ]; then
    roots="$roots$1$nl"
  fi
}

add_env_roots() {
  if [ -z "$1" ]; then
    return 0
  fi

  add_root "${1%%:*}"

  case "$1" in
    *:*) add_env_roots "${1#*:}" ;;
  esac
}

expanded_root() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#"~/"}" ;;
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

first_existing_root() {
  if [ "$#" -eq 0 ]; then
    return 1
  fi

  candidate=$(expanded_root "$1")

  if [ -d "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  shift
  first_existing_root "$@"
}

with_roots() {
  (IFS=$nl; set -f; set -- "$@" $roots; "$@")
}

parse_args() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  case "$1" in
    --cpu) needs_value "$#" "$1"; cpus=$2; shift 2 ;;
    --memory) needs_value "$#" "$1"; memory=$2; shift 2 ;;
    --disk) needs_value "$#" "$1"; disk=$2; shift 2 ;;
    --root) needs_value "$#" "$1"; needs_text "$1" "$2"; add_root "$2"; shift 2 ;;
    --config) needs_value "$#" "$1"; needs_text "$1" "$2"; config_file=$2; shift 2 ;;
    --config-conflict) needs_value "$#" "$1"; needs_conflict "$2"; conflict=$2; shift 2 ;;
    --with-extensions) with_extensions=1; shift ;;
    --no-extensions) no_extensions=1; shift ;;
    --extensions-source) needs_value "$#" "$1"; needs_source "$2"; extensions_source=$2; with_extensions=1; shift 2 ;;
    --no-smoke) no_smoke=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --version) show_version=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_fail "unknown option $1" ;;
  esac

  parse_args "$@"
}

script_dir=$(cd "$(dirname "$0")" && pwd)
checkout=$(dirname "$script_dir")

version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$checkout/package.json" 2>/dev/null | head -n 1)

parse_args "$@"

[ -n "$version" ] || fail_with 69 "preflight: cannot read the package version from $checkout/package.json"

if [ "$show_version" -eq 1 ]; then
  printf '%s\n' "$package_name $version (installer api $installer_api)"
  exit 0
fi

if [ -z "$roots" ]; then
  add_env_roots "${PI_SANDBOX_ROOTS:-}"
fi

shim_dir="$bin_dir"

if [ -d "$bin_dir" ]; then
  shim_dir=$(cd -P "$bin_dir" && pwd)
fi

shim="$shim_dir/pi"

. "$script_dir/bin/path-block.sh"
. "$script_dir/bin/paths.sh"
replaced_link="$state_dir/replaced-pi-link"
legacy_replaced_link="$legacy_state_dir/replaced-pi-link"

from_checkout=0
if [ -f "$checkout/package.json" ] && [ -e "$checkout/.git" ] && grep -q "\"name\": \"$package_name\"" "$checkout/package.json"; then
  from_checkout=1
fi

current_step=preflight

[ "$(id -u)" -ne 0 ] || fail_with 69 "preflight: run install.sh as your own user, not as root or with sudo"

os=$(uname -s)
chip=$(uname -m)

case "$os" in
  Darwin)
    macos=$(sw_vers -productVersion)
    [ "${macos%%.*}" -ge "$min_macos" ] 2>/dev/null || fail_with 69 "preflight: macOS $macos is too old, the sandbox VM (vz with virtiofs) needs macOS $min_macos or newer"
    command -v brew >/dev/null 2>&1 || fail_with 69 "preflight: Homebrew is missing, install it from https://brew.sh and run this again"
    preflight="macOS $macos on $chip, Homebrew present"
    ;;
  *)
    fail_with 69 "preflight: unsupported system $os, pi-sandbox supports macOS only"
    ;;
esac

command -v node >/dev/null 2>&1 || fail_with 69 "preflight: node is missing, install Node $min_node or newer (brew install node)"
command -v npm >/dev/null 2>&1 || fail_with 69 "preflight: npm is missing, install Node $min_node or newer (brew install node)"
node_version=$(node -p 'process.versions.node')
version_at_least "$node_version" "$min_node" || fail_with 69 "preflight: node $node_version is too old, install Node $min_node or newer"

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

require_host_pi() {
  is_managed_root "$agent_dir" ||
    fail_with 69 "preflight: no managed pi in $agent_dir (a pi installed with npm or found on PATH is not used): the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable; install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run this again"
}

require_host_pi

launcher_entry() {
  if [ -f "$script_dir/bin/pi-sandbox-dev.js" ] && [ -f "$script_dir/cli/main.ts" ]; then
    printf '%s\n' "$script_dir/bin/pi-sandbox-dev.js"
  elif [ -f "$script_dir/dist/cli/main.js" ]; then
    printf '%s\n' "$script_dir/bin/pi-sandbox.js"
  fi
}

entry=$(launcher_entry)
[ -n "$entry" ] || fail_with 69 "preflight: the launcher in $script_dir is incomplete (neither cli/main.ts with bin/pi-sandbox-dev.js nor dist/cli/main.js)"

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
  fail_with 73 "launcher: $shim exists and is not the pi-sandbox launcher, move it away and run this again"
fi

if [ -n "$managed_root" ] && [ "$managed_root" != "$agent_root" ]; then
  fail_with 73 "launcher: $shim is pi's managed install at $managed_root, outside the host agent dir $agent_dir; the launcher uses only the managed install in the agent dir, move it away and run this again"
fi

config_status() {
  if [ "$1" -eq 78 ]; then
    fail_with 78 "config: rejected, see the message above; nothing was written"
  fi

  fail_with 70 "config: $2 failed (exit $1)"
}

checked_config() {
  if [ -n "$config_file" ]; then
    with_roots node "$entry" __seed-config --check --from "$config_file" --conflict "$conflict" -- </dev/null
  else
    with_roots node "$entry" __seed-config --check -- </dev/null
  fi
}

current_step=config

check_status=0
planned_config=$(checked_config) || check_status=$?

if [ "$check_status" -ne 0 ]; then
  config_status "$check_status" "checking the configuration"
fi

planned_line=${planned_config%%"$nl"*}
planned_outcome=${planned_line%% *}

if [ -n "$extensions_source" ] && [ "$no_extensions" -eq 0 ]; then
  extensions_note=""
elif [ "$no_extensions" -eq 1 ]; then
  extensions_source=""
  extensions_note="skipped (--no-extensions)"
elif [ "$with_extensions" -eq 0 ]; then
  extensions_note="skipped, pass --with-extensions to install them into host pi"
elif [ "$from_checkout" -eq 1 ]; then
  extensions_note="skipped, a checkout has no default source; pass --extensions-source npm:$package_name@<version> or a git: source"
else
  extensions_source="npm:$package_name@$version"
  extensions_note=""
fi

colima_present=0

if command -v colima >/dev/null 2>&1; then
  colima_present=1
fi

check_colima() {
  colima_version=$(colima version 2>/dev/null </dev/null | sed -n 's/^colima version v\{0,1\}\([0-9.]*\).*/\1/p' | head -n 1)
  version_at_least "${colima_version:-0}" "$min_colima" || fail_with 69 "runtime: colima ${colima_version:-unknown} is older than $min_colima, run brew upgrade colima"
}

if [ "$colima_present" -eq 1 ]; then
  check_colima
fi

npm_spec="${PI_SANDBOX_NPM_SPEC:-$package_name@$version}"
in_global=0
global_root=""

if [ "$from_checkout" -eq 0 ]; then
  mode=global
  receipt_spec=$npm_spec
  global_root=$(npm root -g 2>/dev/null </dev/null) || global_root=""
  self_dir=$(cd -P "$script_dir" && pwd)
  global_dir=$(cd -P "$global_root/$package_name/launcher" 2>/dev/null && pwd) || global_dir=""

  if [ -n "$global_dir" ] && [ "$global_dir" = "$self_dir" ]; then
    in_global=1
  fi
else
  mode=checkout
  receipt_spec=-
fi

installed_version=""

if [ "$mode" = global ] && [ "$in_global" -eq 0 ] && [ -f "$global_root/$package_name/package.json" ]; then
  installed_version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$global_root/$package_name/package.json" | head -n 1)
fi

legacy_present=0

if [ "$mode" = global ] && [ "$in_global" -eq 0 ] && [ -n "$global_root" ] && { [ -e "$global_root/$legacy_name" ] || [ -L "$global_root/$legacy_name" ]; }; then
  legacy_present=1
fi

current_step=launcher

if [ -n "$installed_version" ] && [ "$installed_version" != "$version" ]; then
  busy_status=0
  node "$entry" __busy </dev/null || busy_status=$?

  if [ "$busy_status" -eq 75 ]; then
    fail_with 75 "launcher: pi sessions are live, nothing was changed; end the pi sessions and run this again to replace $package_name@$installed_version"
  fi

  if [ "$busy_status" -ne 0 ]; then
    fail_with 70 "launcher: checking for live pi sessions failed (exit $busy_status)"
  fi
fi

size_to_host

planned_config_note() {
  case "$planned_outcome" in
    created) printf '%s\n' "would write $user_config" ;;
    unchanged) printf '%s\n' "$user_config already matches" ;;
    updated) printf '%s\n' "would update $user_config" ;;
    kept) printf '%s\n' "would keep the edited $user_config and write the organisation config beside it as $(proposed_file)" ;;
    replaced) printf '%s\n' "would replace the edited $user_config and keep it as $user_config.bak" ;;
    *) printf '%s\n' "$user_config left as it is" ;;
  esac
}

proposed_file() {
  case "$user_config" in
    *.json) printf '%s\n' "${user_config%.json}.proposed.json" ;;
    *) printf '%s\n' "$user_config.proposed" ;;
  esac
}

dry_launcher_note() {
  if [ "$from_checkout" -eq 1 ]; then
    printf '%s\n' "would write $shim running $checkout/launcher/bin/pi-sandbox-dev.js"
  elif [ "$in_global" -eq 1 ]; then
    printf '%s\n' "runs from the global install of $package_name@$version, would link $shim to it"
  elif [ "$legacy_present" -eq 1 ]; then
    printf '%s\n' "would uninstall $legacy_name (the pre-release name of this package), install $npm_spec with npm and link $shim to it"
  else
    printf '%s\n' "would install $npm_spec with npm and link $shim to it"
  fi
}

print_plan() {
  if [ "$colima_present" -eq 1 ]; then
    step 2 "runtime: colima is present"
  else
    step 2 "runtime: would install colima with Homebrew"
  fi

  step 3 "launcher: $(dry_launcher_note)"

  if [ -n "$extensions_source" ]; then
    step 4 "extensions: would install $extensions_source into host pi"
  else
    step 4 "extensions: $extensions_note"
  fi

  step 5 "config: $(planned_config_note)"
  step 6 "colima: would start or keep profile $colima_profile (vz, virtiofs, $cpus CPUs, ${memory} GiB, ${disk} GiB$sizing)"

  if [ "$no_smoke" -eq 1 ]; then
    step 7 "image: built at the first pi launch"
    step 8 "smoke: skipped (--no-smoke)"
  else
    step 7 "image: prepared and verified by the smoke check in step 8"
    step 8 "smoke: would run $shim sandbox doctor in a temporary git repository"
  fi

  printf '%s\n' "dry run: nothing was changed"
}

if [ "$dry_run" -eq 1 ]; then
  print_plan
  exit 0
fi

current_step=runtime

if [ "$colima_present" -eq 1 ]; then
  step 2 "runtime: colima is present"
else
  step 2 "runtime: installing colima with Homebrew"
  streamed brew install colima || fail_with 70 "runtime: brew install colima failed (exit $?)"
  check_colima
fi

state_failed() {
  fail_with 70 "launcher: cannot write $replaced_link; check the permissions of $state_dir and run this again"
}

carry_replaced_link() {
  if [ ! -f "$replaced_link" ] && [ -f "$legacy_replaced_link" ]; then
    { mkdir -p "$state_dir" && cat "$legacy_replaced_link" > "$replaced_link"; } || state_failed
  fi
}

record_replaced_link() {
  if [ -n "$managed_root" ]; then
    replaced_target=$(readlink "$shim") || fail_with 70 "launcher: cannot read the link $shim"
    { mkdir -p "$state_dir" && printf '%s\n' "$replaced_target" > "$replaced_link"; } || state_failed
  fi
}

global_bin() {
  npm_prefix=$(npm prefix -g 2>/dev/null </dev/null) || fail_with 70 "launcher: npm prefix -g failed"
  [ -n "$npm_prefix" ] || fail_with 70 "launcher: npm prefix -g printed nothing"
  npm_bin="$npm_prefix/bin/pi-sandbox"
}

link_shim() {
  ln -sfn "$npm_bin" "$shim" || fail_with 70 "launcher: cannot link $shim to $npm_bin; check the permissions of $bin_dir and run this again"
}

{ mkdir -p "$bin_dir" 2>/dev/null && [ -w "$bin_dir" ]; } || fail_with 70 "launcher: $bin_dir cannot be created or is not writable; fix its permissions (ls -ld $bin_dir) and run this again"

carry_replaced_link

if [ "$from_checkout" -eq 1 ]; then
  record_replaced_link
  rm -f "$shim" || fail_with 70 "launcher: cannot remove the old $shim"
  quoted_entry=$(printf '%s' "$checkout/launcher/bin/pi-sandbox-dev.js" | sed "s/'/'\\\\''/g")
  { printf '#!/bin/sh\nexec node '\''%s'\'' "$@"\n' "$quoted_entry" > "$shim" && chmod 0755 "$shim"; } || fail_with 70 "launcher: cannot write $shim; check the permissions of $bin_dir and run this again"
  installed="wrote $shim running $checkout/launcher/bin/pi-sandbox-dev.js"
elif [ "$in_global" -eq 1 ]; then
  global_bin
  record_replaced_link
  link_shim
  installed="running from the global install of $package_name@$version, npm install skipped; linked $shim to $npm_bin"
else
  if [ "$legacy_present" -eq 1 ]; then
    step 3 "launcher: uninstalling $legacy_name, the pre-release name of this package (its live pi sessions cannot be checked)"
    streamed npm uninstall -g "$legacy_name" || fail_with 70 "launcher: npm uninstall -g $legacy_name failed (exit $?)"
  fi

  step 3 "launcher: installing $npm_spec with npm"
  streamed npm install -g --omit=peer "$npm_spec" || fail_with 70 "launcher: npm install -g $npm_spec failed (exit $?)"
  global_bin
  record_replaced_link
  link_shim
  installed="installed $npm_spec and linked $shim to $npm_bin"
fi

snippet_files=""

snippet_broken=""

login_shell=${SHELL:-zsh}
login_shell=${login_shell##*/}

fish_file="$HOME/.config/fish/conf.d/pi-sandbox.fish"

rc_writable() {
  rc_dir=$(dirname "$1")
  mkdir -p "$rc_dir" 2>/dev/null && [ -w "$rc_dir" ] && { [ ! -e "$1" ] || [ -w "$1" ]; }
}

unwritable_rc() {
  snippet_broken="$snippet_broken; $1 is not writable, left as it is: put $bin_dir first on PATH there yourself"
}

add_snippet() {
  if path_block_present "$1" && ! path_block_intact "$1"; then
    snippet_broken="$snippet_broken; $(path_block_broken_note "$1")"
    return 0
  fi

  if path_block_present "$1" && [ "$(path_block_body "$1")" = "$2" ]; then
    return 0
  fi

  if ! rc_writable "$1"; then
    unwritable_rc "$1"
    return 0
  fi

  if path_block_present "$1"; then
    path_block_strip "$1" || fail_with 70 "launcher: rewriting the PATH snippet in $1 failed; check $1 and run this again"
  fi

  printf '\n%s\n%s\n%s\n' "$marker_begin" "$2" "$marker_end" >> "$1" || fail_with 70 "launcher: appending the PATH snippet to $1 failed; check $1 and run this again"

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
    elif [ -n "$host_pi" ] && [ "$host_pi" != "$shim" ]; then
      shadowed=", $host_pi is now shadowed"
    fi
    ;;
  *)
    shadowed="; your login shell $login_shell is not configured: put $bin_dir first on PATH in its startup file, or pi keeps running ${host_pi:-whatever pi it finds} outside the sandbox"
    ;;
esac

step 3 "launcher: $installed, $snippet$snippet_broken$shadowed"

share_list() {
  printf '%s\n' "$1" | awk '{ if (!sub(/:w$/, " writable")) $0 = $0 " read-only"; printf "%s%s", (NR > 1 ? ", " : ""), $0 }'
}

start_vm() {
  if [ "$1" != -- ]; then
    mount=$1
    shift
    start_vm "$@" --mount "$mount"
    return
  fi

  shift
  streamed colima start --profile "$colima_profile" --activate=false --vm-type vz --mount-type virtiofs \
    --cpu "$cpus" --memory "$memory" --disk "$disk" "$@"
}

config_from=""
config_outcome=""
config_sha=""
config_roots=""

write_receipt() {
  set -- --mode "$mode" --spec "$receipt_spec" --smoke "$1"

  if [ -n "$extensions_source" ] && [ "$extensions_done" -eq 1 ]; then
    set -- "$@" --extensions "$extensions_source"
  fi

  if [ -n "$config_from" ]; then
    set -- "$@" --config-from "$config_from" --config-outcome "$config_outcome" --config-sha256 "$config_sha"
  fi

  node "$entry" __receipt "$@" </dev/null || fail_with 70 "receipt: writing $state_dir/install.json failed (exit $?)"
}

extensions_done=0
current_step=extensions

if [ -n "$extensions_source" ]; then
  step 4 "extensions: installing $extensions_source into host pi"
  streamed node "$entry" __extensions install "$extensions_source" || fail_with 70 "extensions: pi install $extensions_source failed (exit $?), see the output above"
  extensions_done=1
  write_receipt pending
  step 4 "extensions: installed $extensions_source into host pi"
else
  step 4 "extensions: $extensions_note"
fi

current_step=config

seed_config() {
  seed_status=0
  seeded=$(with_roots node "$entry" __seed-config --from "$config_file" --conflict "$conflict" -- </dev/null) || seed_status=$?

  if [ "$seed_status" -ne 0 ]; then
    config_status "$seed_status" "installing $config_file"
  fi

  seeded_line=${seeded%%"$nl"*}
  config_from=$config_file
  config_outcome=${seeded_line%% *}
  config_sha=${seeded_line#* }

  case "$seeded" in
    *"$nl"*) config_roots=${seeded#*"$nl"} ;;
  esac
}

seeded_note() {
  case "$config_outcome" in
    created) printf '%s\n' "wrote $user_config from $config_file" ;;
    unchanged) printf '%s\n' "$user_config already matches $config_file" ;;
    updated) printf '%s\n' "updated $user_config from $config_file" ;;
    kept) printf '%s\n' "kept $user_config, which was edited; the organisation config is in $(proposed_file): compare the two, then move it over $user_config to adopt it, or delete it to keep yours" ;;
    replaced) printf '%s\n' "replaced the edited $user_config with $config_file, the previous one is in $user_config.bak" ;;
  esac
}

init_roots() {
  init_status=0
  with_roots "$shim" __init-config </dev/null || init_status=$?

  if [ "$init_status" -eq 1 ]; then
    config_status 78 "writing workspaceRoots"
  fi

  if [ "$init_status" -ne 0 ]; then
    config_status "$init_status" "writing workspaceRoots"
  fi
}

if [ -n "$config_file" ]; then
  seed_config
  config_note=$(seeded_note)
elif [ -n "$roots" ] && [ -f "$user_config" ]; then
  init_roots
  config_note="workspaceRoots in $user_config already match"
elif [ -n "$roots" ]; then
  init_roots
  config_from=--root
  config_outcome=created
  config_note="wrote workspaceRoots to $user_config"
else
  config_note="$user_config left as it is"
fi

if [ -n "$config_from" ]; then
  write_receipt pending
fi

shares_status=0
vm_shares=$("$shim" __vm-shares </dev/null) || shares_status=$?

if [ "$shares_status" -eq 1 ]; then
  config_status 78 "reading the VM shares"
fi

if [ "$shares_status" -ne 0 ]; then
  config_status "$shares_status" "reading the VM shares"
fi

step 5 "config: $config_note"

shares_note=""

if [ -n "$roots$config_file" ]; then
  shares_note="; if its shares differ, the first pi launch restarts it with the new ones"
fi

start_failed() {
  fail_with 70 "colima: colima start --profile $colima_profile failed (exit $1)"
}

start_status=0
current_step=colima

if colima status --profile "$colima_profile" >/dev/null 2>&1 </dev/null; then
  step 6 "colima: profile $colima_profile is running (colima stop --profile $colima_profile and run this again to apply new resources)$shares_note"
elif [ -f "$HOME/.colima/$colima_profile/colima.yaml" ]; then
  step 6 "colima: starting profile $colima_profile (vz, virtiofs, $cpus CPUs, ${memory} GiB, ${disk} GiB$sizing, shares kept)$shares_note"
  start_vm -- || start_failed "$?"
else
  step 6 "colima: starting profile $colima_profile (vz, virtiofs, $cpus CPUs, ${memory} GiB, ${disk} GiB$sizing, $(share_list "$vm_shares"))"
  (IFS=$nl; set -f; start_vm $vm_shares --) || start_failed "$?"
fi

current_step=smoke
smoke_parent="$HOME/.cache"
smoke_where="a temporary git repository"
create_parent=1

if [ -n "$config_roots" ]; then
  create_parent=0
  smoke_parent=$(IFS=$nl; set -f; first_existing_root $config_roots) || smoke_parent=""
  smoke_where="a temporary git repository in $smoke_parent"
elif [ -n "$roots" ]; then
  create_parent=0
  smoke_parent=$(with_roots first_existing_root) || smoke_parent=""
  smoke_where="a temporary git repository in $smoke_parent"
fi

smoke_log=""
smoke_skipped=0

smoke_doctor() {
  { "$shim" sandbox doctor 2>&1; printf '%s\n' "$?" > "$smoke_log.status"; } | tee "$smoke_log"
  return "$(cat "$smoke_log.status")"
}

smoke() {
  if [ "$create_parent" -eq 1 ]; then
    mkdir -p "$smoke_parent" || return 1
  fi

  smoke_dir=$(mktemp -d "$smoke_parent/pi-sandbox-smoke.XXXXXX") || return 1
  smoke_log=$(mktemp "${TMPDIR:-/tmp}/pi-sandbox-smoke.XXXXXX") || smoke_log="$smoke_dir.log"
  smoke_status=0

  git -C "$smoke_dir" init -q || smoke_status=1

  if [ "$smoke_status" -eq 0 ]; then
    (cd "$smoke_dir" && export PATH="$bin_dir:$PATH" && streamed smoke_doctor) || smoke_status=1
    (cd "$smoke_dir" && PATH="$bin_dir:$PATH" "$shim" sandbox reset >/dev/null 2>&1) || true
  fi

  if grep -q "not started until the VM shares" "$smoke_log" 2>/dev/null; then
    smoke_skipped=1
  fi

  rm -rf "$smoke_dir"
  rm -f "$smoke_log" "$smoke_log.status"

  return "$smoke_status"
}

smoke_result=skipped

if [ "$no_smoke" -eq 1 ]; then
  step 7 "image: built at the first pi launch"
  step 8 "smoke: skipped (--no-smoke); run pi sandbox doctor inside a repository"
elif ! command -v git >/dev/null 2>&1; then
  step 7 "image: prepared and verified by the smoke check in step 8"
  step 8 "smoke: skipped, git is missing; run pi sandbox doctor inside a repository"
elif [ -z "$smoke_parent" ]; then
  step 7 "image: prepared and verified by the smoke check in step 8"
  step 8 "smoke: skipped, none of the workspace roots exists; run pi sandbox doctor inside a repository in one of them"
else
  step 7 "image: prepared and verified by the smoke check in step 8"
  step 8 "smoke: running $shim sandbox doctor in $smoke_where; the first image build takes a few minutes"

  if smoke; then
    smoke_result=passed
  else
    write_receipt failed
    fail_with 79 "smoke: the smoke check failed, see the doctor report above, or run $shim sandbox doctor inside a repository; everything else is installed"
  fi

  if [ "$smoke_skipped" -eq 1 ]; then
    step 8 "smoke: $shim sandbox doctor passed the host checks; the sandbox part was skipped because the VM does not share $smoke_parent yet, and runs at the first pi launch"
  else
    step 8 "smoke: $shim sandbox doctor passed"
  fi
fi

write_receipt "$smoke_result"

if [ -n "$snippet_files" ]; then
  step 9 "next, in a new shell: cd <repo> && pi"
else
  step 9 "next: cd <repo> && pi"
fi
