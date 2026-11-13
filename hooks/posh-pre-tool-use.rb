# Claude Code and Codex share the wire format, not a second policy.
require_relative "posh-lookup"

begin
  reason = posh_redirect(JSON.parse($stdin.read))
  if reason
    puts JSON.generate(hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: ARGV.first != "codex" && ENV["POSH_HOOK_DECISION"] == "ask" ? "ask" : "deny",
      permissionDecisionReason: reason
    })
  end
rescue StandardError
  # Malformed transport input fails open.
end
