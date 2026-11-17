import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkReport, expectedReads, inspectTrace } from '../evals/check-evidence.mjs';

const hasSuccessfulRead = (trace, expected) => inspectTrace(trace, expected).read;

const project = '/tmp/claude-eval-fixture/home/cwd';
const unrelated = 'gem:other/rdoc/Other.md';
const init = { type: 'system', subtype: 'init', cwd: project };
// Sanitized call/result envelope retained from Claude Code 2.1.323, without optional hook lifecycle events.
const denialEvents = fs.readFileSync(new URL('./fixtures/claude-hook-denial.jsonl', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line));
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
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
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
  const [lookup, denial] = denialEvents;
  assert.equal(inspectTrace(trace(...denialEvents, call('read', ref), result('read', ref)), ref).readAfterRedirect, true);
  for (const events of [
    [call('read', ref), result('read', ref), ...denialEvents],
    [lookup, call('read', ref), denial, result('read', ref)],
    [...denialEvents, call('read', ref), result('read', ref, false)],
    [denial, call('read', ref), result('read', ref)],
    [lookup, { ...denial, type: 'assistant' }, call('read', ref), result('read', ref)],
  ]) {
    assert.equal(inspectTrace(trace(...events), ref).readAfterRedirect, false);
  }
  const quoted = { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(denial) }] } };
  assert.equal(inspectTrace(trace(quoted, call('read', ref), result('read', ref)), ref).readAfterRedirect, false);
});

