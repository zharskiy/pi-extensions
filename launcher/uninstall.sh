#!/bin/sh
set -eu

package_name=pi-extensions-mz
colima_profile=pi-sandbox
marker_begin="# pi-sandbox begin"
marker_end="# pi-sandbox end"
wrapper_marker="launcher/bin/pi-sandbox"
bin_dir="$HOME/.local/bin"
script_dir=$(cd "$(dirname "$0")" && pwd)
state_dir="${PI_SANDBOX_STATE_DIR:-$HOME/.local/state/pi-sandbox}"

dry_run=0
volumes=0
keep_vm=0

usage() {
  echo "usage: uninstall.sh [--keep-vm] [--volumes] [--bin-dir DIR] [--dry-run]"
}

fail() {
  echo "pi-sandbox uninstall: $1" >&2
  exit 1
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

parse_args() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  case "$1" in
    --volumes) volumes=1; shift ;;
    --keep-vm) keep_vm=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --bin-dir) bin_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac

  parse_args "$@"
}

parse_args "$@"

dry_flag=""

if [ "$dry_run" -eq 1 ]; then
  dry_flag="--dry-run"
fi

if [ -d "$state_dir" ]; then
  command -v node >/dev/null 2>&1 || fail "node is needed to release the git pins, created directories and proxies recorded in $state_dir"
  node "$script_dir/bin/uninstall-engine.mjs" --host-side "$state_dir" $dry_flag || fail "nothing was removed"
fi

engine_socket="$HOME/.colima/$colima_profile/docker.sock"

engine_flags="$dry_flag"

if [ "$volumes" -eq 1 ] || [ "$keep_vm" -eq 0 ]; then
  engine_flags="$engine_flags --volumes"
fi

if [ -S "$engine_socket" ] && command -v node >/dev/null 2>&1; then
  node "$script_dir/bin/uninstall-engine.mjs" "$engine_socket" $engine_flags
else
  echo "containers: the sandbox VM engine is not running, nothing removed"
fi

if [ "$keep_vm" -eq 1 ]; then
  echo "colima: profile $colima_profile kept (--keep-vm)"
elif command -v colima >/dev/null 2>&1 && colima list 2>/dev/null | grep -q "^$colima_profile "; then
  act colima delete --profile "$colima_profile" --force >/dev/null
  echo "colima: $(verb "delete" "deleted") profile $colima_profile"
else
  echo "colima: no profile $colima_profile"
fi

if [ -d "$bin_dir" ]; then
  bin_dir=$(cd -P "$bin_dir" && pwd)
fi

shim="$bin_dir/pi"
replaced_link="$state_dir/replaced-pi-link"

is_ours() {
  if [ -L "$shim" ]; then
    case "$(readlink "$shim")" in
      */pi-sandbox|*/pi-sandbox.js) return 0 ;;
    esac
  fi

  [ -f "$shim" ] && grep -q "$wrapper_marker" "$shim"
}

shim_free=1

if [ -e "$shim" ] || [ -L "$shim" ]; then
  if is_ours; then
    act rm -f "$shim"
    echo "launcher: $(verb "remove" "removed") $shim"
  else
    shim_free=0
    echo "launcher: $shim is not the pi-sandbox launcher, left as it is"
  fi
else
  echo "launcher: no $shim"
fi

recorded_shim=""

if [ -f "$replaced_link" ]; then
  recorded_shim=$(sed -n 1p "$replaced_link")
fi

if [ -n "$recorded_shim" ] && [ "$recorded_shim" != "$shim" ]; then
  echo "launcher: $replaced_link records the replaced pi link of $recorded_shim, not $shim; left as it is"
elif [ -n "$recorded_shim" ] && [ "$shim_free" -eq 1 ]; then
  replaced=$(sed -n 2p "$replaced_link")
  act ln -s "$replaced" "$shim"
  act rm -f "$replaced_link"
  echo "launcher: $(verb "restore" "restored") $shim to $replaced"
fi

remove_state() {
  if [ ! -d "$state_dir" ]; then
    return 0
  fi

  if [ "$dry_run" -eq 0 ]; then
    find "$state_dir" -mindepth 1 -maxdepth 1 ! -name replaced-pi-link -exec rm -rf {} +
    rmdir "$state_dir" 2>/dev/null || true
  fi

  if [ -e "$replaced_link" ]; then
    echo "state: $(verb "remove" "removed") $state_dir except $replaced_link"
  else
    echo "state: $(verb "remove" "removed") $state_dir"
  fi
}

remove_state

if command -v npm >/dev/null 2>&1 && npm ls -g "$package_name" >/dev/null 2>&1; then
  act npm uninstall -g "$package_name" >/dev/null
  echo "package: $(verb "uninstall" "uninstalled") the global $package_name"
else
  echo "package: no global $package_name"
fi

remove_snippet() {
  if [ ! -f "$1" ] || ! grep -qxF "$marker_begin" "$1"; then
    echo "shell: no PATH snippet in $1"
    return 0
  fi

  if ! grep -qxF "$marker_end" "$1"; then
    echo "shell: $1 has \"$marker_begin\" without \"$marker_end\", left as it is"
    return 0
  fi

  if [ "$dry_run" -eq 0 ]; then
    awk -v begin="$marker_begin" -v end="$marker_end" '
      $0 == begin { skip = 1; next }
      $0 == end { skip = 0; next }
      !skip { print }
    ' "$1" > "$1.pi-sandbox.tmp"
    cat "$1.pi-sandbox.tmp" > "$1"
    rm -f "$1.pi-sandbox.tmp"
  fi

  echo "shell: $(verb "remove" "removed") the PATH snippet from $1"
}

remove_snippet "$HOME/.zshrc"

remove_snippet "$HOME/.bashrc"

remove_snippet "$HOME/.bash_profile"

echo "kept: your repositories, ~/.pi and ~/.config/pi-sandbox"
echo "kept: your pi sessions stay in ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
