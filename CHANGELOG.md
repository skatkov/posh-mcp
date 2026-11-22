# Changelog

## 1.3.0 — 2026-11-22

- Parse mode commands only for Copilot prompt events
- Preserve read-only modes and report committed saves accurately
- Explain retired POSH auto mode without enabling guidance
- Save POSH modes atomically and render each reply from one mode
- Assert redirect marker project keys use hex encoding
- Assert OpenCode forwards session IDs to session lookup
- Remove POSH auto mode
- Honor saved POSH modes and report failed writes
- Enable POSH by default in all projects
- Reuse POSH context and print compact tool results
- Batch exact-match POSH lookups in Codex
- Benchmark POSH adoption in Codex and trim tool discovery
- Document the npm install command for OpenCode
- Preserve Vitest compatibility after rebasing
- Assert OpenCode context and forced-mode boundaries
- Use fixture POSH for lifecycle tests on clean hosts
- Enroll lifecycle and Copilot in mutation CI
- Kill Copilot boundary, formatting and feedback mutants
- Mutation-test shared lifecycle modes and guidance
- Isolate extracted lifecycle state in plugin fixtures
- Remove duplicate Copilot auto-mode guidance
- Refresh Copilot project guidance on every prompt
- Share Node lifecycle operations without shell round trips
- Add Copilot CLI plugin with isolated adapter tests
- Use Vitest for incremental mutation testing
- Test adapter boundaries and simplify equivalent formatting paths
- Test policy input boundaries, discovery calls and redirect state
- Directly test policy parsing and remove redundant option handling
- Require a 100 percent Stryker mutation score locally and in CI
- Make home-path and timeout assertions independent and bounded
- Remove the unused gem-version tail from path matching
- Run policy and adapter mutation tests in pull request CI
- Simplify the OpenCode adapter without weakening boundary checks
- Assert OpenCode prompt and host registration contracts
- Cover home paths, default state and shell operand edge cases
- Test POSH response validation and redirect guidance contracts
- Allow subprocess contention without inflating mutation results
- Add opt-in Stryker mutation testing for the shared lookup policy
- Update README.md
- Update README.md
- Close the gaps the release review found

## Unreleased

- Enable POSH guidance in all projects by default and remove `auto` mode. Old
  `auto` settings now behave like `on`. Use `off` to disable guidance; lookup
  redirects still require a Ruby project.

## 1.2.2 — 2026-11-16

- Move the workflow actions onto the Node 24 runtime
- Publish the OpenCode plugin to npm from a tag
- Release with one command instead of five manual edits
