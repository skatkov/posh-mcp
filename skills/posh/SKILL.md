---
name: posh
description: >
  Use on any Ruby, Rails, or gem task before relying on memory: implementation,
  debugging, code review, tests, upgrades, or explaining behavior. Finds
  documentation for this project's exact Ruby and gem versions. Also use when
  the user says "posh" or "check the docs".
argument-hint: "[on|off|auto]"
---

# POSH: docs for this project's exact versions

POSH serves documentation for this project's Ruby version and `Gemfile.lock`: API docs, READMEs, changelogs, and guides where available. Your memory may describe a different version, so POSH comes first, not only when you are stuck.

## When

Before implementing, debugging, reviewing, testing, or explaining code that depends on Ruby, its standard library, Rails, or a gem, verify the APIs, options, configuration, and framework patterns you are about to rely on, even ones you think you remember. Use POSH before web search, Context7, or other external docs. Skip it for plain language basics and work unrelated to Ruby. Read only what the task needs, and reuse what you already read.

## How

1. `docsets`: discover libraries, versions, and docset kinds. Check that `project_path` is the intended project. Reuse the result until the project or dependencies change.
2. `search`: pass a library ref from `docsets`. Search matches symbol and page names (`has_many`, `ActiveRecord::Base`, `Class#method`, `README`, `CHANGELOG`), not full-text questions.
3. `read`: read a returned ref, preferably a focused section from `outline`. A search hit alone is not verification.

- Setup or integration question: look for the relevant guide; the README may not be enough. If the name is unknown, browse with `list` (`LIBRARY_REF/KIND`).
- Never invent refs. A `project` override applies to one call only, so pass the absolute path on every call when the default project is wrong.
- Docs missing or stale: `sync` once (it uses the network), rediscover, and retry.
- Still unavailable or version-mismatched: use official docs for the matching version and state the limitation.

## Finding the tools

Hosts name these tools differently (`posh_search`, `mcp__posh__search`), may defer them behind a tool search, or may expose them only inside a code-execution tool. Look for them before deciding they are missing. With no MCP tools, use the CLI: `posh docsets`, `posh search QUERY --ref REF`, `posh outline REF`, `posh read REF`, `posh sync`.

If POSH is not installed or activated, tell the user once and continue with other sources. For activation, ask them to run `posh activate <posh_key>` locally. Never ask for, read, or expose the license key.

## Switching

`/posh off` turns this guidance off: when the user runs it, confirm in one line and stop following these instructions. `/posh` turns it on everywhere, and `/posh auto` limits it to Ruby projects.
