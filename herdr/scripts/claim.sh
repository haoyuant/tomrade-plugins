#!/bin/sh
# claim.sh <pane> <key>: tells the agent in the pane to claim the ticket through the tomrade MCP server its repository is connected to.
set -u
. "$(dirname "$0")/common.sh"

pane=$1
key=$2
case "$key" in
  [A-Z]*-[0-9]*) ;;
  *) say "Not a ticket key" "$key does not look like TOM-42."; exit 0 ;;
esac
prompt="Before anything else, call the tomrade MCP tool claim_ticket with key \"$key\": it returns the ticket, the branch to use, and marks it Doing. Then implement only its stated outcome and acceptance criteria."
if "$(herdr_bin)" agent prompt "$pane" "$prompt" >/dev/null 2>&1; then
  say "$key handed to the agent in $pane" "It claims the ticket first, then starts on it." done
else
  say "No agent ready in $pane" "Start Claude Code, Codex or another agent there, or wait until it is idle, then try again." request
fi
