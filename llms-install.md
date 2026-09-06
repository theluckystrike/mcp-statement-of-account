# Installing mcp-statement-of-account (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Statement of account** (@theluckystrike/mcp-statement-of-account)
What it does: Build a per-client statement of account for a period from the invoice, credit note and deposit stores this suite already keeps: opening balance, invoices issued, payments received, credit notes, deposits applied and closing balance. Ages the open invoices into 0-30, 31-60, 61-90 and over 90 days past due, writes the statement as text or as an A4 PDF, and drafts a dunning letter at three levels. It reads those three stores and writes to none of them. All data stays on the local machine and nothing is fetched at run time.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/statement-of-account
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-statement-of-account` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`. Everything else on this page is unchanged.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native build tools beyond what `pdfkit` needs, which is none; the package is pure JavaScript.
- This server is only useful next to `mcp-invoice`, which owns the invoice ledger it reads. `mcp-billing-docs` (credit notes) and `mcp-deposits` are optional: a store that is not there is simply absent from the statement.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-statement-of-account
```

The server speaks MCP over stdio. It writes nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`.
Merge this entry into the existing `mcpServers` object; do not overwrite the file.

```json
{
  "mcpServers": {
    "statement-of-account": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-statement-of-account"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add statement-of-account -- npx -y @theluckystrike/mcp-statement-of-account
```

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Same entry as Claude Desktop.

### Cline

File: `cline_mcp_settings.json` (VS Code: Cline panel -> MCP Servers -> Configure MCP Servers). Merge:

```json
{
  "mcpServers": {
    "statement-of-account": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-statement-of-account"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Step 3 - restart the client and verify

Restart the client, then call `license_status`. A successful call returns the current mode (free or pro) and proves the transport works. Then read the `statement://sources` resource: it must list the three stores this server reads, each with `read: true` or `read: false` and a row count, and the one file it writes. Then call `statement_aging {}`: with an invoice ledger present it returns the buckets, and with an empty one it returns no clients rather than an error. `tools/list` must show the eight tools from the server README.

## Optional - Pro key

A Pro key removes the free-tier limits listed in the README. Either add it to the config:

```json
"env": { "MCP_LICENSE_KEY": "MCPL1..." }
```

or call the `license_activate` tool once with the key. Keys are verified offline; nothing is sent anywhere. Keys: https://mcp.zovo.one/buy/statement-of-account

## Alternative A - .mcpb bundle (Claude Desktop one-click)

Download `statement-of-account.mcpb` from https://github.com/theluckystrike/mcp-servers/releases and open it, or drag it onto the Claude Desktop Extensions pane. This installs the server without editing JSON and without Node on PATH assumptions.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build -w servers/timezone -w packages/mcp-license -w servers/invoice -w servers/billing-docs -w servers/quotes -w servers/deposits -w servers/statement-of-account
```

Build the siblings before this server: the invoice ledger, the money formatting and the corrupt-store quarantine come from `mcp-invoice`, the A4 page renderer and the credit note store from `mcp-billing-docs`, the deposit store from `mcp-deposits`, and the timezone-aware "today" from `mcp-quotes`.
Then use `"command": "node", "args": ["<abs path>/mcp-servers/servers/statement-of-account/dist/index.js"]`.

## Alternative C - Docker

```sh
docker buildx build -f servers/statement-of-account/Dockerfile -t mcp-statement-of-account .
```

The build context is the repository root. Run with `docker run -i --rm -v mcp-servers-data:/root/.local/share/mcp-servers mcp-statement-of-account`. Mount the SAME volume the invoice server uses, or there will be no books to state.

## Troubleshooting

- `command not found: npx` - install Node.js 18+.
- Tools missing after config edit - the client only reads the config at startup; restart it fully.
- `"no client named ... appears on any invoice, credit note or deposit"` - the client name is matched against the documents themselves, not against a list this server keeps. The refusal lists every client that does appear. Pass one of those, or the invoice server's client id.
- `"the invoice store could not be read"` - `invoices.json` is on disk and did not parse, so it was quarantined as `invoices.json.corrupt-<timestamp>` with a marker beside it. Restore a good copy and delete the marker. This server refuses every tool until that is done, deliberately: a statement built over an unreadable ledger would say nothing is owed.
- `"one statement is in one currency"` - the client has documents in more than one currency. Pass `currency`. Currencies are never added together; there is no exchange rate in this server.
- `"nothing to chase"` from `dunning_text` - the client has nothing PAST its due date at that date. What is outstanding but not yet due is named in the refusal.
- `"the free tier builds 5 statements a calendar month"` - rebuild any statement already in the register at no cost, use `statement_aging` which is never metered, or activate a Pro key.
- Data location: this server's register of built statements in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/statement-of-account/`. The invoices, credit notes and deposits live in their own servers' directories and are never written to from here.

Built by theluckystrike (https://github.com/theluckystrike).
