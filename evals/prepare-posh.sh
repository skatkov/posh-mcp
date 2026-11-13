#!/bin/sh
# The runner rewrites HOME and XDG paths and strips the operator's environment.
set -eu
real=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)
if [ ! -d "$real" ]; then
  if [ -d "/Users/$(id -un)" ]; then real=/Users/$(id -un); else real=/home/$(id -un); fi
fi
for d in share state; do
  source=$real/.local/$d/posh
  target=$HOME/.local/$d/posh
  [ -d "$source" ] || { echo "POSH eval: missing $source; install, activate and sync POSH first." >&2; exit 1; }
  mkdir -p "$HOME/.local/$d"
  # Never replace an existing directory, including when HOME is the real home.
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then ln -s "$source" "$target"; fi
done

# Fail before launching a model if licence or fixture docs are unavailable.
posh docsets --json --project "$PWD" | ruby -rjson -e '
  result = JSON.parse(STDIN.read)
  abort "POSH eval: docsets failed; check POSH activation." unless result["ok"] == true
  row = result.fetch("data").find { |item| item["ref"] == ARGV[0] && item["version"] == ARGV[1] }
  available = row && !row.fetch("kinds", []).empty?
  expected = ARGV[2] != "missing"
  abort "POSH eval: unexpected docset availability for #{ARGV[0]} #{ARGV[1]}; check activation and sync." unless row && !!available == expected
' "$1" "$2" "${3:-available}"
