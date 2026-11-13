#!/bin/sh
# The runner rewrites HOME and XDG paths and strips the operator's environment.
set -eu
real=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)
if [ ! -d "$real" ]; then
  if [ -d "/Users/$(id -un)" ]; then real=/Users/$(id -un); else real=/home/$(id -un); fi
fi
for d in share state; do
  source=$real/.local/$d/posh
  target=$HOME/.local/$d/posh
  [ -d "$source" ] || { echo "POSH eval: missing $source; install, activate and sync POSH first." >&2; exit 1; }
  mkdir -p "$HOME/.local/$d"
  # Never replace an existing directory, including when HOME is the real home.
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then ln -s "$source" "$target"; fi
done

# Fail before launching a model if licence or fixture docs are unavailable.
posh docsets --json --project "$PWD" | node -e '
  const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (result.ok !== true) {
    console.error("POSH eval: docsets failed; check POSH activation.");
    process.exit(1);
  }
  const [ref, version, name, availability, expectationsPath] = process.argv.slice(1);
  const expectedReads = JSON.parse(require("node:fs").readFileSync(expectationsPath, "utf8"));
  if (!Object.hasOwn(expectedReads, name)) {
    console.error(`POSH eval: unknown fixture ${name}`);
    process.exit(1);
  }
  const expected = expectedReads[name];
  const [library, kind] = expected ? expected.split("/") : [];
  const row = result.data.find(item => item.ref === ref && item.version === version);
  const available = !!(row && Array.isArray(row.kinds) && row.kinds.length);
  if (!row || available !== (availability !== "missing") ||
      (expected && (library !== ref || !row.kinds.includes(kind)))) {
    console.error(`POSH eval: unexpected docset availability for ${ref} ${version} (${kind || availability}); check activation and sync.`);
    process.exit(1);
  }
' "$1" "$2" "$3" "${4:-available}" "$(dirname -- "$0")/expected-reads.json"
