// POSH plugin for OpenCode 2: adds the POSH ruleset to the system prompt of every
// model request, registers the MCP server, and provides /posh [on|off|auto|feedback].
// Mode logic mirrors hooks/posh-hook.sh; test/plugin.test.mjs keeps them in step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Error as ToolError } from '@opencode/plugin/promise/tool';

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

// The home directory is excluded because a stray ~/Gemfile does not make every folder Ruby.
function inRubyProject(start) {
  let dir = path.resolve(start);
  while (dir !== path.dirname(dir) && dir !== os.homedir()) {
    const names = fs.readdirSync(dir);
    if (names.some((name) => ['Gemfile', 'Gemfile.lock', 'gems.rb'].includes(name) || name.endsWith('.gemspec'))) {
      return true;
    }
    if (names.includes('.git')) return false;
    dir = path.dirname(dir);
  }
  return false;
}

const withoutMentions = (items) => items?.map(({ mention, ...item }) => item);

export default {
  id: 'posh',

  async setup(ctx) {
    const ruby = inRubyProject(ctx.location.directory);
    const active = () => {
      const mode = readMode();
      return mode === 'on' || mode === 'feedback' || (mode === 'auto' && ruby);
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
    const addRuleset = (event) => {
      if (!active()) return;
      const text = readMode() === 'feedback' ? ruleset + '\n\n' + feedback : ruleset;
      event.system.push({ type: 'text', text });
    };
    await ctx.session.hook('context', addRuleset);
    await ctx.session.hook('compaction', addRuleset);

    // Only translate the host contract here; every lookup decision lives in Ruby.
    await ctx.tool.hook('execute.before', async (event) => {
      const tools = { read: 'Read', grep: 'Grep', glob: 'Glob', shell: 'Bash', webfetch: 'WebFetch' };
      const tool = tools[event.tool];
      if (!tool || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) return;
      let reason;
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const args = event.input;
        const cwd = tool === 'Bash' && typeof args.workdir === 'string'
          ? path.resolve(session.location.directory, args.workdir)
          : session.location.directory;
        const input = {
          session_id: `opencode-${event.sessionID}`, cwd, tool_name: tool,
          tool_input: tool === 'Read' ? { file_path: args.path } : args,
        };
        const stdout = await new Promise((resolve, reject) => {
          const child = execFile('ruby', [path.join(root, 'hooks/posh-lookup.rb')], {
            cwd, timeout: 4000, killSignal: 'SIGKILL',
          }, (error, stdout) => error ? reject(error) : resolve(stdout));
          // A missing runtime may close stdin before the JSON write finishes.
          child.stdin.on('error', () => {});
          child.stdin.end(JSON.stringify(input));
        });
        if (stdout) reason = JSON.parse(stdout).reason;
      } catch {
        return; // Runtime, session, POSH and transport failures leave permissions alone.
      }
      if (typeof reason === 'string' && reason) throw new ToolError({ message: reason });
    });
  },
};
