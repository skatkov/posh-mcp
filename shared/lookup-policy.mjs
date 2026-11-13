import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const gemTree = Symbol('gem-tree');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function rubyProject(dir) {
  while (dir !== path.dirname(dir) && dir !== os.homedir()) {
    const names = fs.readdirSync(dir);
    if (names.some((name) => ['Gemfile', 'Gemfile.lock', 'gems.rb'].includes(name) || name.endsWith('.gemspec'))) return dir;
    if (names.includes('.git')) return null;
    dir = path.dirname(dir);
  }
  return null;
}

function expandPath(value, cwd) {
  if (typeof value !== 'string') throw new TypeError('Expected a path');
  if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function lookupForPath(value, cwd) {
  const file = expandPath(value, cwd);
  // shortcut: infer installed layouts and exported gem homes, not arbitrary Ruby overrides; extend from observed misses.
  const homes = [process.env.GEM_HOME, ...(process.env.GEM_PATH || '').split(path.delimiter)]
    .filter(Boolean).map((home) => expandPath(home, cwd));
  const roots = homes.filter((home) => file === home || file === `${home}/gems` || file.startsWith(`${home}/gems/`));
  const layouts = /\/(?:vendor\/bundle|ruby\/gems|gems\/\d+\.\d+(?:\.\d+)?|(?:\.gem|gem)\/(?:ruby|jruby|truffleruby)\/[^/]+|rubygems-integration\/(?:all|\d+\.\d+))(?=\/|$)/g;
  for (const match of file.matchAll(layouts)) roots.push(file.slice(0, match.index + match[0].length));
  const root = roots.sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const match = file.slice(root.length).match(/^(?:\/(?:ruby|jruby|truffleruby)\/[^/]+|\/\d+\.\d+(?:\.\d+)?|\/\*\*)?\/gems\/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*/);
  return match ? `gem:${match[1]}` : gemTree;
}

function lookupForUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    let match;
    switch (url.hostname.toLowerCase()) {
      case 'rubydoc.info': case 'www.rubydoc.info': case 'rubygems.org': case 'www.rubygems.org':
        match = url.pathname.match(/^\/gems\/([a-zA-Z0-9_.-]+)(?:\/|$)/) ||
          url.pathname.match(/^\/downloads\/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*\.gem$/);
        break;
      case 'api.rubyonrails.org': case 'guides.rubyonrails.org':
        return 'gem:rails';
      // shortcut: repository names are gem-name hints; use metadata if differently named repos become a real miss.
      case 'github.com':
        match = url.pathname.match(/^\/[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)\/(?:blob|raw)\//);
        break;
      case 'raw.githubusercontent.com':
        match = url.pathname.match(/^\/[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)\//);
        break;
    }
    return match ? `gem:${match[1]}` : null;
  } catch {
    return null;
  }
}

function commandWords(command) {
  if (typeof command !== 'string') return null;
  const words = [];
  let word = '', quote = '', started = false;
  // shortcut: only literal-leading commands, never shell evaluation; extend syntax only for observed misses.
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
    } else if (char === '\\') {
      const next = command[++i];
      if (next === undefined) return null;
      if (next !== '\n') {
        word += quote && !'$`"\\'.includes(next) ? `\\${next}` : next;
        started = true;
      }
    } else if (char === quote) {
      quote = '';
    } else if (char === '$' || char === '`') {
      return null;
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
      started = true;
    } else if (!quote && /[;&|<>\n]/.test(char)) {
      break;
    } else if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

const commandOptions = {
  cat: { flags: 'b e n s t u v A E T', values: '' },
  ls: { flags: 'a A d f F h l n r R s S t u U x 1', values: 'I ignore hide' },
  head: { flags: 'q v', values: 'n c lines bytes' },
  tail: { flags: 'f F q v', values: 'n c lines bytes' },
  cd: { flags: 'L P e', values: '' },
  grep: { flags: 'E F G i v w x n H h r R l L c o q s a I', values: 'e f m A B C regexp file include exclude exclude-dir' },
  rg: { flags: 'F i v w x n H l c o q s U u a', values: 'e f g t T m A B C regexp file glob iglob type type-not' },
  sed: { flags: 'n E r', values: 'e f expression file' },
  awk: { flags: '', values: 'F v f' },
  curl: { flags: 's S L f I k O', values: 'o output d data data-raw data-binary data-urlencode H header X request u user A user-agent e referer w write-out' },
  wget: { flags: 'q c', values: 'O output-document o output-file header post-data post-file' },
};

function commandOperands(tool, args) {
  if (tool === 'find') {
    const end = args.findIndex((arg) => arg.startsWith('-') || ['!', '('].includes(arg));
    return end === -1 ? args : args.slice(0, end);
  }
  const spec = commandOptions[tool];
  if (!spec) return [];
  // shortcut: unknown options fail open; add observed forms rather than guessing operand roles.
  const options = Object.fromEntries([
    ...spec.flags.split(' ').filter(Boolean).map((name) => [name, { type: 'boolean', short: name.length === 1 ? name : undefined }]),
    ...spec.values.split(' ').filter(Boolean).map((name) => [name, { type: 'string', short: name.length === 1 ? name : undefined }]),
  ]);
  const { positionals, values } = parseArgs({ args, options, allowPositionals: true });
  const operands = ['grep', 'rg', 'sed', 'awk'].includes(tool) &&
    !['e', 'f', 'regexp', 'file', 'expression'].some((name) => Object.hasOwn(values, name))
    ? positionals.slice(1) : positionals;
  return tool === 'awk' ? operands.filter((arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) : operands;
}

function lookupForCommand(command, cwd) {
  let words = commandWords(command);
  if (!words) return null;
  if (words[0] === 'bundle' && words[1] === 'exec') words = words.slice(2);
  const [tool, ...args] = words;
  if ((tool === 'gem' && ['contents', 'which', 'unpack'].includes(args[0])) ||
      (tool === 'bundle' && ['show', 'open'].includes(args[0]))) {
    const name = args[1];
    return typeof name === 'string' && /^[a-zA-Z0-9_]/.test(name) && !/[^a-zA-Z0-9_.-]/.test(name) ? `gem:${name}` : null;
  }
  const lookup = ['curl', 'wget'].includes(tool) ? lookupForUrl
    : ['cat', 'sed', 'grep', 'rg', 'find', 'ls', 'head', 'tail', 'awk', 'cd'].includes(tool) ? lookupForPath : null;
  if (lookup) {
    for (const arg of commandOperands(tool, args)) {
      const ref = lookup(arg, cwd);
      if (ref) return ref;
    }
  }
  return null;
}

export async function poshRedirect(input) {
  try {
    if (!isObject(input) || !isObject(input.tool_input)) return null;
    const session = input.session_id;
    if (typeof session !== 'string' || !session || /[^a-zA-Z0-9_-]/.test(session) ||
        typeof input.cwd !== 'string' || !fs.statSync(input.cwd).isDirectory()) return null;
    const cwd = fs.realpathSync(input.cwd);
    const modeFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'posh/agent-mode');
    if (fs.existsSync(modeFile) && fs.readFileSync(modeFile, 'utf8').trim() === 'off') return null;
    const project = rubyProject(cwd);
    if (!project) return null;
    const args = input.tool_input;
    let lookup;
    switch (input.tool_name) {
      case 'Read': lookup = lookupForPath(args.file_path, cwd); break;
      case 'Grep': lookup = lookupForPath(args.path === undefined ? cwd : args.path, cwd); break;
      case 'Glob': lookup = lookupForPath(path.join(args.path === undefined ? cwd : args.path, args.pattern), cwd); break;
      case 'WebFetch': lookup = lookupForUrl(args.url); break;
      case 'Bash': lookup = lookupForCommand(args.command, cwd); break;
    }
    if (!lookup) return null;
    const ref = lookup === gemTree ? null : lookup;
    const state = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA ||
      path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'posh');
    const projectKey = createHash('sha256').update(project).digest('hex');
    const marker = path.join(state, 'nudged', `${session}.${projectKey}.${ref || 'gem-tree'}`);
    if (fs.existsSync(marker)) return null;
    const command = ['docsets', '--json', '--project', project];
    if (ref) command.push('--filter', ref);
    const { stdout } = await execute('posh', command, { cwd, timeout: 4000, killSignal: 'SIGKILL' });
    const docs = JSON.parse(stdout);
    if (!isObject(docs) || docs.ok !== true || !Array.isArray(docs.data) ||
        typeof docs.project_path !== 'string' || fs.realpathSync(docs.project_path) !== project) return null;
    const library = docs.data.find((row) => isObject(row) && typeof row.ref === 'string' &&
      row.ref.startsWith('gem:') && (!ref || row.ref === ref) && Array.isArray(row.kinds) && row.kinds.length);
    if (!library) return null;

    const subject = ref ? `${ref} ${library.version}, the version this project locks` : 'the installed source of the gems this project locks';
    const query = { query: '<symbol or page name>', project, ...(ref ? { ref } : {}) };
    const read = { ref: '<returned document ref>', project };
    const quotedProject = `'${project.replaceAll("'", "'\\''")}'`;
    const cli = `posh search '<symbol>'${ref ? ` --ref ${ref}` : ''} --project ${quotedProject}`;
    const reason = `POSH has local documentation for ${subject}.\n\n` +
      `Use POSH's search tool with ${JSON.stringify(query)}, or \`${cli}\`, then read the returned document ref using ${JSON.stringify(read)}. For CLI reads, keep the same --project argument. Search for README or CHANGELOG for those pages.\n\n` +
      'This redirect fires once per gem per session. If POSH cannot answer, retry the original call; it will go through. Source inspection remains available for implementation details and debugging.\n';
    // Claim atomically only after the reason is ready; failures must not consume the redirect.
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(marker);
    return reason;
  } catch {
    // Invalid input, unavailable POSH or unwritable state must never block real work.
    return null;
  }
}
