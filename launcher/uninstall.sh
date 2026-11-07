#!/bin/sh
set -eu

package_name=pi-extensions-mz
colima_profile=pi-sandbox
marker_begin="# pi-sandbox begin"
marker_end="# pi-sandbox end"
wrapper_marker="launcher/bin/pi-sandbox"
bin_dir="$HOME/.local/bin"
state_dir="${PI_SANDBOX_STATE_DIR:-$HOME/.local/state/pi-sandbox}"
managed_label=pi-sandbox.managed
relay_label=pi-sandbox.relay

dry_run=0
volumes=0
vm=0

usage() {
  echo "usage: uninstall.sh [--volumes] [--vm] [--bin-dir DIR] [--dry-run]"
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
    --vm) vm=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --bin-dir) bin_dir="${2:-}"; shift 2 ;;
    --profile) shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac

  parse_args "$@"
}

parse_args "$@"

shim="$bin_dir/pi"

is_ours() {
  if [ -L "$shim" ]; then
    case "$(readlink "$shim")" in
      */pi-sandbox|*/pi-sandbox.js) return 0 ;;
    esac
  fi

  [ -f "$shim" ] && grep -q "$wrapper_marker" "$shim"
}

if [ -e "$shim" ] || [ -L "$shim" ]; then
  if is_ours; then
    act rm -f "$shim"
    echo "launcher: $(verb "remove" "removed") $shim"
  else
    echo "launcher: $shim is not the pi-sandbox launcher, left as it is"
  fi
else
  echo "launcher: no $shim"
fi

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

is_proxy_daemon() {
  case "$(ps -o command= -p "$1" 2>/dev/null)" in
    *proxy/daemon.ts*|*proxy/daemon.js*) return 0 ;;
  esac

  return 1
}

stopped_proxies=0

stop_proxies() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  if [ -f "$1" ]; then
    pid=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$1" | head -n 1)

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && is_proxy_daemon "$pid"; then
      act kill "$pid"
      echo "proxy: $(verb "stop" "stopped") pid $pid"
      stopped_proxies=$((stopped_proxies + 1))
    elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "proxy: pid $pid from $1 is not the pi-sandbox proxy, left running"
    fi
  fi

  shift
  stop_proxies "$@"
}

stop_proxies "$state_dir/proxy.json" "$state_dir"/proxy/*/proxy.json

if [ "$stopped_proxies" -eq 0 ]; then
  echo "proxy: none running"
fi

state_note() {
  if [ "$1" = "sessions" ]; then
    echo " (launch records)"
  fi
}

remove_state() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  if [ -e "$state_dir/$1" ]; then
    act rm -rf "$state_dir/$1"
    echo "state: $(verb "remove" "removed") $state_dir/$1$(state_note "$1")"
  fi

  shift
  remove_state "$@"
}

remove_state sessions render sync mcp-auth provider-hosts org grants.json

colima_socket="$HOME/.colima/$colima_profile/docker.sock"

if [ -S "$colima_socket" ]; then
  docker_host="unix://$colima_socket"
else
  docker_host="${DOCKER_HOST:-unix:///var/run/docker.sock}"
fi

if command -v docker >/dev/null 2>&1 && docker --host "$docker_host" info >/dev/null 2>&1; then
  relays=$(docker --host "$docker_host" ps -aq --filter "label=$relay_label=true")
  managed=$(docker --host "$docker_host" ps -aq --filter "label=$managed_label=true")
  containers=$(printf '%s\n' $managed | grep -vxF "$(printf '%s\n' $relays)" || true)

  if [ -n "$containers$relays" ]; then
    act docker --host "$docker_host" rm -f $containers $relays >/dev/null
  fi

  networks=$(docker --host "$docker_host" network ls -q --filter "label=$managed_label=true" --filter name=pi-sandbox)

  if [ -n "$networks" ]; then
    act docker --host "$docker_host" network rm $networks >/dev/null
  fi

  echo "containers: $(verb "remove" "removed") $(echo $containers | wc -w | tr -d ' ') sandbox and $(echo $relays | wc -w | tr -d ' ') relay containers and $(echo $networks | wc -w | tr -d ' ') pi-sandbox networks"

  if [ "$volumes" -eq 1 ]; then
    volume_names=$(docker --host "$docker_host" volume ls -q --filter "label=$managed_label=true" --filter name=pi-sandbox- | grep '^pi-sandbox-' || true)

    if [ -n "$volume_names" ]; then
      act docker --host "$docker_host" volume rm $volume_names >/dev/null
    fi

    echo "volumes: $(verb "remove" "removed") $(echo $volume_names | wc -w | tr -d ' ') pi-sandbox volumes"
  else
    echo "volumes: kept (pass --volumes to remove caches and older sandbox-only sessions)"
  fi
else
  echo "containers: no reachable docker engine, nothing removed"
fi

if command -v container >/dev/null 2>&1 && container system status >/dev/null 2>&1; then
  apple_containers=""

  collect_apple_managed() {
    if [ "$#" -eq 0 ]; then
      return 0
    fi

    if container inspect "$1" 2>/dev/null | grep -q "\"$managed_label\"[[:space:]]*:[[:space:]]*\"true\""; then
      apple_containers="$apple_containers $1"
    fi

    shift
    collect_apple_managed "$@"
  }

  collect_apple_managed $(container list --all --quiet 2>/dev/null | grep '^pi-sandbox-' || true)

  if [ -n "$apple_containers" ]; then
    act container delete --force $apple_containers >/dev/null
  fi

  apple_networks=""

  collect_apple_networks() {
    if [ "$#" -eq 0 ]; then
      return 0
    fi

    if container network inspect "$1" 2>/dev/null | grep -q "\"$managed_label\"[[:space:]]*:[[:space:]]*\"true\""; then
      apple_networks="$apple_networks $1"
    fi

    shift
    collect_apple_networks "$@"
  }

  collect_apple_networks $(container network list --quiet 2>/dev/null | grep '^pi-sandbox' || true)

  if [ -n "$apple_networks" ]; then
    act container network delete $apple_networks >/dev/null
  fi

  echo "apple container: $(verb "remove" "removed") $(echo $apple_containers | wc -w | tr -d ' ') pi-sandbox containers and $(echo $apple_networks | wc -w | tr -d ' ') pi-sandbox networks"
fi

if [ "$vm" -eq 1 ]; then
  if command -v colima >/dev/null 2>&1 && colima list 2>/dev/null | grep -q "^$colima_profile "; then
    act colima delete --profile "$colima_profile" --force >/dev/null
    echo "colima: $(verb "delete" "deleted") profile $colima_profile"
  else
    echo "colima: no profile $colima_profile"
  fi
else
  echo "colima: profile $colima_profile kept (pass --vm to delete it)"
fi

echo "kept: your repositories, ~/.pi, ~/.config/pi-sandbox and the rest of $state_dir (image record, CA, salt, proxy instances)"
echo "kept: your pi sessions stay in ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
