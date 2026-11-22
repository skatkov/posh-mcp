// Runs the Claude/Codex hook and the OpenCode plugin against the same scenarios.
// Vitest's forks pool isolates this file's environment from the other suites.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, test, vi } from 'vitest';
import { Error as ToolError } from '@opencode/plugin/promise/tool';
import { poshRedirect } from '../shared/lookup-policy.mjs';
import { repo, hook, tmp, modeFile, MARKER, FEEDBACK, project, runHook, poshBin, gemDir, prompt } from './support/plugin-fixture.mjs';

// A fresh marker directory per call, unless a test passes one to reuse across calls.
const toolUse = (cwd, tool_input, { session = 's', tool = 'Read', data, env = {} } = {}) =>
  runHook('PreToolUse', cwd, JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input }), {
    PATH: `${poshBin}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: data ?? fs.mkdtempSync(path.join(tmp, 'data-')),
    FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd),
    ...env,
  });

let plugin;
beforeAll(async () => {
  plugin = (await import(path.join(repo, 'opencode/posh.mjs'))).default;
});

async function setupOpenCode(directory, servers = {}, implementation = plugin) {
  const state = { hooks: {}, sent: [], requested: [], directory };
  const editor = { get: (n) => servers[n], set: (n, c) => { servers[n] = c; } };
  await implementation.setup({
    location: { directory },
    mcp: { transform: (fn) => fn(editor) },
    command: { transform: (fn) => fn({ add: (c) => { state.command = c; } }) },
    session: {
      get: async (input) => {
        state.requested.push(input);
        if (state.sessionError) throw new Error('session unavailable');
        return { location: { directory: state.directory } };
      },
      hook: (name, fn) => { state.hooks[name] = fn; },
      prompt: (input) => { state.sent.push(input); },
    },
    tool: { hook: (name, fn) => { state.hooks[name] = fn; } },
  });
  state.system = async (kind = 'context') => {
    const event = { sessionID: 's', system: [] };
    await state.hooks[kind](event);
    for (const part of event.system) assert.equal(part.type, 'text');
    return event.system.map((part) => part.text).join('\n');
  };
  state.run = (text) => state.command.execute({ sessionID: 's', prompt: { text }, delivery: 'steer' });
  state.servers = servers;
  return state;
}

async function pluginFixture(skill) {
  const root = fs.mkdtempSync(path.join(tmp, 'plugin-'));
  fs.mkdirSync(path.join(root, 'opencode'));
  fs.mkdirSync(path.join(root, 'skills/posh'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'opencode/posh.mjs'), path.join(root, 'opencode/posh.mjs'));
  fs.writeFileSync(path.join(root, 'skills/posh/SKILL.md'), skill);
  fs.copyFileSync(path.join(repo, 'skills/posh/feedback.md'), path.join(root, 'skills/posh/feedback.md'));
  fs.cpSync(path.join(repo, 'shared'), path.join(root, 'shared'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  return (await import(path.join(root, 'opencode/posh.mjs'))).default;
}

async function withPolicyEnv(cwd, { data, env = {} }, run) {
  const overrides = {
    PATH: `${poshBin}:${process.env.PATH}`,
    PLUGIN_DATA: data ?? fs.mkdtempSync(path.join(tmp, 'opencode-data-')),
    FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd),
    ...env,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function openCodeTool(host, cwd, tool, input, { session = 's', ...options } = {}) {
  return withPolicyEnv(cwd, options, async () => {
    try {
      await host.hooks['execute.before']({ tool, input, sessionID: session, messageID: 'm', id: 'call', agent: 'build' });
      return null;
    } catch (error) {
      assert.ok(error instanceof ToolError, `expected a host Tool.Error, got ${error}`);
      return error.message;
    }
  });
}

test('plugin fixtures put fake POSH before host executables', () => {
  assert.equal(process.env.PATH.split(path.delimiter)[0], poshBin);
});

test('injects valid JSON with the ruleset and no frontmatter in a Ruby project', () => {
  const out = runHook('SessionStart', project('Gemfile.lock'));
  assert.equal(out.hookEventName, 'SessionStart');
  assert.ok(out.additionalContext.includes(MARKER));
  assert.ok(out.additionalContext.includes('`has_many`'));
  assert.ok(!out.additionalContext.includes('argument-hint'));
});

test('warns once when the posh command is missing, and stays quiet when it is there', () => {
  const dir = project('Gemfile.lock');
  const real = process.env.PATH;
  // A stub keeps the quiet case independent of whether this machine has POSH installed.
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(bin, 'posh'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    process.env.PATH = '/usr/bin:/bin';
    const missing = runHook('SessionStart', dir).additionalContext;
    assert.match(missing, /posh command is not on PATH/);
    assert.ok(missing.includes(MARKER));
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.doesNotMatch(runHook('SessionStart', dir).additionalContext, /not on PATH/);
  } finally {
    process.env.PATH = real;
  }
});

test('session and subagent hooks supply guidance by default outside Ruby projects', () => {
  const dir = project('package.json');
  for (const event of ['SessionStart', 'SubagentStart']) {
    const out = runHook(event, dir);
    assert.equal(out.hookEventName, event);
    assert.ok(out.additionalContext.includes(MARKER));
    assert.ok(!out.additionalContext.includes(FEEDBACK));
  }
  assert.equal(fs.existsSync(modeFile), false);
});

test('hook commands switch modes and the OpenCode plugin honours the same file', async () => {
  const ruby = project('Gemfile');
  const other = project();
  const hostOnOther = await setupOpenCode(other);

  const off = runHook('UserPromptSubmit', ruby, prompt('/posh off'));
  assert.match(off.additionalContext, /POSH is now off/);
  assert.equal(runHook('SessionStart', ruby), null);
  const hostOnRuby = await setupOpenCode(ruby);
  assert.equal(await hostOnRuby.system(), '');
  const retired = runHook('UserPromptSubmit', other, prompt('/posh auto')).additionalContext;
  assert.match(retired, /auto mode was removed/);
  assert.ok(!retired.includes(MARKER));
  await hostOnOther.run('auto');
  assert.match(hostOnOther.sent.at(-1).text, /auto mode was removed/);
  assert.ok(!hostOnOther.sent.at(-1).text.includes(MARKER));
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');

  const on = runHook('UserPromptSubmit', other, prompt('$posh:posh'));
  assert.ok(on.additionalContext.includes(MARKER));
  assert.ok(runHook('SessionStart', other));
  assert.ok((await hostOnOther.system()).includes(MARKER));
});

test('feedback mode adds the evaluation rules on top of on, everywhere, in both hosts', async () => {
  const other = project();
  const host = await setupOpenCode(other);

  const switched = runHook('UserPromptSubmit', other, prompt('/posh feedback'));
  assert.match(switched.additionalContext, /POSH feedback mode is now on/);
  for (const text of [switched.additionalContext, runHook('SessionStart', other).additionalContext, await host.system(), await host.system('compaction')]) {
    assert.ok(text.includes(MARKER));
    assert.ok(text.includes(FEEDBACK));
  }

  const on = runHook('UserPromptSubmit', other, prompt('/posh on'));
  assert.match(on.additionalContext, /Stop adding the POSH feedback section/);
  assert.ok(!on.additionalContext.includes(FEEDBACK));
  assert.ok(!runHook('SessionStart', other).additionalContext.includes(FEEDBACK));
  assert.ok(!(await host.system()).includes(FEEDBACK));
  assert.doesNotMatch(runHook('UserPromptSubmit', other, prompt('/posh on')).additionalContext, /Stop adding/);
});

test('OpenCode /posh feedback persists the mode', async () => {
  const host = await setupOpenCode(project());
  await host.run('on');
  const ruleset = await host.system();
  await host.run('feedback');
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'feedback\n');
  assert.match(host.sent.at(-1).text, /POSH feedback mode is now on/);
  const text = await host.system();
  assert.ok(text.includes(FEEDBACK));
  assert.equal(text, text.trim());
  assert.equal(text, ruleset + '\n\n' + fs.readFileSync(path.join(repo, 'skills/posh/feedback.md'), 'utf8').trim());
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

test('OpenCode adds the ruleset by default on model and compaction requests outside Ruby projects', async () => {
  const host = await setupOpenCode(project('package.json'));
  for (const kind of ['context', 'compaction']) {
    const text = await host.system(kind);
    assert.ok(text.startsWith(`# ${MARKER}`));
    assert.equal(text, text.trim());
    assert.doesNotMatch(text, /argument-hint:/);
  }
  assert.deepEqual(host.requested, []);
});

