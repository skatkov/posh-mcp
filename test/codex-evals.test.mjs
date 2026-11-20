import assert from 'node:assert/strict';
import { test } from 'vitest';
import { expectedReads } from '../evals/check-evidence.mjs';
import { inspectCodexTrace } from '../evals/codex-evidence.mjs';

const project = '/tmp/project';
const expected = expectedReads['hook-redirect'];
const read = {
  type: 'McpToolCall', pluginId: 'posh@skatkov', server: 'docs', tool: 'read', status: 'completed',
  arguments: { project, ref: `posh://${expected}` },
  result: {
    structuredContent: { ok: true, summary: 'Document read', data: { ref: `posh://${expected}`, content: 'API docs' } },
  },
};
const denial = {
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    output: [{ type: 'input_text', text: 'Script error:\nCommand blocked by PreToolUse hook: POSH has local documentation for gem:activerecord 8.1.4.1' }],
  },
};
const completed = (item) => ({ type: 'event_msg', payload: { type: 'item_completed', item } });
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const turn = { type: 'turn.completed', usage: { input_tokens: 500 } };

test('Codex redirect evidence requires a tool denial before the POSH read completes', () => {
  const inspect = (...session) => inspectCodexTrace(jsonl(turn), jsonl(...session), project, expected);
  const { evidence, usage } = inspect(denial, completed(read));
  assert.equal(evidence.readAfterRedirect, true);
  assert.equal(usage.input_tokens, 500);
  assert.equal(inspect(completed(read), denial).evidence.readAfterRedirect, false);
  const quotedDenial = { type: 'response_item', payload: { type: 'message', content: denial.payload.output } };
  assert.equal(inspect(quotedDenial, completed(read)).evidence.redirected, false);
});

test('Codex read evidence rejects wrong projects, refs, plugins and errored MCP results', () => {
  for (const item of [
    { ...read, arguments: { ...read.arguments, project: '../other' } },
    { ...read, arguments: { ...read.arguments, ref: `${expected}-other` } },
    { ...read, pluginId: 'other@skatkov' },
    { ...read, result: { ...read.result, isError: true } },
    { ...read, result: { structuredContent: { ...read.result.structuredContent, data: { ref: expected, content: ' ' } } } },
  ]) {
    assert.equal(inspectCodexTrace(jsonl(turn), jsonl(completed(item)), project, expected).evidence.expectedRead, false);
  }
  assert.equal(inspectCodexTrace(jsonl(turn), jsonl(completed(read)), project, expected).evidence.expectedRead, true);
});

test('Codex counts failed POSH attempts once and checks fallback for a successful source read', () => {
  const mcp = { type: 'mcp_tool_call', server: 'docs', tool: 'search', id: '1' };
  const edit = { type: 'command_execution', id: '2', command: "bash -lc 'posh docsets'", exit_code: 1 };
  const command = "bash -lc 'cat vendor/bundle/ruby/4.0.0/gems/widget_press-0.1.0/lib/widget_press.rb'";
  const fallback = { type: 'command_execution', id: '3', command, aggregated_output: 'widgets.count { |widget| widget.temperature > 40 }' };
  const inspect = (exit_code) => inspectCodexTrace(jsonl(
    { type: 'item.started', item: mcp },
    { type: 'item.completed', item: { ...mcp, status: 'failed' } },
    { type: 'item.completed', item: edit },
    { type: 'item.completed', item: { ...fallback, exit_code } },
    turn,
  ), '', project, null).evidence;
  assert.equal(inspect(0).poshMcpCalls, 1);
  assert.equal(inspect(0).poshCliCommands, 1);
  assert.equal(inspect(0).reachedUndocumentedSource, true);
  assert.equal(inspect(1).reachedUndocumentedSource, false);
  assert.throws(() => inspectCodexTrace('', '', project, null), /did not complete/);
});
