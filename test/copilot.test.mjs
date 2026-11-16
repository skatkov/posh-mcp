import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { repo, tmp, modeFile, MARKER, FEEDBACK, project, runHook, poshBin, gemDir, prompt } from './support/plugin-fixture.mjs';

const copilotManifest = JSON.parse(fs.readFileSync(path.join(repo, '.github/plugin/plugin.json'), 'utf8'));
const copilotHooks = JSON.parse(fs.readFileSync(path.join(repo, copilotManifest.hooks), 'utf8')).hooks;
function runCopilot(event, cwd, input = {}, extraEnv = {}) {
  const { CLAUDE_PLUGIN_DATA, PLUGIN_DATA, ...env } = process.env;
  const result = execFileSync('sh', ['-c', copilotHooks[event][0].bash], {
    cwd: repo,
    env: {
      ...env, COPILOT_PLUGIN_ROOT: repo,
      COPILOT_PLUGIN_DATA: fs.mkdtempSync(path.join(tmp, 'copilot-data-')),
      PATH: `${poshBin}:${env.PATH}`, FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd), ...extraEnv,
    },
    input: typeof input === 'string' ? input : JSON.stringify({ sessionId: 'native', cwd, ...input }),
    encoding: 'utf8',
  });
  return result ? JSON.parse(result) : null;
}

test('Copilot manifest reuses the skill, MCP configuration and marketplace', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, copilotManifest.mcpServers), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(repo, copilotManifest.skills, 'posh/SKILL.md')));
  assert.deepEqual(mcp.mcpServers.docs, { command: 'posh', args: ['mcp'] });
  assert.equal(marketplace.plugins.find(({ name }) => name === copilotManifest.name).source, './');
  assert.deepEqual(Object.keys(copilotHooks), ['sessionStart', 'subagentStart', 'userPromptTransformed', 'preToolUse']);
});

test('Copilot lifecycle uses the payload cwd and returns native additionalContext without frontmatter', () => {
  const cwd = project('thing.gemspec');
  const sub = path.join(cwd, 'lib');
  fs.mkdirSync(sub);
  const pluginPath = path.join(tmp, 'plugin with spaces');
  fs.symlinkSync(repo, pluginPath);
  for (const event of ['sessionStart', 'subagentStart']) {
    const out = runCopilot(event, sub, {}, { CLAUDE_PROJECT_DIR: project(), COPILOT_PLUGIN_ROOT: pluginPath });
    assert.deepEqual(Object.keys(out), ['additionalContext']);
    assert.ok(out.additionalContext.includes(MARKER));
    assert.ok(out.additionalContext.includes(JSON.stringify({ project: cwd })));
    assert.ok(out.additionalContext.includes('every MCP tool call'));
    assert.ok(!out.additionalContext.includes('argument-hint'));
  }
  assert.equal(runCopilot('sessionStart', project()), null);
  const boundary = project('Gemfile');
  fs.mkdirSync(path.join(boundary, 'other/.git'), { recursive: true });
  assert.equal(runCopilot('sessionStart', path.join(boundary, 'other')), null);
});

test('Copilot mode commands share state and preserve the transformed prompt', () => {
  const cwd = project('Gemfile');
  const transformedPrompt = 'The original prompt, expanded by Copilot.\n"quotes" and \\slashes.';
  const command = (text, directory = cwd) => runCopilot('userPromptTransformed', directory, { prompt: text, transformedPrompt });
  const off = command('/posh off');
  assert.match(off.modifiedTransformedPrompt, /POSH is now off/);
  assert.ok(off.modifiedTransformedPrompt.endsWith(transformedPrompt));
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
  assert.equal(runCopilot('sessionStart', cwd), null);
  assert.equal(runHook('SessionStart', cwd), null);
  const other = project();
  assert.match(command('/posh feedback', other).modifiedTransformedPrompt, /POSH feedback mode is now on/);
  assert.ok(runCopilot('sessionStart', other).additionalContext.includes(FEEDBACK));
  assert.ok(runHook('SessionStart', other).additionalContext.includes(FEEDBACK));
  const on = command('/posh');
  assert.match(on.modifiedTransformedPrompt, /Stop adding the POSH feedback section/);
  assert.ok(!on.modifiedTransformedPrompt.includes(FEEDBACK));
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'on');
  assert.match(command('/posh auto', other).modifiedTransformedPrompt, /This is not one/);
  assert.equal(fs.existsSync(modeFile), false);
  assert.equal(runCopilot('sessionStart', other), null);
});