test('OpenCode guidance does not depend on session lookup', async () => {
  const host = await setupOpenCode(project('.git'));
  host.sessionError = true;
  for (const mode of ['on', 'feedback', 'off']) {
    await host.run(mode);
    for (const kind of ['context', 'compaction']) {
      const text = await host.system(kind);
      if (mode === 'off') assert.equal(text, '');
      else {
        assert.ok(text.includes(MARKER));
        assert.equal(text.includes(FEEDBACK), mode === 'feedback');
      }
    }
  }
  assert.deepEqual(host.requested, []);
});

test('OpenCode off leaves existing context parts unchanged', async () => {
  const host = await setupOpenCode(project('Gemfile'));
  await host.run('off');
  for (const kind of ['context', 'compaction']) {
    const system = [{ type: 'text', text: 'Existing project instructions.' }];
    await host.hooks[kind]({ sessionID: 's', system });
    assert.deepEqual(system, [{ type: 'text', text: 'Existing project instructions.' }]);
  }
});

test('OpenCode strips leading frontmatter with LF or CRLF but preserves body separators', async () => {
  const body = '# Guidance\n\n---\nbody: keep this\n---\n\nKeep the body.';
  const crlf = body.replaceAll('\n', '\r\n');
  for (const [skill, expected] of [
    [`---\nname: posh\n---\n\n${body}\n`, body],
    [`---\r\nname: posh\r\n---\r\n\r\n${crlf}\r\n`, crlf],
    [body, body],
  ]) {
    const implementation = await pluginFixture(skill);
    const host = await setupOpenCode(project('Gemfile'), {}, implementation);
    assert.equal(await host.system(), expected);
  }
});

test('OpenCode uses the default HOME config path when XDG_CONFIG_HOME is absent', async () => {
  const cwd = project('Gemfile');
  const home = fs.mkdtempSync(path.join(tmp, 'default-home-'));
  const mode = path.join(home, '.config/posh/agent-mode');
  fs.mkdirSync(path.dirname(mode), { recursive: true });
  fs.writeFileSync(mode, 'off\n');
  await withPolicyEnv(cwd, { env: { HOME: home, XDG_CONFIG_HOME: undefined } }, async () => {
    const implementation = await pluginFixture(fs.readFileSync(path.join(repo, 'skills/posh/SKILL.md'), 'utf8'));
    const host = await setupOpenCode(cwd, {}, implementation);
    assert.equal(await host.system(), '');
    await host.run('on');
    assert.equal(fs.readFileSync(mode, 'utf8'), 'on\n');
    assert.ok((await host.system()).includes(MARKER));
  });
});

test('OpenCode registers the MCP server but keeps a user-configured one', async () => {
  const host = await setupOpenCode(project());
  assert.deepEqual(host.servers.posh, { type: 'local', command: ['posh', 'mcp'] });
  assert.equal(host.command.name, 'posh');
  assert.match(host.command.description, /on, off, feedback/);
  const mine = { type: 'local', command: ['/opt/posh', 'mcp'] };
  assert.equal((await setupOpenCode(project(), { posh: mine })).servers.posh, mine);
});

test('OpenCode /posh persists the mode before the turn and passes other text through', async () => {
  const host = await setupOpenCode(project());
  await host.run('off');
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  assert.match(host.sent.at(-1).text, /POSH is now off/);
  await host.run('');
  assert.ok((await host.system()).includes(MARKER));
  await host.run('how does has_many work');
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'on\n');
  assert.ok(host.sent.at(-1).text.endsWith('how does has_many work'));
  assert.ok(host.sent.at(-1).text.includes(MARKER));
});

test('OpenCode reports a failed mode save without confirming the change', async ({ onTestFinished }) => {
  const host = await setupOpenCode(project());
  fs.mkdirSync(modeFile, { recursive: true });
  onTestFinished(() => fs.rmdirSync(modeFile));
  await host.run('off');
  const { text } = host.sent.at(-1);
  assert.match(text, /Could not save the POSH mode/);
  assert.doesNotMatch(text, /POSH is now off|# POSH:/);
});

test('OpenCode trims mode commands and defaults to on for unknown saved values', async () => {
  const host = await setupOpenCode(project());
  await host.run('  off \n');
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'off');
  fs.writeFileSync(modeFile, 'unknown-mode\n');
  assert.ok((await host.system()).includes(MARKER));
});

test('OpenCode preserves command attachments and delivery but removes stale mention offsets', async () => {
  const host = await setupOpenCode(project('Gemfile'));
  const file = { uri: 'file:///project/model.rb', name: 'model.rb', description: 'Review this file', source: { type: 'uri', uri: 'file:///project/model.rb' } };
  const prompt = {
    text: '  @review @posh model.rb  ',
    files: [{ ...file, mention: { start: 16, end: 24, text: 'model.rb' } }, { uri: 'file:///project/other.rb' }],
    agents: [{ name: 'review', mention: { start: 2, end: 9, text: '@review' } }],
    skills: [{ id: 'posh', mention: { start: 10, end: 15, text: '@posh' } }],
  };
  const original = structuredClone(prompt);
  await host.command.execute({ sessionID: 'attachments', prompt, delivery: 'queue' });
  const { text, ...sent } = host.sent.at(-1);
  assert.ok(text.endsWith('\n\n@review @posh model.rb'));
  assert.deepEqual(sent, {
    sessionID: 'attachments', delivery: 'queue',
    files: [file, { uri: 'file:///project/other.rb' }],
    agents: [{ name: 'review' }],
    skills: [{ id: 'posh' }],
  });
  assert.deepEqual(prompt, original);
});

