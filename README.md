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

### Claude Code plugin

This repository includes `.claude-plugin/plugin.json` and `.mcp.json` for plugin
distribution. POSH must already be installed and activated. This is not a claim
that Anthropic has reviewed or listed the plugin.

### Cursor plugin

This repository includes `.cursor-plugin/plugin.json` and root `mcp.json`.
Install and activate POSH first. The integration launches `posh mcp` locally;
pass the intended absolute project path in tool calls. This is not a claim that
Cursor has reviewed or listed the plugin. POSH remains proprietary software.

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
