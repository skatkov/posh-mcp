#!/bin/sh
# POSH lifecycle hook for Claude Code and Codex. $1 is the hook event name.
# Plain sh because POSH only ships for macOS and Linux, and Ruby machines often
# have no Node or jq on the PATH that hooks see.

event=$1
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
mode_file=${XDG_CONFIG_HOME:-$HOME/.config}/posh/agent-mode

mode() {
  case $(cat "$mode_file" 2>/dev/null) in
    on) echo on ;;
    off) echo off ;;
    *) echo auto ;;
  esac
}

# $HOME is excluded because a stray ~/Gemfile does not make every folder Ruby.
in_ruby_project() {
  dir=${CLAUDE_PROJECT_DIR:-$PWD}
  while [ "$dir" != / ] && [ "$dir" != "$HOME" ]; do
    for marker in "$dir"/Gemfile "$dir"/Gemfile.lock "$dir"/gems.rb "$dir"/*.gemspec; do
      [ -e "$marker" ] && return 0
    done
    [ -e "$dir/.git" ] && return 1
    dir=$(dirname -- "$dir")
  done
  return 1
}

active() {
  case $(mode) in
    on) return 0 ;;
    off) return 1 ;;
    *) in_ruby_project ;;
  esac
}

ruleset() {
  awk 'n >= 2; /^---[[:space:]]*$/ && n < 2 { n++ }' "$root/skills/posh/SKILL.md"
}

# Only our own text reaches this, never the prompt, and SKILL.md has no tabs.
emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"' "$event"
  printf '%s\n' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
  printf '"}}\n'
}

set_mode() {
  mkdir -p "$(dirname -- "$mode_file")" && printf '%s\n' "$1" >"$mode_file"
}

handle_command() {
  # The first "prompt" key on the single-line payload; an escaped quote just ends the match early.
  prompt=$(sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\).*/\1/p' | head -n 1)
  set -f
  # shellcheck disable=SC2086 # word splitting is the point
  set -- $prompt
  case ${1:-} in
    /posh | /posh:posh | \$posh | \$posh:posh | @posh) ;;
    *) return 0 ;;
  esac

  case ${2:-on} in
    on)
      set_mode on
      emit "POSH is now on for every project. Confirm in one short line.

$(ruleset)"
      ;;
    off)
      set_mode off
      emit "POSH is now off. Stop following earlier POSH instructions until the user turns it back on. Confirm in one short line."
      ;;
    auto)
      rm -f "$mode_file"
      if in_ruby_project; then
        emit "POSH is now on for Ruby projects only, which includes this one. Confirm in one short line.

$(ruleset)"
      else
        emit "POSH is now on for Ruby projects only. This is not one, so stop following earlier POSH instructions. Confirm in one short line."
      fi
      ;;
  esac
}

case $event in
  SessionStart | SubagentStart)
    active && emit "$(ruleset)"
    ;;
  UserPromptSubmit)
    handle_command
    ;;
esac
exit 0
