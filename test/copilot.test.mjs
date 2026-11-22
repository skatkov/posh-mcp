import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, vi } from 'vitest';
import { repo, tmp, modeFile, MARKER, FEEDBACK, project, runHook, poshBin, gemDir, prompt } from './support/plugin-fixture.mjs';

const copilotManifest = JSON.parse(fs.readFileSync(path.join(repo, '.github/plugin/plugin.json'), 'utf8'));
const copilotHooks = JSON.parse(fs.readFileSync(path.join(repo, copilotManifest.hooks), 'utf8')).hooks;
function runCopilotProcess(event, cwd, input = {}, extraEnv = {}) {
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

async function runCopilot(event, cwd, input = {}, extraEnv = {}, readModeFile) {
  vi.resetModules();
  const events = {
    sessionStart: 'SessionStart', subagentStart: 'SubagentStart',
    userPromptTransformed: 'UserPromptSubmit', preToolUse: 'PreToolUse',
  };
  for (const [key, value] of Object.entries({
    CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined,
    COPILOT_PLUGIN_DATA: fs.mkdtempSync(path.join(tmp, 'copilot-direct-')),
    PATH: `${poshBin}:${process.env.PATH}`, FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd), ...extraEnv,
  })) vi.stubEnv(key, value);
  const stdin = typeof input === 'string' ? input : JSON.stringify({ sessionId: 'native', cwd, ...input });
  const readFile = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (file === 0) return Buffer.from(stdin);
    if (file === modeFile && readModeFile) return readModeFile();
    return readFile(file, ...args);
  });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('hook exit'); });
  const argv = process.argv;
  process.argv = [argv[0], path.join(repo, 'hooks/posh-copilot-hook.mjs'), events[event] ?? event];
  try {
    await import('../hooks/posh-copilot-hook.mjs');
    for (const args of exit.mock.calls) assert.deepEqual(args, [0]);
    assert.ok(output.mock.calls.length <= 1);
    return output.mock.calls.length ? JSON.parse(output.mock.calls[0][0]) : null;
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
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
    const out = runCopilotProcess(event, sub, {}, { CLAUDE_PROJECT_DIR: project(), COPILOT_PLUGIN_ROOT: pluginPath });
    assert.deepEqual(Object.keys(out), ['additionalContext']);
    assert.ok(out.additionalContext.includes(MARKER));
    assert.ok(out.additionalContext.includes(JSON.stringify({ project: cwd })));
    assert.ok(out.additionalContext.includes('every MCP tool call'));
    assert.ok(!out.additionalContext.includes('argument-hint'));
  }
  const other = project();
  const unscoped = runCopilotProcess('sessionStart', other).additionalContext;
  assert.ok(unscoped.includes(MARKER));
  assert.match(unscoped, /POSH is enabled, but no Ruby project was found/);
  assert.ok(!unscoped.includes(FEEDBACK));
  assert.equal(fs.existsSync(modeFile), false);
  const boundary = project('Gemfile');
  fs.mkdirSync(path.join(boundary, 'other/.git'), { recursive: true });
  assert.match(runCopilotProcess('sessionStart', path.join(boundary, 'other')).additionalContext, /no Ruby project was found/);
});

test('Copilot mode commands share state and preserve the transformed prompt', async () => {
  const cwd = project('Gemfile');
  const transformedPrompt = 'The original prompt, expanded by Copilot.\n"quotes" and \\slashes.';
  const command = (text, directory = cwd) => runCopilot('userPromptTransformed', directory, { prompt: text, transformedPrompt });
  const off = await command('/posh off');
  assert.match(off.modifiedTransformedPrompt, /POSH is now off/);
  assert.match(off.modifiedTransformedPrompt, /Confirm in one short line\.\n\nFor this prompt/);
  assert.ok(off.modifiedTransformedPrompt.endsWith(transformedPrompt));
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
  assert.equal(await runCopilot('sessionStart', cwd), null);
  assert.equal(runHook('SessionStart', cwd), null);
  const retired = (await command('/posh auto')).modifiedTransformedPrompt;
  assert.match(retired, /auto mode was removed/);
  assert.ok(!retired.includes(MARKER));
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  const other = project();
  assert.match((await command('/posh feedback', other)).modifiedTransformedPrompt, /POSH feedback mode is now on/);
  assert.ok((await runCopilot('sessionStart', other)).additionalContext.includes(FEEDBACK));
  assert.ok(runHook('SessionStart', other).additionalContext.includes(FEEDBACK));
  const on = await command('/posh');
  assert.match(on.modifiedTransformedPrompt, /Stop adding the POSH feedback section/);
  assert.match(on.modifiedTransformedPrompt, /Confirm in one short line\.\n\n# POSH:/);
  assert.ok(!on.modifiedTransformedPrompt.includes(FEEDBACK));
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'on');
});

