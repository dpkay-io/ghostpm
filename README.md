# GhostPM 👻

**The invisible, zero-latency PM interface for AI Agents.**

GhostPM is a Model Context Protocol (MCP) server that seamlessly bridges the gap between AI coding agents (like Claude Desktop or custom agents) and your remote project management tools (GitHub Issues, Azure DevOps). 

It utilizes a robust **local-first Outbox Pattern**, meaning your agent experiences exactly **zero latency** when querying or updating tasks. GhostPM intercepts updates, saves them instantly to a local SQLite cache, and syncs them in the background with the remote PM tools via their native CLIs (`gh` and `az`).

## Why GhostPM?

- ⚡ **Zero Latency:** Your AI agent never has to wait 5+ seconds for a network request to GitHub or Azure DevOps. Tasks are queried and updated instantly from a local cache.
- 🔗 **Vendor Agnostic:** Your agent interacts with a single, unified set of MCP tools (`query_tasks`, `get_task`, `start_task`, etc.) regardless of whether the project uses GitHub Issues or Azure DevOps.
- 🔐 **No OAuth Hassle:** GhostPM piggybacks off your existing terminal CLI authentications (`gh auth login` and `az login`). If your terminal has access, GhostPM has access. No secret keys or complex OAuth flows required.
- 🛠️ **Developer Friendly:** Creates local branches automatically when a task is started, and provides a way to instantly open attachments in your local browser.

## Architecture

GhostPM uses a highly resilient Outbox Sync pattern:
1. **Local SQLite Cache (`.mcp-pm.db`)**: Stores the latest known state of your PM board.
2. **Outbox Queue**: When an AI agent updates a task, it's queued in the outbox and the cache is optimistically updated.
3. **Background Daemon**: A background polling loop constantly flushes outbox mutations to the remote CLI and pulls down the latest remote changes.
4. **Conflict Resolution**: If the remote state overtakes your local outbox payload, GhostPM catches it and provides a `resolve_conflict` tool to let you decide who wins.

## Supported Providers
- **GitHub Issues** (requires the `gh` CLI)
- **Azure DevOps** (requires the `az` and `az boards` CLI extensions)

---

## Installation

### Prerequisites
- Node.js (v18+)
- [GitHub CLI (`gh`)](https://cli.github.com/) OR [Azure CLI (`az`)](https://learn.microsoft.com/en-us/cli/azure/)
- Ensure you are logged into your respective CLI.

### Setup

```bash
# Clone the repository
git clone https://github.com/your-username/ghostpm.git
cd ghostpm

# Install dependencies
npm install

# Build the project
npm run build
```

## Initialization

Navigate to any local Git repository where you want to enable GhostPM and run the initialization script.

```bash
npx ghostpm init
```
*Note: You can run `node /path/to/ghostpm/dist/init.js` if not installed globally.*

GhostPM will automatically detect whether your remote is hosted on GitHub or Azure DevOps, sniff your board's available workflow states, and generate a `.mcp-pm.yml` configuration file at the root of your repository.

## Adding to an AI Agent

Add GhostPM to your MCP client configuration (e.g., `mcp.json` or `claude_desktop_config.json`).

```json
{
  "mcpServers": {
    "ghostpm": {
      "command": "node",
      "args": [
        "/path/to/ghostpm/dist/mcp-server.js"
      ],
      "cwd": "C:/Path/To/Your/Project"
    }
  }
}
```

*Note: Ensure the `cwd` points to the root of your project where the `.mcp-pm.yml` file is located.*

## Exposed MCP Tools

Once connected, your AI Agent will have access to the following tools:

- `query_tasks`: Fetches a tabular list of tasks based on a filter string.
- `get_task`: Fetches the full JSON details of a specific task.
- `start_task`: Transitions a task to "In Progress" and automatically checks out a new git branch (e.g., `task/<id>`).
- `update_task`: Updates a task's state or adds a comment.
- `open_attachment`: Opens a URL securely in your machine's default browser (great for viewing screenshots or PDFs attached to tasks).
- `resolve_conflict`: Resolves a sync conflict by forcing the local state or dropping it in favor of the remote.

---

## Testing

GhostPM includes a comprehensive test suite (powered by Jest) with near 100% code coverage.

```bash
npm run test
npm run test:coverage
```

## License
MIT
