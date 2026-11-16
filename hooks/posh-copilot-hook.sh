#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if command -v node >/dev/null 2>&1; then
  node "$root/hooks/posh-copilot-hook.mjs" "$1"
fi
# Copilot fails closed on hook crashes; POSH is an adoption nudge, not a gate.
exit 0
