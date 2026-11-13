import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const expectedReads = JSON.parse(fs.readFileSync(new URL('./expected-reads.json', import.meta.url), 'utf8'));

const normalizeRef = (ref) => typeof ref === 'string' ? ref.replace(/^posh:\/\//, '') : null;

function matchesDocument(actual, expected) {
  const ref = normalizeRef(actual);
  if (!ref) return false;
  const [page, section] = ref.split('#');
  const [expectedPage, expectedSection] = expected.split('#');
  return page === expectedPage && (!section || !expectedSection || section === expectedSection);
}

function isNokogiriSource(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      ['github.com', 'www.github.com', 'raw.githubusercontent.com'].includes(url.hostname) &&
      /^\/sparklemotion\/nokogiri(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function inspectTrace(trace, expected) {
  const events = trace.split(/\r?\n/).map((line, index) => {
    if (!line.trim()) return null;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) return event;
    } catch {}
    throw new Error(`Invalid trace JSON at line ${index + 1}`);
  }).filter(Boolean);
  const calls = new Map();
  const evidence = { read: false, readAfterRedirect: false, githubFetches: 0 };
  let project;
  let redirected = false;
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string' && path.isAbsolute(event.cwd)) {
      project = path.resolve(event.cwd);
    }
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        const input = block.input;
        const scope = input && Object.hasOwn(input, 'project') ? input.project : project;
        const read = block.name === 'mcp__plugin_posh_docs__read' && project && typeof scope === 'string' &&
          path.resolve(project, scope) === project && matchesDocument(input?.ref, expected);
        const githubSource = block.name === 'WebFetch' && isNokogiriSource(input?.url);
        calls.set(block.id, { tool: block.name, ref: read ? normalizeRef(input.ref) : null, redirected, githubSource });
        // Unresolved fetches also fail closed; only a correlated error proves no successful fetch.
        if (githubSource) evidence.githubFetches++;
      }
      if (event.type !== 'user' || block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      calls.delete(block.tool_use_id);
      if (!call) continue;
      // Read this result block, never content or permission metadata belonging to a sibling.
      const content = Array.isArray(block.content)
        ? block.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
        : block.content;
      if (block.is_error === true) {
        const decision = Array.isArray(event.tool_result_meta)
          ? event.tool_result_meta.find((item) => item?.id === block.tool_use_id)?.permission_decision : null;
        if (decision?.decision === 'reject' && decision.source === 'hook' && decision.reason_type === 'hook' &&
            typeof content === 'string' &&
            content.startsWith(`PreToolUse:${call.tool} hook error: POSH has local documentation for `)) redirected = true;
        if (call.githubSource) evidence.githubFetches--;
        continue;
      }
      if (!call.ref) continue;
      if (typeof content !== 'string') continue;
      let body;
      try { body = JSON.parse(content); } catch { continue; }
      if (body?.ok === true && body.summary === 'Document read' &&
          normalizeRef(body.data?.ref) === call.ref &&
          typeof body.data?.content === 'string' && body.data.content.trim()) {
        evidence.read = true;
        if (call.redirected) evidence.readAfterRedirect = true;
      }
    }
  }
  return evidence;
}

export function checkReport(report, runsOverride) {
  if (runsOverride !== undefined && (!Number.isInteger(runsOverride) || runsOverride < 1)) {
    throw new Error('--runs must be a positive integer, matching the eval command');
  }
  if (!report || report.schemaVersion !== 1 || report.partial !== false ||
      !Array.isArray(report.cases) || !report.cases.length ||
      !['none', 'with-without'].includes(report.suite?.ablation)) {
    throw new Error('Expected a complete schemaVersion 1 eval report; partial runs are not adoption evidence');
  }
  const arms = report.suite?.ablation === 'with-without' ? ['with', 'without'] : ['with'];
  const failures = [];
  let checked = 0;
  for (const spec of report.cases) {
    if (!Object.hasOwn(expectedReads, spec.name) || !Number.isInteger(spec.runsPerCase) || spec.runsPerCase < 1) {
      throw new Error(`Unknown or invalid eval case: ${spec.name}`);
    }
    for (const arm of arms) {
      const runs = spec.arms?.[arm];
      if (!Array.isArray(runs) || runs.length !== (runsOverride ?? spec.runsPerCase)) {
        failures.push(`${spec.name} [${arm}]: incomplete run count`);
        continue;
      }
      for (const [index, run] of runs.entries()) {
        const label = `${spec.name} [${arm}] run ${index + 1}`;
        if (!run || run.error || run.aborted || run.skippedPaidGraders) {
          failures.push(`${label}: run did not finish normally`);
          continue;
        }
        const expected = expectedReads[spec.name];
        if (arm !== 'with' || !expected) continue;
        checked++;
        try {
          const evidence = inspectTrace(fs.readFileSync(run.tracePath, 'utf8'), expected);
          if (!evidence.read) {
            failures.push(`${label}: no successful read of ${expected} in the fixture project`);
          }
          if (spec.name === 'hook-redirect' && !evidence.readAfterRedirect) {
            failures.push(`${label}: no successful POSH read issued after a native POSH denial`);
          }
          if (spec.name === 'github-source' && evidence.githubFetches) {
            failures.push(`${label}: successful or unresolved GitHub source fetch`);
          }
        } catch (error) {
          failures.push(`${label}: cannot inspect retained trace (${error.message})`);
        }
      }
    }
  }
  return { checked, failures };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [reportPath, flag, count, ...extra] = process.argv.slice(2);
    if (!reportPath || (flag !== undefined && (flag !== '--runs' || count === undefined)) || extra.length) {
      throw new Error('Usage: node evals/check-evidence.mjs REPORT.json [--runs N] (run evals with --keep-temp)');
    }
    const { checked, failures } = checkReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')), flag ? Number(count) : undefined);
    for (const failure of failures) console.error(failure);
    console.log(`POSH read evidence: ${checked} run(s) checked, ${failures.length} failure(s)`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
