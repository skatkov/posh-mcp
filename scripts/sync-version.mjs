// Runs from npm's `version` lifecycle: package.json and its lock already carry
// the new version, nothing is committed yet. Mirrors that version into the host
// manifests, writes the changelog entry, and stages all of it for npm's commit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const manifests = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.github/plugin/plugin.json',
  'gemini-extension.json',
];
const changelog = 'CHANGELOG.md';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`unexpected version ${version}`);

for (const file of manifests) {
  const before = fs.readFileSync(file, 'utf8');
  // Rerunning a half-finished release finds some manifests already bumped, so an
  // unchanged file is fine; a missing version field is not.
  if (!/^\s*"version":/m.test(before)) throw new Error(`no version field in ${file}`);
  fs.writeFileSync(file, before.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`));
}

let since = '';
try {
  since = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
} catch {
  // No release tag yet, so the whole history is the first entry.
}
const subjects = git('log', '--format=%s', ...(since ? [`${since}..HEAD`] : []))
  .split('\n')
  .filter((line) => line && !/^Release \d/.test(line));

const entry = `## ${version} — ${new Date().toISOString().slice(0, 10)}\n\n` +
  `${subjects.map((line) => `- ${line}`).join('\n') || '- No changes recorded.'}\n`;
const existing = fs.existsSync(changelog)
  ? fs.readFileSync(changelog, 'utf8').replace(/^# Changelog\n+/, '')
  : '';
fs.writeFileSync(changelog, `# Changelog\n\n${entry}\n${existing}`);

execFileSync('git', ['add', '--', changelog, ...manifests], { stdio: 'inherit' });
console.log(`Staged ${version} in ${manifests.length} manifests and ${changelog}.`);
