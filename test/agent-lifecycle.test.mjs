import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo, tmp, modeFile, project } from './support/plugin-fixture.mjs';

const { guidance, readMode, ruleset, setMode } = await import('../shared/agent-lifecycle.mjs');
const missing = '\n\nThe posh command is not on PATH in this session, so no local documentation is reachable. Tell the user once, in one line, and do not call POSH tools or posh commands.';
const feedback = fs.readFileSync(path.join(repo, 'skills/posh/feedback.md'), 'utf8').trim();
const replies = {
  on: 'POSH is now on for every project.',
  off: 'POSH is now off. Stop following earlier POSH instructions until the user turns it back on.',
  auto: 'POSH is now on for Ruby projects only.',
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

test('mode state uses HOME when XDG_CONFIG_HOME is absent', async (t) => {
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  t.after(() => {
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
  assert.equal(lifecycle.setMode('on'), replies.on + ' Confirm in one short line.');
  assert.equal(fs.readFileSync(mode, 'utf8'), 'on\n');
});

test('mode discovery defaults safely and accepts only trimmed, known modes', () => {
  assert.equal(readMode(), 'auto');
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  for (const [value, expected] of [
    ['on', 'on'], ['off', 'off'], ['feedback', 'feedback'],
    [' \tfeedback\r\n', 'feedback'], ['auto', 'auto'], ['', 'auto'], ['unknown', 'auto'],
  ]) {
    fs.writeFileSync(modeFile, value);
    assert.equal(readMode(), expected, value);
  }
});

test('mode commands validate before writing and persist exactly the chosen mode', () => {
  fs.mkdirSync(path.dirname(modeFile), { recursive: true });
  fs.writeFileSync(modeFile, 'off\n');
  for (const mode of ['unknown', '', 'toString', '__proto__', null, undefined]) {
    assert.equal(setMode(mode), null);
    assert.equal(fs.readFileSync(modeFile, 'utf8'), 'off\n');
  }
  for (const mode of ['on', 'off', 'feedback']) {
    fs.rmSync(path.dirname(modeFile), { recursive: true });
    assert.equal(setMode(mode), replies[mode] + ' Confirm in one short line.');
    assert.equal(fs.readFileSync(modeFile, 'utf8'), mode + '\n');
  }
  assert.equal(setMode('auto'), replies.auto + ' Stop adding the POSH feedback section. Confirm in one short line.');
  assert.equal(fs.existsSync(modeFile), false);
  assert.equal(setMode('auto'), replies.auto + ' Confirm in one short line.');
});

test('feedback is revoked only when switching from feedback to on or auto', () => {
  for (const mode of Object.keys(replies)) {
    setMode('feedback');
    const stop = ['on', 'auto'].includes(mode) ? ' Stop adding the POSH feedback section.' : '';
    assert.equal(setMode(mode), replies[mode] + stop + ' Confirm in one short line.');
  }
});

test('failed mode writes throw instead of confirming an unpersisted mode', () => {
  fs.mkdirSync(modeFile, { recursive: true });
  assert.throws(() => setMode('off'));
  fs.rmdirSync(modeFile);
});

test('guidance honors explicit modes, current persisted mode, and Ruby project discovery', (t) => {
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  const bin = project();
  fs.writeFileSync(path.join(bin, 'posh'), '', { mode: 0o755 });
  process.env.PATH = bin;
  const ruby = project('Gemfile');
  const other = project('.git');
  assert.equal(guidance(other), '');
  assert.equal(guidance(ruby), ruleset);
  for (const mode of ['on', 'off', 'auto', 'feedback']) {
    setMode(mode);
    const suffix = mode === 'feedback' ? '\n\n' + feedback : '';
    assert.equal(guidance(ruby), mode === 'off' ? '' : ruleset + suffix);
    assert.equal(guidance(other), ['off', 'auto'].includes(mode) ? '' : ruleset + suffix);
  }
  assert.equal(guidance('/not/a/project', 'on'), ruleset);
  assert.equal(guidance('/not/a/project', 'off'), '');
  assert.equal(guidance('/not/a/project', 'feedback'), ruleset + '\n\n' + feedback);
});

test('PATH discovery rejects missing, non-executable and directory entries, then checks later entries', (t) => {
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  const bin = project();
  process.env.PATH = bin;
  assert.equal(guidance(null, 'on'), ruleset + missing);
  fs.writeFileSync(path.join(bin, 'posh'), '', { mode: 0o644 });
  assert.equal(guidance(null, 'on'), ruleset + missing);
  fs.unlinkSync(path.join(bin, 'posh'));
  fs.mkdirSync(path.join(bin, 'posh'));
  assert.equal(guidance(null, 'on'), ruleset + missing);
  const installed = project();
  fs.writeFileSync(path.join(installed, 'posh'), '', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${installed}`;
  assert.equal(guidance(null, 'on'), ruleset);
  assert.equal(guidance(null, 'feedback'), ruleset + '\n\n' + feedback);
});

test('an absent PATH uses the current directory and missing-POSH feedback retains both messages', (t) => {
  const previous = process.env.PATH;
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  process.chdir(project());
  delete process.env.PATH;
  assert.equal(guidance(null, 'feedback'), ruleset + missing + '\n\n' + feedback);
  fs.writeFileSync('posh', '', { mode: 0o755 });
  assert.equal(guidance(null, 'on'), ruleset);
  process.env.PATH = '';
  assert.equal(guidance(null, 'on'), ruleset);
});
