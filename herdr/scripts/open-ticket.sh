#!/bin/sh
# Opens the clicked ticket in Tomrade: a tomrade:// link as it is, a bare key through the repository's project.
set -u
. "$(dirname "$0")/common.sh"

url=${HERDR_PLUGIN_CLICKED_URL:-}
case "$url" in
  tomrade://item/*)
    open_link "$url" || say "Tomrade is not installed here" "Nothing handles tomrade:// links on this machine."
    exit 0 ;;
  "")
    say "Ctrl-click a ticket key" "A key such as TOM-42, or a tomrade:// link, opens the ticket in Tomrade."
    exit 0 ;;
esac

dir=$(pane_cwd) || dir=$PWD
project=$(project_of "$dir") || {
  say "No Tomrade project here" "This folder is not connected to Tomrade: run \"Connect repository to coding agents\" there first."
  exit 0
}
open_link "tomrade://item/$project/$url" || say "Tomrade is not installed here" "Nothing handles tomrade:// links on this machine."
