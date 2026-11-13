# Adoption evals

Does an agent actually reach for POSH, and does the `PreToolUse` hook catch it when it
does not? Both questions are measured here, because neither is answered by the plugin's
text checks: those protect the advertised guidance, they do not prove adoption.

The cases are synthetic reproductions of patterns reported in a local transcript audit:
installed gem reads, GitHub documentation fetches, undocumented gems, and unrelated work.
They are not a representative sample of all Ruby tasks.

## Running

```sh
claude plugin eval . \
  --ablation with-without \
  --scaffold --trust-plugin \
  --allow-real-servers --no-publish --keep-temp \
  --json evals/results/latest.json \
  --allow-tools WebFetch Edit mcp__plugin_posh_docs &&
node evals/check-evidence.mjs evals/results/latest.json
```

Each flag is load-bearing:

- `--allow-real-servers` starts the plugin's real MCP server. There is no `mocks/`
  directory yet; recording one would make the suite hermetic and is the obvious next step.
- `--scaffold` runs each case's `scaffold.sh`, which writes the `Gemfile.lock` the case
  needs. Documentation cases call `prepare-posh.sh`, which links POSH's data into the run
  and verifies the exact fixture docset before launching the model. A case runs with `HOME`, `XDG_DATA_HOME`
  and `XDG_STATE_HOME` all pointed inside the run's sandbox, where POSH finds neither its
  docsets (`$XDG_DATA_HOME/posh/storage.db`) nor its licence
  (`$XDG_STATE_HOME/posh/license.json`), and every call returns `license_required` — the
  agent then answers from memory and the suite silently measures nothing. Exporting those
  variables yourself does not help: the runner overrides them. The scaffold shares that
  sandbox home, so the helper symlinks the real `~/.local/{share,state}/posh` into it
  instead, without replacing existing directories. This gives trusted plugin processes
  access to the operator's POSH stores; it is not a hermetic test. Custom POSH storage
  locations are not currently auto-discovered. `typo-control` prepares the same known
  docset too, so it exercises an operational hook rather than an unavailable POSH fallback.
  Without `--scaffold`, the suite has no fixtures and its scores are not meaningful.
- `--allow-tools` grants what the cases ask for. `Bash` is deliberately absent: granting a
  shell requires a sandbox backend (`bubblewrap` and `socat`), and without one the run is
  refused outright. The Bash routes — `gem contents`, `bundle show`, `curl
  rubygems.org` — are covered by `test/plugin.test.mjs` instead.

`--ablation with-without` compares the whole plugin (instructions **and** interception)
against no plugin. It does not isolate the hook's contribution from the instructions.
Plugin-only graders are marked `arm: with-only`: they become pass/fail indicators and
do not inflate the quality-score delta by penalizing the baseline for not having POSH.
Inspect those indicators as well as scores; a two-arm run can score 1.00 while POSH
adoption fails. The separate evidence checker must pass too: it validates successful
reads in the with-plugin arm only, without adding impossible requirements to the baseline.
`--keep-temp` is required because it reads each run's retained `tracePath`.
It rejects partial reports, incomplete run counts, errored runs and missing traces.
If the eval command uses `--runs N`, repeat it on the checker:
`node evals/check-evidence.mjs REPORT.json --runs N`. Claude Code 2.1.323 records the
case's default `runsPerCase`, not the command-line override; the checker cannot infer
the requested count from that report alone.

For a cheaper first check after changing a grader:

```sh
claude plugin eval . --case typo-control --ablation none --runs 3 \
  --scaffold --trust-plugin --allow-real-servers --no-publish \
  --allow-tools Edit mcp__plugin_posh_docs
```

All model and judge calls consume account usage. Optionally set `--max-cost-usd` for a
list-price cost ceiling, and pin `--model` and `--judge-model` for comparisons.

## Prerequisites

