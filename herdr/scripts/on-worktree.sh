#!/bin/sh
# A worktree herdr just made: offer to put a ticket on it.
set -u
. "$(dirname "$0")/common.sh"

path=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | json_field path)
say "New worktree${path:+: $(basename "$path")}" "Start an agent in it, then run \"Tomrade: claim this pane to a ticket\" to give it a ticket." none
