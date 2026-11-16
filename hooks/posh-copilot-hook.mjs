import fs from 'node:fs';
import path from 'node:path';
import { poshRedirect, rubyProject } from '../shared/lookup-policy.mjs';
import { guidance, readMode, setMode } from '../shared/agent-lifecycle.mjs';

function projectContext(cwd) {
  const mode = readMode();
  const project = rubyProject(cwd);
  const reset = 'For this prompt, discard all earlier POSH project-path instructions. ';
  if (mode === 'off' || (mode === 'auto' && !project)) {
    return reset + `POSH is ${mode === 'off' ? 'off' : 'inactive in this non-Ruby directory (auto mode)'}. Stop following earlier POSH guidance until it is active again.`;
  }
  // Copilot defaults plugin MCP servers to the plugin directory, not the Ruby project.
  const scope = project
    ? `POSH is active for this Ruby project. Check its version-matched documentation before relying on memory when available. When using POSH, pass ${JSON.stringify({ project })} to every MCP tool call; on the CLI, keep the same absolute path with --project. Do not use the MCP server's default project.`
    : 'POSH is enabled, but no Ruby project was found from the current directory. Locate the intended Ruby project and pass its absolute path explicitly; do not reuse a previous project or the MCP server default.';
  return reset + scope + (mode === 'feedback' ? ' Include POSH feedback after meaningful POSH use.' : '');
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const event = process.argv[2];
  let output;
  if (event === 'PreToolUse') {
    const tools = { view: 'Read', grep: 'Grep', rg: 'Grep', glob: 'Glob', bash: 'Bash', web_fetch: 'WebFetch' };
    const tool = tools[input.toolName];
    const args = typeof input.toolArgs === 'string' ? JSON.parse(input.toolArgs) : input.toolArgs;
    const reason = tool && await poshRedirect({
      cwd: input.cwd,
      session_id: typeof input.sessionId === 'string' && input.sessionId ? `copilot-${input.sessionId}` : null,
      tool_name: tool,
      tool_input: tool === 'Read' && args ? { file_path: args.path } : args,
    });
    if (reason) output = { permissionDecision: 'deny', permissionDecisionReason: reason };
  } else {
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) process.exit(0);
    if (!fs.statSync(input.cwd).isDirectory()) process.exit(0);
    const cwd = fs.realpathSync(input.cwd);
    if (event === 'UserPromptSubmit' && typeof input.transformedPrompt !== 'string') process.exit(0);
    let context;
    if (event === 'UserPromptSubmit') {
      const [command, mode = 'on'] = typeof input.prompt === 'string' ? input.prompt.trim().split(/\s+/) : [];
      if (['/posh', '/posh:posh', '$posh', '$posh:posh', '@posh'].includes(command)) {
        context = setMode(mode);
        if (context) context = [context, guidance(cwd)].filter(Boolean).join('\n\n');
      }
    } else if (event === 'SessionStart' || event === 'SubagentStart') context = guidance(cwd);
    if (context || event === 'UserPromptSubmit') {
      const scope = projectContext(cwd);
      context = context ? `${context}\n\n${scope}` : scope;
      output = event === 'UserPromptSubmit'
        ? { modifiedTransformedPrompt: `${context}\n\n${input.transformedPrompt}` }
        : { additionalContext: context };
    }
  }
  if (output) console.log(JSON.stringify(output));
} catch {
  // Invalid transport, unavailable POSH and lifecycle failures leave the session alone.
}
