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
  --allow-real-servers --no-publish \
  --allow-tools WebFetch Edit mcp__plugin_posh_docs
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
  locations are not currently auto-discovered. `typo-control` does not need those links.
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
adoption fails. Use `--ablation none` to make all adoption indicators count toward the
pass threshold during regression testing.

For a cheaper first check after changing a grader:

```sh
claude plugin eval . --case typo-control --ablation none --runs 3 \
  --scaffold --trust-plugin --allow-real-servers --no-publish \
  --allow-tools Edit mcp__plugin_posh_docs
```

All model and judge calls consume account usage. Optionally set `--max-cost-usd` for a
list-price cost ceiling, and pin `--model` and `--judge-model` for comparisons.

## Prerequisites

Use Claude Code 2.1.269 or later and Ruby with its JSON, Open3 and Psych libraries.
POSH must be activated, and must have docsets for the versions the scaffolds lock:
`activerecord 8.1.4.1`, `kamal 2.12.0`, `nokogiri 1.19.7`. Check with `posh docsets` in a
project that locks them; `posh sync` fetches what is missing. The preflight rejects missing
or wrong-version docsets. For `undocumented-gem`, it verifies that POSH works but that
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

`hook-redirect` failing with *pattern not found in trace* means the hook did not fire.
Hooks do run inside `claude plugin eval`, so check, in order: the scaffold's symlinks
landed (without them `posh docsets` fails inside the run and the hook correctly allows
everything); the `PreToolUse` matcher in `hooks/claude-hooks.json` covers the tool
the agent reached for; and the gem is one POSH has a docset for.

`typo-control` grades the exact final README contents with
`target: { source: file, path: README.md }`. `target: files` means a list of newly created
paths, not their contents. A matching Edit argument alone would not prove the edit succeeded.
Six zero-call graders reject every POSH MCP tool, including unsuccessful attempts.

A case failing on *read-&lt;gem&gt;-docs-from-posh* while its answer grader passes means the
agent may have answered from memory or the web. A `posh://` match is only one indicator:
it can appear in a search result without a read. The adoption cases also require a
search-before-read tool order and POSH's successful `Document read` response summary.
Neither a tool attempt nor a `license_required` response passes all these checks.

## Validation status

`npm test` exercises the hook, parallel once-only markers, fail-open behavior, manifest
scope, all six scaffolds, and deterministic grader checks without a Claude account or
real POSH licence. The scaffolds and redirect/retry behavior have also been smoke-tested
against real POSH on Linux.

The revised suite has **not** completed live agent runs or a with/without baseline:
the last attempted live run on 2026-11-13 stopped on the account's five-hour limit.
Older reports under ignored `results/` predate the revised graders and are not results
for this version. Do not quote a measured adoption improvement until the full comparison
finishes successfully.
