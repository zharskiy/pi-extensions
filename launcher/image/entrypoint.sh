#!/bin/sh
set -eu

agent_dir="${HOME:-/home/pi}/.pi/agent"
render_dir=/opt/pi-sandbox/render
bundle_dir=/tmp/pi-sandbox
system_bundle=/etc/ssl/certs/ca-certificates.crt
trust_bundle=/etc/pi-sandbox/ca.pem

mkdir -p "$agent_dir" "$bundle_dir"

find "$agent_dir" -mindepth 1 -maxdepth 1 -type l -lname "$render_dir/*" ! -exec test -e {} \; -exec rm -f {} \;

if [ -L "$agent_dir/mcp-auth.json" ]; then
  rm -f "$agent_dir/mcp-auth.json"
fi

if [ -d "$render_dir" ]; then
  find "$render_dir" -mindepth 1 -maxdepth 1 ! -name mcp-auth.json -exec sh -c '
    link="$1/$(basename "$2")"

    rm -rf "$link"
    ln -s "$2" "$link"
  ' sh "$agent_dir" {} \;
fi

if [ -f /opt/pi-sandbox/settings.json ] && [ ! -e "$agent_dir/settings.json" ]; then
  cp /opt/pi-sandbox/settings.json "$agent_dir/settings.json"
  chmod 0644 "$agent_dir/settings.json"
fi

cat "$system_bundle" > "$bundle_dir/ca-bundle.pem"

if [ -f "$trust_bundle" ]; then
  cat "$trust_bundle" >> "$bundle_dir/ca-bundle.pem"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec tini -s -- sleep infinity
