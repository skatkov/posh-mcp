// POSH plugin for OpenCode 2: adds the POSH ruleset to the system prompt of every
// model request, registers the MCP server, and provides /posh [on|off|feedback].
// Node hosts share lifecycle operations; the legacy shell hook remains standalone.

import fs from 'node:fs';
import path from 'node:path';
import { Error as ToolError } from '@opencode/plugin/promise/tool';
import { poshRedirect } from '../shared/lookup-policy.mjs';
import { guidance, ruleset, setMode } from '../shared/agent-lifecycle.mjs';

const withoutMentions = (items) => items?.map(({ mention, ...item }) => item);

export default {
  id: 'posh',

  async setup(ctx) {
    const sessionDirectory = async (sessionID) => {
      const session = await ctx.session.get({ sessionID });
      return fs.realpathSync(session.location.directory);
    };

    // A server the user configured themselves wins.
    await ctx.mcp.transform((editor) => {
      if (!editor.get('posh')) editor.set('posh', { type: 'local', command: ['posh', 'mcp'] });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'posh',
        description: 'Check docs for this project\'s versions first (on, off, feedback)',
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = (prompt.text || '').trim();
          const mode = arg === '' ? 'on' : arg;
          const text = setMode(mode) ?? ruleset + '\n\n' + arg;
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text,
            files: withoutMentions(prompt.files),
            agents: withoutMentions(prompt.agents),
            skills: withoutMentions(prompt.skills),
            delivery,
          });
        },
      });
    });

    // Compaction is a separate request kind and would otherwise lose the ruleset.
    const addRuleset = async (event) => {
      const text = guidance();
      if (text) event.system.push({ type: 'text', text });
    };
    await ctx.session.hook('context', addRuleset);
    await ctx.session.hook('compaction', addRuleset);

    // Only translate the host contract here; every lookup decision is shared.
    await ctx.tool.hook('execute.before', async ({ tool: toolName, input: args, sessionID }) => {
      const tools = { read: 'Read', grep: 'Grep', glob: 'Glob', shell: 'Bash', webfetch: 'WebFetch' };
      const tool = tools[toolName];
      if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return;
      let reason;
      try {
        const directory = await sessionDirectory(sessionID);
        const cwd = tool === 'Bash' && typeof args.workdir === 'string'
          ? path.resolve(directory, args.workdir)
          : directory;
        reason = await poshRedirect({
          session_id: `opencode-${sessionID}`, cwd, tool_name: tool,
          tool_input: tool === 'Read' ? { file_path: args.path } : args,
        });
      } catch {
        // Session and transport failures leave reason unset, so permissions stay unchanged.
      }
      if (reason) throw new ToolError({ message: reason });
    });
  },
};
