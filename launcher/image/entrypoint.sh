#!/bin/sh
set -eu

home="${HOME:-/home/pi}"
agent_dir="$home/.pi/agent"
render_dir=/opt/pi-sandbox/render
tools_dir="$render_dir/tools"
agents_skills_render="$render_dir/agents-skills"
agents_skills="$home/.agents/skills"
handover=/tmp/pi-sandbox-handover
ready=/tmp/pi-sandbox-ready
forward_status=/tmp/pi-sandbox-forward
forwarder=/usr/local/lib/pi-sandbox/forwarder.mjs
handover_tries=600

await_handover() {
  tries=0

  while [ ! -e "$handover" ]; do
    if [ "$tries" -ge "$handover_tries" ]; then
      echo "pinata: the volumes were not handed to the sandbox user within $((handover_tries / 10)) s, stopping" >&2
      exit 1
    fi

    tries=$((tries + 1))
    sleep 0.1
  done
}

if [ -n "${PI_SANDBOX_AWAIT_HANDOVER:-}" ]; then
  await_handover
fi

mkdir -p "$agent_dir"

copy_file() {
  temporary=$(mktemp "$2.pi-sandbox-XXXXXX")
  cp "$1" "$temporary"
  chmod "$3" "$temporary"

  if [ -d "$2" ]; then
    rm -rf "$2" || true
  fi

  mv -f "$temporary" "$2"
}

linked() {
  [ "$(readlink "$2" 2>/dev/null || true)" = "$1" ]
}

place_link() {
  if linked "$1" "$2"; then
    return
  fi

  if [ -d "$2" ]; then
    rm -rf "$2" || true
  fi

  temporary=$(mktemp "$2.pi-sandbox-XXXXXX")
  ln -sf "$1" "$temporary"
  mv -f "$temporary" "$2" 2>/dev/null || rm -f "$temporary"
  linked "$1" "$2"
}

find "$agent_dir" -mindepth 1 -maxdepth 1 -type l -lname "$render_dir/*" ! -exec test -e {} \; -exec rm -f {} \; || true

for entry in "$render_dir"/* "$render_dir"/.[!.]* "$render_dir"/..?*; do
  name=${entry##*/}

  if [ ! -e "$entry" ] || [ "$name" = tools ] || [ "$name" = agents-skills ]; then
    continue
  fi

  link="$agent_dir/$name"

  if [ "$name" = auth.json ]; then
    copy_file "$entry" "$link" 0444
    continue
  fi

  place_link "$entry" "$link"
done

if [ -d "$agents_skills_render" ]; then
  mkdir -p "$(dirname "$agents_skills")"
  place_link "$agents_skills_render" "$agents_skills"
elif [ -L "$agents_skills" ] && [ ! -e "$agents_skills" ]; then
  rm -f "$agents_skills"
fi

link_tool() {
  if [ -f "$tools_dir/$1" ]; then
    mkdir -p "$(dirname "$home/$2")"
    place_link "$tools_dir/$1" "$home/$2"
  fi
}

copy_tool() {
  if [ -f "$tools_dir/$1" ]; then
    mkdir -p "$(dirname "$home/$2")"
    copy_file "$tools_dir/$1" "$home/$2" "$3"
  fi
}

link_tool m2-settings.xml .m2/settings.xml
link_tool npmrc .npmrc
link_tool pip.conf .config/pip/pip.conf
copy_tool glab-config.yml .config/glab-cli/config.yml 0600
copy_tool gitconfig .gitconfig 0644

start_forwarder() {
  rm -f "$forward_status"
  node "$forwarder" "$forward_status" "$PI_SANDBOX_SERVICES_HOST" $PI_SANDBOX_SERVICE_PORTS &
  forwarder_pid=$!

  while [ ! -e "$forward_status" ]; do
    if ! kill -0 "$forwarder_pid" 2>/dev/null; then
      [ -e "$forward_status" ] || echo "the port forwarder exited before it listened" > "$forward_status"
    fi

    sleep 0.1
  done
}

if [ -n "${PI_SANDBOX_SERVICE_PORTS:-}" ]; then
  start_forwarder
fi

: > "$ready"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec sleep infinity
