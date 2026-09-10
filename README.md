# mcp-statement-of-account

<!-- mirror-seo:start -->

**MCP server for customer statements of account, accounts receivable and invoice aging.** The one document that answers what a client actually owes you, aged as at any date, with the chaser drafted.

Works with Claude Desktop, Claude Code, Cursor and any Model Context Protocol client. Runs on your own machine, or hosted with no install.

## Install

**Hosted, nothing to install.** Get a token from <https://mcp.zovo.one/mcp/connect> (the connect page) or <https://mcp.zovo.one/mcp/token> (the same token as JSON); a free anonymous one is issued on the spot and a Pro key works the same way. Then point an MCP client at `https://mcp.zovo.one/mcp/statement-of-account` over streamable-http and send the token as `Authorization: Bearer <token>`.

If your client cannot set headers, put the token in the path instead: `https://mcp.zovo.one/mcp/statement-of-account/t/<token>`. Both forms work. The bare URL with no token answers 401 on `tools/call`, so the token is not optional.

**Claude Desktop, one click.** Download `statement-of-account.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it.

**From source.** The mirror is self-contained: every `@theluckystrike/*` dependency is vendored, so a fresh clone builds with no extra setup.

```sh
git clone https://github.com/theluckystrike/mcp-statement-of-account.git
cd mcp-statement-of-account
npm install && npm run build
```

Then point your client at the built entry point:

```json
{
  "mcpServers": {
    "statement-of-account": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-statement-of-account/dist/index.js"]
    }
  }
}
```

> `@theluckystrike/mcp-statement-of-account` is **not published on npm yet**, so an `npx -y @theluckystrike/mcp-statement-of-account` command will fail. The three paths above are the working ones and each is exercised by CI.

![statement-of-account demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-statement-of-account.gif)

Read-only mirror of [mcp-servers/servers/statement-of-account](https://github.com/theluckystrike/mcp-servers/tree/main/servers/statement-of-account). See [MIRROR.md](MIRROR.md).

<!-- mirror-seo:end -->

Send a client the one document that answers "what do I actually owe you". This MCP server
reads the books you already keep in this suite -- your invoices, your credit notes and your
deposits -- and turns them into a statement of account for a period: the balance you were
carrying at the start, every invoice you issued, every payment that came in, every credit
note you gave, and the balance at the end. It ages what is still open into 0-30, 31-60,
61-90 and over 90 days past due, so you can see at a glance which client is the problem;
it writes the statement as pasteable text or as an A4 PDF that looks like your invoices;
and it drafts the chaser, at a friendly, a firm or a final level. It never writes anything
back into your invoices, and it never invents a late fee.

Built by [theluckystrike](https://github.com/theluckystrike).

npm publish for `@theluckystrike/mcp-statement-of-account` is pending, so `npx -y @theluckystrike/mcp-statement-of-account` returns 404 today. Until then, the `.mcpb` one-click bundle or a clone+build is the working path.

## Install

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), same entry as Claude Desktop.

## Tools

| tool | what it does |
| --- | --- |
| `statement_build` | One client's statement for a period: opening balance, invoices issued, payments received, credit notes, deposits applied, closing balance. Every figure in minor units and formatted |
| `statement_aging` | What is owed, split into 0-30, 31-60, 61-90 and over 90 days past the due date as at a chosen date, for one client or for everyone, per currency |
| `statement_text` | The same statement as plain text, movements in date order, ready to paste into an email |
| `statement_pdf` | The same statement as an A4 PDF titled STATEMENT OF ACCOUNT, on the same page layout as your invoices and credit notes |
| `dunning_text` | A payment chaser at level 1 (friendly), 2 (firm) or 3 (final demand), with the overdue list and your bank details |
| `statements_report` | Every client at once: what is outstanding per currency, aged, and the oldest overdue invoice in the book |
| `license_status` | Free or Pro, and where to upgrade |
| `license_activate` | Activate a Pro key |

Plus the `statement://sources` resource, which says which of the three stores this server
could read and how many rows each holds, and the `chase_overdue` prompt.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Statements built | 5 a calendar month | unlimited |
| Rebuilding a statement already built | unlimited | unlimited |
| `statement_aging` | unlimited | unlimited |
| `statement_text` | yes | yes |
| `dunning_text` levels 1 and 2 | yes | yes |
| `dunning_text` level 3, final demand | no | yes |
| `statement_pdf` | no | yes |
| `statements_report` | no | yes |
| PDF footer credit | shown | removed |

Aging is free and unlimited on purpose. "Who owes me money" is the question this whole
server exists for, and a free tier that hides it is a demo rather than a tool. The meter is
on the statement, the document that actually goes to a client, and it counts distinct
statements: the same client, period and currency built again is free forever.

[Get Pro](https://mcp.zovo.one/buy/statement-of-account) -- one-time, lifetime, for this
server. Keys verify offline.

## Where the numbers come from

Nothing here is typed in twice. The server reads three stores and writes to none of them:

| store | server | what is taken from it |
| --- | --- | --- |
| `invoices.json` | `mcp-invoice` | the invoices, their due dates and how much of each is paid |
| `credit-notes.json` | `mcp-billing-docs` | the credit notes, already stored with a negative sign |
| `deposits.json` | `mcp-deposits` | the deposit applications, and what is still held |

A store you have never installed is simply absent, and the statement is built without it.
A store that is on disk and cannot be READ is a different thing entirely, and is reported
as such on every figure, because a balance that could not be computed must never be shown
as a balance of nothing owed. The one store the server refuses to work without is the
invoice ledger.

## A measured insight

**Aging a past date with today's payment figures is not slightly wrong, it is silently
empty.** Aging is usually written as "take each invoice, subtract what has been paid, and
bucket by the due date". The subtraction is the part nobody dates. On the worked month in
`test/_client.mjs`, aged at 2026-06-10, the two rules give:

| rule | outstanding | overdue |
| --- | --- | --- |
| as at 2026-06-10 | 2,500.00 EUR | 500.00 EUR, 31 days late |
| today's `paid_minor` | 1,700.00 EUR | 0.00 EUR |

The naive rule understates what was owed by 800.00 of 2,500.00, a third of the balance,
and it reports NOTHING overdue on a date when an invoice was a month late, because a
payment that arrived two days later has already been subtracted from it. The failure is
invisible: the answer looks tidy, the buckets add up, and it cannot be reproduced next
month because the input keeps moving. So every figure in `statement_aging` is taken as at
the date asked for, in both directions: an invoice issued after it is not on the books, a
payment made after it has not happened, and a credit note issued after it has not been
given.

The second thing measurement showed: `paid_minor` and `payments[]` on an invoice do not
have to agree, and routinely do not. `invoice_mark_paid` writes both, but `deposit_apply`
raises `paid_minor` and appends no payment row at all, and an invoice created before that
field existed has no rows either. Reconstructing receipts from `payments[]` would have
lost 300.00 of the worked month's 900.00 of receipts, a third of the cash, with no error
anywhere. `paid_minor` is treated as the authority and the rows are only the attribution.

## Rules this server holds to

- **A deposit is money that moves once.** Applying a deposit already writes the payment on
  the invoice, so the statement counts it there and breaks it out as "of which deposits
  applied" rather than crediting it a second time. Deposit money still held is a memo line
  and is never part of the balance: it is the client's money until it is applied.
- **Currencies are never added together.** One statement is one currency, and a client
  billed in two is asked which. There is no exchange rate in this server, so a single
  figure across a EUR ledger and a USD one would be one it made up.
- **Due today is not overdue.** An invoice enters the 0-30 bucket on the first day past its
  due date. What is outstanding but not yet due is reported beside the buckets, never
  inside them and never hidden.
- **A credit note reduces the invoice it names and no other.** An open balance floors at
  zero and any excess is reported as unapplied credit, rather than quietly cancelling an
  invoice the client never agreed it against.
- **No chaser invents a charge.** The three dunning levels differ in tone and deadline and
  in nothing else. No level states a late fee, an interest rate or a legal cost, because
  this server holds no contract terms, no statutory rate and no jurisdiction, and the one
  place never to put a made-up number is a demand for money.
- **A chaser for a client with nothing overdue is refused**, and the refusal says what is
  outstanding but not yet due.

## Privacy

All data stays on your machine. The invoices, credit notes and deposits are read from
`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/`, this server's own register of built
statements is written to `.../mcp-servers/statement-of-account/`, and nothing is sent
anywhere. There is no network call in this server at all. License keys verify offline.

## License

MIT. Support: support@zovo.one

Built by [theluckystrike](https://github.com/theluckystrike).
