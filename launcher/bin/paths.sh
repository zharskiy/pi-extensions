agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

case "$agent_dir" in
  "~") agent_dir="$HOME" ;;
  "~/"*) agent_dir="$HOME/${agent_dir#"~/"}" ;;
esac

state_dir="${PI_SANDBOX_STATE_DIR:-$agent_dir/pi-sandbox/state}"
user_config="${PI_SANDBOX_USER_CONFIG:-$agent_dir/pi-sandbox/config.json}"
legacy_state_dir="$HOME/.local/state/pi-sandbox"
