// Runs the Claude/Codex hook and the OpenCode plugin against the same scenarios.
// node --test isolates each file in its own process, so setting XDG_CONFIG_HOME is safe.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repo, 'hooks/posh-hook.sh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'posh-plugin-')));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
const modeFile = path.join(tmp, 'config/posh/agent-mode');
const MARKER = "POSH: docs for this project's exact versions";

const project = (...files) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'project-'));
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
};

function runHook(event, cwd, stdin = '') {
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const out = execFileSync('sh', [hook, event], { cwd, env, input: stdin, encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

const prompt = (text) => JSON.stringify({ session_id: 'x', cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: text });

let plugin;
before(async () => {
  plugin = (await import(path.join(repo, 'opencode/posh.mjs'))).default;
});
beforeEach(() => fs.rmSync(modeFile, { force: true }));

async function setupOpenCode(directory, servers = {}) {
  const state = { hooks: {}, sent: [] };
  const editor = { get: (n) => servers[n], set: (n, c) => { servers[n] = c; } };
  await plugin.setup({
    location: { directory },
    mcp: { transform: (fn) => fn(editor) },
    command: { transform: (fn) => fn({ add: (c) => { state.command = c; } }) },
    session: {
      hook: (name, fn) => { state.hooks[name] = fn; },
      prompt: (input) => { state.sent.push(input); },
    },
  });
  state.system = (kind = 'context') => {
    const event = { system: [] };
    state.hooks[kind](event);
    return event.system.map((part) => part.text).join('\n');
  };
  state.run = (text) => state.command.execute({ sessionID: 's', prompt: { text }, delivery: 'steer' });
  state.servers = servers;
  return state;
}

test('injects valid JSON with the ruleset and no frontmatter in a Ruby project', () => {
  const out = runHook('SessionStart', project('Gemfile.lock'));
  assert.equal(out.hookEventName, 'SessionStart');
  assert.ok(out.additionalContext.includes(MARKER));
  assert.ok(out.additionalContext.includes('`has_many`'));
  assert.ok(!out.additionalContext.includes('argument-hint'));
});

test('subagents get the ruleset too', () => {
  assert.equal(runHook('SubagentStart', project('Gemfile')).hookEventName, 'SubagentStart');
});

for (const marker of ['Gemfile', 'gems.rb', 'thing.gemspec']) {
  test(`auto detects ${marker}, and from a subdirectory`, async () => {
    const dir = project(marker);
    const sub = path.join(dir, 'app/models');
    fs.mkdirSync(sub, { recursive: true });
    assert.ok(runHook('SessionStart', sub));
    assert.ok((await setupOpenCode(sub)).system().includes(MARKER));
  });
}

test('auto stays silent outside Ruby projects and does not cross a git root', async () => {
  const outer = project('Gemfile');
  const inner = path.join(outer, 'vendored');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  for (const dir of [project('package.json'), inner]) {
    assert.equal(runHook('SessionStart', dir), null);
    assert.equal((await setupOpenCode(dir)).system(), '');
  }
});

test('auto treats home as not a project', async () => {
  const home = project('Gemfile');
  const dir = path.join(home, 'notes');
  fs.mkdirSync(dir);
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  assert.equal(execFileSync('sh', [hook, 'SessionStart'], { cwd: dir, env: { ...env, HOME: home }, input: '', encoding: 'utf8' }), '');
});

test('hook commands switch modes and the OpenCode plugin honours the same file', async () => {
  const ruby = project('Gemfile');
  const other = project();
  const hostOnOther = await setupOpenCode(other);

  const off = runHook('UserPromptSubmit', ruby, prompt('/posh off'));
  assert.match(off.additionalContext, /POSH is now off/);
  assert.equal(runHook('SessionStart', ruby), null);
  assert.equal((await setupOpenCode(ruby)).system(), '');

  const on = runHook('UserPromptSubmit', other, prompt('/posh'));
  assert.ok(on.additionalContext.includes(MARKER));
  assert.ok(runHook('SessionStart', other));
  assert.ok(hostOnOther.system().includes(MARKER));

  const auto = runHook('UserPromptSubmit', other, prompt('$posh:posh auto'));
  assert.match(auto.additionalContext, /This is not one/);
  assert.equal(fs.existsSync(modeFile), false);
  assert.equal(hostOnOther.system(), '');
});

test('ordinary prompts neither change the mode nor add context', () => {
  const dir = project('Gemfile');
  for (const text of ['please /posh off', 'posh off', '/poshy off', 'say \\"/posh off\\" now', '/posh how does has_many work']) {
    assert.equal(runHook('UserPromptSubmit', dir, prompt(text)), null, text);
    assert.equal(fs.existsSync(modeFile), false, text);
  }
});

test('shell metacharacters in a prompt are inert', () => {
  const dir = project('Gemfile');
  assert.equal(runHook('UserPromptSubmit', dir, prompt('/posh $(touch pwned) * `touch pwned`')), null);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
});

test('OpenCode adds the ruleset on model and compaction requests', async () => {
  const host = await setupOpenCode(project('Gemfile'));
  assert.ok(host.system('context').includes(MARKER));
  assert.ok(host.system('compaction').includes(MARKER));
});

test('OpenCode registers the MCP server but keeps a user-configured one', async () => {
  assert.deepEqual((await setupOpenCode(project())).servers.posh, { type: 'local', command: ['posh', 'mcp'] });
  const mine = { type: 'local', command: ['/opt/posh', 'mcp'] };
  assert.equal((await setupOpenCode(project(), { posh: mine })).servers.posh, mine);
});

test('OpenCode /posh persists the mode before the turn and passes other text through', async () => {
  const host = await setupOpenCode(project());
  await host.run('off');
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
  assert.match(host.sent.at(-1).text, /POSH is now off/);
  await host.run('');
  assert.ok(host.system().includes(MARKER));
  await host.run('auto');
  assert.equal(fs.existsSync(modeFile), false);
  await host.run('how does has_many work');
  assert.equal(fs.existsSync(modeFile), false);
  assert.ok(host.sent.at(-1).text.endsWith('how does has_many work'));
  assert.ok(host.sent.at(-1).text.includes(MARKER));
});

test('the module has only a default export (OpenCode treats exported functions as plugins)', async () => {
  const mod = await import(path.join(repo, 'opencode/posh.mjs'));
  assert.deepEqual(Object.keys(mod), ['default']);
});
