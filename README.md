# GhostPM 👻

Zero-latency, vendor-agnostic PM interface for AI agents. Connects GitHub Issues and Azure DevOps to any MCP-compatible AI tool.

## Install

```bash
npm install -g ghostpm
```

### Prerequisites

- Node.js v18+
- [GitHub CLI (`gh`)](https://cli.github.com/) or [Azure CLI (`az`)](https://learn.microsoft.com/en-us/cli/azure/)
- Logged in: `gh auth login` or `az login`

## Quick Start

```bash
cd your-project
ghostpm init
```

`init` auto-detects your PM vendor from `.git/config`, sniffs workflow states from your existing issues, creates `.mcp-pm.yml`, and registers the MCP server with Claude Code and Claude Desktop. No manual config editing.

## Commands

| Command | Description |
|---------|-------------|
| `ghostpm init` | Initialize project + auto-register MCP server |
| `ghostpm setup` | Re-register MCP server with AI tools |
| `ghostpm setup --global` | Register in global Claude Code settings |
| `ghostpm tasks` | List cached tasks from local DB |
| `ghostpm sync` | Force sync with remote PM tool |
| `ghostpm status` | Show vendor, cache size, outbox, last sync |
| `ghostpm serve` | Start MCP server (used by MCP clients internally) |

## How It Works

GhostPM uses a local-first **Outbox Pattern**:

1. **Local SQLite cache** (`.mcp-pm.db`) stores the latest known board state
2. **Reads are instant** — always served from cache, zero network latency
3. **Writes queue locally** — optimistically applied to cache, synced in background
4. **Conflict detection** — if remote changed while your update was queued, GhostPM flags it and provides `resolve_conflict`

A background daemon polls every 5 minutes, or syncs immediately after any mutation.

## MCP Tools

Once connected, AI agents get these tools:

| Tool | Description |
|------|-------------|
| `query_tasks` | Markdown table of all cached tasks |
| `get_task` | Full JSON of a single task |
| `start_task` | Transition to "In Progress" + checkout `task/<id>` branch |
| `update_task` | Change state or add comment |
| `open_attachment` | Open URL in local browser |
| `resolve_conflict` | Resolve sync conflict (keep local or accept remote) |

## Supported Providers

- **GitHub Issues** — uses `gh` CLI
- **Azure DevOps** — uses `az boards` CLI

## Configuration

`ghostpm init` generates `.mcp-pm.yml` at your repo root:

```yaml
vendor: "github"
workflow:
  states: ["open", "in_progress", "in_review", "closed"]
  transitions:
    start_task: "in_progress"
    code_push: "in_review"
views:
  list_columns: ["id", "state", "title", "assignee"]
  detail_fields: ["id", "title", "body", "comments"]
```

## Manual MCP Registration

If `ghostpm setup` doesn't cover your MCP client, add this to your client's config:

```json
{
  "mcpServers": {
    "ghostpm": {
      "command": "ghostpm",
      "args": ["serve"]
    }
  }
}
```

## Development

```bash
git clone https://github.com/dpkay-io/ghostpm.git
cd ghostpm
npm install
npm run build
npm test
```

## License

MIT