test('Copilot renders guidance and project context from one mode per response', async () => {
  const cwd = project('Gemfile');
  let reads = 0;
  const changingMode = () => ++reads === 1 ? 'feedback\n' : 'off\n';
  const { additionalContext } = await runCopilot('sessionStart', cwd, {}, {}, changingMode);
  assert.ok(additionalContext.includes(FEEDBACK));
  assert.match(additionalContext, /POSH is active for this Ruby project/);
  assert.equal(reads, 1);

  const prompt = '/posh feedback';
  const { modifiedTransformedPrompt } = await runCopilot('userPromptTransformed', cwd, {
    prompt, transformedPrompt: prompt,
  }, {}, changingMode);
  assert.ok(modifiedTransformedPrompt.includes(FEEDBACK));
  assert.match(modifiedTransformedPrompt, /POSH is active for this Ruby project/);
  assert.equal(reads, 1, 'a successful mode command renders from the mode it saved');
});

test('Copilot reports failed mode commands without confirming or injecting the requested mode', async ({ onTestFinished }) => {
  const cwd = project('Gemfile');
  fs.mkdirSync(modeFile, { recursive: true });
  onTestFinished(() => fs.rmdirSync(modeFile));
  const { modifiedTransformedPrompt } = await runCopilot('userPromptTransformed', cwd, {
    prompt: '/posh feedback', transformedPrompt: 'original prompt',
  });
  assert.match(modifiedTransformedPrompt, /Could not save the POSH mode/);
  assert.ok(modifiedTransformedPrompt.endsWith('original prompt'));
  assert.ok(!modifiedTransformedPrompt.includes(MARKER));
  assert.doesNotMatch(modifiedTransformedPrompt, /feedback mode is now on|Include POSH feedback/);
});

test('Copilot scopes ordinary prompts without changing mode or evaluating command arguments', async () => {
  const cwd = project('Gemfile');
  for (const prompt of ['fix the app', 'please /posh off', '/posh how does has_many work', '/posh $(touch pwned)']) {
    const text = (await runCopilot('userPromptTransformed', cwd, { prompt, transformedPrompt: prompt })).modifiedTransformedPrompt;
    assert.ok(text.includes(JSON.stringify({ project: cwd })));
    assert.ok(text.endsWith(`\n\n${prompt}`));
    assert.ok(!text.includes(MARKER));
    assert.equal(fs.existsSync(modeFile), false);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
  assert.equal(await runCopilot('userPromptTransformed', cwd, { prompt: '/posh off' }), null);
  assert.equal(fs.existsSync(modeFile), false);
});

test('Copilot maps native lookup tools and both argument encodings to the shared policy', async () => {
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
      const out = await runCopilot('preToolUse', cwd, { toolName, toolArgs }, { POSH_HOOK_DECISION: 'ask' });
      assert.equal(out.permissionDecision, 'deny');
      assert.deepEqual(Object.keys(out), ['permissionDecision', 'permissionDecisionReason']);
      assert.match(out.permissionDecisionReason, /gem:kamal 2\.12\.0/);
      assert.ok(out.permissionDecisionReason.includes(`"project":${JSON.stringify(cwd)}`));
    }
  }
});

test('Copilot retries are per project and session and use its plugin data directory', async () => {
  const data = fs.mkdtempSync(path.join(tmp, 'copilot-retries-'));
  const call = (cwd, sessionId) => runCopilot('preToolUse', cwd, {
    sessionId, toolName: 'bash', toolArgs: { command: 'bundle show kamal' },
  }, { COPILOT_PLUGIN_DATA: data });
  for (const cwd of [project('Gemfile.lock'), project('Gemfile.lock')]) {
    for (const session of ['one', 'two']) {
      assert.equal((await call(cwd, session)).permissionDecision, 'deny');
      assert.equal(await call(cwd, session), null);
    }
  }
  const markers = fs.readdirSync(path.join(data, 'nudged'));
  assert.equal(markers.length, 4);
  assert.ok(markers.every((marker) => marker.startsWith('copilot-')));
});

