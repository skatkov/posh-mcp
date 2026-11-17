import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// Vitest's forks pool isolates each test file's environment and state.
export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const hook = path.join(repo, 'hooks/posh-hook.sh');
export const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'posh-plugin-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
export const modeFile = path.join(tmp, 'config/posh/agent-mode');
beforeEach(() => fs.rmSync(modeFile, { force: true }));
export const MARKER = "POSH: docs for this project's exact versions";
export const FEEDBACK = 'POSH feedback: proactively evaluate successful use too';

export const project = (...files) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'project-'));
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
};

export function runHook(event, cwd, stdin = '', extraEnv = {}) {
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const out = execFileSync('sh', [hook, event], { cwd, env: { ...env, ...extraEnv }, input: stdin, encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

// Keep lookup tests off this machine's licence and synced docsets.
const DOCSETS = {
  'gem:activerecord': { version: '8.1.4.1', kinds: ['rdoc'] },
  'gem:kamal': { version: '2.12.0', kinds: ['rdoc', 'guide'] },
  'gem:nokogiri': { version: '1.19.7', kinds: ['rdoc'] },
  'gem:rails': { version: '8.1.4.1', kinds: ['rdoc'] },
  'gem:geneva_drive': { version: '0.7.0', kinds: ['yard'] },
  'gem:geneva_drive_admin': { version: '0.6.0', kinds: [] },
};
export const poshBin = path.join(tmp, 'bin');
beforeAll(() => {
  fs.mkdirSync(poshBin, { recursive: true });
  const cases = Object.entries(DOCSETS)
    .map(([ref, spec]) => `  *'--filter ${ref}') printf '%s' '${JSON.stringify([{ ref, ...spec }])}' ;;`)
    .join('\n');
  const all = JSON.stringify(Object.entries(DOCSETS).map(([ref, spec]) => ({ ref, ...spec })));
  fs.writeFileSync(
    path.join(poshBin, 'posh'),
    `#!/bin/sh
[ "$1" = docsets ] && [ "$2" = --json ] && [ "$3" = --project ] || exit 1
[ "$#" = 4 ] || { [ "$#" = 6 ] && [ "$5" = --filter ]; } || exit 1
if [ -n "\${FAKE_POSH_CALLS:-}" ]; then printf '%s\\n' "$@" >> "$FAKE_POSH_CALLS"; fi
if [ -n "\${FAKE_POSH_EXPECT_PROJECT:-}" ]; then [ "$4" = "$FAKE_POSH_EXPECT_PROJECT" ] || exit 1; fi
if [ -n "\${FAKE_POSH_RESPONSE+x}" ]; then printf '%s' "$FAKE_POSH_RESPONSE"; exit; fi
printf '%s' '{"ok":true,"project_path":' "$FAKE_POSH_PROJECT_JSON" ',"data":'
case "$*" in
${cases}
  *--filter*) printf '%s' '[]' ;;
  *) printf '%s' '${all}' ;;
esac
printf '}'
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${poshBin}${path.delimiter}${process.env.PATH || ''}`;
});

export const gemDir = (gem, version) => `/home/x/.local/share/mise/installs/ruby/4.0.9/lib/ruby/gems/4.0.0/gems/${gem}-${version}`;
export const prompt = (text) => JSON.stringify({ session_id: 'x', cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: text });
