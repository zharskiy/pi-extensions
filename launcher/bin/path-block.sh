marker_begin="# pi-sandbox begin"
marker_end="# pi-sandbox end"

path_block_present() {
  [ -f "$1" ] && { grep -qxF "$marker_begin" "$1" || grep -qxF "$marker_end" "$1"; }
}

path_block_intact() {
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin { if (inside) bad = 1; inside = 1; next }
    $0 == end { if (!inside) bad = 1; inside = 0; next }
    END { exit (bad || inside) ? 1 : 0 }
  ' "$1"
}

path_block_body() {
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin && !done { inside = 1; next }
    $0 == end && inside { inside = 0; done = 1; next }
    inside { print }
  ' "$1"
}

path_block_line() {
  printf "export PATH='%s':\"\$PATH\"" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

path_block_bin_dir() {
  path_block_body "$1" | awk -v q="'" '
    function ends(text, tail) { return length(text) >= length(tail) && substr(text, length(text) - length(tail) + 1) == tail }
    function inner(text, head, tail) { return substr(text, length(head) + 1, length(text) - length(head) - length(tail)) }
    {
      quoted_head = "export PATH=" q
      quoted_tail = q ":\"$PATH\""
      plain_head = "export PATH=\""
      plain_tail = ":$PATH\""
      dir = ""

      if (index($0, quoted_head) == 1 && ends($0, quoted_tail)) {
        dir = inner($0, quoted_head, quoted_tail)
        gsub(q "\\\\" q q, q, dir)
      } else if (index($0, plain_head) == 1 && ends($0, plain_tail)) {
        dir = inner($0, plain_head, plain_tail)
      }

      if (substr(dir, 1, 1) == "/") {
        print dir
        exit
      }
    }
  '
}

path_block_strip() {
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$1" > "$1.pi-sandbox.tmp"
  cat "$1.pi-sandbox.tmp" > "$1"
  rm -f "$1.pi-sandbox.tmp"
}

path_block_broken_note() {
  echo "$1 has a \"$marker_begin\" or \"$marker_end\" line without its pair, left as it is"
}
