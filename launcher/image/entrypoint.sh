#!/bin/sh
set -eu

agent_dir="${HOME:-/home/pi}/.pi/agent"
bundle_dir=/tmp/pi-sandbox
system_bundle=/etc/ssl/certs/ca-certificates.crt
sandbox_ca=/etc/pi-sandbox/ca.pem

mkdir -p "$agent_dir" "$bundle_dir"

link_read_only() {
  if [ ! -e "$agent_dir/$1" ] && [ ! -L "$agent_dir/$1" ]; then
    ln -s "/opt/pi-sandbox/$1" "$agent_dir/$1"
  fi
}

link_read_only models.json
link_read_only auth.json

if [ -f /opt/pi-sandbox/settings.json ] && [ ! -e "$agent_dir/settings.json" ]; then
  cp /opt/pi-sandbox/settings.json "$agent_dir/settings.json"
  chmod 0644 "$agent_dir/settings.json"
fi

cat "$system_bundle" > "$bundle_dir/ca-bundle.pem"

if [ -f "$sandbox_ca" ]; then
  cat "$sandbox_ca" >> "$bundle_dir/ca-bundle.pem"
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec tini -s -- sleep infinity
