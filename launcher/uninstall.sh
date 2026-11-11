#!/bin/sh
set -eu
unset CDPATH
COLIMA_HOME="$HOME/.colima"
export COLIMA_HOME

package_name=pi-extensions-mz
colima_profile=pi-sandbox
wrapper_marker="launcher/bin/pi-sandbox"
sessions_live_exit=75
script_dir=$(cd "$(dirname "$0")" && pwd)

. "$script_dir/bin/path-block.sh"
state_dir="${PI_SANDBOX_STATE_DIR:-$HOME/.local/state/pi-sandbox}"
bin_dir="$HOME/.local/bin"
fish_file="$HOME/.config/fish/conf.d/pi-sandbox.fish"

usage() {
  echo "usage: uninstall.sh"
}

fail() {
  echo "pi-sandbox uninstall: $1" >&2
  exit 1
}

case "${1:-}" in
  "") ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; fail "unknown option $1" ;;
esac

launcher_entry() {
  if [ -f "$script_dir/bin/pi-sandbox-dev.js" ] && [ -f "$script_dir/cli/main.ts" ]; then
    echo "$script_dir/bin/pi-sandbox-dev.js"
  elif [ -f "$script_dir/dist/cli/main.js" ]; then
    echo "$script_dir/bin/pi-sandbox.js"
  fi
}

entry=$(launcher_entry)

if [ -z "$entry" ] || ! command -v node >/dev/null 2>&1; then
  echo "launcher: not found, so the folders it created and its proxies stay; removing the profile and the host files anyway"
else
  cleanup_status=0
  node "$entry" __uninstall || cleanup_status=$?

  if [ "$cleanup_status" -eq "$sessions_live_exit" ]; then
    fail "pi sessions still run in the sandbox, nothing was removed; exit them and run uninstall.sh again"
  fi

  if [ "$cleanup_status" -ne 0 ]; then
    echo "launcher: its cleanup failed (exit $cleanup_status); removing the profile and the host files anyway"
  fi
fi

colima_failed=0

if ! command -v colima >/dev/null 2>&1; then
  echo "colima: not installed"
elif ! colima list 2>/dev/null | grep -q "^$colima_profile "; then
  echo "colima: no profile $colima_profile"
elif colima delete --profile "$colima_profile" --force >/dev/null; then
  echo "colima: deleted profile $colima_profile with its containers, volumes and images"
else
  colima_failed=1
  echo "colima: colima delete --profile $colima_profile failed, the profile stays"
fi

shim_dir="$bin_dir"

if [ -d "$bin_dir" ]; then
  shim_dir=$(cd -P "$bin_dir" && pwd)
fi

shim="$shim_dir/pi"
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
    rm -f "$shim"
    echo "launcher: removed $shim"
  else
    shim_free=0
    echo "launcher: $shim is not the pi-sandbox launcher, left as it is"
  fi
else
  echo "launcher: no $shim"
fi

if [ -f "$replaced_link" ]; then
  replaced=$(sed -n 1p "$replaced_link")

  if [ "$shim_free" -eq 1 ]; then
    ln -s "$replaced" "$shim"
    echo "launcher: restored $shim to $replaced"
  else
    echo "launcher: pi's managed link was $shim -> $replaced; put it back with ln -s '$replaced' '$shim' once that path is free"
  fi
fi

if [ -d "$state_dir" ]; then
  rm -rf "$state_dir"
  echo "state: removed $state_dir"
fi

if command -v npm >/dev/null 2>&1 && npm ls -g "$package_name" >/dev/null 2>&1; then
  npm uninstall -g "$package_name" >/dev/null
  echo "package: uninstalled the global $package_name"
else
  echo "package: no global $package_name"
fi

remove_snippet() {
  if ! path_block_present "$1"; then
    return 0
  fi

  if ! path_block_intact "$1"; then
    echo "shell: $(path_block_broken_note "$1")"
    return 0
  fi

  path_block_strip "$1"
  echo "shell: removed the PATH snippet from $1"
}

remove_snippet "$HOME/.zshrc"

remove_snippet "$HOME/.bashrc"

remove_snippet "$HOME/.bash_profile"

remove_snippet "$fish_file"

if [ -f "$fish_file" ] && ! grep -q '[^[:space:]]' "$fish_file"; then
  rm -f "$fish_file"
fi

echo "kept: your repositories, ~/.pi and ~/.config/pi-sandbox"
echo "kept: your pi sessions stay in ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"

if [ "$colima_failed" -eq 1 ]; then
  fail "the colima profile $colima_profile could not be deleted; run colima delete --profile $colima_profile --force"
fi
