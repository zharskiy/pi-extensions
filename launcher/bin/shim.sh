package_name=pi-extensions-mz
wrapper_marker="launcher/bin/pi-sandbox"
bin_dir="$HOME/.local/bin"
fish_file="$HOME/.config/fish/conf.d/pi-sandbox.fish"
shim_dir="$bin_dir"

if [ -d "$bin_dir" ]; then
  shim_dir=$(cd -P "$bin_dir" && pwd)
fi

shim="$shim_dir/pi"

is_ours() {
  if [ -L "$shim" ]; then
    case "$(readlink "$shim")" in
      */pi-sandbox|*/pi-sandbox.js) return 0 ;;
    esac
  fi

  [ -f "$shim" ] && grep -q "$wrapper_marker" "$shim"
}