test('the module has only a default export (OpenCode treats exported functions as plugins)', async () => {
  const mod = await import(path.join(repo, 'opencode/posh.mjs'));
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(mod.default.id, 'posh');
});

// --- PreToolUse: the gem documentation routes -------------------------------

test('denies installed gem source and names the POSH call to make instead', () => {
  const dir = project('Gemfile.lock');
  const out = toolUse(dir, { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record/relation.rb` });
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /gem:activerecord 8\.1\.4\.1/);
  assert.match(out.permissionDecisionReason, /"ref":"gem:activerecord"/);
  assert.match(out.permissionDecisionReason, /posh search '<symbol>' --ref gem:activerecord/);
});

test('redirects once per gem per session, so a second attempt proceeds', () => {
  const dir = project('Gemfile.lock');
  const data = fs.mkdtempSync(path.join(tmp, 'data-'));
  const call = (session) => toolUse(dir, { file_path: `${gemDir('geneva_drive', '0.7.0')}/lib/geneva_drive/executor.rb` }, { session, data });
  assert.equal(call('s1').permissionDecision, 'deny');
  assert.equal(call('s1'), null);
  assert.equal(call('s2').permissionDecision, 'deny');
  assert.equal(toolUse(dir, { command: 'bundle show kamal' }, { tool: 'Bash', session: 's1', data }).permissionDecision, 'deny');
});

test('moving one session to another Ruby project gets its own redirect', () => {
  const data = fs.mkdtempSync(path.join(tmp, 'data-'));
  for (const cwd of [project('Gemfile.lock'), project('Gemfile.lock')]) {
    const call = () => toolUse(cwd, { command: 'bundle show kamal' }, { tool: 'Bash', data });
    assert.equal(call().permissionDecision, 'deny');
    assert.equal(call(), null);
  }
});

test('shared policy returns a harness-neutral reason from normalized input, independent of process cwd', async () => {
  const cwd = project('Gemfile.lock');
  const payload = JSON.stringify({ cwd, session_id: 'neutral', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } });
  assert.notEqual(process.cwd(), cwd);
  const reason = await withPolicyEnv(cwd, {}, () => poshRedirect(JSON.parse(payload)));
  assert.match(reason, /gem:kamal/);
});

test('shared policy rejects non-object payloads and non-string session and directory values', async () => {
  const cwd = project('Gemfile.lock');
  const valid = { cwd, session_id: 'types', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  for (const input of [
    Object.assign([], valid), Object.assign(() => {}, valid),
    { ...valid, tool_input: Object.assign([], valid.tool_input) },
    { ...valid, tool_input: Object.assign(() => {}, valid.tool_input) },
    { ...valid, session_id: 17 }, { ...valid, cwd: Buffer.from(cwd) },
  ]) assert.equal(await withPolicyEnv(cwd, {}, () => poshRedirect(input)), null);
});

test('non-Ruby projects do not inspect tool-specific inputs', async () => {
  const cwd = project('package.json');
  let reads = 0;
  const tool_input = { get file_path() { reads++; return gemDir('kamal', '2.12.0'); } };
  assert.equal(await withPolicyEnv(cwd, {}, () => poshRedirect({
    cwd, session_id: 'not-ruby', tool_name: 'Read', tool_input,
  })), null);
  assert.equal(reads, 0);
});

test('POSH discovery filters the requested gem and is not repeated for a retry', async () => {
  const cwd = project('Gemfile.lock');
  const data = fs.mkdtempSync(path.join(tmp, 'discovery-data-'));
  const calls = path.join(tmp, 'discovery-calls');
  const input = { cwd, session_id: 'discovery', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  await withPolicyEnv(cwd, { data, env: { FAKE_POSH_CALLS: calls } }, async () => {
    assert.match(await poshRedirect(input), /gem:kamal/);
    assert.equal(await poshRedirect(input), null);
  });
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
    'docsets', '--json', '--project', cwd, '--filter', 'gem:kamal',
  ]);
});

test('a timed-out POSH lookup fails open without consuming the retry marker', async () => {
  const cwd = project('Gemfile.lock');
  const data = fs.mkdtempSync(path.join(tmp, 'timeout-data-'));
  const bin = fs.mkdtempSync(path.join(tmp, 'timeout-bin-'));
  const posh = path.join(bin, 'posh');
  fs.writeFileSync(posh, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
  const input = { cwd, session_id: 'timeout', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  const call = () => withPolicyEnv(cwd, { data, env: { PATH: bin } }, () => poshRedirect(input));
  const started = performance.now();
  assert.equal(await call(), null);
  assert.ok(performance.now() - started < 10000, 'a stalled POSH lookup must not wait for the 30-second child to finish');
  assert.deepEqual(fs.readdirSync(data), []);
  fs.copyFileSync(path.join(poshBin, 'posh'), posh);
  assert.match(await call(), /gem:kamal/);
});

test('matches a gem directory with no trailing slash, as `cd <gem dir> && ...` leaves', () => {
  const dir = project('Gemfile.lock');
  const command = `cd ${gemDir('geneva_drive', '0.7.0')} && sed -n '300,400p' lib/geneva_drive/executor.rb`;
  assert.equal(toolUse(dir, { command }, { tool: 'Bash' }).permissionDecision, 'deny');
});

test('takes the gem relative to its installation root, not the ruby version directory', () => {
  const dir = project('Gemfile.lock');
  const out = toolUse(dir, { pattern: 'def perform', path: gemDir('kamal', '2.12.0') }, { tool: 'Grep' });
  assert.match(out.permissionDecisionReason, /gem:kamal 2\.12\.0/);
});

test('does not take the gem name from an ancestor or from files inside the installed gem', () => {
  const dir = project('Gemfile.lock');
  for (const file_path of [
    '/repo/gems/payments-0.1.0/vendor/bundle/ruby/4.0.0/gems/kamal-2.12.0/lib/kamal.rb',
    `${gemDir('geneva_drive', '0.7.0')}/vendor/bundle/ruby/4.0.0/gems/kamal-2.12.0/lib/kamal.rb`,
    `${gemDir('kamal', '2.12.0')}/lib/gems/payments-0.1.0/example.rb`,
  ]) {
    assert.match(toolUse(dir, { file_path }).permissionDecisionReason, /gem:kamal 2\.12\.0/);
  }
});

for (const [name, tool, tool_input] of [
  ['bundle show', 'Bash', { command: 'bundle show kamal' }],
  ['gem contents', 'Bash', { command: 'gem contents kamal | head -30' }],
  ['gem unpack', 'Bash', { command: 'gem unpack kamal --target /tmp' }],
  ['gem which', 'Bash', { command: 'gem which kamal' }],
  ['bundle open', 'Bash', { command: 'bundle open kamal' }],
  ['a .gem download', 'Bash', { command: 'curl -sSLo k.gem https://rubygems.org/downloads/kamal-2.12.0.gem' }],
  ['rubydoc.info', 'WebFetch', { url: 'https://rubydoc.info/gems/kamal/Kamal' }],
  ['a bare gem page', 'WebFetch', { url: 'https://rubygems.org/gems/kamal' }],
  ['vendor/bundle source', 'Read', { file_path: '/app/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb' }],
  ['relative vendored source', 'Grep', { path: 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib', pattern: 'registry' }],
  ['a source glob', 'Glob', { pattern: '**/vendor/bundle/**/gems/kamal-2.12.0/lib/**/*.rb' }],
  ['a quoted source locator', 'Bash', { command: 'bundle show "kamal"' }],
  ['a bundled source locator', 'Bash', { command: 'bundle exec gem contents kamal' }],
  ['a literal-leading source read', 'Bash', { command: "sed -n '1,30p' /app/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb" }],
  ['a raw GitHub URL', 'WebFetch', { url: 'https://raw.githubusercontent.com/basecamp/kamal/v2.12.0/README.md' }],
]) {
  test(`intercepts ${name}`, () => {
    assert.match(toolUse(project('Gemfile.lock'), tool_input, { tool }).permissionDecisionReason, /gem:kamal/);
  });
}

test('maps the Rails documentation sites onto gem:rails', () => {
  const out = toolUse(project('Gemfile.lock'), { url: 'https://guides.rubyonrails.org/active_record_querying.html' }, { tool: 'WebFetch' });
  assert.match(out.permissionDecisionReason, /gem:rails/);
});

test('intercepts gem source on GitHub only when the repository is a locked gem', () => {
  const dir = project('Gemfile.lock');
  const url = (repo) => ({ url: `https://github.com/${repo}/blob/v1.19.7/lib/nokogiri/xml/searchable.rb` });
  assert.match(toolUse(dir, url('sparklemotion/nokogiri'), { tool: 'WebFetch' }).permissionDecisionReason, /gem:nokogiri/);
  assert.equal(toolUse(dir, url('skatkov/posh-mcp'), { tool: 'WebFetch' }), null);
  assert.equal(toolUse(dir, { command: 'gh api repos/skatkov/posh-mcp/contents --jq .[].name' }, { tool: 'Bash' }), null);
});

for (const [name, tool, tool_input] of [
  ['a gem with no local docset', 'Bash', { command: `ls ${gemDir('geneva_drive_admin', '0.6.0')}/lib` }],
  ['a gem that is not in this project', 'Read', { file_path: `${gemDir('sinatra', '4.1.1')}/lib/sinatra.rb` }],
  ['application code', 'Read', { file_path: '/home/x/app/models/library.rb' }],
  ['first-party gem code', 'Read', { file_path: '/repo/gems/payments/lib/payments.rb' }],
  ['first-party gem search', 'Grep', { path: 'gems/payments', pattern: 'def charge' }],
  ['a versioned first-party gem', 'Read', { file_path: '/repo/gems/kamal-2.12.0/lib/kamal.rb' }],
  ['an embedded documentation URL', 'WebFetch', { url: 'https://example.com/?next=https://rubygems.org/gems/kamal' }],
  ['a documentation URL in a fragment', 'WebFetch', { url: 'https://example.com/#https://guides.rubyonrails.org/' }],
  ['a lookalike documentation host', 'WebFetch', { url: 'https://rubygems.org.example.com/gems/kamal' }],
  ['a gem page under an unrelated URL prefix', 'WebFetch', { url: 'https://rubygems.org/other/gems/kamal' }],
  ['a gem download under an unrelated URL prefix', 'WebFetch', { url: 'https://rubygems.org/other/downloads/kamal-2.12.0.gem' }],
  ['a documentation URL in shell output', 'Bash', { command: 'echo https://rubygems.org/gems/kamal' }],
  ['a source locator in shell output', 'Bash', { command: 'echo "bundle show kamal"' }],
  ['an unquoted locator in a documentation edit', 'Bash', { command: 'echo bundle show kamal >> README.md' }],
  ['a fetch command printed as data', 'Bash', { command: 'echo curl https://rubygems.org/gems/kamal' }],
  ['a read command printed as data', 'Bash', { command: `printf '%s\\n' cat ${gemDir('kamal', '2.12.0')}/lib/kamal.rb` }],
  ['a source path in a later echo command', 'Bash', { command: `ls app && echo ${gemDir('kamal', '2.12.0')}` }],
  ['an opaque command containing a locator', 'Bash', { command: 'ruby -e "bundle show kamal"' }],
  ['a normalized path outside vendor/bundle', 'Read', { file_path: '/repo/vendor/bundle/../../app/models/report.rb' }],
  ['an ordinary command', 'Bash', { command: 'bin/rails test test/models/library_test.rb' }],
  ['a source path in a Bash description', 'Bash', { command: 'pwd', description: `Looking for ${gemDir('kamal', '2.12.0')}` }],
  ['a source path in a search pattern', 'Grep', { pattern: gemDir('kamal', '2.12.0'), path: 'app' }],
  ['a URL in a WebFetch prompt', 'WebFetch', { url: 'https://example.com', prompt: 'Compare with https://guides.rubyonrails.org/' }],
  ['a GitHub pull request', 'WebFetch', { url: 'https://github.com/basecamp/kamal/pull/100' }],
  ['an installation command', 'Bash', { command: 'gem install kamal --install-dir /app/vendor/bundle' }],
  ['a node_modules path', 'Read', { file_path: '/home/x/node_modules/foo-1.2.0/index.js' }],
]) {
  test(`allows ${name}`, () => {
    assert.equal(toolUse(project('Gemfile.lock'), tool_input, { tool }), null);
  });
}

// An unlicensed, unsynced or uninstalled POSH must not take gem work with it.
for (const [name, posh] of [
  ['exits non-zero', '#!/bin/sh\nexit 1\n'],
  ['prints nothing', '#!/bin/sh\n'],
]) {
  test(`fails open when posh ${name}`, () => {
    const broken = fs.mkdtempSync(path.join(tmp, 'broken-'));
    fs.writeFileSync(path.join(broken, 'posh'), posh, { mode: 0o755 });
    const read = { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record.rb` };
    assert.equal(toolUse(project('Gemfile.lock'), read, { env: { PATH: `${broken}:${process.env.PATH}` } }), null);
  });
}

test('stays out of the way outside Ruby projects and when POSH is off', () => {
  const read = { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record.rb` };
  assert.equal(toolUse(project('package.json'), read), null);
  runHook('UserPromptSubmit', project('Gemfile'), prompt('/posh off'));
  assert.equal(toolUse(project('Gemfile.lock'), read), null);
});

test('lookup redirects stay enabled in on and feedback modes', () => {
  const cwd = project('Gemfile.lock');
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  for (const mode of ['on', 'feedback']) {
    fs.writeFileSync(modeFile, `${mode}\n`);
    const out = toolUse(cwd, { command: 'bundle show kamal' }, { tool: 'Bash' });
    assert.match(out.permissionDecisionReason, /gem:kamal/, mode);
  }
});

test('POSH_HOOK_DECISION downgrades the block to a prompt', () => {
  const out = toolUse(project('Gemfile.lock'), { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record.rb` }, { env: { POSH_HOOK_DECISION: 'ask' } });
  assert.equal(out.permissionDecision, 'ask');
});

test('POSH_HOOK_DECISION cannot grant a tool permission', () => {
  const out = toolUse(project('Gemfile.lock'), { command: 'bundle show kamal' }, { tool: 'Bash', env: { POSH_HOOK_DECISION: 'allow' } });
  assert.equal(out.permissionDecision, 'deny');
});

test('needs Node and POSH but not Ruby on the hook PATH', () => {
  for (const missing of ['node', 'posh', 'ruby']) {
    const bin = fs.mkdtempSync(path.join(tmp, 'isolated-path-'));
    for (const name of ['sh', 'cat']) fs.symlinkSync(`/bin/${name}`, path.join(bin, name));
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    if (missing !== 'node') fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    if (missing !== 'posh') fs.symlinkSync(path.join(poshBin, 'posh'), path.join(bin, 'posh'));
    const out = toolUse(project('Gemfile.lock'), { command: 'bundle show kamal' }, { tool: 'Bash', env: { PATH: bin } });
    if (missing === 'ruby') assert.equal(out.permissionDecision, 'deny');
    else assert.equal(out, null);
  }
});

test('redirects a search of the whole gem tree, where no single gem is named', () => {
  const dir = project('Gemfile.lock');
  for (const root of [`${dir}/vendor/bundle`, '/opt/ruby/lib/ruby/gems', '/var/lib/gems/3.4.0']) {
    const out = toolUse(dir, { pattern: 'def update_all', path: root }, { tool: 'Grep' });
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /the installed source of the gems this project locks/);
    assert.match(out.permissionDecisionReason, /posh search '<symbol>'/);
  }
});

test('gem-tree redirects have their own marker and give an unfiltered, project-pinned search', () => {
  const cwd = project('Gemfile.lock');
  const data = fs.mkdtempSync(path.join(tmp, 'tree-data-'));
  const out = toolUse(cwd, { path: '/app/vendor/bundle', pattern: 'def perform' }, {
    tool: 'Grep', session: 'tree', data,
  });
  const reason = out.permissionDecisionReason;
  assert.match(fs.readdirSync(path.join(data, 'nudged'))[0], /^tree\.[a-f0-9]{64}\.gem-tree$/);
  assert.deepEqual(JSON.parse(reason.match(/search tool with (\{.*?\}), or/)[1]), {
    query: '<symbol or page name>', project: cwd,
  });
  const cli = reason.match(/or `(.+?)`, then/)[1];
  const args = execFileSync('/bin/sh', ['-c', `posh() { printf '%s\\n' "$@"; }\n${cli}`], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(args, ['search', '<symbol>', '--project', cwd]);
});

test('recognizes custom RubyGems homes without treating sibling application files as gems', () => {
  const dir = project('Gemfile.lock');
  const home = path.join(dir, 'custom-gem-home');
  const env = { GEM_HOME: home, GEM_PATH: home };
  assert.match(toolUse(dir, { file_path: `${home}/gems/kamal-2.12.0/lib/kamal.rb` }, { env }).permissionDecisionReason, /gem:kamal/);
  assert.equal(toolUse(dir, { file_path: `${home}/app/models/report.rb` }, { env }), null);
});

test('recognizes each exported gem home without needing a Ruby executable', () => {
  const cwd = project('Gemfile.lock');
  const homes = [path.join(cwd, 'custom home'), path.join(cwd, 'another-home')];
  for (const env of [
    { GEM_HOME: homes[0], GEM_PATH: '' },
    { GEM_HOME: '', GEM_PATH: homes.join(path.delimiter) },
  ]) {
    const home = env.GEM_HOME || homes[1];
    assert.match(toolUse(cwd, { file_path: `${home}/gems/kamal-2.12.0/lib/kamal.rb` }, { env }).permissionDecisionReason, /gem:kamal/);
    assert.equal(toolUse(cwd, { file_path: `${home}/app/models/report.rb` }, { env }), null);
    assert.equal(toolUse(cwd, { file_path: `${home}-sibling/gems/kamal-2.12.0/lib/kamal.rb` }, { env }), null);
  }
});

test('expands home-relative gem paths and recognizes searches of custom gem-home roots', () => {
  const cwd = project('Gemfile.lock');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(home);
  for (const gemHome of ['~/custom gems', '~']) {
    const absoluteHome = gemHome === '~' ? home : path.join(home, 'custom gems');
    const env = { HOME: home, GEM_HOME: absoluteHome, GEM_PATH: '' };
    const out = toolUse(cwd, { file_path: `${gemHome}/gems/kamal-2.12.0/lib/kamal.rb` }, { env });
    assert.match(out.permissionDecisionReason, /gem:kamal/);
    const exported = toolUse(cwd, { file_path: `${absoluteHome}/gems/kamal-2.12.0/lib/kamal.rb` }, {
      env: { ...env, GEM_HOME: gemHome },
    });
    assert.match(exported.permissionDecisionReason, /gem:kamal/);
    for (const root of [gemHome, `${gemHome}/gems`]) {
      const tree = toolUse(cwd, { path: root, pattern: 'def perform' }, { tool: 'Grep', env });
      assert.match(tree.permissionDecisionReason, /the installed source of the gems this project locks/);
    }
    assert.equal(toolUse(cwd, { file_path: `${gemHome}-sibling/gems/kamal-2.12.0/lib/kamal.rb` }, { env }), null);
  }
});

test('a search with no path uses the current directory inside an installed gem', () => {
  const root = project('Gemfile.lock');
  const cwd = path.join(root, 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0');
  fs.mkdirSync(cwd, { recursive: true });
  const out = toolUse(cwd, { pattern: 'def perform' }, {
    tool: 'Grep', env: { FAKE_POSH_PROJECT_JSON: JSON.stringify(root) },
  });
  assert.match(out.permissionDecisionReason, /gem:kamal/);
});

test('default config and retry state stay in the isolated HOME or XDG cache', async () => {
  const cwd = project('Gemfile.lock');
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const mode = path.join(home, '.config/posh/agent-mode');
  fs.mkdirSync(path.dirname(mode), { recursive: true });
  const cache = path.join(home, 'xdg-cache');
  const input = { cwd, session_id: 'fallback', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  for (const xdg of [cache, undefined]) {
    const env = {
      HOME: home, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: xdg,
      PLUGIN_DATA: undefined, CLAUDE_PLUGIN_DATA: undefined,
    };
    await withPolicyEnv(cwd, { env }, async () => {
      fs.writeFileSync(mode, 'off\n');
      assert.equal(await poshRedirect(input), null);
      fs.writeFileSync(mode, 'on\n');
      assert.match(await poshRedirect(input), /gem:kamal/);
      assert.equal(await poshRedirect(input), null);
      const markers = path.join(xdg || path.join(home, '.cache'), 'posh/nudged');
      assert.equal(fs.readdirSync(markers).length, 1);
    });
  }
});

test('recognizes standard user, XDG, distro and alternate-Ruby installation layouts', () => {
  const cwd = project('Gemfile.lock');
  for (const home of [
    '/home/x/.gem/ruby/3.4.0',
    '/home/x/.local/share/gem/ruby/4.0.0',
    '/home/x/.gem/jruby/3.1.0',
    '/app/vendor/bundle/truffleruby/3.3.0',
    '/usr/share/rubygems-integration/all',
  ]) assert.match(toolUse(cwd, { file_path: `${home}/gems/kamal-2.12.0/lib/kamal.rb` }).permissionDecisionReason, /gem:kamal/);
});

test('shell quoting preserves literal arguments without evaluating expansions or malformed commands', () => {
  const cwd = project('Gemfile.lock');
  for (const command of [
    'bundle show k"am"al',
    "bundle show 'kamal'",
    'bundle show ka\\mal',
    'bundle \\\nshow kamal',
    'bundle show kamal; echo ignored',
    'bundle show kamal\nprintf ignored',
  ]) assert.match(toolUse(cwd, { command }, { tool: 'Bash' }).permissionDecisionReason, /gem:kamal/, command);
  for (const command of [
    'bundle show "kamal',
    "bundle show 'kamal",
    'bundle show kamal\\',
    'bundle show ""',
    'bundle show "$GEM"',
    'bundle show "$(touch pwned)"',
    'bundle show `touch pwned`',
    'bundle show "${GEM:-kamal}"',
    "bundle show 'kamal\n'",
    'echo ignored; bundle show kamal',
    'printf ignored\nbundle show kamal',
  ]) assert.equal(toolUse(cwd, { command }, { tool: 'Bash' }), null, command);
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
});

test('shell lookup targets exclude patterns, scripts, option values and request bodies', () => {
  const cwd = project('Gemfile.lock');
  const source = `${gemDir('kamal', '2.12.0')}/lib/kamal.rb`;
  const url = 'https://rubygems.org/gems/kamal';
  const data = fs.mkdtempSync(path.join(tmp, 'operand-data-'));
  for (const command of [
    `grep -F '${source}' README.md`,
    `grep -e '${source}' README.md`,
    `rg --glob '${source}' needle app`,
    `rg -g'${source}' needle app`,
    `sed -n '${source}' README.md`,
    `awk '${source}' README.md`,
    `awk -v source='${source}' 'print source' README.md`,
    `awk '{ print source }' source='${source}' README.md`,
    `awk -f local.awk _source='${source}' README.md`,
    `find app -path '${source}'`,
    `ls --ignore '${source}' app`,
    `curl --data '${url}' https://example.com`,
    `curl -o '${url}' https://example.com`,
    `wget --post-data='${url}' https://example.com`,
    `cat --unknown-option '${source}'`,
  ]) {
    assert.equal(toolUse(cwd, { command }, { tool: 'Bash', data }), null, command);
  }
  // False positives must not consume the real lookup's once-only marker.
  assert.match(toolUse(cwd, { command: `cat '${source}'` }, { tool: 'Bash', data }).permissionDecisionReason, /gem:kamal/);
});

test('shell operands still identify source files and fetched URLs after known options', () => {
  const cwd = project('Gemfile.lock');
  const source = `${gemDir('kamal', '2.12.0')}/lib/kamal.rb`;
  for (const command of [
    `cat -n '${source}'`,
    `ls -l '${source}'`,
    `cd -P '${source}'`,
    `grep -F needle '${source}'`,
    `grep -e needle '${source}'`,
    `grep -f patterns.txt '${source}'`,
    `grep --regexp=needle '${source}'`,
    `rg -n needle '${source}'`,
    `rg -g '*.rb' needle '${source}'`,
    `sed -n '1,30p' '${source}'`,
    `sed -e 's/old/new/' '${source}'`,
    `sed --expression='1p' '${source}'`,
    `awk -F : '{ print $1 }' '${source}'`,
    `awk '{ print source }' source=README.md '${source}'`,
    `awk -f local.awk source=README.md '${source}'`,
    `awk -f local.awk '${source}'`,
    `find '${source}'`,
    `find '${source}' -name '*.rb'`,
    `head -n 20 '${source}'`,
    `tail --lines=20 '${source}'`,
    `cat -- '${source}'`,
    'curl -sSLo k.gem https://rubygems.org/downloads/kamal-2.12.0.gem',
    'wget -q -O k.gem https://rubygems.org/downloads/kamal-2.12.0.gem',
  ]) {
    assert.match(toolUse(cwd, { command }, { tool: 'Bash' }).permissionDecisionReason, /gem:kamal/, command);
  }
});

test('leaves a bundler path that is not being read alone', () => {
  const dir = project('Gemfile.lock');
  assert.equal(toolUse(dir, { command: 'bundle config set --local path vendor/bundle' }, { tool: 'Bash' }), null);
});

test('incomplete source locator commands stay allowed', () => {
  for (const command of ['gem', 'gem contents', 'bundle', 'bundle show', '']) {
    assert.equal(toolUse(project('Gemfile.lock'), { command }, { tool: 'Bash' }), null);
  }
});

test('Claude Code and Codex register interception through the same hook adapter', () => {
  const load = (file) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  const claude = load('.claude-plugin/plugin.json');
  const codex = load('.codex-plugin/plugin.json');
  assert.ok(claude.hooks.some((file) => load(file).hooks.PreToolUse));
  assert.ok(codex.hooks.some((file) => load(file).hooks.PreToolUse));
});

// The publish workflow runs this suite before npm publish, so a release whose
// manifests drifted apart fails here instead of shipping.
test('every host manifest carries the released version', () => {
  const load = (file) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  const { version } = load('package.json');
  assert.match(version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json', '.github/plugin/plugin.json', 'gemini-extension.json']) {
    assert.equal(load(file).version, version, file);
  }
});

test('Codex manifest command denies canonical Bash calls, never emits unsupported ask, and allows retries', () => {
  const cwd = project('Gemfile.lock');
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'hooks/codex-hooks.json'), 'utf8'));
  const group = manifest.hooks.PreToolUse[0];
  assert.match('Bash', new RegExp(group.matcher));
  const env = {
    ...process.env, PLUGIN_ROOT: repo, PLUGIN_DATA: fs.mkdtempSync(path.join(tmp, 'codex-data-')),
    POSH_HOOK_DECISION: 'ask', PATH: `${poshBin}:${process.env.PATH}`, FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd),
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_DATA;
  const call = (command) => execFileSync('sh', ['-c', group.hooks[0].command], {
    cwd, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: '019c-codex', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
  });
  assert.equal(call('echo bundle show kamal'), '');
  const out = JSON.parse(call('bundle show kamal')).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /gem:kamal/);
  assert.equal(call('bundle show kamal'), '');
  assert.equal(fs.readdirSync(path.join(env.PLUGIN_DATA, 'nudged')).length, 1);
});