test('Copilot leaves ordinary prompts untouched and does not evaluate command arguments', () => {
  const cwd = project('Gemfile');
  for (const prompt of ['fix the app', 'please /posh off', '/posh how does has_many work', '/posh $(touch pwned)']) {
    assert.equal(runCopilot('userPromptTransformed', cwd, { prompt, transformedPrompt: prompt }), null);
    assert.equal(fs.existsSync(modeFile), false);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
  assert.equal(runCopilot('userPromptTransformed', cwd, { prompt: '/posh off' }), null);
  assert.equal(fs.existsSync(modeFile), false);
});

test('Copilot maps native lookup tools and both argument encodings to the shared policy', () => {
  const cwd = project('Gemfile.lock');
  for (const [toolName, args] of [
    ['view', { path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` }],
    ['grep', { path: 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib', pattern: 'registry' }],
    ['rg', { path: 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib', pattern: 'registry' }],
    ['glob', { pattern: '**/vendor/bundle/**/gems/kamal-2.12.0/lib/**/*.rb' }],
    ['bash', { command: 'bundle show kamal' }],
    ['web_fetch', { url: 'https://rubydoc.info/gems/kamal/Kamal' }],
  ]) {
    for (const toolArgs of [args, JSON.stringify(args)]) {
      const out = runCopilot('preToolUse', cwd, { toolName, toolArgs }, { POSH_HOOK_DECISION: 'ask' });
      assert.equal(out.permissionDecision, 'deny');
      assert.deepEqual(Object.keys(out), ['permissionDecision', 'permissionDecisionReason']);
      assert.match(out.permissionDecisionReason, /gem:kamal 2\.12\.0/);
      assert.ok(out.permissionDecisionReason.includes(`"project":${JSON.stringify(cwd)}`));
    }
  }
});

test('Copilot retries are per project and session and use its plugin data directory', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'copilot-retries-'));
  const call = (cwd, sessionId) => runCopilot('preToolUse', cwd, {
    sessionId, toolName: 'bash', toolArgs: { command: 'bundle show kamal' },
  }, { COPILOT_PLUGIN_DATA: data });
  for (const cwd of [project('Gemfile.lock'), project('Gemfile.lock')]) {
    for (const session of ['one', 'two']) {
      assert.equal(call(cwd, session).permissionDecision, 'deny');
      assert.equal(call(cwd, session), null);
    }
  }
  const markers = fs.readdirSync(path.join(data, 'nudged'));
  assert.equal(markers.length, 4);
  assert.ok(markers.every((marker) => marker.startsWith('copilot-')));
});

test('Copilot ignores ordinary tools, malformed payloads and unsafe session IDs', () => {
  const cwd = project('Gemfile');
  for (const input of [
    'not json', 'null', '[]',
    { toolName: 'bash', toolArgs: 'not json' },
    { toolName: 'bash', toolArgs: null },
    { toolName: 'view', toolArgs: { file_path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` } },
    { toolName: 'edit', toolArgs: { path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` } },
    { toolName: 'bash', toolArgs: { command: 'echo bundle show kamal' } },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: null },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: '' },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: '../../escape' },
  ]) assert.equal(runCopilot('preToolUse', cwd, input), null);
});

test('Copilot honors off, exact project matching, missing POSH and unwritable state', () => {
  const cwd = project('Gemfile.lock');
  const input = { toolName: 'bash', toolArgs: { command: 'bundle show kamal' } };
  const bin = fs.mkdtempSync(path.join(tmp, 'copilot-no-posh-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const env of [
    { FAKE_POSH_PROJECT_JSON: JSON.stringify(project('Gemfile.lock')) },
    { FAKE_POSH_RESPONSE: 'not json' },
    { PATH: `${bin}:/usr/bin:/bin` },
    { COPILOT_PLUGIN_DATA: path.join(cwd, 'Gemfile.lock/cannot-write') },
  ]) assert.equal(runCopilot('preToolUse', cwd, input, env), null);
  runHook('UserPromptSubmit', cwd, prompt('/posh off'));
  assert.equal(runCopilot('preToolUse', cwd, input), null);
  assert.equal(runCopilot('preToolUse', project(), input), null);
});

test('Copilot launcher exits successfully when Node is missing or crashes', () => {
  const cwd = project('Gemfile');
  const bin = fs.mkdtempSync(path.join(tmp, 'copilot-launcher-'));
  for (const name of ['sh', 'dirname']) {
    fs.symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), path.join(bin, name));
  }
  assert.equal(runCopilot('sessionStart', cwd, {}, { PATH: bin }), null);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(runCopilot('preToolUse', cwd, {}, { PATH: bin }), null);
});

test('Copilot lifecycle runs directly in Node without shell helpers or POSH on PATH', () => {
  const cwd = project('Gemfile');
  for (const event of ['SessionStart', 'SubagentStart', 'UserPromptSubmit']) {
    const out = JSON.parse(execFileSync(process.execPath, [path.join(repo, 'hooks/posh-copilot-hook.mjs'), event], {
      env: { ...process.env, PATH: '' }, encoding: 'utf8',
      input: JSON.stringify({ cwd, prompt: '/posh feedback', transformedPrompt: 'original' }),
    }));
    const text = out.additionalContext ?? out.modifiedTransformedPrompt;
    assert.ok(text.includes(MARKER));
    assert.match(text, /posh command is not on PATH/);
    if (event === 'UserPromptSubmit') assert.ok(text.includes(FEEDBACK));
  }
});

test('Copilot parses decoded command whitespace and ignores nested prompt keys', () => {
  const cwd = project('Gemfile');
  const out = runCopilot('userPromptTransformed', cwd, {
    prompt: '/posh\toff\n', transformedPrompt: 'original', metadata: { prompt: '/posh on' },
  });
  assert.match(out.modifiedTransformedPrompt, /POSH is now off/);
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
});

test('Copilot rejects unusable lifecycle input before changing shared mode', () => {
  const cwd = project('Gemfile');
  for (const input of [
    { cwd: 'relative' }, { cwd: path.join(cwd, 'missing') },
    { cwd: path.join(cwd, 'Gemfile') }, { transformedPrompt: null },
  ]) {
    assert.equal(runCopilot('userPromptTransformed', cwd, {
      prompt: '/posh off', transformedPrompt: 'original', ...input,
    }), null);
    assert.equal(fs.existsSync(modeFile), false);
  }
});
