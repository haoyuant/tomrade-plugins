# Shared by the plugin's scripts. POSIX sh; nothing beyond sed, grep and the herdr CLI.

herdr_bin() { printf '%s' "${HERDR_BIN_PATH:-herdr}"; }

# A herdr toast, for the person at the terminal.
say() { "$(herdr_bin)" notification show "$1" --body "${2:-}" --sound "${3:-none}" >/dev/null 2>&1 || true; }

# One string field out of a line of JSON, by name. Good enough for paths and ids; never for text with quotes in it.
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }

# Where the pane that invoked us is: its foreground program's folder, else the pane's own.
pane_cwd() {
  [ -n "${HERDR_PANE_ID:-}" ] || return 1
  info=$("$(herdr_bin)" pane get "$HERDR_PANE_ID" 2>/dev/null) || return 1
  dir=$(printf '%s' "$info" | json_field foreground_cwd)
  [ -n "$dir" ] || dir=$(printf '%s' "$info" | json_field cwd)
  [ -n "$dir" ] && printf '%s' "$dir"
}

# The project a folder belongs to: the id at the end of the tomrade server's URL in the nearest .mcp.json, as "Connect repository" wrote it.
project_of() {
  dir=$1
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.mcp.json" ]; then
      url=$(tr -d '\n ' < "$dir/.mcp.json" | sed -n 's/.*"tomrade":{[^}]*"url":"\([^"]*\)".*/\1/p')
      case "$url" in
        */mcp/*) printf '%s' "${url##*/}"; return 0 ;;
      esac
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Hand a link to the system: Tomrade registered tomrade:// when it first ran.
open_link() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  else return 1
  fi
}
