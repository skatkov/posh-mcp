import fs from 'node:fs';
import { poshRedirect } from '../shared/lookup-policy.mjs';

try {
  const reason = await poshRedirect(JSON.parse(fs.readFileSync(0, 'utf8')));
  if (reason) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: process.argv[2] !== 'codex' && process.env.POSH_HOOK_DECISION === 'ask' ? 'ask' : 'deny',
      permissionDecisionReason: reason,
    } }));
  }
} catch {
  // Malformed transport input fails open.
}