test('Copilot ignores ordinary tools, malformed payloads and unsafe session IDs', async () => {
  const cwd = project('Gemfile');
  for (const input of [
    'not json', 'null', '[]',
    { toolName: 'bash', toolArgs: 'not json' },
    { toolName: 'bash', toolArgs: null },
    { toolName: 'view', toolArgs: { file_path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` } },
    { toolName: 'edit', toolArgs: { path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` } },
    { toolName: 'bash', toolArgs: { command: 'echo bundle show kamal' } },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: null },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: 42 },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: {} },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: '' },
    { toolName: 'bash', toolArgs: { command: 'bundle show kamal' }, sessionId: '../../escape' },
  ]) assert.equal(await runCopilot('preToolUse', cwd, input), null);
});

test('Copilot honors off, exact project matching, missing POSH and unwritable state', async () => {
  const cwd = project('Gemfile.lock');
  const input = { toolName: 'bash', toolArgs: { command: 'bundle show kamal' } };
  const bin = fs.mkdtempSync(path.join(tmp, 'copilot-no-posh-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const env of [
    { FAKE_POSH_PROJECT_JSON: JSON.stringify(project('Gemfile.lock')) },
    { FAKE_POSH_RESPONSE: 'not json' },
    { PATH: `${bin}:/usr/bin:/bin` },
    { COPILOT_PLUGIN_DATA: path.join(cwd, 'Gemfile.lock/cannot-write') },
  ]) assert.equal(await runCopilot('preToolUse', cwd, input, env), null);
  runHook('UserPromptSubmit', cwd, prompt('/posh off'));
  assert.equal(await runCopilot('preToolUse', cwd, input), null);
  assert.equal(await runCopilot('preToolUse', project(), input), null);
});

test('Copilot launcher exits successfully when Node is missing or crashes', () => {
  const cwd = project('Gemfile');
  const bin = fs.mkdtempSync(path.join(tmp, 'copilot-launcher-'));
  for (const name of ['sh', 'dirname']) {
    fs.symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), path.join(bin, name));
  }
  assert.equal(runCopilotProcess('sessionStart', cwd, {}, { PATH: bin }), null);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(runCopilotProcess('preToolUse', cwd, {}, { PATH: bin }), null);
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

test('Copilot parses decoded command whitespace and ignores nested prompt keys', async () => {
  const cwd = project('Gemfile');
  const out = await runCopilot('userPromptTransformed', cwd, {
    prompt: '/posh\toff\n', transformedPrompt: 'original', metadata: { prompt: '/posh on' },
  });
  assert.match(out.modifiedTransformedPrompt, /POSH is now off/);
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
});

test('Copilot rejects unusable lifecycle input before changing shared mode', async () => {
  const cwd = project('Gemfile');
  for (const input of [
    { cwd: path.relative(repo, cwd) }, { cwd: path.join(cwd, 'missing') },
    { cwd: path.join(cwd, 'Gemfile') }, { transformedPrompt: null },
    { prompt: null }, { prompt: 42 }, { prompt: {} }, { cwd: 42 },
  ]) {
    assert.equal(await runCopilot('userPromptTransformed', cwd, {
      prompt: '/posh off', transformedPrompt: 'original', ...input,
    }), null);
    assert.equal(fs.existsSync(modeFile), false);
  }
});

test('Copilot refreshes project guidance on ordinary prompts without a new session start', async () => {
  const original = project('Gemfile', '.git');
  const moved = project('Gemfile.lock', '.git');
  const nested = path.join(moved, 'app/models');
  fs.mkdirSync(nested, { recursive: true });
  assert.ok((await runCopilot('sessionStart', original)).additionalContext.includes(JSON.stringify({ project: original })));
  const transformedPrompt = 'Keep this expanded prompt unchanged.\n"quotes" and \\slashes.';
  for (const cwd of [moved, nested]) {
    const text = (await runCopilot('userPromptTransformed', cwd, { prompt: 'fix this app', transformedPrompt })).modifiedTransformedPrompt;
    assert.ok(text.includes(JSON.stringify({ project: moved })));
    assert.ok(!text.includes(original));
    assert.match(text, /discard all earlier POSH project-path instructions/);
    assert.ok(text.endsWith(`\n\n${transformedPrompt}`));
    assert.ok(!text.includes(MARKER), 'ordinary prompts need only the short project directive');
  }
  assert.equal(fs.existsSync(modeFile), false);
});

