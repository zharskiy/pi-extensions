command_not_found_handle() {
  case "$1" in
    sudo | doas | systemctl)
      printf 'bash: %s: command not found\npinata: there is no root in the sandbox, so %s cannot help; Debian packages go in image.packages in pi-sandbox/config.json under pi'\''s agent dir on the host and are installed as root when the image is built, and a server the agent needs runs in a container of its own listed under services (see "Services" in pinata'\''s CONFIGURATION.md)\n' "$1" "$1" >&2
      ;;
    *)
      printf 'bash: %s: command not found\npinata: %s is not in the sandbox image; add its Debian package to image.packages or its npm package to image.npmGlobal in pi-sandbox/config.json under pi'\''s agent dir on the host (~/.pi/agent unless PI_CODING_AGENT_DIR is set)\n' "$1" "$1" >&2
      ;;
  esac

  return 127
}
