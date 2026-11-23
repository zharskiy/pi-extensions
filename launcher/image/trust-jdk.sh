#!/bin/sh
set -eu

ca_dir=/usr/local/share/ca-certificates/pi-sandbox
net_lines=/usr/local/lib/pi-sandbox/jdk-net.properties
alias_prefix=pi-sandbox-
store_pass=changeit

unset JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS

fail() {
  echo "pi-sandbox trust: $*" >&2
  exit 1
}

first_existing() {
  for candidate in "$@"; do
    if [ -e "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

found_jdks() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -type f -path '*/bin/keytool' -print \
    | sed 's|/bin/keytool$||' \
    | sort -u
}

alias_of() {
  echo "$alias_prefix$(basename "$1" .crt)"
}

store_aliases() {
  "$1" -list -keystore "$2" -storepass "$store_pass" 2>/dev/null </dev/null \
    | sed -n "s/^\($alias_prefix[^,]*\),.*/\1/p"
}

trust_store() {
  keytool_bin="$1"
  store="$2"
  present="$(store_aliases "$keytool_bin" "$store")"
  wanted=""

  for crt in "$ca_dir"/*.crt; do
    [ -f "$crt" ] || continue
    name="$(alias_of "$crt")"
    wanted="$wanted $name "

    if ! printf '%s\n' "$present" | grep -qx "$name"; then
      output="$("$keytool_bin" -importcert -noprompt -keystore "$store" -storepass "$store_pass" -alias "$name" -file "$crt" 2>&1 </dev/null)" \
        || fail "could not import $crt into $store: $output"
    fi
  done

  for name in $present; do
    case "$wanted" in
      *" $name "*) ;;
      *) output="$("$keytool_bin" -delete -noprompt -keystore "$store" -storepass "$store_pass" -alias "$name" 2>&1 </dev/null)" \
        || fail "could not remove $name from $store: $output" ;;
    esac
  done
}

write_net_properties() {
  file="$1"
  next="$(mktemp)"

  awk '
    NR == FNR { key = $0; sub(/[[:space:]]*[=:].*/, "", key); keys[key] = 1; next }
    { key = $0; sub(/^[[:space:]]+/, "", key); sub(/[[:space:]]*[=:].*/, "", key) }
    !(key in keys)
  ' "$net_lines" "$file" > "$next"
  cat "$net_lines" >> "$next"

  if ! cmp -s "$next" "$file"; then
    cat "$next" > "$file"
  fi

  rm -f "$next"
}

jdk_problem() {
  problem="$1 has no $2"

  if [ "$discovered" = yes ]; then
    echo "pi-sandbox trust: skipping $problem" >&2
    return 0
  fi

  fail "$problem"
}

trust_jdk() {
  home="${1%/}"
  keytool_bin="$home/bin/keytool"

  [ -x "$keytool_bin" ] || { jdk_problem "$home" "bin/keytool"; return 0; }
  cacerts="$(first_existing "$home/lib/security/cacerts" "$home/jre/lib/security/cacerts")" \
    || { jdk_problem "$home" "lib/security/cacerts"; return 0; }
  net_file="$(first_existing "$home/conf/net.properties" "$home/jre/lib/net.properties" "$home/lib/net.properties")" \
    || { jdk_problem "$home" "conf/net.properties"; return 0; }

  trust_store "$keytool_bin" "$(readlink -f "$cacerts")"
  write_net_properties "$(readlink -f "$net_file")"
  echo "pi-sandbox trust: $home trusts the sandbox CAs and uses the sandbox proxy"
}

[ -f "$net_lines" ] || fail "$net_lines is missing"

discovered=no

if [ "$#" -gt 0 ]; then
  for home in "$@"; do
    trust_jdk "$home"
  done
  exit 0
fi

discovered=yes

found_jdks | while read -r home; do
  trust_jdk "$home"
done
