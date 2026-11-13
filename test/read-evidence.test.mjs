import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReport, expectedReads, inspectTrace } from '../evals/check-evidence.mjs';

const hasSuccessfulRead = (trace, expected) => inspectTrace(trace, expected).read;

const project = '/tmp/claude-eval-fixture/home/cwd';
const unrelated = 'gem:other/rdoc/Other.md';
const init = { type: 'system', subtype: 'init', cwd: project };
const denial = {
  type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', exit_code: 0, outcome: 'success',
  output: JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'POSH has local documentation for gem:activerecord 8.1.4.1.',
  } }),
};
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

test('redirect evidence requires a native denial before the successful read is issued', () => {
  const ref = expectedReads['hook-redirect'];
  assert.equal(inspectTrace(trace(denial, call('read', ref), result('read', ref)), ref).readAfterRedirect, true);
  for (const events of [
    [call('read', ref), result('read', ref), denial],
    [call('read', ref), denial, result('read', ref)],
    [denial, call('read', ref), result('read', ref, false)],
    [{ ...denial, type: 'assistant' }, call('read', ref), result('read', ref)],
    [{ ...denial, hook_event: 'SessionStart' }, call('read', ref), result('read', ref)],
    [{ ...denial, exit_code: 1 }, call('read', ref), result('read', ref)],
    [{ ...denial, outcome: 'error' }, call('read', ref), result('read', ref)],
    [{ ...denial, output: 'not JSON' }, call('read', ref), result('read', ref)],
    [{ ...denial, output: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) }, call('read', ref), result('read', ref)],
  ]) {
    assert.equal(inspectTrace(trace(...events), ref).readAfterRedirect, false);
  }
  const quoted = { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(denial) }] } };
  assert.equal(inspectTrace(trace(quoted, call('read', ref), result('read', ref)), ref).readAfterRedirect, false);
});

test('GitHub evidence counts correlated WebFetch outcomes, not URLs quoted in documentation', () => {
  const ref = expectedReads['github-source'];
  const url = 'https://github.com/sparklemotion/nokogiri/blob/v1.19.7/lib/nokogiri/xml/searchable.rb';
  const fetch = (id, url) => ({
    type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebFetch', input: { url } }] },
  });
  const fetched = (id, is_error = false) => ({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Fetch result' }] },
  });
  const docs = result('read', ref);
  docs.message.content[0].content = JSON.stringify({
    ok: true, summary: 'Document read', data: { ref, content: `Source: ${url}` },
  });
  const inspect = (...events) => inspectTrace(trace(call('read', ref), docs, ...events), ref);
  assert.equal(inspect().githubFetches, 0);
  assert.equal(inspect(fetch('denied', url), fetched('denied', true)).githubFetches, 0);
  assert.equal(inspect(fetch('ok', url), fetched('ok')).githubFetches, 1);
  assert.equal(inspect(fetch('pending', url)).githubFetches, 1);
  assert.equal(inspect(fetch('ok', url), fetched('wrong-id')).githubFetches, 1);
  assert.equal(inspect(fetch('ok', url), fetch('denied', url), fetched('denied', true), fetched('ok')).githubFetches, 1);
  assert.equal(inspect(fetch('raw', 'https://raw.githubusercontent.com/sparklemotion/nokogiri/v1.19.7/README.md'), fetched('raw')).githubFetches, 1);
  for (const unrelatedUrl of [
    'https://example.com/?next=https://github.com/sparklemotion/nokogiri',
    'https://github.com.example.com/sparklemotion/nokogiri',
    'https://github.com/another/project',
    'https://github.com/sparklemotion/nokogiri-other',
  ]) assert.equal(inspect(fetch('other', unrelatedUrl), fetched('other')).githubFetches, 0);
});

test('report checker enforces structured interception and GitHub requirements', () => {
  const tracePath = path.join(tmp, 'behavior-trace.jsonl');
  for (const name of ['hook-redirect', 'github-source']) {
    const ref = expectedReads[name];
    const report = {
      schemaVersion: 1, partial: false, suite: { ablation: 'none' },
      cases: [{ name, runsPerCase: 1, arms: { with: [{ error: null, tracePath }] } }],
    };
    const read = [call('read', ref), result('read', ref)];
    fs.writeFileSync(tracePath, trace(...read));
    assert.equal(checkReport(report).failures.length, name === 'hook-redirect' ? 1 : 0);
    fs.writeFileSync(tracePath, trace(denial, ...read));
    assert.deepEqual(checkReport(report), { checked: 1, failures: [] });
    if (name === 'hook-redirect') continue;
    fs.writeFileSync(tracePath, trace(...read, {
      type: 'assistant', message: { content: [{
        type: 'tool_use', id: 'fetch', name: 'WebFetch',
        input: { url: 'https://github.com/sparklemotion/nokogiri/blob/main/README.md' },
      }] },
    }));
    assert.match(checkReport(report).failures.join('\n'), /GitHub source fetch/);
  }
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
  report.cases[0].runsPerCase = 3; // Claude Code 2.1.323 retains this default under --runs 1.
  assert.match(checkReport(report).failures.join('\n'), /incomplete run count/);
  assert.deepEqual(checkReport(report, 1), { checked: 1, failures: [] });
  assert.throws(() => checkReport(report, 0), /positive integer/);
  report.cases[0].runsPerCase = 1;
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
  report.cases[0].runsPerCase = 3;
  fs.writeFileSync(reportPath, JSON.stringify(report));
  assert.equal(spawnSync(process.execPath, [checker, reportPath, '--runs', '1']).status, 0);
  assert.equal(spawnSync(process.execPath, [checker, reportPath, '--runs', '0']).status, 1);
  assert.equal(spawnSync(process.execPath, [checker, reportPath, '--runs']).status, 1);
  fs.writeFileSync(tracePath, '');
  assert.equal(spawnSync(process.execPath, [checker, reportPath]).status, 1);
  assert.equal(spawnSync(process.execPath, [checker]).status, 1);
});