test('redirect evidence correlates hook rejection metadata and the POSH reason to the same result', () => {
  const ref = expectedReads['hook-redirect'];
  const [lookup, denial] = denialEvents;
  for (const mutate of [
    (event) => { delete event.tool_result_meta; },
    (event) => { event.tool_result_meta[0].id = 'another-call'; },
    (event) => { event.tool_result_meta[0].permission_decision.decision = 'accept'; },
    (event) => { event.tool_result_meta[0].permission_decision.source = 'config'; },
    (event) => { event.tool_result_meta[0].permission_decision.reason_type = 'rule'; },
    (event) => { event.message.content[0].is_error = false; },
    (event) => { event.message.content[0].content = 'Unrelated failure'; },
    (event) => { event.message.content[0].content = 'Quoted: ' + event.message.content[0].content; },
    (event) => { event.message.content[0].content = event.message.content[0].content.replace('PreToolUse:Grep', 'PreToolUse:Read'); },
    (event) => {
      event.message.content.push({ ...event.message.content[0], tool_use_id: 'another-call' });
      event.message.content[0].content = 'Unrelated failure';
    },
  ]) {
    const changed = structuredClone(denial);
    mutate(changed);
    assert.equal(inspectTrace(trace(lookup, changed, call('read', ref), result('read', ref)), ref).readAfterRedirect, false);
  }
  const textBlocks = structuredClone(denial);
  textBlocks.message.content[0].content = [{ type: 'text', text: textBlocks.message.content[0].content }];
  assert.equal(inspectTrace(trace(lookup, textBlocks, call('read', ref), result('read', ref)), ref).readAfterRedirect, true);
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
  for (const name of ['hook-redirect', 'github-source', 'activerecord-api']) {
    const ref = expectedReads[name];
    const report = {
      schemaVersion: 1, partial: false, suite: { ablation: 'none' },
      cases: [{ name, runsPerCase: 1, arms: { with: [{ error: null, tracePath }] } }],
    };
    const read = [call('read', ref), result('read', ref)];
    fs.writeFileSync(tracePath, trace(...read));
    assert.deepEqual(checkReport(report).failures, name === 'hook-redirect'
      ? ['hook-redirect [with] run 1: no successful POSH read issued after a native POSH denial'] : []);
    fs.writeFileSync(tracePath, trace(...denialEvents, ...read));
    assert.deepEqual(checkReport(report), { checked: 1, failures: [] });
    if (name === 'hook-redirect') continue;
    fs.writeFileSync(tracePath, trace(...read, {
      type: 'assistant', message: { content: [{
        type: 'tool_use', id: 'fetch', name: 'WebFetch',
        input: { url: 'https://github.com/sparklemotion/nokogiri/blob/main/README.md' },
      }] },
    }));
    assert.deepEqual(checkReport(report).failures, name === 'github-source'
      ? ['github-source [with] run 1: successful or unresolved GitHub source fetch'] : []);
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

test('trace parsing ignores blank lines but rejects non-object events with their line number', () => {
  const ref = expectedReads['activerecord-api'];
  const valid = trace(call('read', ref), result('read', ref));
  assert.equal(hasSuccessfulRead(`\n \t\n${valid}\n`, ref), true);
  for (const value of [null, true, 17, 'text', []]) {
    assert.throws(() => inspectTrace(`${JSON.stringify(init)}\n${JSON.stringify(value)}`, ref), /Invalid trace JSON at line 2/);
  }
});

test('only an absolute project from a system init event can authorize read evidence', () => {
  const ref = expectedReads['activerecord-api'];
  for (const invalid of [
    { ...init, type: 'user' }, { ...init, subtype: 'other' },
    { ...init, cwd: 'relative' }, { ...init, cwd: 17 }, { ...init, cwd: null },
  ]) {
    const events = [invalid, call('read', ref, project), result('read', ref)];
    assert.equal(hasSuccessfulRead(events.map((event) => JSON.stringify(event)).join('\n'), ref), false);
  }
});

test('document identity checks type, section and only a leading protocol prefix', () => {
  const ref = expectedReads['activerecord-api'];
  for (const actual of [null, 17, '', `${ref.split('#')[0]}#other-section`]) {
    assert.equal(hasSuccessfulRead(trace(call('read', actual), result('read', actual)), ref), false);
  }
  assert.equal(hasSuccessfulRead(trace(call('read', ref), result('read', `posh://${ref}`)), ref), true);
  const page = 'gem:example/rdoc/Thing.md';
  const embedded = 'gem:example/rdoc/posh://Thing.md';
  assert.equal(hasSuccessfulRead(trace(call('read', embedded), result('read', embedded)), page), false);
});

test('malformed blocks and non-read calls cannot become read evidence', () => {
  const ref = expectedReads['activerecord-api'];
  const original = call('read', ref);
  const block = original.message.content[0];
  for (const invalid of [
    { ...original, type: 'user' },
    { type: 'assistant', message: { content: [{ ...block, type: 'text' }] } },
    { type: 'assistant', message: { content: [{ ...block, type: 'tool_result' }] } },
    { type: 'assistant', message: { content: [{ ...block, name: 'another_tool' }] } },
    { type: 'assistant', message: { content: [{ ...block, input: undefined }] } },
    call(17, ref),
  ]) {
    const id = invalid.message.content[0].id;
    assert.equal(hasSuccessfulRead(trace(invalid, result(id, ref)), ref), false);
  }
  assert.equal(hasSuccessfulRead(trace({
    type: 'assistant', message: { content: [null, 17, 'text', true] },
  }, original, result('read', ref)), ref), true);
  const unrelatedCall = call('other', ref);
  unrelatedCall.message.content[0].name = 'Other';
  assert.equal(hasSuccessfulRead(trace(unrelatedCall, result('other', null)), ref), false);
});

test('a result consumes its call ID even when it contains no successful evidence', () => {
  const ref = expectedReads['activerecord-api'];
  const failed = result('read', ref);
  failed.message.content[0].is_error = true;
  assert.equal(hasSuccessfulRead(trace(call('read', ref), failed, result('read', ref)), ref), false);
  const wrongRole = result('read', ref);
  wrongRole.type = 'assistant';
  assert.equal(hasSuccessfulRead(trace(call('read', ref), wrongRole), ref), false);
  const wrongType = result('read', ref);
  wrongType.message.content[0].type = 'tool_use';
  assert.equal(hasSuccessfulRead(trace(call('read', ref), wrongType), ref), false);
});

test('successful read envelopes require the exact success fields and nonblank text', () => {
  const ref = expectedReads['activerecord-api'];
  for (const body of [
    null, { ok: true }, { ok: true, summary: 'Other', data: { ref, content: 'API' } },
    { ok: 1, summary: 'Document read', data: { ref, content: 'API' } },
    { ok: false, summary: 'Document read', data: { ref, content: 'API' } },
    { summary: 'Document read', data: { ref, content: 'API' } },
    { ok: true, summary: 'Document read' },
    { ok: true, summary: 'Document read', data: { ref, content: ' \n\t ' } },
    { ok: true, summary: 'Document read', data: { ref, content: 17 } },
  ]) {
    const response = result('read', ref);
    response.message.content[0].content = JSON.stringify(body);
    assert.equal(hasSuccessfulRead(trace(call('read', ref), response), ref), false);
  }
  for (const content of [17, null, 'not json']) {
    const response = result('read', ref);
    response.message.content[0].content = content;
    assert.equal(hasSuccessfulRead(trace(call('read', ref), response), ref), false);
  }
});

test('text blocks ignore non-text items and cannot join fragments into fabricated JSON', () => {
  const ref = expectedReads['activerecord-api'];
  const response = result('read', ref);
  const text = response.message.content[0].content;
  response.message.content[0].content = [null, { type: 'image' }, { type: 'text', text }];
  assert.equal(hasSuccessfulRead(trace(call('read', ref), response), ref), true);
  response.message.content[0].content = [
    { type: 'text', text: text.slice(0, 3) }, { type: 'text', text: text.slice(3) },
  ];
  assert.equal(hasSuccessfulRead(trace(call('read', ref), response), ref), false);
});

test('redirect metadata tolerates unrelated rows but requires textual hook output', () => {
  const ref = expectedReads['hook-redirect'];
  const [lookup, original] = denialEvents;
  const denial = structuredClone(original);
  denial.tool_result_meta.unshift(null, { permission_decision: { decision: 'reject' } });
  assert.equal(inspectTrace(trace(lookup, denial, call('read', ref), result('read', ref)), ref).readAfterRedirect, true);
  denial.message.content[0].content = 17;
  assert.equal(inspectTrace(trace(lookup, denial, call('read', ref), result('read', ref)), ref).readAfterRedirect, false);
});

test('GitHub source matching checks protocol, host and repository boundaries', () => {
  const ref = expectedReads['github-source'];
  for (const [url, count] of [
    ['http://www.github.com/sparklemotion/nokogiri', 1],
    ['https://github.com/sparklemotion/nokogiri', 1],
    ['ftp://github.com/sparklemotion/nokogiri/README.md', 0],
    ['https://github.com/other/sparklemotion/nokogiri/README.md', 0],
    ['not a URL', 0], [null, 0],
  ]) {
    const event = { type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'fetch', name: 'WebFetch', input: { url },
    }] } };
    assert.equal(inspectTrace(trace(event), ref).githubFetches, count);
    event.message.content[0].name = 'Other';
    assert.equal(inspectTrace(trace(event), ref).githubFetches, 0);
  }
  assert.equal(inspectTrace(trace({
    type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fetch', name: 'WebFetch' }] },
  }), ref).githubFetches, 0);
});

