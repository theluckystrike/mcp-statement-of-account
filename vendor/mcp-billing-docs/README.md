# mcp-billing-docs

Credit notes and purchase orders, on the same engine as your invoices.

When a client sends work back, or you billed them twice, you owe them a credit note: a document that
names the invoice it reverses and takes the money off it, with the VAT unwound at the rate you
charged. When you order from a supplier, you owe them a purchase order: what you want, at what price,
by when, with your own details on it. This server writes both, against the invoices and the clients
the `mcp-invoice` server already holds, and it will not let a credit note give back more money than
the invoice charged. Sending the same document twice is refused by the id of the one already there,
and a document nothing depends on can be deleted, so a re-send never costs you a free-tier slot.
Everything stays on your machine.

Built on `@theluckystrike/mcp-invoice/lib`: the money, VAT, currency and formatting code is the
invoice server's, not a second copy of it, so a credit note and the invoice it reverses agree to the
minor unit.

![billing-docs demo](../../assets/demo-billing-docs.gif)

## Install

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "billing-docs": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-billing-docs"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add billing-docs -- npx -y @theluckystrike/mcp-billing-docs
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "billing-docs": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-billing-docs"]
    }
  }
}
```

Run `mcp-invoice` alongside it: this server reads that server's invoices and clients, and both take
their name, address, VAT id and default currency from one shared business profile.

## Tools

| tool | what it does |
| --- | --- |
| `credit_note_create` | Credit an invoice: the whole thing, a gross amount, or named lines with quantities |
| `credit_note_list` | Every credit note, with the credited total per currency. Filter by invoice, client or date |
| `credit_note_get` | One credit note in full |
| `credit_note_pdf` | The A4 PDF, titled CREDIT NOTE and carrying the invoice number it reverses (Pro) |
| `credit_note_text` | The plain-text version to paste into an email |
| `credit_note_delete` | Remove one that was never posted to its invoice or rendered: the free monthly slot comes back |
| `purchase_order_create` | Raise an order: line items, VAT, currency, expected delivery date |
| `purchase_order_list` | Every order with its status: open, partially received, received |
| `purchase_order_get` | One order in full, with its receipts |
| `purchase_order_pdf` | The A4 PDF, titled PURCHASE ORDER (Pro) |
| `purchase_order_text` | The plain-text version to send the supplier |
| `purchase_order_receive` | Mark an order received, in full or in part |
| `purchase_order_delete` | Remove one with nothing received against it and no render: the free monthly slot comes back |
| `billing_docs_report` | Credited per currency, on order per currency, deliveries past their date (Pro) |
| `license_status`, `license_activate` | Free or Pro, and how to upgrade |

One resource, `billing-docs://open-orders`, and one prompt, `chase_deliveries`.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Documents per calendar month | 5, credit notes and purchase orders together | Unlimited |
| `credit_note_delete`, `purchase_order_delete` | Yes: the cap counts what is in the store, so a delete returns the slot | Yes |
| `credit_note_text`, `purchase_order_text` | Yes, unlimited | Yes |
| Full, partial and per-line credit notes, VAT, multi-currency, receiving orders | Yes | Yes |
| `credit_note_pdf`, `purchase_order_pdf` | No | Yes, plus your logo and no footer credit |
| `billing_docs_report` | No | Yes |

Get Pro: https://mcp.zovo.one/buy/billing-docs ($19 one-time for this server, $39 for the bundle).

## A measured thing

**Crediting part of a mixed-VAT invoice at one rate is wrong by more than the rounding you would
expect.** An invoice of EUR 1,000.00 consulting at 23% plus EUR 500.00 print at 8% totals EUR
1,770.00. Credit ten percent of it, EUR 177.00, the way a single-rate credit note would: net EUR
143.90, VAT EUR 33.10. This server splits the credit across the rates the invoice actually used, in
proportion to each rate's share of the total, and gets net EUR 150.00 with VAT of EUR 23.00 at 23%
and EUR 4.00 at 8%, EUR 27.00 in all. The gross the client sees is identical either way. The VAT line
differs by EUR 6.10, 22.6 percent of it, and that is the number that goes on a VAT return.

Asserted in `test/unit.test.mjs`, "a credit note by amount splits the gross across the invoice's VAT
rates and reuses each rate".

## Privacy

All data stays local: `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/billing-docs/`. No account, no API
key, no network call, ever. Licence keys are verified offline.

Built by [theluckystrike](https://github.com/theluckystrike). Support: support@zovo.one
