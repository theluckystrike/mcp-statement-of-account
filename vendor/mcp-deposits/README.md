# mcp-deposits

Security and retainer deposits, held per client, on the same engine as your invoices.

A deposit is the client's money sitting on your account. It has to be recorded when it arrives, set
against an invoice when the work is billed, given back when it is not, and answered for at any point
in between: how much of theirs are you holding, in which currency, since when. This server does
those four things, against the invoices and the clients the `mcp-invoice` server already holds. When
a deposit is applied to an invoice, the payment is recorded on that invoice, so `invoice_list` and
`overdue_report` stop chasing money you already have. Everything stays on your machine.

Built on `@theluckystrike/mcp-invoice/lib` for the money, currency and store code, and on
`@theluckystrike/mcp-billing-docs/lib` for the A4 page, so a deposit statement looks like the credit
note and the invoice next to it and agrees with them to the minor unit.

![deposits demo](../../assets/demo-deposits.gif)

npm publish for `@theluckystrike/mcp-deposits` is pending, so `npx -y @theluckystrike/mcp-deposits` returns 404 today. Until then, the `.mcpb` one-click bundle or a clone+build is the working path.

## Install

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "deposits": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-deposits"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add deposits -- npx -y @theluckystrike/mcp-deposits
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "deposits": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-deposits"]
    }
  }
}
```

Run `mcp-invoice` alongside it: this server reads that server's invoices and clients, writes the
payment an applied deposit makes onto the invoice, and both take their name, address, VAT id and
default currency from one shared business profile.

## Tools

| tool | what it does |
| --- | --- |
| `deposit_record` | Record a security or retainer deposit received: amount in minor units, currency, date, reference |
| `deposit_list` | Every deposit with received, applied, refunded and held. Filter by client, status, kind or date |
| `deposit_apply` | Apply part or all of a held deposit to an invoice, as a payment on that invoice |
| `deposit_refund` | Give part or all of a held deposit back, with the date and the method |
| `deposit_delete` | Remove a deposit recorded by mistake, if none of it was ever applied or refunded |
| `deposit_balance` | What is held, per client and per currency: received, applied, refunded, held |
| `deposit_statement_text` | The plain-text statement to paste into an email |
| `deposit_statement_pdf` | The A4 PDF, titled DEPOSIT STATEMENT (Pro) |
| `deposits_report` | Held per currency, the oldest held deposits, and what has sat unapplied for N days (Pro) |
| `license_status`, `license_activate` | Free or Pro, and how to upgrade |

One resource, `deposits://held`, and one prompt, `settle_deposits`.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Deposits recorded per calendar month | 5 | Unlimited |
| Applying to invoices, refunds, balances, lists | Yes, unlimited | Yes |
| `deposit_delete` for a deposit that never moved money | Yes, unlimited | Yes |
| `deposit_statement_text` | Yes, unlimited | Yes |
| `deposit_statement_pdf` | No | Yes, plus your logo and no footer credit |
| `deposits_report` | No | Yes |

The free cap is on recording new deposits only. Money already held can always be applied, refunded
and accounted for, on any tier: a limit that trapped a client's deposit would be a limit on their
money, not on yours.

The cap counts the deposits stored with a received date in that month, so `deposit_delete` gives the
slot straight back: a deposit typed in twice or with the wrong amount costs nothing but the id.
`deposit_record` also refuses a deposit that matches one already stored on client, amount, currency,
kind, received date and reference, names that id and stores nothing, so the same money is never held
twice and no free slot is spent on a retry.

Get Pro: https://mcp.zovo.one/buy/deposits ($19 one-time for this server, $39 for the bundle).

## A measured thing

**The invoice server's own payment tool SETS the amount paid, so routing a deposit through it erases
the payment that came before.** Measured against `servers/invoice/dist/index.js` on a EUR 1,000.00
invoice: `invoice_mark_paid {amount: 200}` for a bank transfer, then `invoice_mark_paid {amount:
300}` for the deposit, leaves `paid_minor` at 30000 and the reply reads "balance due EUR 700.00". The
EUR 200.00 that actually arrived is gone from the record, and the client gets chased for it.

`deposit_apply` writes the same three fields on the same record -- `paid_minor`, `paid_date`,
`status` -- but ADDS: the same two payments leave `paid_minor` at 50000 and a balance due of EUR
500.00. Asserted in `test/unit.test.mjs`, "a second application ADDS to paid_minor, it does not
replace it".

The general form: a store shared between two servers is safe to write only if you have read how the
owning server writes it. The field names matching is not the contract; the arithmetic on them is.

## Privacy

All data stays local: `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/deposits/`. No account, no API
key, no network call, ever. Licence keys are verified offline.

Built by [theluckystrike](https://github.com/theluckystrike). Support: support@zovo.one
