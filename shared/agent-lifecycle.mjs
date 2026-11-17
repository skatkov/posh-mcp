import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubyProject } from './lookup-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const modeFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'posh/agent-mode');
export const ruleset = fs.readFileSync(path.join(root, 'skills/posh/SKILL.md'), 'utf8')
  .replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
const feedback = fs.readFileSync(path.join(root, 'skills/posh/feedback.md'), 'utf8').trim();

export function readMode() {
  try {
    const mode = fs.readFileSync(modeFile, 'utf8').trim();
    return ['on', 'off', 'feedback'].includes(mode) ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

export function setMode(mode) {
  const replies = {
    on: 'POSH is now on for every project.',
    off: 'POSH is now off. Stop following earlier POSH instructions until the user turns it back on.',
    auto: 'POSH is now on for Ruby projects only.',
    feedback: 'POSH feedback mode is now on for every project.',
  };
  if (!Object.hasOwn(replies, mode)) return null;
  const stopFeedback = readMode() === 'feedback' && ['on', 'auto'].includes(mode)
    ? ' Stop adding the POSH feedback section.' : '';
  if (mode === 'auto') fs.rmSync(modeFile, { force: true });
  else {
    fs.mkdirSync(path.dirname(modeFile), { recursive: true });
    fs.writeFileSync(modeFile, mode + '\n');
  }
  return replies[mode] + stopFeedback + ' Confirm in one short line.';
}

export function guidance(directory, mode = readMode()) {
  if (mode === 'off' || (mode === 'auto' && !rubyProject(directory))) return '';
  let text = ruleset;
  const installed = (process.env.PATH || '').split(path.delimiter).some((directory) => {
    try {
      const executable = path.resolve(directory, 'posh');
      fs.accessSync(executable, fs.constants.X_OK);
      return fs.statSync(executable).isFile();
    } catch {
      // Missing or inaccessible candidates do not stop the PATH search.
    }
  });
  if (!installed) text += '\n\nThe posh command is not on PATH in this session, so no local documentation is reachable. Tell the user once, in one line, and do not call POSH tools or posh commands.';
  if (mode === 'feedback') text += '\n\n' + feedback;
  return text;
}
