import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, test, vi } from 'vitest';
import { rubyProject, expandPath, lookupForPath, lookupForUrl, commandWords, commandOptions, commandOperands, lookupForCommand, poshRedirect } from '../shared/lookup-policy.mjs';

const cwd = '/project';
const saved = { GEM_HOME: process.env.GEM_HOME, GEM_PATH: process.env.GEM_PATH };
beforeEach(() => {
  delete process.env.GEM_HOME;
  delete process.env.GEM_PATH;
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('project discovery finds markers, stops at repositories, and excludes HOME and the filesystem root', ({ onTestFinished }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posh-project-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.git'), '');
  const nested = path.join(root, 'app/models');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(rubyProject(nested), null);
  for (const marker of ['Gemfile', 'Gemfile.lock', 'gems.rb', 'app.gemspec']) {
    fs.writeFileSync(path.join(root, marker), '');
    assert.equal(rubyProject(nested), root);
    fs.unlinkSync(path.join(root, marker));
  }
  fs.writeFileSync(path.join(root, 'Gemfile'), '');
  const inner = path.join(root, 'nested-repo');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, '.git'), '');
  assert.equal(rubyProject(inner), null);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  assert.equal(rubyProject(nested), null);
  assert.equal(rubyProject(path.parse(root).root), null);
});

test('path expansion rejects non-strings and resolves relative, absolute and home paths', () => {
  for (const value of [undefined, null, 17, {}, [], true]) {
    assert.throws(() => expandPath(value, cwd), { name: 'TypeError', message: 'Expected a path' });
  }
  assert.equal(expandPath('lib/../app', cwd), '/project/app');
  assert.equal(expandPath('/outside/app', cwd), '/outside/app');
  assert.equal(expandPath('~', cwd), os.homedir());
  assert.equal(expandPath('~/gems', cwd), path.join(os.homedir(), 'gems'));
});

test('path classification handles multi-digit and two-part Ruby versions', () => {
  for (const root of [
    '/var/lib/gems/12.34.56', '/var/lib/gems/12.34', '/usr/share/rubygems-integration/12.34',
    '/app/vendor/bundle/12.34.56', '/app/vendor/bundle/12.34',
  ]) {
    assert.equal(lookupForPath(`${root}/gems/kamal-2.12.0/lib/kamal.rb`, cwd), 'gem:kamal', root);
  }
  for (const file of [
    '/usr/share/rubygems-integration/x.34/gems/kamal-2.12.0',
    '/usr/share/rubygems-integration/12.xy/gems/kamal-2.12.0',
    '/project/app/models/kamal.rb',
  ]) assert.equal(lookupForPath(file, cwd), null, file);
  assert.equal(typeof lookupForPath('/app/vendor/bundle/not-an-install/gems/kamal-2.12.0', cwd), 'symbol');
  for (const root of ['/home/x/.gem/ruby/3.4.0', '/home/x/.local/share/gem/jruby/3.1.0', '/var/lib/gems/12.34']) {
    assert.equal(lookupForPath(`${root}/gems/kamal-2.12.0`, cwd), 'gem:kamal');
    assert.equal(typeof lookupForPath(root, cwd), 'symbol');
  }
  assert.equal(lookupForPath('/app/vendor/bundle/ruby/3.4.0/gems/outer-1.0/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0', cwd), 'gem:kamal');
});

test('exported gem homes preserve root boundaries and search every configured home', () => {
  process.env.GEM_HOME = '/custom';
  process.env.GEM_PATH = ['/other', '/longer/home'].join(path.delimiter);
  for (const root of ['/custom', '/other', '/longer/home']) {
    assert.equal(lookupForPath(`${root}/gems/kamal-2.12.0`, cwd), 'gem:kamal');
    assert.equal(typeof lookupForPath(root, cwd), 'symbol');
    assert.equal(typeof lookupForPath(`${root}/gems`, cwd), 'symbol');
    assert.equal(lookupForPath(`${root}/app/models/kamal.rb`, cwd), null);
    assert.equal(lookupForPath(`${root}-sibling/gems/kamal-2.12.0`, cwd), null);
  }
});

