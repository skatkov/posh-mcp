import path from 'node:path';
import { matchesDocument } from './check-evidence.mjs';

const redirectPrefix = 'Command blocked by PreToolUse hook: POSH has local documentation for gem:activerecord ';
const sourcePath = 'gems/widget_press-0.1.0/lib/widget_press.rb';

function jsonl(trace) {
  return trace.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function poshRead(item, project, expected) {
  if (item?.type !== 'McpToolCall' || item.pluginId !== 'posh@skatkov' || item.server !== 'docs' ||
      item.tool !== 'read' || item.status !== 'completed' || item.error || item.result?.isError) return false;

  // The POSH stdio server starts in the fixture directory. An explicit override must resolve there too.
  const args = item.arguments;
  const scope = args && Object.hasOwn(args, 'project') ? args.project : project;
  if (!expected || typeof scope !== 'string' || path.resolve(project, scope) !== project ||
      !matchesDocument(args?.ref, expected)) return false;
  const doc = item.result?.structuredContent;
  return doc?.ok === true && doc.summary === 'Document read' &&
    typeof doc.data?.ref === 'string' &&
    args.ref.replace(/^posh:\/\//, '') === doc.data.ref.replace(/^posh:\/\//, '') &&
    typeof doc.data?.content === 'string' && Boolean(doc.data.content.trim());
}

export function inspectCodexTrace(events, session, project, expected) {
  const trace = jsonl(events);
  const turn = trace.findLast((event) => event.type === 'turn.completed');
  if (!turn || trace.some((event) => event.type === 'turn.failed')) {
    throw new Error('Codex did not complete the turn');
  }

  const poshCalls = new Set();
  const commands = new Map();
  const webSearches = new Set();
  for (const { type, item } of trace) {
    if (type !== 'item.started' && type !== 'item.completed') continue;
    if (item.type === 'mcp_tool_call' && item.server === 'docs') poshCalls.add(item.id);
    if (item.type === 'command_execution') commands.set(item.id, item);
    if (item.type === 'web_search') webSearches.add(item.id);
  }

  const evidence = {
    expectedRead: false,
    redirected: false,
    readAfterRedirect: false,
    poshMcpCalls: poshCalls.size,
    poshCliCommands: [...commands.values()].filter(({ command }) =>
      /(?:^|[\s'"/;&|])posh\s+(?:docsets|search|list|outline|read|sync)(?:\s|['"]|$)/.test(command)).length,
    reachedUndocumentedSource: [...commands.values()].some(({ command, exit_code, aggregated_output }) =>
      exit_code === 0 && aggregated_output?.includes('widget.temperature > 40') &&
      (command.includes(sourcePath) || aggregated_output.includes(sourcePath))),
    webSearches: webSearches.size,
  };
  for (const { type, payload } of jsonl(session)) {
    if (type === 'response_item' && payload.type === 'function_call_output' &&
        typeof payload.output === 'string' && payload.output.startsWith(redirectPrefix)) {
      evidence.redirected = true;
    }
    if (type === 'response_item' && payload.type === 'custom_tool_call_output' &&
        Array.isArray(payload.output) && payload.output.some(({ type: kind, text }) =>
          kind === 'input_text' && text?.startsWith(`Script error:\n${redirectPrefix}`))) {
      evidence.redirected = true;
    }
    if (type === 'event_msg' && payload.type === 'item_completed' && poshRead(payload.item, project, expected)) {
      evidence.expectedRead = true;
      evidence.readAfterRedirect ||= evidence.redirected;
    }
  }
  return { evidence, usage: turn.usage };
}
