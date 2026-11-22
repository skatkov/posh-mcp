#!/bin/sh
# POSH lifecycle hook for Claude Code and Codex. $1 is the hook event name.
# Lifecycle guidance needs only sh; lookup interception additionally requires Node.

event=$1
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
mode_file=${XDG_CONFIG_HOME:-$HOME/.config}/posh/agent-mode

mode() {
  saved=$(LC_ALL=C awk '
    { text = text (NR > 1 ? "\n" : "") $0 }
    END { sub(/^[[:space:]]+/, "", text); sub(/[[:space:]]+$/, "", text); print text }
  ' "$mode_file" 2>/dev/null)
  case $saved in
    off | feedback) printf '%s\n' "$saved" ;;
    *) echo on ;;
  esac
}

ruleset() {
  awk 'n >= 2; /^---[[:space:]]*$/ && n < 2 { n++ }' "$root/skills/posh/SKILL.md"
  # A GUI or service launch often drops the brew and ~/.local/bin entries, so POSH
  # can be installed and still be invisible here. Say so instead of failing silently.
  command -v posh >/dev/null 2>&1 ||
    printf '\nThe posh command is not on PATH in this session, so no local documentation is reachable. Tell the user once, in one line, and do not call POSH tools or posh commands.\n'
  if [ "$1" = feedback ]; then
    printf '\n'
    cat "$root/skills/posh/feedback.md"
  fi
}

# Only our own text reaches this, never the prompt, and SKILL.md has no tabs.
emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"' "$event"
  printf '%s\n' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
  printf '"}}\n'
}

set_mode() (
  target=$mode_file
  if [ -L "$target" ]; then
    target=$(realpath "$target") && [ -e "$target" ] || exit 1
  fi
  directory=$(dirname -- "$target")
  mkdir -p "$directory" && [ ! -d "$target" ] || exit 1
  staged=$(mktemp "$directory/.agent-mode.XXXXXX") || exit 1
  trap 'rm -f -- "$staged"' 0
  printf '%s\n' "$1" >"$staged" && mv -f -- "$staged" "$target"
)

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
  requested=${2:-on}
  case $requested in
    on)
      message='POSH is now on for every project.'
      # Earlier feedback instructions stay in the transcript, so they must be revoked.
      [ "$(mode)" = feedback ] && message="$message Stop adding the POSH feedback section."
      ;;
    feedback) message='POSH feedback mode is now on for every project.' ;;
    off) message='POSH is now off. Stop following earlier POSH instructions until the user turns it back on.' ;;
    auto)
      emit "POSH auto mode was removed. Tell the user to choose on or off; no mode was changed."
      return 0
      ;;
    *) return 0 ;;
  esac

  if ! set_mode "$requested"; then
    emit "Could not save the POSH mode. Tell the user the save failed; do not confirm a mode change."
    return 0
  fi

  message="$message Confirm in one short line."
  if [ "$requested" != off ]; then
    message="$message

$(ruleset "$requested")"
  fi
  emit "$message"
}

case $event in
  SessionStart | SubagentStart)
    current=$(mode)
    [ "$current" != off ] && emit "$(ruleset "$current")"
    ;;
  UserPromptSubmit)
    handle_command
    ;;
  PreToolUse)
    if command -v node >/dev/null 2>&1; then
      node "$root/hooks/posh-pre-tool-use.mjs" "${2:-claude}"
    fi
    ;;
esac
exit 0
