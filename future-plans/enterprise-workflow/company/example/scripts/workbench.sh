#!/usr/bin/env bash
# Acme workbench helper. Needs git and jq.
#   workbench.sh new <EPIC-KEY> <dept>/<repo> ...   create ~/work/<EPIC-KEY> and clone the repos
#   workbench.sh add <dept>/<repo>                  clone one more repo (run in the workbench root)
#   workbench.sh branch <dept> <TICKET> <slug>      create the department branch in its repos
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
config="$pkg/departments.json"
root="$(jq -r .workbenchRoot "$config" | sed "s|^~|$HOME|")"

clone() {
  local dept="${1%%/*}" repo="${1#*/}"
  local remote default
  remote="$(jq -r --arg d "$dept" --arg r "$repo" '.departments[$d].repos[$r].remote // empty' "$config")"
  default="$(jq -r --arg d "$dept" --arg r "$repo" '.departments[$d].repos[$r].default // empty' "$config")"
  [ -n "$remote" ] || { echo "unknown repo $1" >&2; exit 1; }
  mkdir -p "$dept"
  [ -f "$dept/AGENTS.md" ] || cp "$pkg/departments/$dept/AGENTS.md" "$dept/AGENTS.md"
  [ -d "$dept/$repo/.git" ] || git clone --branch "$default" "$remote" "$dept/$repo"
}

case "${1:-}" in
  new)
    key="$2"; shift 2
    dir="$root/$key"
    [ ! -e "$dir" ] || { echo "$dir exists" >&2; exit 1; }
    mkdir -p "$dir/docs" && cd "$dir"
    cp "$pkg/templates/workbench-AGENTS.md" AGENTS.md
    cp "$pkg/templates/WORKBENCH.md" WORKBENCH.md
    for spec in "$@"; do clone "$spec"; done
    echo "$dir"
    ;;
  add)
    clone "$2"
    ;;
  branch)
    dept="$2" ticket="$3" slug="$4"
    pattern="$(jq -r --arg d "$dept" '.departments[$d].branch' "$config")"
    name="${pattern//\{ticket\}/$ticket}"; name="${name//\{slug\}/$slug}"
    for repo in "$dept"/*/; do
      [ -d "$repo/.git" ] || continue
      if [ -n "$(git -C "$repo" status --porcelain)" ]; then echo "skip $repo: uncommitted changes" >&2; continue; fi
      git -C "$repo" switch "$name" 2>/dev/null || git -C "$repo" switch -c "$name"
      echo "$repo -> $name"
    done
    ;;
  *)
    sed -n '2,5p' "$0"; exit 1
    ;;
esac
