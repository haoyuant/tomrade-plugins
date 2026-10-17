#!/bin/sh
# The agent in this pane claims a ticket: the clicked key when there is one, else the key the popup asks for.
set -u
. "$(dirname "$0")/common.sh"

key=${HERDR_PLUGIN_CLICKED_URL:-}
case "$key" in
  tomrade://item/*) key=${key##*/} ;;
esac
if [ -n "$key" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  exec sh "$(dirname "$0")/claim.sh" "$HERDR_PANE_ID" "$key"
fi
if [ -z "${HERDR_PANE_ID:-}" ]; then
  say "No pane to claim" "Run this from the pane whose agent should take the ticket."
  exit 0
fi
"$(herdr_bin)" plugin pane open --plugin "${HERDR_PLUGIN_ID:-tomrade.herdr}" --entrypoint ask --placement popup --env "TOMRADE_TARGET_PANE=$HERDR_PANE_ID" --focus >/dev/null 2>&1 \
  || say "Could not ask for the key" "Open the ticket in Tomrade and start it there, or type the claim to the agent yourself."
