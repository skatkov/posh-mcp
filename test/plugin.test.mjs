// Runs the Claude/Codex hook and the OpenCode plugin against the same scenarios.
// node --test isolates each file in its own process, so setting XDG_CONFIG_HOME is safe.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repo, 'hooks/posh-hook.sh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'posh-plugin-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
const modeFile = path.join(tmp, 'config/posh/agent-mode');
const MARKER = "POSH: docs for this project's exact versions";
const FEEDBACK = 'POSH feedback: proactively evaluate successful use too';

const project = (...files) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'project-'));
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
};

function runHook(event, cwd, stdin = '', extraEnv = {}) {
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const out = execFileSync('sh', [hook, event], { cwd, env: { ...env, ...extraEnv }, input: stdin, encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

// A fake `posh` keeps the PreToolUse tests off this machine's licence and synced docsets.
const DOCSETS = {
  'gem:activerecord': { version: '8.1.4.1', kinds: ['rdoc'] },
  'gem:kamal': { version: '2.12.0', kinds: ['rdoc', 'guide'] },
  'gem:nokogiri': { version: '1.19.7', kinds: ['rdoc'] },
  'gem:rails': { version: '8.1.4.1', kinds: ['rdoc'] },
  'gem:geneva_drive': { version: '0.7.0', kinds: ['yard'] },
  'gem:geneva_drive_admin': { version: '0.6.0', kinds: [] },
};
const poshBin = path.join(tmp, 'bin');
before(() => {
  fs.mkdirSync(poshBin, { recursive: true });
  const cases = Object.entries(DOCSETS)
    .map(([ref, spec]) => `  *'--filter ${ref}') printf '%s' '${JSON.stringify([{ ref, ...spec }])}' ;;`)
    .join('\n');
  // Without --filter the real posh lists the whole project, which is how the hook
  // asks whether this project has any local docs at all.
  const all = JSON.stringify(Object.entries(DOCSETS).map(([ref, spec]) => ({ ref, ...spec })));
  fs.writeFileSync(
    path.join(poshBin, 'posh'),
    `#!/bin/sh
[ "$1" = docsets ] || exit 1
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
});

// A fresh marker directory per call, unless a test passes one to reuse across calls.
const toolUse = (cwd, tool_input, { session = 's', tool = 'Read', data, env = {} } = {}) =>
  runHook('PreToolUse', cwd, JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input }), {
    PATH: `${poshBin}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: data ?? fs.mkdtempSync(path.join(tmp, 'data-')),
    FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd),
    ...env,
  });

const gemDir = (gem, version) => `/home/x/.local/share/mise/installs/ruby/4.0.9/lib/ruby/gems/4.0.0/gems/${gem}-${version}`;

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

test('feedback mode adds the evaluation rules on top of on, everywhere, in both hosts', async () => {
  const other = project();
  const host = await setupOpenCode(other);

  const switched = runHook('UserPromptSubmit', other, prompt('/posh feedback'));
  assert.match(switched.additionalContext, /POSH feedback mode is now on/);
  for (const text of [switched.additionalContext, runHook('SessionStart', other).additionalContext, host.system(), host.system('compaction')]) {
    assert.ok(text.includes(MARKER));
    assert.ok(text.includes(FEEDBACK));
  }

  const on = runHook('UserPromptSubmit', other, prompt('/posh on'));
  assert.match(on.additionalContext, /Stop adding the POSH feedback section/);
  assert.ok(!on.additionalContext.includes(FEEDBACK));
  assert.ok(!runHook('SessionStart', other).additionalContext.includes(FEEDBACK));
  assert.ok(!host.system().includes(FEEDBACK));
  assert.doesNotMatch(runHook('UserPromptSubmit', other, prompt('/posh on')).additionalContext, /Stop adding/);
});

test('OpenCode /posh feedback persists the mode', async () => {
  const host = await setupOpenCode(project());
  await host.run('feedback');
  assert.equal(fs.readFileSync(modeFile, 'utf8').trim(), 'feedback');
  assert.match(host.sent.at(-1).text, /POSH feedback mode is now on/);
  assert.ok(host.system().includes(FEEDBACK));
});

test('/posh auto still sees a project whose only marker is a gemspec', () => {
  const auto = runHook('UserPromptSubmit', project('thing.gemspec'), prompt('/posh auto'));
  assert.match(auto.additionalContext, /which includes this one/);
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

// --- PreToolUse: the gem documentation routes -------------------------------

test('denies installed gem source and names the POSH call to make instead', () => {
  const dir = project('Gemfile.lock');
  const out = toolUse(dir, { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record/relation.rb` });
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

test('shared policy returns a harness-neutral reason from normalized JSON input', () => {
  const cwd = project('Gemfile.lock');
  const payload = JSON.stringify({ cwd, session_id: 'neutral', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } });
  const result = execFileSync('ruby', [path.join(repo, 'hooks/posh-lookup.rb')], {
    cwd: project('package.json'), input: payload, encoding: 'utf8',
    env: { ...process.env, PATH: `${poshBin}:${process.env.PATH}`, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(tmp, 'data-')), FAKE_POSH_PROJECT_JSON: JSON.stringify(cwd) },
  });
  assert.deepEqual(Object.keys(JSON.parse(result)), ['reason']);
  assert.match(JSON.parse(result).reason, /gem:kamal/);
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

test('POSH_HOOK_DECISION downgrades the block to a prompt', () => {
  const out = toolUse(project('Gemfile.lock'), { file_path: `${gemDir('activerecord', '8.1.4.1')}/lib/active_record.rb` }, { env: { POSH_HOOK_DECISION: 'ask' } });
  assert.equal(out.permissionDecision, 'ask');
});

test('POSH_HOOK_DECISION cannot grant a tool permission', () => {
  const out = toolUse(project('Gemfile.lock'), { command: 'bundle show kamal' }, { tool: 'Bash', env: { POSH_HOOK_DECISION: 'allow' } });
  assert.equal(out.permissionDecision, 'deny');
});

test('fails open when either runtime executable is absent, without falling back to real POSH', () => {
  const ruby = execFileSync('/bin/sh', ['-c', 'command -v ruby'], { encoding: 'utf8' }).trim();
  for (const missing of ['ruby', 'posh']) {
    const bin = fs.mkdtempSync(path.join(tmp, 'isolated-path-'));
    for (const name of ['sh', 'cat']) fs.symlinkSync(`/bin/${name}`, path.join(bin, name));
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    if (missing !== 'ruby') fs.symlinkSync(ruby, path.join(bin, 'ruby'));
    if (missing !== 'posh') fs.symlinkSync(path.join(poshBin, 'posh'), path.join(bin, 'posh'));
    assert.equal(toolUse(project('Gemfile.lock'), { command: 'bundle show kamal' }, { tool: 'Bash', env: { PATH: bin } }), null);
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

test('recognizes custom RubyGems homes without treating sibling application files as gems', () => {
  const dir = project('Gemfile.lock');
  const home = path.join(dir, 'custom-gem-home');
  const env = { GEM_HOME: home, GEM_PATH: home };
  assert.match(toolUse(dir, { file_path: `${home}/gems/kamal-2.12.0/lib/kamal.rb` }, { env }).permissionDecisionReason, /gem:kamal/);
  assert.equal(toolUse(dir, { file_path: `${home}/app/models/report.rb` }, { env }), null);
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
  assert.equal(JSON.parse(reason.match(/search tool with (\{.*?\}), or/)[1]).project, root);
  assert.equal(JSON.parse(reason.match(/ref using (\{.*?\})\./)[1]).project, root);
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

test('fails open on missing/unsafe sessions, malformed payloads, and unsavable markers', () => {
  const dir = project('Gemfile.lock');
  for (const session of ['', '../../outside', 'quote"']) {
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
