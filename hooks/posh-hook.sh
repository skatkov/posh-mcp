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
    feedback) echo feedback ;;
    *) echo auto ;;
  esac
}

# $HOME is excluded because a stray ~/Gemfile does not make every folder Ruby.
ruby_project() {
  dir=${CLAUDE_PROJECT_DIR:-$PWD}
  while [ "$dir" != / ] && [ "$dir" != "$HOME" ]; do
    for marker in "$dir"/Gemfile "$dir"/Gemfile.lock "$dir"/gems.rb "$dir"/*.gemspec; do
      if [ -e "$marker" ]; then
        printf '%s\n' "$dir"
        return 0
      fi
    done
    [ -e "$dir/.git" ] && return 1
    dir=$(dirname -- "$dir")
  done
  return 1
}

active() {
  case $(mode) in
    on | feedback) return 0 ;;
    off) return 1 ;;
    *) ruby_project >/dev/null ;;
  esac
}

ruleset() {
  awk 'n >= 2; /^---[[:space:]]*$/ && n < 2 { n++ }' "$root/skills/posh/SKILL.md"
  if [ "$(mode)" = feedback ]; then
    printf '\n'
    cat "$root/skills/posh/feedback.md"
  fi
}

# Only our own text reaches this, never the prompt, and SKILL.md has no tabs.
json_string() {
  printf '%s\n' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
}

emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"' "$event"
  json_string "$1"
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
  set +f
  case ${1:-} in
    /posh | /posh:posh | \$posh | \$posh:posh | @posh) ;;
    *) return 0 ;;
  esac

  # Earlier feedback instructions stay in the transcript, so they must be revoked.
  stop_feedback=
  [ "$(mode)" = feedback ] && stop_feedback=' Stop adding the POSH feedback section.'

  case ${2:-on} in
    on)
      set_mode on
      emit "POSH is now on for every project.$stop_feedback Confirm in one short line.

$(ruleset)"
      ;;
    feedback)
      set_mode feedback
      emit "POSH feedback mode is now on for every project. Confirm in one short line.

$(ruleset)"
      ;;
    off)
      set_mode off
      emit "POSH is now off. Stop following earlier POSH instructions until the user turns it back on. Confirm in one short line."
      ;;
    auto)
      rm -f "$mode_file"
      if ruby_project >/dev/null; then
        emit "POSH is now on for Ruby projects only, which includes this one.$stop_feedback Confirm in one short line.

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
  PreToolUse)
    if command -v ruby >/dev/null 2>&1; then
      ruby "$root/hooks/posh-pre-tool-use.rb" "${2:-claude}"
    fi
    ;;
esac
exit 0
