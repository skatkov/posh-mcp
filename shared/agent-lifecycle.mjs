import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modeFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'posh/agent-mode');
export const ruleset = fs.readFileSync(path.join(root, 'skills/posh/SKILL.md'), 'utf8')
  .replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
const feedback = fs.readFileSync(path.join(root, 'skills/posh/feedback.md'), 'utf8').trim();

export function readMode() {
  try {
    const mode = fs.readFileSync(modeFile, 'utf8').trim();
    return mode === 'off' || mode === 'feedback' ? mode : 'on';
  } catch {
    return 'on';
  }
}

function saveMode(mode) {
  const target = fs.lstatSync(modeFile, { throwIfNoEntry: false })?.isSymbolicLink()
    ? fs.realpathSync(modeFile) : modeFile;
  if (fs.existsSync(target)) fs.accessSync(target, fs.constants.W_OK);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(directory, '.agent-mode.'));
  try {
    const staged = path.join(staging, 'agent-mode');
    fs.writeFileSync(staged, mode + '\n', { mode: 0o600 });
    fs.renameSync(staged, target);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true });
    } catch {
      // Cleanup must not turn a committed rename into a reported save failure.
    }
  }
}

export function setMode(mode) {
  if (mode === 'auto') {
    return { text: 'POSH auto mode was removed. Tell the user to choose on or off; no mode was changed.' };
  }
  const replies = {
    on: 'POSH is now on for every project.',
    off: 'POSH is now off. Stop following earlier POSH instructions until the user turns it back on.',
    feedback: 'POSH feedback mode is now on for every project.',
  };
  if (!Object.hasOwn(replies, mode)) return null;
  const stopFeedback = mode === 'on' && readMode() === 'feedback'
    ? ' Stop adding the POSH feedback section.' : '';
  try {
    saveMode(mode);
  } catch {
    return { text: 'Could not save the POSH mode. Tell the user the save failed; do not confirm a mode change.' };
  }
  return { mode, text: replies[mode] + stopFeedback + ' Confirm in one short line.' };
}

export function guidance(mode = readMode()) {
  if (mode === 'off') return '';
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
