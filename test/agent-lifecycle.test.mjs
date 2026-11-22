import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { repo, tmp, modeFile, project, runHook, prompt, FEEDBACK } from './support/plugin-fixture.mjs';

const { guidance, readMode, ruleset, setMode } = await import('../shared/agent-lifecycle.mjs');
const missing = '\n\nThe posh command is not on PATH in this session, so no local documentation is reachable. Tell the user once, in one line, and do not call POSH tools or posh commands.';
const feedback = fs.readFileSync(path.join(repo, 'skills/posh/feedback.md'), 'utf8').trim();
const replies = {
  on: 'POSH is now on for every project.',
  off: 'POSH is now off. Stop following earlier POSH instructions until the user turns it back on.',
  feedback: 'POSH feedback mode is now on for every project.',
};

async function isolatedLifecycle(skill) {
  const root = project();
  fs.cpSync(path.join(repo, 'shared'), path.join(root, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills/posh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/posh/SKILL.md'), skill);
  fs.copyFileSync(path.join(repo, 'skills/posh/feedback.md'), path.join(root, 'skills/posh/feedback.md'));
  return import(path.join(root, 'shared/agent-lifecycle.mjs'));
}

test('ruleset loading strips only leading frontmatter and trims the body', async () => {
  const body = '# Guidance\n\n---\nbody: keep this\n---\n\nKeep the body.';
  const crlf = body.replaceAll('\n', '\r\n');
  for (const [skill, expected] of [
    [`---\nname: posh\n---\n\n${body}\n`, body],
    [`---\r\nname: posh\r\n---\r\n\r\n${crlf}\r\n`, crlf],
    [body, body],
  ]) assert.equal((await isolatedLifecycle(skill)).ruleset, expected);
});

test('mode state uses HOME when XDG_CONFIG_HOME is absent', async ({ onTestFinished }) => {
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  onTestFinished(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const home = project();
  const mode = path.join(home, '.config/posh/agent-mode');
  fs.mkdirSync(path.dirname(mode), { recursive: true });
  fs.writeFileSync(mode, 'off\n');
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  const lifecycle = await isolatedLifecycle('# Guidance');
  assert.equal(lifecycle.readMode(), 'off');
  assert.equal(lifecycle.setMode('on').text, replies.on + ' Confirm in one short line.');
  assert.equal(fs.readFileSync(mode, 'utf8'), 'on\n');
});

test('shell and Node agree on default, trimmed, and unknown saved modes', () => {
  const other = project('.git');
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  for (const [value, expected] of [
    [null, 'on'], ['on', 'on'], ['off\r\n', 'off'], ['feedback', 'feedback'],
    [' \tfeedback\r\n', 'feedback'], ['auto\n', 'on'], ['', 'on'], ['unknown', 'on'],
    ['\n off \n', 'off'], ['off\nfeedback\n', 'on'],
  ]) {
    if (value !== null) fs.writeFileSync(modeFile, value);
    assert.equal(readMode(), expected, value);
    const context = runHook('SessionStart', other)?.additionalContext;
    assert.equal(Boolean(context), expected !== 'off', value);
    assert.equal(Boolean(context?.includes(FEEDBACK)), expected === 'feedback', value);
  }
});

test('mode commands validate before writing and persist exactly the chosen mode', () => {
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  fs.writeFileSync(modeFile, 'off\n');
  for (const mode of ['auto', 'unknown', '', 'toString', '__proto__', null, undefined]) {
    assert.equal(setMode(mode), null);
    assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  }
  for (const mode of ['on', 'off', 'feedback']) {
    fs.rmSync(path.dirname(modeFile), { recursive: true });
    assert.deepEqual(setMode(mode), { mode, text: replies[mode] + ' Confirm in one short line.' });
    assert.equal(fs.readFileSync(modeFile, 'utf8'), mode + '\n');
    assert.deepEqual(fs.readdirSync(path.dirname(modeFile)), ['agent-mode']);
  }
});

test('switching from feedback to on explicitly revokes feedback', () => {
  for (const mode of Object.keys(replies)) {
    setMode('feedback');
    const stop = mode === 'on' ? ' Stop adding the POSH feedback section.' : '';
    assert.equal(setMode(mode).text, replies[mode] + stop + ' Confirm in one short line.');
  }
});

test('shell and Node mode saves update the target of a symlink without replacing the link', () => {
  const cwd = project('settings');
  const target = path.join(cwd, 'settings');
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(modeFile), target), modeFile);

  setMode('off');
  assert.equal(fs.readFileSync(target, 'utf8'), 'off\n');
  const result = runHook('UserPromptSubmit', cwd, prompt('/posh feedback'));
  assert.match(result.additionalContext, /POSH feedback mode is now on/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'feedback\n');
  assert.ok(fs.lstatSync(modeFile).isSymbolicLink());
});

test('failed Node mode saves retain the old setting and remove the staged file', ({ onTestFinished }) => {
  setMode('off');
  let stagedMode;
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((staged) => {
    stagedMode = fs.readFileSync(staged, 'utf8');
    throw new Error('rename failed');
  });
  onTestFinished(() => rename.mockRestore());
  const result = setMode('feedback');
  assert.match(result.text, /Could not save the POSH mode/);
  assert.equal(result.mode, undefined);
  assert.equal(rename.mock.calls.length, 1);
  const [[staged, destination]] = rename.mock.calls;
  assert.equal(path.dirname(path.dirname(staged)), path.dirname(modeFile));
  assert.equal(destination, modeFile);
  assert.equal(stagedMode, 'feedback\n');
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  assert.deepEqual(fs.readdirSync(path.dirname(modeFile)), ['agent-mode']);
});

test('failed shell mode saves report the failure and retain the old setting', () => {
  setMode('off');
  const cwd = project('.git');
  const bin = project();
  fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = runHook('UserPromptSubmit', cwd, prompt('/posh feedback'), { PATH: `${bin}:${process.env.PATH}` });
  assert.match(result.additionalContext, /Could not save the POSH mode/);
  assert.doesNotMatch(result.additionalContext, /mode is now on/);
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  assert.deepEqual(fs.readdirSync(path.dirname(modeFile)), ['agent-mode']);
});

test('guidance honors the current persisted mode', ({ onTestFinished }) => {
  const previous = process.env.PATH;
  onTestFinished(() => { process.env.PATH = previous; });
  const bin = project();
  fs.writeFileSync(path.join(bin, 'posh'), '', { mode: 0o755 });
  process.env.PATH = bin;
  assert.equal(guidance(), ruleset);
  for (const mode of Object.keys(replies)) {
    setMode(mode);
    const suffix = mode === 'feedback' ? '\n\n' + feedback : '';
    assert.equal(guidance(), mode === 'off' ? '' : ruleset + suffix);
  }
});

test('PATH discovery rejects missing, non-executable and directory entries, then checks later entries', ({ onTestFinished }) => {
  const previous = process.env.PATH;
  onTestFinished(() => { process.env.PATH = previous; });
  const bin = project();
  process.env.PATH = bin;
  assert.equal(guidance(), ruleset + missing);
  fs.writeFileSync(path.join(bin, 'posh'), '', { mode: 0o644 });
  assert.equal(guidance(), ruleset + missing);
  fs.unlinkSync(path.join(bin, 'posh'));
  fs.mkdirSync(path.join(bin, 'posh'));
  assert.equal(guidance(), ruleset + missing);
  const installed = project();
  fs.writeFileSync(path.join(installed, 'posh'), '', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${installed}`;
  assert.equal(guidance(), ruleset);
  setMode('feedback');
  assert.equal(guidance(), ruleset + '\n\n' + feedback);
});

test('an absent PATH uses the current directory and missing-POSH feedback retains both messages', ({ onTestFinished }) => {
  const previous = process.env.PATH;
  const cwd = process.cwd();
  onTestFinished(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  process.chdir(project());
  delete process.env.PATH;
  setMode('feedback');
  assert.equal(guidance(), ruleset + missing + '\n\n' + feedback);
  setMode('on');
  fs.writeFileSync('posh', '', { mode: 0o755 });
  assert.equal(guidance(), ruleset);
  process.env.PATH = '';
  assert.equal(guidance(), ruleset);
});
