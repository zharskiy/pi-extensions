#!/usr/bin/env bash
# Copies the company agents into pi's agent dir. A workaround: pi-subagents loads agent files only from
# its own folder, <agentDir>/agents and a trusted project's .pi/agents, and skips symlinked subfolders.
# Rerun after every update of this package.
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
target="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents/acme"

rm -rf "$target"
mkdir -p "$target"
cp "$pkg"/agents/*.md "$target/"
echo "copied $(ls "$target" | wc -l | tr -d ' ') agent file(s) to $target; run /reload in pi"
