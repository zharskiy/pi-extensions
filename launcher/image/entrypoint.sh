#!/bin/sh
set -eu

home="${HOME:-/home/pi}"
agent_dir="$home/.pi/agent"
render_dir=/opt/pi-sandbox/render
tools_dir="$render_dir/tools"
bundle_dir=/tmp/pi-sandbox
system_bundle=/etc/ssl/certs/ca-certificates.crt
trust_bundle=/etc/pi-sandbox/ca.pem
truststore="$bundle_dir/truststore.p12"

mkdir -p "$agent_dir" "$bundle_dir"

find "$agent_dir" -mindepth 1 -maxdepth 1 -type l -lname "$render_dir/*" ! -exec test -e {} \; -exec rm -f {} \;

for entry in "$render_dir"/* "$render_dir"/.[!.]* "$render_dir"/..?*; do
  if [ ! -e "$entry" ] || [ "$(basename "$entry")" = tools ]; then
    continue
  fi

  link="$agent_dir/$(basename "$entry")"

  rm -rf "$link"
  ln -s "$entry" "$link"
done

link_tool() {
  if [ -f "$tools_dir/$1" ]; then
    mkdir -p "$(dirname "$home/$2")"
    rm -rf "${home:?}/$2"
    ln -s "$tools_dir/$1" "$home/$2"
  fi
}

copy_tool() {
  if [ -f "$tools_dir/$1" ]; then
    mkdir -p "$(dirname "$home/$2")"
    rm -rf "${home:?}/$2"
    cp "$tools_dir/$1" "$home/$2"
    chmod "$3" "$home/$2"
  fi
}

link_tool m2-settings.xml .m2/settings.xml
link_tool gh-hosts.yml .config/gh/hosts.yml
link_tool npmrc .npmrc
link_tool pip.conf .config/pip/pip.conf
copy_tool glab-config.yml .config/glab-cli/config.yml 0600
copy_tool gitconfig .gitconfig 0644

cat "$system_bundle" > "$bundle_dir/ca-bundle.pem"

if [ -f "$trust_bundle" ]; then
  cat "$trust_bundle" >> "$bundle_dir/ca-bundle.pem"
fi

build_truststore() {
  java_bin="$(command -v java)" || return 1
  java_home="$(dirname "$(dirname "$(readlink -f "$java_bin")")")"
  keytool_bin="$java_home/bin/keytool"
  certs_dir="$bundle_dir/jvm-ca"

  [ -f "$trust_bundle" ] && [ -x "$keytool_bin" ] || return 1
  rm -rf "$certs_dir" "$truststore.tmp"
  mkdir -p "$certs_dir"
  cp -L "$java_home/lib/security/cacerts" "$truststore.tmp" 2>/dev/null || return 1
  awk -v dir="$certs_dir" '
    /-----BEGIN CERTIFICATE-----/ { count++; file = dir "/pi-sandbox-" count ".pem" }
    file != "" { print > file }
    /-----END CERTIFICATE-----/ { close(file); file = "" }
  ' "$trust_bundle"
  failed="$(find "$certs_dir" -name '*.pem' ! -exec sh -c '
    "$1" -importcert -noprompt -keystore "$2" -storepass changeit -alias "$(basename "$3" .pem)" -file "$3" >/dev/null 2>&1
  ' sh "$keytool_bin" "$truststore.tmp" {} \; -print)"
  imported="$(find "$certs_dir" -name '*.pem')"
  rm -rf "$certs_dir"
  [ -z "$failed" ] && [ -n "$imported" ] || return 1
  mv "$truststore.tmp" "$truststore"
}

rm -f "$truststore"

if ! build_truststore; then
  rm -f "$truststore.tmp"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec sleep infinity
