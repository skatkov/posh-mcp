# POSH MCP server

Search and read local Ruby and gem documentation matched to your project's versions.

POSH gives coding agents documentation selected from your Ruby version and
`Gemfile.lock`: API references, READMEs, changelogs, and guides where available.
Documentation lookups use local files and an index after syncing. The `sync`
tool uses the network to download docs and update that index.

**This repository contains public installation metadata and integration manifests,
not the POSH application source. POSH is proprietary software.** Its terminal
documentation browser and basic sync are free; MCP and agent CLI tools require a
POSH license. Current plans and trial details are at [poshtui.com](https://poshtui.com/#pricing).

## Install and activate

Supported platforms: macOS (Apple Silicon and Intel) and Linux (ARM64, x86-64,
and x86). Windows and hosted HTTP connections are not supported.

```sh
brew install --cask skatkov/tap/poshtui
```

On Arch Linux, use `yay -S poshtui-bin`. Other installs are available from
[GitHub Releases](https://github.com/skatkov/homebrew-tap/releases).

Retrieve your license from the customer portal linked in your Polar purchase
email. Activate it locally, outside agent chats:

```sh
posh activate YOUR_LICENSE_KEY
```

Never put a license key in a public issue, chat, or MCP configuration.

From your Ruby project, download its documentation:

```sh
posh sync
```

## MCP configuration

Add this to your client's MCP configuration, replacing the project path:

```json
{
  "mcpServers": {
    "posh": {
      "command": "posh",
      "args": ["mcp"]
    }
  }
}
```

Transport: local stdio. POSH must be on your client's PATH; otherwise use its
absolute executable path. Update the configured project when switching projects,
or supply `project` on individual tool calls. No API-key environment variable is
required: the executable uses the license activation saved on your computer.

### MCP Bundle

Compatible clients can install the universal `posh-mcp.mcpb` asset from
[POSH releases](https://github.com/skatkov/homebrew-tap/releases). Select your Ruby
project when prompted. The bundle contains the existing platform binaries and
does not bypass license activation. It does not host or upload your project.

### Gemini CLI extension

After installing and activating POSH:

```sh
gemini extensions install https://github.com/skatkov/posh-mcp
```

The extension runs `posh mcp` locally. Ask the agent to pass your absolute Ruby
project directory in tool calls if its working directory is not your project.

### Agent plugins: Claude Code, Codex, and OpenCode

An MCP server alone gets used late, because agents tend to reach for it only
once they are stuck. These plugins connect the server and also tell the agent
to check POSH before relying on memory for Ruby, Rails, and gem work. Install
and activate POSH first.

Claude Code, as two separate prompts:

```text
/plugin marketplace add skatkov/posh-mcp
/plugin install posh@skatkov
```

Codex, then open `/hooks`, trust the POSH hooks, and start a new thread. Codex
skips hooks until they are trusted:

```sh
codex plugin marketplace add skatkov/posh-mcp
codex plugin add posh@skatkov
```

OpenCode 2:

```sh
opencode plugin add github:skatkov/posh-mcp#main
```

The instructions come from [`skills/posh/SKILL.md`](skills/posh/SKILL.md).
OpenCode adds them to the system prompt of every model request. Claude Code and
Codex have no plugin API for the system prompt, so they receive them as hidden
context at session start, after compaction, and when a subagent starts.

| Command | Effect |
| --- | --- |
| `/posh auto` | Default. Active when the project has a `Gemfile`, `Gemfile.lock`, `gems.rb`, or `*.gemspec`, in the working directory or above it, up to the Git root |
| `/posh` or `/posh on` | Active in every project. Use this when the Ruby app sits in a subdirectory |
| `/posh feedback` | Same as `/posh on`, and the agent ends replies that used POSH with a **POSH feedback** section. The feedback stays in the reply; nothing is sent anywhere |
| `/posh off` | Inactive everywhere |

In Codex, use `$posh` in place of `/posh`. The mode is saved in
`~/.config/posh/agent-mode` and shared by all three agents. These plugins are
not a claim that Anthropic, OpenAI, or OpenCode has reviewed or listed them.

#### Redirecting gem source reads

Instructions are advisory, and an agent deep in a task tends to read the
installed gem source anyway. In Claude Code, Codex, and OpenCode 2 the plugin declines that one
call and says what to run instead: reading a gem's source, or fetching its
documentation over HTTP, is declined once per gem per session when POSH has a
docset for that gem in this project.

The check resolves the Ruby project above the current working directory, stopping
at the Git root, including after entering a worktree. It validates POSH's returned
project against that root, not against an arbitrary subdirectory. It requires a matching locked gem with installed
documentation; private gems with docs are treated the same as public ones.
Redirect instructions pin both search and read to the resolved project, so an MCP
server started in a different project cannot silently select the wrong versions.
Gems with no local docs, git-sourced gems, non-Ruby projects in auto mode,
and `/posh off` are left alone. A broad search of the gem tree gets one
separate nudge when any locked gem has local docs.

All three harnesses run the same JavaScript policy in [`shared/lookup-policy.mjs`](shared/lookup-policy.mjs).
It owns lookup classification, mode and project checks, POSH discovery, redirect
text, and atomic retry markers. The adapters only translate their host contracts:

- Claude Code and Codex use [`hooks/posh-pre-tool-use.mjs`](hooks/posh-pre-tool-use.mjs)
  to turn the shared reason into a `PreToolUse` response. Their shell launcher
  invokes Node only for lookup interception.
- [`opencode/posh.mjs`](opencode/posh.mjs) maps OpenCode's built-in tool inputs,
  resolves the session's current location (or a shell's explicit `workdir`),
  imports the policy directly, and turns its reason into the host SDK's `Tool.Error`.

The policy uses Node's standard library, with no runtime parsing dependencies or
Ruby subprocesses. Claude/Codex interception requires Node on the hook's PATH.
Missing Node, missing or failing POSH, malformed responses, and unwritable
session state all leave normal tool permissions unchanged. A retry of the
same lookup goes through: this is an adoption nudge, not a security boundary
or a ban on implementation-level source inspection. GitHub matching uses
repository names as gem-name hints; it does not cover every repository or
arbitrary shell program.
Shell detection recognizes literal-leading commands (optionally `bundle exec`),
not executable-looking words printed as arguments; compound-command tails are skipped.
Filesystem detection recognizes Bundler/RubyGems installation layouts and custom
gem homes exported through `GEM_HOME` or `GEM_PATH`; a first-party directory merely
named `gems` is left alone. It does not run `Gem.path`, so arbitrary unexported
RubyGems path overrides are not detected.
Web lookups use the actual URL host and path, not embedded links in a query or fragment.

Claude Code alone supports `POSH_HOOK_DECISION=ask` to request approval instead
of declining the lookup. Codex does not support that response; Codex and OpenCode
always use a one-time denial followed by an allowed retry. In Codex, review the
new hooks in `/hooks` after updating. Hosted tools such as Codex's web search
do not pass through local tool hooks and are not intercepted.

OpenCode requires the 2.3+ plugin SDK; it supplies the runtime SDK, while the
repository pins a development copy for adapter tests. Claude and Codex hooks
need Node but not the OpenCode SDK. Lifecycle guidance and mode commands still
work without Node; only lookup interception is skipped when it is unavailable.

Session markers are scoped by project and gem, and live in the plugin's data
directory (or `$XDG_CACHE_HOME/posh/nudged`, defaulting to
`~/.cache/posh/nudged`). [`evals/`](evals/README.md) measures whether this
changes what the agent does; its live-agent suite currently targets Claude Code.

### Cursor plugin

Install and activate POSH first, then paste this into the browser address bar.
Cursor prompts before it installs:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=posh&config=eyJjb21tYW5kIjoicG9zaCIsImFyZ3MiOlsibWNwIl19
```

The encoded configuration is `{"command":"posh","args":["mcp"]}`. GitHub strips
`cursor://` links, so the one-click button lives in the
[installation docs](https://poshtui.com/docs/installation/#integrations)
instead.

This repository also includes `.cursor-plugin/plugin.json` and root `mcp.json`.
The deeplink adds only the MCP server; the plugin format also carries the POSH
skill, and Cursor lists plugins only after its own review. The integration
launches `posh mcp` locally; pass the intended absolute project path in tool
calls. This is not a claim that Cursor has reviewed or listed the plugin. POSH
remains proprietary software.

## Tools

| Tool | Purpose | Effects |
| --- | --- | --- |
| `docsets` | Discover project versions and installed documentation | Read-only |
| `search` | Find APIs and documentation | Read-only |
| `list` | Browse a docset's indexed entries | Read-only |
| `outline` | Get headings and section references | Read-only |
| `read` | Read a document or section | Read-only |
| `sync` | Download and index documentation | Network access and local cache/index writes |

Start with `docsets`, search using a returned library ref, and read the returned
document or section ref. Sync missing docs, then retry. Do not invent refs or
assume a tool call's project override persists to the next call.

## Privacy Policy

See [POSH's privacy policy](https://poshtui.com/privacy-policy). Documentation
lookups read locally synced documentation. Sync requires network access;
license activation and verification contact licensing services. Your MCP client
controls what tool results it sends to its model provider. Do not claim that all
MCP calls are offline or read-only.

## License and support

Copyright © 2026 KROONI B.V. All rights reserved. See [LICENSE](LICENSE) and
[Terms of Service](https://poshtui.com/terms-of-service). This repository does not
grant additional rights to POSH or its binaries.

- [Homepage](https://poshtui.com)
- [Installation](https://poshtui.com/docs/installation/)
- [Activation](https://poshtui.com/docs/activation/)
- [MCP documentation](https://poshtui.com/docs/mcp/)
- [Support](https://poshtui.com/contact): contact@poshtui.com