test('URL classification accepts HTTP, HTTPS and documented host aliases', () => {
  for (const host of ['rubydoc.info', 'www.rubydoc.info', 'rubygems.org', 'www.rubygems.org']) {
    assert.equal(lookupForUrl(`http://${host}/gems/kamal`), 'gem:kamal');
    assert.equal(lookupForUrl(`https://${host}/gems/kamal/Kamal`), 'gem:kamal');
  }
  for (const host of ['api.rubyonrails.org', 'guides.rubyonrails.org']) {
    assert.equal(lookupForUrl(`https://${host}/index.html`), 'gem:rails');
  }
  for (const value of [
    'https://github.com/basecamp/kamal/blob/main/README.md',
    'https://github.com/basecamp/kamal/raw/main/README.md',
    'https://raw.githubusercontent.com/basecamp/kamal/main/README.md',
    'https://rubygems.org/downloads/kamal-2.12.0.gem',
  ]) assert.equal(lookupForUrl(value), 'gem:kamal');
  for (const value of [
    undefined, null, {}, { toString: () => 'https://rubygems.org/gems/kamal' },
    ' https://rubygems.org/gems/kamal', 'ftp://rubygems.org/gems/kamal', 'https://[',
    'https://rubygems.org/downloads/kamal-2.12.0.gem/extra',
    'https://rubygems.org/other/gems/kamal',
    'https://rubygems.org/other/downloads/kamal-2.12.0.gem',
    'https://github.com/!/basecamp/kamal/blob/main/README.md',
    'https://github.com/basecamp/kamal/pull/100',
    'https://raw.githubusercontent.com/!/basecamp/kamal/main/README.md',
  ]) assert.equal(lookupForUrl(value), null);
});

test('shell words preserve empty tokens, whitespace and literal escapes', () => {
  for (const [command, expected] of [
    ['', []], [' \t ', []], ['  cat   file   ', ['cat', 'file']],
    ['grep "" file', ['grep', '', 'file']], ['\\a b', ['a', 'b']],
    ['cat "\\q"', ['cat', '\\q']], ['cat "\\$"', ['cat', '$']],
    ['cat "\\`"', ['cat', '`']], ['cat "\\\\"', ['cat', '\\']],
    ['cat "\\"" ', ['cat', '"']], ["cat '$HOME'", ['cat', '$HOME']],
    ['cat "file;name"', ['cat', 'file;name']],
    ['bundle show ka\\mal', ['bundle', 'show', 'kamal']],
    ['bundle \\\nshow kamal', ['bundle', 'show', 'kamal']],
  ]) assert.deepEqual(commandWords(command), expected, command);
  for (const separator of [';', '&&', '|', '<', '>', '\n']) {
    assert.deepEqual(commandWords(`cat file ${separator} ignored`), ['cat', 'file']);
  }
  for (const command of [undefined, null, 17, {}, 'cat "unterminated', 'cat file\\', 'cat "$HOME"', 'cat `pwd`']) {
    assert.equal(commandWords(command), null);
  }
});

test('command operands stop at find expressions and preserve non-AWK assignments', () => {
  for (const expression of ['!', '(', '-name']) {
    assert.deepEqual(commandOperands('find', ['app', expression, '/not-a-root']), ['app']);
  }
  assert.deepEqual(commandOperands('find', ['app', 'lib']), ['app', 'lib']);
  assert.deepEqual(commandOperands('unknown', ['app']), []);
  assert.deepEqual(commandOperands('cat', ['name=value']), ['name=value']);
  assert.deepEqual(commandOperands('awk', ['{print}', 'name=value', 'dir/file=value']), ['dir/file=value']);
  assert.deepEqual(commandOperands('awk', ['-f', 'script.awk', 'file']), ['file']);
  assert.deepEqual(commandOperands('grep', ['--file', 'patterns', 'file']), ['file']);
  assert.deepEqual(commandOperands('grep', ['--regexp', 'pattern', 'file']), ['file']);
  assert.deepEqual(commandOperands('sed', ['--expression', '1p', 'file']), ['file']);
  for (const tool of ['grep', 'rg', 'sed', 'awk']) {
    assert.deepEqual(commandOperands(tool, ['pattern', 'file']), ['file']);
  }
  assert.deepEqual(commandOperands('ls', ['--hide', 'ignored', 'file']), ['file']);
  assert.deepEqual(commandOperands('head', ['-q', 'file']), ['file']);
  assert.deepEqual(commandOperands('tail', ['-v', 'file']), ['file']);
  for (const args of [['--=value', 'file'], ['-- ', 'file']]) {
    assert.throws(() => commandOperands('cat', args));
  }
  assert.equal(commandOptions.cat.values, '');
  assert.equal(commandOptions.cd.values, '');
  assert.equal(commandOptions.awk.flags, '');
});

test('command classification rejects incomplete, substituted and unrelated gem locators', () => {
  for (const command of [
    '', 'gem contents', 'bundle show', "gem contents '-kamal'", "gem contents 'ka/mal'",
    'echo exec bundle show kamal', 'ls show kamal', 'ls contents kamal', 'bundle install kamal',
    'cat "$HOME/.gem/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb"',
    'cat `pwd`/.gem/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb',
  ]) assert.equal(lookupForCommand(command, cwd), null, command);
  assert.equal(lookupForCommand('cat README.md /app/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb', cwd), 'gem:kamal');
  assert.equal(lookupForCommand('bundle exec gem contents kamal', cwd), 'gem:kamal');
  for (const command of ['gem which kamal', 'gem unpack kamal', 'bundle show kamal', 'bundle open kamal']) {
    assert.equal(lookupForCommand(command, cwd), 'gem:kamal');
  }
  assert.equal(lookupForCommand('cat exec /app/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb', cwd), 'gem:kamal');
});

