import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evals = path.join(repo, 'evals');
const names = fs.readdirSync(evals).filter((name) => fs.existsSync(path.join(evals, name, 'case.yaml')));
const cases = JSON.parse(execFileSync('ruby', ['-rpsych', '-rjson', '-e',
  'puts JSON.generate(ARGV.map { |file| Psych.safe_load_file(file) })',
  ...names.map((name) => path.join(evals, name, 'case.yaml')),
], { encoding: 'utf8' }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posh-evals-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const real = path.join(tmp, 'real-home');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
for (const kind of ['share', 'state']) {
  fs.mkdirSync(path.join(real, '.local', kind, 'posh'), { recursive: true });
}
fs.writeFileSync(path.join(bin, 'getent'), `#!/bin/sh\nprintf '%s\\n' 'x:x:0:0::${real}:/bin/sh'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'posh'), '#!/bin/sh\n[ -d "$HOME/.local/share/posh" ] && [ -d "$HOME/.local/state/posh" ] || exit 1\nprintf "%s" "$FAKE_POSH_DOCSETS"\n', { mode: 0o755 });
const data = [
  { ref: 'gem:activerecord', version: '8.1.4.1', kinds: ['rdoc'] },
  { ref: 'gem:kamal', version: '2.12.0', kinds: ['guide'] },
  { ref: 'gem:nokogiri', version: '1.19.7', kinds: ['rdoc'] },
  { ref: 'gem:widget_press', version: '0.1.0', kinds: [] },
];

function scaffold(name, { docs = data, home = fs.mkdtempSync(path.join(tmp, 'home-')) } = {}) {
  const cwd = fs.mkdtempSync(path.join(tmp, 'workspace-'));
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: path.join(home, 'plugin-data'),
    FAKE_POSH_DOCSETS: JSON.stringify({ ok: true, project_path: cwd, data: docs }),
  };
  execFileSync('sh', [path.join(evals, name, 'scaffold.sh')], {
    cwd, env, stdio: 'pipe',
  });
  return { cwd, home, env };
}

test('all six evals have runnable scaffolds and stay out of the operator home', () => {
  assert.equal(cases.length, 6);
  for (const spec of cases) {
    const { cwd, home } = scaffold(spec.name);
    assert.ok(fs.existsSync(path.join(cwd, 'Gemfile.lock')));
    for (const kind of ['share', 'state']) {
      assert.equal(fs.realpathSync(path.join(home, `.local/${kind}/posh`)), path.join(real, `.local/${kind}/posh`));
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(real, '.local/share/posh')), []);
  assert.deepEqual(fs.readdirSync(path.join(real, '.local/state/posh')), []);
});

test('scaffold preflight fails on missing or wrong-version docs', () => {
  assert.throws(() => scaffold('activerecord-api', { docs: [] }));
  assert.throws(() => scaffold('typo-control', { docs: [] }));
  assert.throws(() => scaffold('activerecord-api', {
    docs: [{ ref: 'gem:activerecord', version: '7.0.0', kinds: ['rdoc'] }],
  }));
  assert.throws(() => scaffold('undocumented-gem', {
    docs: [{ ref: 'gem:widget_press', version: '0.1.0', kinds: ['rdoc'] }],
  }));
});

test('typo control has a working denial path but reading its README is allowed', () => {
  const { cwd, env } = scaffold('typo-control');
  const hook = (tool_input) => execFileSync('sh', [path.join(repo, 'hooks/posh-hook.sh'), 'PreToolUse'], {
    cwd, env, input: JSON.stringify({ session_id: 'control', cwd, tool_name: 'Read', tool_input }), encoding: 'utf8',
  });
  assert.equal(hook({ file_path: path.join(cwd, 'README.md') }), '');
  const source = { file_path: path.join(cwd, 'vendor/bundle/ruby/4.0.0/gems/activerecord-8.1.4.1/lib/active_record/relation.rb') };
  assert.equal(JSON.parse(hook(source)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook(source), '');
});

test('scaffolds never replace existing POSH directories', () => {
  scaffold('activerecord-api', { home: real });
  assert.equal(fs.lstatSync(path.join(real, '.local/share/posh')).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(path.join(real, '.local/share/posh')), []);
});

test('typo grader checks actual file contents, not an Edit request or the final reply', () => {
  const spec = cases.find((item) => item.name === 'typo-control');
  const grader = spec.graders.find((item) => item.name === 'typo-is-fixed');
  assert.deepEqual(grader.target, { source: 'file', path: 'README.md' });
  const { cwd } = scaffold(spec.name);
  const original = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');
  const pattern = new RegExp(grader.pattern);
  assert.equal(pattern.test(original), false);
  assert.equal(pattern.test(original.replace('reportts', 'reports')), true);
  assert.equal(pattern.test(original.replace('reportts', 'reports') + 'Unrequested text\n'), false);
  for (const tool of ['docsets', 'search', 'read', 'list', 'outline', 'sync']) {
    assert.ok(spec.graders.some((item) =>
      item.type === 'tool_used' && item.tool === `mcp__plugin_posh_docs__${tool}` && item.min === 0 && item.max === 0));
  }
});

test('adoption correlates the expected document, project, and successful tool result', () => {
  const project = '/tmp/claude-eval-fixture/home/cwd';
  const refs = {
    'activerecord-api': 'posh://gem:activerecord/rdoc/ActiveRecord/Relation.md#method-i-update_all',
    'hook-redirect': 'posh://gem:activerecord/rdoc/ActiveRecord/Relation.md#method-i-update_all',
    'github-source': 'posh://gem:nokogiri/rdoc/Nokogiri/XML/Searchable.md#method-i-css',
    'kamal-guide': 'posh://gem:kamal/guide/docs/configuration/docker-registry.md',
  };
  const unrelated = 'posh://lang:ruby/rdoc/Array.md';
  const init = { type: 'system', subtype: 'init', cwd: project };
  const call = (id, ref, scope) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_posh_docs__read', input: { ref, ...(scope === undefined ? {} : { project: scope }) } }] },
  });
  const result = (id, ref, ok = true) => {
    const body = ok ? { data: { ref, content: 'API docs' }, ok: true, summary: 'Document read' } : { ok: false, code: 'license_required' };
    return {
      type: 'user',
      message: { content: [{ tool_use_id: id, type: 'tool_result', content: JSON.stringify(body) }] },
      tool_use_result: { structuredContent: body },
    };
  };
  const trace = (...events) => [init, ...events].map((event) => JSON.stringify(event)).join('\n');
  for (const spec of cases.filter((item) => item.tags.includes('adoption') || item.tags.includes('interception'))) {
    const ref = refs[spec.name];
    const order = spec.graders.find((grader) => grader.type === 'tool_order');
    assert.equal(order.before, 'mcp__plugin_posh_docs__search');
    assert.equal(order.after.tool, 'mcp__plugin_posh_docs__read');
    assert.equal(order.arm, 'with-only');
    assert.equal(new RegExp(order.after.input_match).test(JSON.stringify({ ref })), true);
    assert.equal(new RegExp(order.after.input_match).test(JSON.stringify({ ref: unrelated })), false);
    const success = spec.graders.find((grader) => grader.name === 'documentation-read-succeeded');
    const pattern = new RegExp(success.pattern, success.flags);
    assert.equal(pattern.test(trace(call('expected', ref), result('expected', ref))), true);
    assert.equal(pattern.test(trace(call('expected', ref, project), result('expected', ref))), true);
    assert.equal(pattern.test(trace(call('expected', ref, `${project}/`), result('expected', ref))), true);
    assert.equal(pattern.test(trace(call('expected', ref, '/another/project'), result('expected', ref))), false);
    assert.equal(pattern.test(trace(call('expected', ref), result('expected', ref, false))), false);
    assert.equal(pattern.test(trace(call('expected', ref), result('other-id', ref))), false);
    assert.equal(pattern.test(trace(call('expected', ref), result('expected', unrelated))), false);
    assert.equal(pattern.test(trace(call('other', unrelated), result('other', unrelated))), false);
    // The old independent indicators passed this sequence: correct-gem search ref,
    // failed expected read, then a successful unrelated read.
    const search = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search', name: 'mcp__plugin_posh_docs__search', input: { query: 'API' } }] } };
    assert.equal(pattern.test(trace(search, result('search', ref), call('expected', ref), result('expected', ref, false), call('other', unrelated), result('other', unrelated))), false);
    assert.equal(pattern.test(trace(call('expected', ref), result('expected', ref, false), call('wrong-project', ref, '/another/project'), result('wrong-project', ref))), false);
    assert.equal(pattern.test(trace(call('expected', ref), { type: 'assistant', message: { content: [{ type: 'text', text: `Document read: ${ref}` }] } })), false);
    assert.equal(pattern.test(trace(call('expected', ref), call('other', unrelated), result('other', unrelated), result('expected', ref))), true);
    assert.ok(spec.graders.some((grader) => grader.type === 'llm' && grader.arm !== 'with-only'));
    assert.ok(spec.graders.filter((grader) => grader.type !== 'llm').every((grader) => grader.arm === 'with-only'));
  }
});
