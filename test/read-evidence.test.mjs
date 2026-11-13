import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReport, expectedReads, hasSuccessfulRead } from '../evals/check-evidence.mjs';

const project = '/tmp/claude-eval-fixture/home/cwd';
const unrelated = 'gem:other/rdoc/Other.md';
const init = { type: 'system', subtype: 'init', cwd: project };
const call = (id, ref, scope) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_posh_docs__read', input: { ref, ...(scope === undefined ? {} : { project: scope }) } }] },
});
const result = (id, ref, ok = true) => ({
  type: 'user',
  message: { content: [{
    type: 'tool_result', tool_use_id: id,
    content: JSON.stringify(ok
      ? { data: { ref, content: 'API docs' }, ok: true, summary: 'Document read' }
      : { ok: false, code: 'license_required' }),
  }] },
});
const trace = (...events) => [init, ...events].map((event) => JSON.stringify(event)).join('\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posh-evidence-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const checker = fileURLToPath(new URL('../evals/check-evidence.mjs', import.meta.url));

for (const [name, ref] of Object.entries(expectedReads).filter(([, ref]) => ref)) {
  test(`${name}: reads are correlated by ID, document and project`, () => {
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', ref)), ref), true);
    assert.equal(hasSuccessfulRead(trace(call('read', ref, project), result('read', ref)), ref), true);
    assert.equal(hasSuccessfulRead(trace(call('read', ref, `${project}/`), result('read', ref)), ref), true);
    assert.equal(hasSuccessfulRead(trace(call('read', ref, '.'), result('read', ref)), ref), true);
    assert.equal(hasSuccessfulRead(trace(call('read', `posh://${ref}`), result('read', ref)), ref), true);
    const page = ref.split('#')[0];
    assert.equal(hasSuccessfulRead(trace(call('read', page), result('read', page)), ref), true);
    for (const scope of ['/another/project', '..', null, 17]) {
      assert.equal(hasSuccessfulRead(trace(call('read', ref, scope), result('read', ref)), ref), false);
    }
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('other-id', ref)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', unrelated)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', unrelated), result('read', unrelated)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', ref, false)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', ref, false), call('other', unrelated), result('other', unrelated)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', ref, false), call('wrong-project', ref, '/another/project'), result('wrong-project', ref)), ref), false);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), call('other', unrelated), result('other', unrelated), result('read', ref)), ref), true);
  });
}

test('JSON key order and MCP text-block envelopes do not affect evidence', () => {
  const ref = expectedReads['activerecord-api'];
  const reorder = (value) => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
    return value;
  };
  const response = result('read', ref);
  response.message.content[0].content = [{ type: 'text', text: response.message.content[0].content }];
  const reordered = [init, call('read', ref, project), response].map(reorder).map((event) => JSON.stringify(event)).join('\r\n');
  assert.equal(hasSuccessfulRead(reordered, ref), true);
});

test('list and outline discovery can lead to verified reads without a search call', () => {
  for (const ref of Object.values(expectedReads).filter(Boolean)) {
    const discovery = [
      ['docsets', {}],
      ['list', { ref: ref.split('/').slice(0, 2).join('/') }],
      ['outline', { ref }],
    ].map(([tool, input]) => ({
      type: 'assistant', message: { content: [{
        type: 'tool_use', id: tool, name: `mcp__plugin_posh_docs__${tool}`, input,
      }] },
    }));
    assert.equal(hasSuccessfulRead(trace(...discovery, call('read', ref), result('read', ref)), ref), true);
  }
});

test('results cannot borrow success from metadata or a sibling result block', () => {
  const ref = expectedReads['activerecord-api'];
  const response = result('read', ref, false);
  response.message.content.push(result('other', unrelated).message.content[0]);
  response.tool_use_result = { structuredContent: { ok: true, summary: 'Document read', data: { ref, content: 'API docs' } } };
  assert.equal(hasSuccessfulRead(trace(call('read', ref), call('other', unrelated), response), ref), false);
  assert.equal(hasSuccessfulRead(trace(call('read', ref), { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(result('read', ref)) }] } }), ref), false);
  const error = result('read', ref);
  error.message.content[0].is_error = true;
  assert.equal(hasSuccessfulRead(trace(call('read', ref), error), ref), false);
});

test('incomplete, malformed, and empty read evidence fails closed', () => {
  const ref = expectedReads['activerecord-api'];
  assert.equal(hasSuccessfulRead(trace(call('read', ref)), ref), false);
  assert.equal(hasSuccessfulRead([call('read', ref), result('read', ref)].map((event) => JSON.stringify(event)).join('\n'), ref), false);
  const response = result('read', ref);
  response.message.content[0].content = JSON.stringify({ ok: true, summary: 'Document read', data: { ref, content: '' } });
  assert.equal(hasSuccessfulRead(trace(call('read', ref), response), ref), false);
  assert.throws(() => hasSuccessfulRead(`${trace(call('read', ref), result('read', ref))}\nnot JSON`, ref), /line 4/);
});

test('report checker requires complete runs, retained traces and matching read evidence', () => {
  const tracePath = path.join(tmp, 'trace.jsonl');
  const ref = expectedReads['activerecord-api'];
  fs.writeFileSync(tracePath, trace(call('read', ref), result('read', ref)));
  const report = {
    schemaVersion: 1, partial: false, suite: { ablation: 'with-without' },
    cases: [{ name: 'activerecord-api', runsPerCase: 1, arms: {
      with: [{ error: null, tracePath }], without: [{ error: null }],
    } }],
  };
  assert.deepEqual(checkReport(report), { checked: 1, failures: [] });
  assert.throws(() => checkReport({ ...report, partial: true }), /complete/);
  assert.throws(() => checkReport({ ...report, suite: {} }), /complete/);
  report.cases[0].arms.without = [];
  assert.match(checkReport(report).failures.join('\n'), /incomplete run count/);
  report.cases[0].arms.without = [{ error: 'interrupted' }];
  assert.match(checkReport(report).failures.join('\n'), /did not finish/);
  report.cases[0].arms.without = [{ error: null }];
  fs.writeFileSync(tracePath, trace(call('read', unrelated), result('read', unrelated)));
  assert.match(checkReport(report).failures.join('\n'), /no successful read/);
  fs.unlinkSync(tracePath);
  assert.match(checkReport(report).failures.join('\n'), /cannot inspect retained trace/);
});

test('CLI exits nonzero when evidence is missing and succeeds for a verified read', () => {
  const tracePath = path.join(tmp, 'cli-trace.jsonl');
  const reportPath = path.join(tmp, 'report.json');
  const ref = expectedReads['activerecord-api'];
  const report = {
    schemaVersion: 1, partial: false, suite: { ablation: 'none' },
    cases: [{ name: 'activerecord-api', runsPerCase: 1, arms: { with: [{ error: null, tracePath }] } }],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(tracePath, trace(call('read', ref), result('read', ref)));
  assert.equal(spawnSync(process.execPath, [checker, reportPath]).status, 0);
  fs.writeFileSync(tracePath, '');
  assert.equal(spawnSync(process.execPath, [checker, reportPath]).status, 1);
  assert.equal(spawnSync(process.execPath, [checker]).status, 1);
});