test('report validation rejects invalid schema, cases and run counts', () => {
  const report = {
    schemaVersion: 1, partial: false, suite: { ablation: 'none' },
    cases: [{ name: 'typo-control', runsPerCase: 1, arms: { with: [{}] } }],
  };
  for (const invalid of [
    null, {}, { ...report, schemaVersion: 2 }, { ...report, partial: true },
    { ...report, cases: [] }, { ...report, cases: {} }, { ...report, suite: undefined },
  ]) assert.throws(() => checkReport(invalid), /Expected a complete schemaVersion 1 eval report/);
  for (const spec of [
    { name: 'unknown', runsPerCase: 1 }, { name: 'typo-control', runsPerCase: 0 },
    { name: 'typo-control', runsPerCase: 1.5 },
  ]) assert.throws(() => checkReport({ ...report, cases: [spec] }), /Unknown or invalid eval case/);
  assert.deepEqual(checkReport({ ...report, cases: [{ name: 'typo-control', runsPerCase: 1 }] }), {
    checked: 0, failures: ['typo-control [with]: incomplete run count'],
  });
  for (const run of [null, { error: 'failed' }, { aborted: true }, { skippedPaidGraders: true }]) {
    assert.deepEqual(checkReport({ ...report, cases: [{ ...report.cases[0], arms: { with: [run] } }] }), {
      checked: 0, failures: ['typo-control [with] run 1: run did not finish normally'],
    });
  }
});