test('OpenCode maps all five built-in lookup tools to the shared policy', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  for (const [tool, input] of [
    ['read', { path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` }],
    ['read', { path: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb`, workdir: project('package.json') }],
    ['grep', { path: 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib', pattern: 'registry' }],
    ['glob', { pattern: '**/vendor/bundle/**/gems/kamal-2.12.0/lib/**/*.rb' }],
    ['glob', { path: 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib', pattern: '*.rb' }],
    ['shell', { command: 'bundle show kamal' }],
    ['webfetch', { url: 'https://rubydoc.info/gems/kamal/Kamal' }],
  ]) {
    const reason = await openCodeTool(host, cwd, tool, input);
    assert.match(reason, /gem:kamal 2\.12\.0/);
    assert.ok(reason.includes(`"project":${JSON.stringify(cwd)}`));
  }
});

test('OpenCode leaves ordinary tools, metadata and malformed inputs alone', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  for (const [tool, input] of [
    ['read', { path: 'app/models/kamal.rb' }],
    ['grep', { pattern: gemDir('kamal', '2.12.0'), path: 'app' }],
    ['shell', { command: 'echo bundle show kamal' }],
    ['webfetch', { url: 'https://example.com', prompt: 'https://rubygems.org/gems/kamal' }],
    ['read', { filePath: `${gemDir('kamal', '2.12.0')}/lib/kamal.rb` }],
    ['posh_read', { ref: 'gem:kamal' }],
    ['read', null], ['shell', 'bundle show kamal'], ['read', {}],
  ]) assert.equal(await openCodeTool(host, cwd, tool, input), null);
});

test('OpenCode rejects unknown tools and non-object inputs before requesting a session', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  for (const [tool, input] of [
    ['unknown', { path: gemDir('kamal', '2.12.0') }],
    ...[null, undefined, false, 17, 'file', [], () => {}].map((input) => ['read', input]),
  ]) assert.equal(await openCodeTool(host, cwd, tool, input), null);
  assert.deepEqual(host.requested, []);
});

test('OpenCode retries proceed and new sessions get their own redirect', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  const data = fs.mkdtempSync(path.join(tmp, 'opencode-data-'));
  const call = (session) => openCodeTool(host, cwd, 'shell', { command: 'bundle show kamal' }, { data, session });
  assert.match(await call('s1'), /gem:kamal/);
  assert.equal(await call('s1'), null);
  assert.match(await call('s2'), /gem:kamal/);
  assert.deepEqual(host.requested, [{ sessionID: 's1' }, { sessionID: 's1' }, { sessionID: 's2' }]);
});

