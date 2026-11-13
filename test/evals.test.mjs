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
fs.writeFileSync(path.join(bin, 'posh'), '#!/bin/sh\nprintf "%s" "$FAKE_POSH_DOCSETS"\n', { mode: 0o755 });
const data = [
  { ref: 'gem:activerecord', version: '8.1.4.1', kinds: ['rdoc'] },
  { ref: 'gem:kamal', version: '2.12.0', kinds: ['guide'] },
  { ref: 'gem:nokogiri', version: '1.19.7', kinds: ['rdoc'] },
  { ref: 'gem:widget_press', version: '0.1.0', kinds: [] },
];

function scaffold(name, { docs = data, home = fs.mkdtempSync(path.join(tmp, 'home-')) } = {}) {
  const cwd = fs.mkdtempSync(path.join(tmp, 'workspace-'));
  execFileSync('sh', [path.join(evals, name, 'scaffold.sh')], {
    cwd,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_POSH_DOCSETS: JSON.stringify({ ok: true, project_path: cwd, data: docs }) },
    stdio: 'pipe',
  });
  return { cwd, home };
}

test('all six evals have runnable scaffolds and stay out of the operator home', () => {
  assert.equal(cases.length, 6);
  for (const spec of cases) {
    const { cwd, home } = scaffold(spec.name);
    assert.ok(fs.existsSync(path.join(cwd, 'Gemfile.lock')));
    if (spec.name !== 'typo-control') {
      assert.equal(fs.realpathSync(path.join(home, '.local/share/posh')), path.join(real, '.local/share/posh'));
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(real, '.local/share/posh')), []);
  assert.deepEqual(fs.readdirSync(path.join(real, '.local/state/posh')), []);
});

test('scaffold preflight fails on missing or wrong-version docs', () => {
  assert.throws(() => scaffold('activerecord-api', { docs: [] }));
  assert.throws(() => scaffold('activerecord-api', {
    docs: [{ ref: 'gem:activerecord', version: '7.0.0', kinds: ['rdoc'] }],
  }));
  assert.throws(() => scaffold('undocumented-gem', {
    docs: [{ ref: 'gem:widget_press', version: '0.1.0', kinds: ['rdoc'] }],
  }));
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

test('adoption requires search then read, a successful result, and unbiased ablation scoring', () => {
  for (const spec of cases.filter((item) => item.tags.includes('adoption') || item.tags.includes('interception'))) {
    assert.ok(spec.graders.some((grader) =>
      grader.type === 'tool_order' && grader.before.endsWith('__search') && grader.after.endsWith('__read') && grader.arm === 'with-only'));
    const success = spec.graders.find((grader) => grader.name === 'documentation-read-succeeded');
    const pattern = new RegExp(success.pattern);
    assert.equal(pattern.test(JSON.stringify({ ok: true, summary: 'Document read', data: { content: 'docs' } })), true);
    assert.equal(pattern.test(JSON.stringify({ ok: false, code: 'license_required' })), false);
    assert.equal(pattern.test(JSON.stringify({ ref: 'posh://gem:activerecord/rdoc/Relation.md' })), false);
    assert.ok(spec.graders.some((grader) => grader.type === 'llm' && grader.arm !== 'with-only'));
    assert.ok(spec.graders.filter((grader) => grader.type !== 'llm').every((grader) => grader.arm === 'with-only'));
  }
});