test('Copilot never reuses a previous project in forced-on or off mode', async () => {
  const ruby = project('Gemfile');
  const other = project('.git');
  const command = (prompt) => runCopilot('userPromptTransformed', ruby, { prompt, transformedPrompt: prompt });
  await command('/posh on');
  const input = { prompt: 'continue', transformedPrompt: 'continue' };
  const unscoped = (await runCopilot('userPromptTransformed', other, input)).modifiedTransformedPrompt;
  assert.match(unscoped, /POSH is enabled, but no Ruby project was found/);
  assert.match(unscoped, /Locate the intended Ruby project/);
  assert.ok(!unscoped.includes(ruby));
  await command('/posh off');
  const off = (await runCopilot('userPromptTransformed', ruby, input)).modifiedTransformedPrompt;
  assert.match(off, /POSH is off/);
  assert.match(off, /discard all earlier POSH project-path instructions/);
  assert.ok(!off.includes(JSON.stringify({ project: ruby })));
});

test('Copilot command aliases change mode, and only feedback mode adds the short feedback directive', async () => {
  const cwd = project('Gemfile');
  for (const alias of ['/posh', '/posh:posh', '$posh', '$posh:posh', '@posh']) {
    const prompt = `${alias} feedback`;
    const out = await runCopilot('userPromptTransformed', cwd, { prompt, transformedPrompt: prompt });
    assert.equal(fs.readFileSync(modeFile, 'utf8'), 'feedback\n');
    assert.match(out.modifiedTransformedPrompt, /Include POSH feedback after meaningful POSH use\./);
    const ordinary = await runCopilot('userPromptTransformed', cwd, { prompt: 'continue', transformedPrompt: 'continue' });
    assert.match(ordinary.modifiedTransformedPrompt, /Include POSH feedback after meaningful POSH use\./);
    runHook('UserPromptSubmit', cwd, JSON.stringify({ prompt: '/posh on' }));
    const on = await runCopilot('userPromptTransformed', cwd, { prompt: 'continue', transformedPrompt: 'continue' });
    assert.doesNotMatch(on.modifiedTransformedPrompt, /Include POSH feedback/);
    assert.ok(on.modifiedTransformedPrompt.endsWith("Do not use the MCP server's default project.\n\ncontinue"));
  }
});

test('Copilot trims leading command whitespace and groups repeated separators', async () => {
  const cwd = project('Gemfile');
  for (const prompt of ['  /posh   off  ', '\t/posh\t\toff\n']) {
    runHook('UserPromptSubmit', cwd, JSON.stringify({ prompt: '/posh on' }));
    const out = await runCopilot('userPromptTransformed', cwd, { prompt, transformedPrompt: prompt });
    assert.match(out.modifiedTransformedPrompt, /POSH is now off/);
    assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  }
});

test('Copilot ignores unsupported lifecycle event names', async () => {
  assert.equal(await runCopilot('SessionEnd', project('Gemfile')), null);
  const out = execFileSync(process.execPath, [path.join(repo, 'hooks/posh-copilot-hook.mjs'), 'SessionEnd'], {
    env: { ...process.env }, encoding: 'utf8',
    input: JSON.stringify({ cwd: project('Gemfile') }),
  });
  assert.equal(out, '');
});

test('Copilot manifest launchers and direct adapters return the same native responses', async () => {
  const cwd = project('Gemfile.lock');
  for (const [event, input] of [
    ['sessionStart', {}], ['subagentStart', {}],
    ['userPromptTransformed', { prompt: 'continue', transformedPrompt: 'continue' }],
    ['preToolUse', { toolName: 'bash', toolArgs: { command: 'bundle show kamal' } }],
  ]) {
    assert.deepEqual(await runCopilot(event, cwd, input), runCopilotProcess(event, cwd, input));
  }
});
