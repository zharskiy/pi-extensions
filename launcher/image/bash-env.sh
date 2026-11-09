command_not_found_handle() {
  printf 'bash: %s: command not found\npi-sandbox: %s is not in the sandbox image; add it with image.packages or image.npmGlobal in ~/.config/pi-sandbox/config.json (see pi sandbox doctor)\n' "$1" "$1" >&2
  return 127
}

if [ -f /tmp/pi-sandbox/truststore.p12 ]; then
  case " ${JAVA_TOOL_OPTIONS:-} " in
    *" -Djavax.net.ssl.trustStore=/tmp/pi-sandbox/truststore.p12 "*) ;;
    *) export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djavax.net.ssl.trustStore=/tmp/pi-sandbox/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12 -Djavax.net.ssl.trustStorePassword=changeit" ;;
  esac
fi