async function runCli(args, script = checker) {
  vi.resetModules();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [argv[0], script, ...args];
  try {
    await import('../evals/check-evidence.mjs');
    return {
      status: process.exitCode,
      stdout: output.mock.calls.flat(),
      stderr: errors.mock.calls.flat(),
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
}

for (const script of [null, path.join(tmp, 'another-script.mjs')]) {
  test(`importing the checker has no CLI side effects: ${script}`, async () => {
    const status = process.exitCode;
    assert.deepEqual(await runCli([], script), { status, stdout: [], stderr: [] });
  });
}

for (const override of [false, true]) {
  test(`CLI reports verified evidence${override ? ' with a run-count override' : ''}`, async () => {
    const tracePath = path.join(tmp, 'direct-cli-trace.jsonl');
    const reportPath = path.join(tmp, 'direct-cli-report.json');
    const ref = expectedReads['activerecord-api'];
    fs.writeFileSync(tracePath, trace(call('read', ref), result('read', ref)));
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1, partial: false, suite: { ablation: 'none' },
      cases: [{ name: 'activerecord-api', runsPerCase: override ? 3 : 1, arms: { with: [{ tracePath }] } }],
    }));
    assert.deepEqual(await runCli([reportPath, ...(override ? ['--runs', '1'] : [])]), {
      status: 0, stdout: ['POSH read evidence: 1 run(s) checked, 0 failure(s)'], stderr: [],
    });
  });
}

test('CLI prints each evidence failure and exits nonzero', async () => {
  const reportPath = path.join(tmp, 'missing-trace-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 1, partial: false, suite: { ablation: 'none' },
    cases: [{ name: 'activerecord-api', runsPerCase: 2, arms: { with: [
      { tracePath: path.join(tmp, 'missing-1.jsonl') }, { tracePath: path.join(tmp, 'missing-2.jsonl') },
    ] } }],
  }));
  const out = await runCli([reportPath]);
  assert.equal(out.status, 1);
  assert.deepEqual(out.stdout, ['POSH read evidence: 2 run(s) checked, 2 failure(s)']);
  assert.equal(out.stderr.length, 2);
  assert.match(out.stderr[0], /activerecord-api \[with\] run 1: cannot inspect retained trace/);
  assert.match(out.stderr[1], /activerecord-api \[with\] run 2: cannot inspect retained trace/);
});

for (const args of [[], ['unused.json', '--other', '1'], ['unused.json', '--runs'], ['unused.json', '--runs', '1', 'extra']]) {
  test(`CLI rejects invalid arguments: ${JSON.stringify(args)}`, async () => {
    assert.deepEqual(await runCli(args), {
      status: 1, stdout: [],
      stderr: ['Usage: node evals/check-evidence.mjs REPORT.json [--runs N] (run evals with --keep-temp)'],
    });
  });
}

test('CLI catches malformed report JSON', async () => {
  const reportPath = path.join(tmp, 'invalid-report.json');
  fs.writeFileSync(reportPath, 'not json');
  const out = await runCli([reportPath]);
  assert.equal(out.status, 1);
  assert.deepEqual(out.stdout, []);
  assert.equal(out.stderr.length, 1);
  assert.match(out.stderr[0], /JSON/);
});
