import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posh-hook-adapter-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(tmp, 'Gemfile.lock'), '');
fs.writeFileSync(path.join(bin, 'posh'), `#!/bin/sh
printf '%s' '${JSON.stringify({
  ok: true, project_path: tmp, data: [{ ref: 'gem:kamal', kinds: ['rdoc'] }],
})}'
`, { mode: 0o755 });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('XDG_CONFIG_HOME', path.join(tmp, 'config'));
  vi.stubEnv('PATH', bin);
  vi.stubEnv('PLUGIN_DATA', fs.mkdtempSync(path.join(tmp, 'data-')));
  vi.stubEnv('POSH_HOOK_DECISION', undefined);
});

async function runAdapter(input, host = 'claude') {
  const readFile = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) =>
    file === 0 ? Buffer.from(input) : readFile(file, ...args));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const argv = process.argv;
  process.argv = [argv[0], 'posh-pre-tool-use.mjs', host];
  try {
    await import('../hooks/posh-pre-tool-use.mjs');
    return output.mock.calls;
  } finally {
    process.argv = argv;
  }
}

const lookup = JSON.stringify({
  cwd: tmp, session_id: 'hook-adapter', tool_name: 'Bash',
  tool_input: { command: 'bundle show kamal' },
});

for (const [host, setting, decision] of [
  ['claude', undefined, 'deny'],
  ['claude', 'ask', 'ask'],
  ['claude', 'allow', 'deny'],
  ['codex', 'ask', 'deny'],
]) {
  test(`${host} maps ${setting ?? 'default'} to ${decision}`, async () => {
    vi.stubEnv('POSH_HOOK_DECISION', setting);
    const calls = await runAdapter(lookup, host);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    const out = JSON.parse(calls[0][0]);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), [
      'hookEventName', 'permissionDecision', 'permissionDecisionReason',
    ]);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, decision);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /gem:kamal/);
  });
}

test('ordinary lookups produce no transport output', async () => {
  assert.deepEqual(await runAdapter(JSON.stringify({
    cwd: tmp, session_id: 'ordinary', tool_name: 'Bash', tool_input: { command: 'pwd' },
  })), []);
});

for (const input of ['not json', 'null', '{}']) {
  test(`malformed input fails open: ${input}`, async () => {
    assert.deepEqual(await runAdapter(input), []);
  });
}