Use Claude Code 2.1.269 or later and Node 18.3+.
POSH must be activated, and must have docsets for the versions the scaffolds lock:
`activerecord 8.1.4.1`, `kamal 2.12.0`, `nokogiri 1.19.7`. Check with `posh docsets` in a
project that locks them; `posh sync` fetches what is missing. The preflight rejects missing
or wrong-version docsets, and requires the documentation kind named by the case's
expected read in `expected-reads.json` (including Kamal's `guide` kind).
For `undocumented-gem`, it verifies that POSH works but that
`widget_press` has no docs. There are no MCP mocks, and no credentials are committed.

## The cases

| Case | Observed behaviour it reproduces | Passing means |
|---|---|---|
| `activerecord-api` | 8 reads of `activerecord` source for an API question | answered from the locked version's docs, via POSH |
| `kamal-guide` | 6 reads of `kamal` source, plus README fetches, for a configuration question | found the answer in the guide docset |
| `github-source` | `github.com/sparklemotion/nokogiri/blob/v1.19.4/lib/nokogiri/xml/searchable.rb`, fetched verbatim | used POSH and never fetched the file |
| `hook-redirect` | gem-source reads, pointed at a synthetic vendored copy whose comment is wrong for the upstream locked version | a source lookup was redirected, followed by a successful POSH read and a correct upstream answer |
| `undocumented-gem` | `geneva_drive_admin` and the git-sourced `rdoc`: locked, but no docset | reading the gem's source still works |
| `typo-control` | ordinary work in a Ruby project | no documentation lookup at all |

The last two are the guards, and they matter more than the adoption cases. A hook that
denies tool calls can break gem work in a way that prose never could: `undocumented-gem`
fails if POSH cannot answer and the hook blocks the fallback anyway, and `typo-control`
fails on any POSH call during a task that needs none. Keep both passing at 100% before
tuning anything else.

## Reading a failure

`hook-redirect` failing with *no successful POSH read issued after a native POSH denial*
means the checker could not establish the redirect-to-read sequence.
Hooks do run inside `claude plugin eval`, so check, in order: the scaffold's symlinks
landed (without them `posh docsets` fails inside the run and the hook correctly allows
everything); the `PreToolUse` matcher in `hooks/claude-hooks.json` covers the tool
the agent reached for; and the gem is one POSH has a docset for.

`typo-control` grades the exact final README contents with
`target: { source: file, path: README.md }`. `target: files` means a list of newly created
paths, not their contents. A matching Edit argument alone would not prove the edit succeeded.
Six zero-call graders reject every POSH MCP tool, including unsuccessful attempts.
Its fixture's internal CLI preflight is not a model-issued lookup. A deterministic
check also proves that a known-gem source read is denied in that same fixture while
the README read is allowed.

The adoption cases require a successful read of the expected API page or registry
guide, not a particular discovery sequence. `search`, `list`, `outline`, and previously
returned refs are all valid ways to find it; no redundant search call is required.
`check-evidence.mjs` parses JSONL records once with `JSON.parse`, matches tool calls
and result blocks by tool ID, and verifies the project, returned ref and nonempty
document content. Expected refs live once in `expected-reads.json`; `null` means a
control case has no required read. JSON field order does not matter.

The same event sequence owns interception and remote-source evidence; neither is
graded by searching arbitrary trace text. `hook-redirect` requires a successful
native `PreToolUse` hook response carrying a POSH denial, followed by a newly issued
successful POSH read. A read issued before the denial cannot satisfy that sequence.
`github-source` rejects successful or unresolved WebFetch calls to Nokogiri's GitHub
repository, while allowing correlated error/denial results and URLs quoted in docs.

An omitted project uses the fixture default; explicit paths are resolved against that
root and must select the same project. Unrelated successes, sibling result blocks and
quoted success messages cannot satisfy a failed read. The checker consumes each result
block's actual MCP JSON content, not shared transport metadata. Unrecognized evidence
fails closed. Unit tests cover reordered fields, MCP text arrays, mixed results, wrong
projects, mismatched IDs, failed reads, partial reports and parallel result ordering.

## Validation status

Run `npm ci` once, then `npm test`. Tests use Node and shell tools, not a Ruby
executable; `yaml` is a development-only dependency for reading the eval cases.
The suite exercises the shared policy, parallel
once-only markers, fail-open behavior, both hook manifests, all six scaffolds, and
deterministic grader checks without an agent account or real POSH licence. OpenCode
contract tests use its real SDK error class and a stubbed plugin context, covering
all five lookup tools, direct policy imports, moved sessions and shell working-directory overrides. Codex
contract tests execute the manifest's command with its native plugin environment
and verify denial, retry and unsupported-`ask` handling. Isolated-PATH checks
verify that hooks need Node/POSH but not Ruby. Gem-path regressions cover exported
custom homes and standard user, XDG, system and alternate-Ruby layouts.

The live eval suite and retained JSONL checker target Claude Code, not Codex or
OpenCode. The scaffolds and redirect/retry behavior have been smoke-tested against
real POSH on Linux, but no live-agent runs have verified the new Codex/OpenCode
adapters yet.

The latest full comparisons were interrupted, so there is no completed with/without
baseline for this version. Older reports under ignored `results/` predate the JSONL
checker and are not results for this version. Do not quote a measured adoption
improvement until both the full comparison and the evidence checker finish successfully.