test('OpenCode uses the moved session location and a shell workdir, not its plugin location', async () => {
  const original = project('package.json', '.git');
  const cwd = project('Gemfile.lock', '.git');
  const nested = path.join(cwd, 'app/models');
  fs.mkdirSync(nested, { recursive: true });
  const host = await setupOpenCode(original);
  const call = (input) => openCodeTool(host, cwd, 'shell', { command: 'bundle show kamal', ...input });
  assert.equal(await call(), null);
  host.directory = nested;
  assert.match(await call(), /gem:kamal/);
  host.directory = original;
  assert.match(await call({ workdir: nested }), /gem:kamal/);
  assert.equal(await call(), null);
});

test('OpenCode imports the policy without external runtimes and fails open on POSH/session/state errors', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  const call = (options) => openCodeTool(host, cwd, 'shell', { command: 'bundle show kamal' }, options);
  assert.match(await call({ env: { PATH: poshBin } }), /gem:kamal/);
  assert.equal(await call({ env: { PATH: tmp } }), null);
  assert.equal(await call({ env: { FAKE_POSH_RESPONSE: 'not json' } }), null);
  const data = path.join(tmp, 'opencode-state-file');
  fs.writeFileSync(data, '');
  assert.equal(await call({ data }), null);
  host.sessionError = true;
  assert.equal(await call(), null);
});

