#!/bin/sh
set -eu

agent_dir="${HOME:-/home/pi}/.pi/agent"
render_dir=/opt/pi-sandbox/render
bundle_dir=/tmp/pi-sandbox
system_bundle=/etc/ssl/certs/ca-certificates.crt
trust_bundle=/etc/pi-sandbox/ca.pem

mkdir -p "$agent_dir" "$bundle_dir"

find "$agent_dir" -mindepth 1 -maxdepth 1 -type l -lname "$render_dir/*" ! -exec test -e {} \; -exec rm -f {} \;

if [ -d "$render_dir" ]; then
  find "$render_dir" -mindepth 1 -maxdepth 1 -exec sh -c '
    link="$1/$(basename "$2")"

    rm -rf "$link"
    ln -s "$2" "$link"
  ' sh "$agent_dir" {} \;
fi

cat "$system_bundle" > "$bundle_dir/ca-bundle.pem"

if [ -f "$trust_bundle" ]; then
  cat "$trust_bundle" >> "$bundle_dir/ca-bundle.pem"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec tini -s -- sleep infinity
