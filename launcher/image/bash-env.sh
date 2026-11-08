command_not_found_handle() {
  printf 'bash: %s: command not found\npi-sandbox: %s is not in the sandbox image; add it with image.packages or image.npmGlobal in ~/.config/pi-sandbox/config.json (see pi sandbox doctor)\n' "$1" "$1" >&2
  return 127
}
