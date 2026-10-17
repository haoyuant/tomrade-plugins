#!/bin/sh
# The popup: asks for the ticket key, then hands the claim to the agent in the pane that opened it.
set -u
. "$(dirname "$0")/common.sh"

target=${TOMRADE_TARGET_PANE:-}
if [ -z "$target" ]; then
  printf 'No pane to claim for: run "Tomrade: claim this pane to a ticket" from an agent pane.\n'
  sleep 2
  exit 0
fi
printf 'Ticket key for the agent in %s (for example TOM-42): ' "$target"
read -r key
key=$(printf '%s' "$key" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
[ -n "$key" ] || exit 0
sh "$(dirname "$0")/claim.sh" "$target" "$key"