test('supported command flags and value options leave only source and URL operands', () => {
  const source = '/app/vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0/lib/kamal.rb';
  for (const command of [
    `cat -n '${source}'`, `ls -l '${source}'`, `cd -P '${source}'`,
    `head -q -n 20 '${source}'`, `tail -v --lines=20 '${source}'`,
    `grep -F -e pattern '${source}'`, `rg -n -g '*.rb' pattern '${source}'`,
    `sed -n -e '1p' '${source}'`, `awk -F : '{ print $1 }' '${source}'`,
    'curl -sSL -o download https://rubygems.org/downloads/kamal-2.12.0.gem',
    'wget -q -O download https://rubygems.org/downloads/kamal-2.12.0.gem',
  ]) assert.equal(lookupForCommand(command, cwd), 'gem:kamal', command);
});

describe('redirect policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posh-policy-team's-$HOME-"));
  const bin = path.join(root, 'bin');
  const input = { cwd: root, session_id: 'policy', tool_name: 'Bash', tool_input: { command: 'bundle show kamal' } };
  const library = { ref: 'gem:kamal', version: '2.12.0', kinds: ['rdoc'] };
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'Gemfile.lock'), '');
  fs.writeFileSync(path.join(bin, 'posh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_POSH_CALLS"\nprintf "%s" "$FAKE_POSH_RESPONSE"\n', { mode: 0o755 });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('PLUGIN_DATA', fs.mkdtempSync(path.join(root, 'data-')));
    vi.stubEnv('FAKE_POSH_CALLS', path.join(root, 'calls'));
    vi.stubEnv('FAKE_POSH_RESPONSE', JSON.stringify({ ok: true, project_path: root, data: [library] }));
  });

  test('named and gem-tree redirects keep distinct markers and project-pinned instructions', async () => {
    for (const [tool_input, ref] of [[{ command: 'bundle show kamal' }, 'gem:kamal'], [{ command: 'grep pattern /app/vendor/bundle' }, null]]) {
      const reason = await poshRedirect({ ...input, tool_input });
      assert.deepEqual(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n'), [
        'docsets', '--json', '--project', root, ...(ref ? ['--filter', ref] : []),
      ]);
      assert.match(reason, ref ? /gem:kamal 2\.12\.0, the version this project locks/ : /the installed source of the gems this project locks/);
      assert.deepEqual(JSON.parse(reason.match(/search tool with (\{.*?\}), or/)[1]), {
        query: '<symbol or page name>', project: root, ...(ref ? { ref } : {}),
      });
      assert.deepEqual(JSON.parse(reason.match(/ref using (\{.*?\})\./)[1]), {
        ref: '<returned document ref>', project: root,
      });
      const cli = reason.match(/or `(.+?)`, then/)[1];
      const args = execFileSync('/bin/sh', ['-c', `posh() { printf '%s\\n' "$@"; }\n${cli}`], { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(args, ['search', '<symbol>', ...(ref ? ['--ref', ref] : []), '--project', root]);
      assert.match(reason, /retry the original call; it will go through/);
      assert.equal(await poshRedirect({ ...input, tool_input }), null);
    }
    const markers = fs.readdirSync(path.join(process.env.PLUGIN_DATA, 'nudged'));
    assert.deepEqual(markers.map((name) => name.match(/^policy\.[a-f0-9]{64}\.(.+)$/)?.[1]).sort(), [
      'gem-tree', 'gem:kamal',
    ]);
  });

  test('a search without a path classifies the current gem directory', async () => {
    const cwd = path.join(root, 'vendor/bundle/ruby/3.4.0/gems/kamal-2.12.0');
    fs.mkdirSync(cwd, { recursive: true });
    assert.match(await poshRedirect({ ...input, cwd, tool_name: 'Grep', tool_input: { pattern: 'perform' } }), /gem:kamal/);
  });

  test('malformed and unrelated rows cannot hide a later matching docset', async () => {
    vi.stubEnv('FAKE_POSH_RESPONSE', JSON.stringify({
      ok: true, project_path: root,
      data: [null, {}, { ref: 17 }, { ref: 'lang:ruby', kinds: ['rdoc'] },
        { ref: 'gem:other', kinds: ['rdoc'] }, { ref: 'gem:kamal', kinds: 'rdoc' },
        { ref: 'gem:kamal', kinds: [] }, library],
    }));
    assert.match(await poshRedirect(input), /gem:kamal 2\.12\.0/);
  });

  test('an unfiltered discovery without any documented gem leaves no marker', async () => {
    vi.stubEnv('FAKE_POSH_RESPONSE', JSON.stringify({
      ok: true, project_path: root, data: [{ ref: 'lang:ruby', kinds: ['rdoc'] }],
    }));
    assert.equal(await poshRedirect({ ...input, tool_input: { command: 'grep pattern /app/vendor/bundle' } }), null);
    assert.deepEqual(fs.readdirSync(process.env.PLUGIN_DATA), []);
  });
});
