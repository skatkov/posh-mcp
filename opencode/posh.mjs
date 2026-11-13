// POSH plugin for OpenCode 2: adds the POSH ruleset to the system prompt of every
// model request, registers the MCP server, and provides /posh [on|off|auto|feedback].
// Mode logic mirrors hooks/posh-hook.sh; test/plugin.test.mjs keeps them in step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Error as ToolError } from '@opencode/plugin/promise/tool';
import { poshRedirect, rubyProject } from '../shared/lookup-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modeFile = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'posh',
  'agent-mode',
);
const ruleset = fs
  .readFileSync(path.join(root, 'skills/posh/SKILL.md'), 'utf8')
  .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
  .trim();
const feedback = fs.readFileSync(path.join(root, 'skills/posh/feedback.md'), 'utf8').trim();

function readMode() {
  try {
    const mode = fs.readFileSync(modeFile, 'utf8').trim();
    return ['on', 'off', 'feedback'].includes(mode) ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

function writeMode(mode) {
  if (mode === 'auto') return fs.rmSync(modeFile, { force: true });
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  fs.writeFileSync(modeFile, mode + '\n');
}

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

    const replies = {
      on: 'POSH is now on for every project. Confirm in one short line.',
      off: 'POSH is now off. Confirm in one short line.',
      auto: 'POSH is now on for Ruby projects only. Confirm in one short line.',
      feedback: 'POSH feedback mode is now on for every project. Confirm in one short line.',
    };

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'posh',
        description: 'Check docs for this project\'s versions first (on, off, auto, feedback)',
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = (prompt.text || '').trim();
          const mode = arg === '' ? 'on' : arg;
          let text = replies[mode];
          if (text) writeMode(mode);
          else text = ruleset + '\n\n' + arg;
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
      const mode = readMode();
      if (mode === 'off') return;
      if (mode === 'auto') {
        try {
          if (!rubyProject(await sessionDirectory(event.sessionID))) return;
        } catch {
          return; // An unavailable session must not interrupt a model request.
        }
      }
      const text = mode === 'feedback' ? ruleset + '\n\n' + feedback : ruleset;
      event.system.push({ type: 'text', text });
    };
    await ctx.session.hook('context', addRuleset);
    await ctx.session.hook('compaction', addRuleset);

    // Only translate the host contract here; every lookup decision is shared.
    await ctx.tool.hook('execute.before', async (event) => {
      const tools = { read: 'Read', grep: 'Grep', glob: 'Glob', shell: 'Bash', webfetch: 'WebFetch' };
      const tool = tools[event.tool];
      if (!tool || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) return;
      let reason;
      try {
        const directory = await sessionDirectory(event.sessionID);
        const args = event.input;
        const cwd = tool === 'Bash' && typeof args.workdir === 'string'
          ? path.resolve(directory, args.workdir)
          : directory;
        const input = {
          session_id: `opencode-${event.sessionID}`, cwd, tool_name: tool,
          tool_input: tool === 'Read' ? { file_path: args.path } : args,
        };
        reason = await poshRedirect(input);
      } catch {
        return; // Runtime, session, POSH and transport failures leave permissions alone.
      }
      if (typeof reason === 'string' && reason) throw new ToolError({ message: reason });
    });
  },
};