test('OpenCode honors off, project boundaries and exact docset project matching', async () => {
  const cwd = project('Gemfile.lock');
  const host = await setupOpenCode(cwd);
  const call = (env = {}) => openCodeTool(host, cwd, 'shell', { command: 'bundle show kamal' }, { env });
  assert.equal(await call({ FAKE_POSH_PROJECT_JSON: JSON.stringify(project('Gemfile.lock')) }), null);
  runHook('UserPromptSubmit', cwd, prompt('/posh off'));
  assert.equal(await call(), null);
  fs.rmSync(modeFile);
  const inner = path.join(cwd, 'non-ruby-repo');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, '.git'), '');
  host.directory = inner;
  assert.equal(await call(), null);
});

test('uses the current directory, not the project where the session started', () => {
  const current = project('Gemfile.lock');
  const out = toolUse(current, { command: 'bundle show kamal' }, { tool: 'Bash', env: { CLAUDE_PROJECT_DIR: project('package.json') } });
  assert.equal(out.permissionDecision, 'deny');
});

test('uses the Ruby project root when the current directory is nested', () => {
  const root = project('Gemfile.lock', '.git');
  const cwd = path.join(root, 'app/models');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { FAKE_POSH_PROJECT_JSON: JSON.stringify(root), FAKE_POSH_EXPECT_PROJECT: root };
  assert.equal(toolUse(cwd, { command: 'bundle show kamal' }, { tool: 'Bash', env }).permissionDecision, 'deny');
});

