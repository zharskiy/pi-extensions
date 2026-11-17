#!/bin/sh
bootstrap_version=0.4.0 # x-release-please-version

pinata_bootstrap() {
  set -eu
  unset CDPATH

  download_complete=--pinata-bootstrap-complete

  if [ "$#" -eq 0 ]; then
    printf '%s\n' "pinata bootstrap: the download of install.sh is incomplete, nothing was run" >&2
    exit 70
  fi

  eval "last_arg=\${$#}"

  if [ "$last_arg" != "$download_complete" ]; then
    printf '%s\n' "pinata bootstrap: the download of install.sh is incomplete, nothing was run" >&2
    exit 70
  fi

  package_name=@zharskiy/pinata
  legacy_name=pi-extensions-mz
  tarball_prefix=zharskiy-pinata-
  min_macos=13
  bootstrap_api=1
  min_node=22.19.0
  managed_kind='"kind"[[:space:]]*:[[:space:]]*"pi-managed-install"'
  managed_schema='"schemaVersion"[[:space:]]*:[[:space:]]*1([^0-9.]|$)'
  managed_layout='"layout"[[:space:]]*:[[:space:]]*"releases-v1"'
  managed_package="node_modules/@earendil-works/pi-coding-agent/package.json"

  flag_version=""
  flag_package=""
  pi_installer="${PI_INSTALLER_URL:-https://pi.dev/install.sh}"
  skip_pi=0
  dry_run=0
  download=""
  current_step=options

  usage() {
    printf '%s\n' \
      "usage: install.sh [--package-version X] [--package SPEC] [--skip-pi] [--pi-installer URL|FILE]" \
      "                  [--dry-run] [--version] [-h|--help] [installer options...]" \
      "Installs pi when it is missing, npm install -g $package_name, then runs the package's" \
      "launcher/install.sh with --with-extensions and every other option given here." \
      "Environment: PINATA_VERSION, PINATA_PACKAGE, PI_INSTALLER_URL, PI_CODING_AGENT_DIR; a flag wins over its variable," \
      "and --package (or PINATA_PACKAGE) wins over --package-version (or PINATA_VERSION)." \
      "Exit codes: 0 ok, 64 usage, 69 prerequisite, 70 step failed, 73 not ours, 75 busy, 78 config, 79 unhealthy," \
      "130 and 143 interrupted; treat any other non-zero code as a failure."
  }

  say() {
    printf '%s\n' "pinata bootstrap: $1"
  }

  fail() {
    printf '%s\n' "pinata bootstrap: $2" >&2
    exit "$1"
  }

  usage_error() {
    usage >&2
    fail 64 "$1"
  }

  cleanup() {
    if [ -n "$download" ]; then
      rm -f "$download" 2>/dev/null || :
    fi
  }

  finish() {
    finish_status=$?
    trap - EXIT
    cleanup

    case "$finish_status" in
      0|64|69|70|73|75|78|79|130|143) exit "$finish_status" ;;
    esac

    printf '%s\n' "pinata bootstrap: $current_step: failed unexpectedly (exit $finish_status)" >&2
    exit 70
  }

  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  version_at_least() {
    awk -v have="$1" -v want="$2" 'BEGIN {
      split(have, h, "."); split(want, w, ".");
      exit !((h[1] * 1000000 + h[2] * 1000 + h[3]) >= (w[1] * 1000000 + w[2] * 1000 + w[3]))
    }'
  }

  is_exact_version() {
    case "$1" in
      ""|*[!0-9A-Za-z.+-]*|[!0-9]*) return 1 ;;
      *.*.*) return 0 ;;
      *) return 1 ;;
    esac
  }

  is_url() {
    case "$1" in
      https://*|http://*) return 0 ;;
      *) return 1 ;;
    esac
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

  package_version_in() {
    sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1
  }

  run_detached() {
    node -e '
      const { spawn } = require("node:child_process");
      const child = spawn("sh", [process.argv[1]], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
      const forward = (signal) => () => child.kill(signal);
      process.on("SIGINT", forward("SIGINT"));
      process.on("SIGTERM", forward("SIGTERM"));
      child.on("error", () => process.exit(127));
      child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
    ' "$1"
  }

  argc=$(($# - 1))

  while [ "$argc" -gt 0 ]; do
    arg=$1
    shift
    argc=$((argc - 1))

    case "$arg" in
      --package-version|--package|--pi-installer)
        if [ "$argc" -eq 0 ] || [ -z "$1" ]; then
          usage_error "$arg needs a value"
        fi

        value=$1
        shift
        argc=$((argc - 1))

        case "$arg" in
          --package-version) flag_version=$value ;;
          --package) flag_package=$value ;;
          --pi-installer) pi_installer=$value ;;
        esac
        ;;
      --skip-pi) skip_pi=1 ;;
      --dry-run) dry_run=1 ;;
      --version)
        printf '%s\n' "$package_name bootstrap $bootstrap_version (bootstrap api $bootstrap_api)"
        exit 0
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *) set -- "$@" "$arg" ;;
    esac
  done

  shift

  if [ -n "$flag_package" ]; then
    package_spec=$flag_package
  elif [ -n "$flag_version" ]; then
    package_spec="$package_name@$flag_version"
  elif [ -n "${PINATA_PACKAGE:-}" ]; then
    package_spec=$PINATA_PACKAGE
  else
    package_spec="$package_name@${PINATA_VERSION:-$bootstrap_version}"
  fi

  [ "$package_spec" != "$package_name@" ] || usage_error "the package version is empty"

  tarball_version() {
    tarball=${1##*/}

    case "$tarball" in
      "$tarball_prefix"*.tgz)
        tarball=${tarball#"$tarball_prefix"}
        printf '%s\n' "${tarball%.tgz}"
        ;;
    esac
  }

  case "$package_spec" in
    "$package_name"@*) wanted_version=${package_spec#"$package_name"@} ;;
    *) wanted_version=$(tarball_version "$package_spec") ;;
  esac

  if ! is_exact_version "$wanted_version"; then
    wanted_version=""
  fi

  if ! is_url "$pi_installer" && [ ! -f "$pi_installer" ]; then
    usage_error "--pi-installer $pi_installer is neither an http(s) URL nor a file"
  fi

  current_step=preflight

  [ "$(id -u)" -ne 0 ] || fail 69 "preflight: run install.sh as your own user, not as root or with sudo"

  os=$(uname -s)
  [ "$os" = Darwin ] || fail 69 "preflight: unsupported system $os, pinata installs on macOS only"

  macos=$(sw_vers -productVersion 2>/dev/null) || macos=unknown
  [ "${macos%%.*}" -ge "$min_macos" ] 2>/dev/null || fail 69 "preflight: macOS $macos is too old, the sandbox VM (vz with virtiofs) needs macOS $min_macos or newer"
  command -v brew >/dev/null 2>&1 || fail 69 "preflight: Homebrew is missing, install it from https://brew.sh and run this again"

  command -v node >/dev/null 2>&1 || fail 69 "preflight: node is missing, install Node $min_node or newer (brew install node) and run this again"
  command -v npm >/dev/null 2>&1 || fail 69 "preflight: npm is missing, install Node $min_node or newer with npm (brew install node) and run this again"
  node_version=$(node -p 'process.versions.node' 2>/dev/null) || fail 69 "preflight: node does not run, reinstall Node $min_node or newer"
  version_at_least "$node_version" "$min_node" || fail 69 "preflight: node $node_version is too old, install Node $min_node or newer (brew upgrade node) and run this again"

  agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

  case "$agent_dir" in
    "~") agent_dir="$HOME" ;;
    "~/"*) agent_dir="$HOME/${agent_dir#"~/"}" ;;
  esac

  current_step=pi
  pi_present=0

  if is_managed_root "$agent_dir"; then
    pi_present=1
    say "pi: the managed pi in $agent_dir is present, pi's installer is not run"
  elif [ "$skip_pi" -eq 1 ]; then
    fail 69 "pi: no managed pi in $agent_dir and --skip-pi was given; install pi with curl -fsSL https://pi.dev/install.sh | sh and run this again"
  elif [ "$dry_run" -eq 1 ]; then
    if is_url "$pi_installer"; then
      command -v curl >/dev/null 2>&1 || fail 69 "pi: curl is missing, it is needed to download pi's installer"
    fi

    say "pi: would run pi's installer from $pi_installer without a terminal, installing pi into $agent_dir"
  else
    installer=$pi_installer

    if is_url "$pi_installer"; then
      command -v curl >/dev/null 2>&1 || fail 69 "pi: curl is missing, it is needed to download pi's installer"
      download=$(mktemp "${TMPDIR:-/tmp}/pi-installer.XXXXXX") || fail 70 "pi: cannot create a temporary file for pi's installer"
      say "pi: downloading pi's installer from $pi_installer"
      curl -fsSL "$pi_installer" -o "$download" || fail 70 "pi: downloading pi's installer from $pi_installer failed"
      installer=$download
    fi

    say "pi: running pi's installer without a terminal, installing pi into $agent_dir"
    run_detached "$installer" || fail 70 "pi: pi's installer failed with status $?"
    is_managed_root "$agent_dir" || fail 70 "pi: pi's installer finished but there is no managed pi in $agent_dir"
    say "pi: installed the managed pi in $agent_dir"
    pi_present=1
  fi

  current_step=package
  global_root=$(npm root -g 2>/dev/null) || fail 70 "package: npm root -g failed"
  package_dir="$global_root/$package_name"
  stage1="$package_dir/launcher/install.sh"
  legacy_dir="$global_root/$legacy_name"
  installed_version=""
  legacy_present=0

  if [ -f "$package_dir/package.json" ]; then
    installed_version=$(package_version_in "$package_dir")
  fi

  if [ -e "$legacy_dir" ] || [ -L "$legacy_dir" ]; then
    legacy_present=1
  fi

  supports_installer_api() {
    [ -f "$1" ] || return 1
    probe=$(sh "$1" --version 2>/dev/null) || return 1

    case "$probe" in
      *"installer api"*) return 0 ;;
      *) return 1 ;;
    esac
  }

  install_needed=1

  if [ "$legacy_present" -eq 0 ] && [ -n "$wanted_version" ] && [ "$installed_version" = "$wanted_version" ] && supports_installer_api "$stage1"; then
    install_needed=0
  fi

  if [ "$install_needed" -eq 1 ] && [ -n "$installed_version" ] && supports_installer_api "$stage1"; then
    busy_status=0
    node "$package_dir/launcher/bin/pi-sandbox.js" __busy >/dev/null 2>&1 </dev/null || busy_status=$?

    if [ "$busy_status" -eq 75 ]; then
      fail 75 "package: pi sessions are live, nothing was changed; end the pi sessions and run this again"
    fi
  fi

  if [ "$dry_run" -eq 1 ]; then
    if [ "$legacy_present" -eq 1 ]; then
      say "package: would run npm uninstall -g $legacy_name, the pre-release name of this package"
    fi

    if [ "$install_needed" -eq 1 ]; then
      say "package: would run npm install -g --omit=peer $package_spec${installed_version:+ (replacing $package_name $installed_version)}"
    else
      say "package: $package_name $installed_version is installed, npm install would be skipped"
    fi

    if [ "$install_needed" -eq 1 ] || [ "$pi_present" -eq 0 ]; then
      say "installer: would run sh $stage1 --with-extensions --dry-run${*:+ $*}; not run now, its own checks run at the real install"
      exit 0
    fi
  else
    if [ "$legacy_present" -eq 1 ]; then
      say "package: npm uninstall -g $legacy_name, the pre-release name of this package (its live pi sessions cannot be checked)"
      npm uninstall -g "$legacy_name" </dev/null || fail 70 "package: npm uninstall -g $legacy_name failed"
    fi

    if [ "$install_needed" -eq 1 ]; then
      say "package: npm install -g --omit=peer $package_spec"
      npm install -g --omit=peer "$package_spec" </dev/null || fail 70 "package: npm install -g --omit=peer $package_spec failed"
    else
      say "package: $package_name $installed_version is installed, npm install is skipped"
    fi
  fi

  current_step=installer
  [ -f "$stage1" ] || fail 70 "package: $stage1 is missing after installing $package_spec"
  supports_installer_api "$stage1" || fail 69 "installer: $package_spec predates the one-step installer (its launcher/install.sh has no installer api); install a newer version of $package_name"

  PI_INSTALL_BOOTSTRAP_API=$bootstrap_api
  PI_INSTALL_BOOTSTRAP_VERSION=$bootstrap_version
  PI_SANDBOX_NPM_SPEC=$package_spec
  export PI_INSTALL_BOOTSTRAP_API PI_INSTALL_BOOTSTRAP_VERSION PI_SANDBOX_NPM_SPEC

  trap - EXIT INT TERM
  cleanup

  if [ "$dry_run" -eq 1 ]; then
    exec sh "$stage1" --with-extensions --dry-run "$@"
  fi

  exec sh "$stage1" --with-extensions "$@"
}

pinata_bootstrap "$@" --pinata-bootstrap-complete
