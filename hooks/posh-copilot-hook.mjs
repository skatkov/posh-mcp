import fs from 'node:fs';
import path from 'node:path';
import { poshRedirect, rubyProject } from '../shared/lookup-policy.mjs';
import { guidance, setMode } from '../shared/agent-lifecycle.mjs';

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
        if (context) {
          const text = guidance(cwd);
          if (text) context += '\n\n' + text;
          else if (mode === 'auto') context += ' This is not one, so stop following earlier POSH instructions.';
        }
      }
    } else if (event === 'SessionStart' || event === 'SubagentStart') context = guidance(cwd);
    if (context) {
      const project = rubyProject(cwd);
      // Copilot defaults plugin MCP servers to the plugin directory, not the Ruby project.
      if (project) context += `\n\nWhen using POSH in this session, pass ${JSON.stringify({ project })} to every MCP tool call. On the CLI, keep the same absolute project path with --project. The MCP server's default project may be the plugin directory, not this Ruby project.`;
      output = event === 'UserPromptSubmit'
        ? { modifiedTransformedPrompt: `${context}\n\n${input.transformedPrompt}` }
        : { additionalContext: context };
    }
  }
  if (output) console.log(JSON.stringify(output));
} catch {
  // Invalid transport, unavailable POSH and lifecycle failures leave the session alone.
}