test('keeps search and read in the resolved project and shell-quotes the CLI path', () => {
  const original = project('Gemfile.lock');
  const root = `${original} team's $HOME`;
  fs.renameSync(original, root);
  const cwd = path.join(root, 'app/models');
  fs.mkdirSync(cwd, { recursive: true });
  const out = toolUse(cwd, { command: 'bundle show kamal' }, {
    tool: 'Bash', env: { FAKE_POSH_PROJECT_JSON: JSON.stringify(root) },
  });
  const reason = out.permissionDecisionReason;
  assert.deepEqual(JSON.parse(reason.match(/search tool with (\{.*?\}), or/)[1]), {
    query: '<symbol or page name>', project: root, ref: 'gem:kamal',
  });
  assert.deepEqual(JSON.parse(reason.match(/ref using (\{.*?\})\./)[1]), {
    ref: '<returned document ref>', project: root,
  });
  assert.match(reason, /retry the original call; it will go through/);
  const cli = reason.match(/or `(.+?)`, then/)[1];
  const args = execFileSync('/bin/sh', ['-c', `posh() { printf '%s\\n' "$@"; }\n${cli}`], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(args, ['search', '<symbol>', '--ref', 'gem:kamal', '--project', root]);
});

test('rejects an outer project even when POSH returns an ancestor of the current directory', () => {
  const outer = project('Gemfile.lock');
  const inner = path.join(outer, 'nested-repo');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, '.git'), '');
  fs.writeFileSync(path.join(inner, 'Gemfile.lock'), '');
  assert.equal(toolUse(inner, { command: 'bundle show kamal' }, {
    tool: 'Bash', env: { FAKE_POSH_PROJECT_JSON: JSON.stringify(outer) },
  }), null);
  fs.unlinkSync(path.join(inner, 'Gemfile.lock'));
  runHook('UserPromptSubmit', inner, prompt('/posh on'));
  assert.equal(toolUse(inner, { command: 'bundle show kamal' }, {
    tool: 'Bash', env: { FAKE_POSH_PROJECT_JSON: JSON.stringify(outer) },
  }), null);
});

test('a project path mentioning gems is not itself a source read', () => {
  const dir = project('Gemfile.lock');
  const cwd = path.join(dir, 'gems/kamal-2.12.0');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(toolUse(cwd, { command: 'pwd' }, { tool: 'Bash' }), null);
});

for (const response of [
  'not json', 'null', '[]', '{"ok":false,"data":[{"ref":"gem:kamal","kinds":["rdoc"]}]}',
]) {
  test(`fails open on an invalid docsets response: ${response}`, () => {
    assert.equal(toolUse(project('Gemfile.lock'), { command: 'bundle show kamal' }, {
      tool: 'Bash', env: { FAKE_POSH_RESPONSE: response },
    }), null);
  });
}

test('accepts formatted JSON but rejects the wrong library, project, and Ruby-only docs', () => {
  const dir = project('Gemfile.lock');
  const call = (data, project_path = dir, tool_input = { command: 'bundle show kamal' }) =>
    toolUse(dir, tool_input, { tool: 'Bash', env: { FAKE_POSH_RESPONSE: JSON.stringify({ ok: true, project_path, data }, null, 2) } });
  assert.equal(call([{ ref: 'gem:kamal', version: '2.12.0', kinds: ['rdoc'] }]).permissionDecision, 'deny');
  assert.equal(call([{ ref: 'gem:kamal-extra', kinds: ['rdoc'] }]), null);
  assert.equal(call([{ ref: 'gem:kamal', kinds: ['rdoc'] }], project()), null);
  assert.equal(call([{ ref: 'lang:ruby', kinds: ['rdoc'] }], dir, { command: 'grep registry /app/vendor/bundle' }), null);
});

test('POSH project paths are type-checked before filesystem resolution', async () => {
  const cwd = project('Gemfile.lock');
  const realpath = fs.realpathSync;
  const resolved = [];
  vi.spyOn(fs, 'realpathSync').mockImplementation((file, ...args) => {
    resolved.push(file);
    return realpath(file, ...args);
  });
  const env = { FAKE_POSH_RESPONSE: JSON.stringify({
    ok: true, project_path: 17, data: [{ ref: 'gem:kamal', kinds: ['rdoc'] }],
  }) };
  assert.equal(await withPolicyEnv(cwd, { env }, () => poshRedirect({
    cwd, session_id: 'project-type', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' },
  })), null);
  assert.deepEqual(resolved, [cwd]);
});

test('only an explicitly successful POSH response can consume a retry marker', async () => {
  const cwd = project('Gemfile.lock');
  const input = { cwd, session_id: 'response-status', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  const docs = { project_path: cwd, data: [{ ref: 'gem:kamal', kinds: ['rdoc'] }] };
  for (const ok of [false, undefined, null, 1, 'true']) {
    const data = fs.mkdtempSync(path.join(tmp, 'status-data-'));
    const env = { FAKE_POSH_RESPONSE: JSON.stringify({ ...docs, ok }) };
    assert.equal(await withPolicyEnv(cwd, { data, env }, () => poshRedirect(input)), null);
    assert.deepEqual(fs.readdirSync(data), []);
    assert.match(await withPolicyEnv(cwd, { data }, () => poshRedirect(input)), /gem:kamal/);
    assert.equal(await withPolicyEnv(cwd, { data }, () => poshRedirect(input)), null);
  }
});

test('malformed docset rows do not hide a later usable library', () => {
  const cwd = project('Gemfile.lock');
  const data = [
    null, {}, { ref: 17 }, { ref: 'gem:kamal', kinds: 'rdoc' }, { ref: 'gem:kamal', kinds: [] },
    { ref: 'gem:kamal', version: '2.12.0', kinds: ['rdoc'] },
  ];
  const out = toolUse(cwd, { command: 'bundle show kamal' }, {
    tool: 'Bash', env: { FAKE_POSH_RESPONSE: JSON.stringify({ ok: true, project_path: cwd, data }) },
  });
  assert.match(out.permissionDecisionReason, /gem:kamal 2\.12\.0/);
});

test('fails open on missing/unsafe sessions, malformed payloads, and unsavable markers', () => {
  const dir = project('Gemfile.lock');
  for (const session of ['', '../../outside', 'quote"', 's\n', 's\r\n']) {
    assert.equal(toolUse(dir, { command: 'bundle show kamal' }, { tool: 'Bash', session }), null);
  }
  for (const payload of ['not json', 'null', '{}', '{"tool_input":null}']) {
    assert.equal(runHook('PreToolUse', dir, payload), null);
  }
  const data = path.join(tmp, 'not-a-directory');
  fs.writeFileSync(data, '');
  for (let i = 0; i < 2; i++) {
    assert.equal(toolUse(dir, { command: 'bundle show kamal' }, { tool: 'Bash', data }), null);
  }
});

test('parallel source reads get exactly one redirect', async () => {
  const dir = project('Gemfile.lock');
  const data = fs.mkdtempSync(path.join(tmp, 'parallel-'));
  const input = JSON.stringify({ session_id: 'parallel', cwd: dir, tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } });
  const outputs = await Promise.all(Array.from({ length: 6 }, async () => {
    const child = execFile('sh', [hook, 'PreToolUse'], {
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: data, PATH: `${poshBin}:${process.env.PATH}`, FAKE_POSH_PROJECT_JSON: JSON.stringify(dir) },
    });
    const result = new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`hook exited ${code}`)));
    });
    child.stdin.end(input);
    return result;
  }));
  assert.equal(outputs.filter(Boolean).length, 1);
  assert.equal(JSON.parse(outputs.find(Boolean)).hookSpecificOutput.permissionDecision, 'deny');
});
