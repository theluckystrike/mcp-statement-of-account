#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { formatMoney, type ComputedLine } from "@theluckystrike/mcp-invoice/lib";
import { renderDocPdf } from "@theluckystrike/mcp-billing-docs/lib";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import {
  dataDir, findStatement, getStatements, lockPath, nextStatementId, setStatements, statementKey,
  type StatementRecord,
} from "./store.js";
import {
  businessMissing, degradedNotes, invoicesUnreadable, issuer, NO_BUSINESS_NOTE,
  readSources, sourceReport, type SourceSet,
} from "./sources.js";
import {
  ageClient, allMovements, buildStatement, BUCKETS, oldestOverdue, pickCurrency, resolveClient,
  type AgedInvoice, type Bucket, type ClientScope, type Movement, type Statement,
} from "./statement.js";

/**
 * Free tier: five DISTINCT statements a calendar month, plus aging with no limit at all.
 *
 * Aging is free because it is the answer to "who owes me money", and a free tier that
 * hides that is not useful, it is a demo. The meter is on the statement -- the document
 * that gets sent to a client -- and it counts distinct client, period and currency
 * combinations, so re-rendering September for the same client as many times as needed
 * costs nothing after the first.
 *
 * Pro removes the cap and adds the three outputs that only matter once there are enough
 * clients to need them: the A4 PDF, the final-demand dunning level, and the report
 * across every client at once.
 */
const FREE_STATEMENTS_PER_MONTH = 5;
const MAX_NAME = 200;
const MAX_TEXT = 4000;
const MAX_ROWS = 2000;

const gate = createLicenseGate({ product: "statement-of-account" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));

const str = (field: string, max: number) => z.string().max(max, `${field} must be ${max} characters or fewer`);

/**
 * Only this server's own register is ever written, so there is one lock and it is this
 * server's. The invoice, credit note and deposit stores are read and never written, so
 * their locks are not taken: holding another server's lock for the length of a read it
 * does not need would block that server's own writes for no gain.
 */
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}

function expandPath(p: string): string {
  const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}

function checkDate(value: string | undefined, fallback: string, field: string): string {
  const d = value ?? fallback;
  if (!isIsoDate(d)) throw new Error(`cannot read a date: ${field} "${value}" is not a real date in YYYY-MM-DD form.`);
  return d;
}

/* ----------------------------------------------------------------- assembly */

/** Read the stores once per call and refuse by name when the invoice ledger is unreadable. */
function sources(toolName: string): SourceSet {
  const s = readSources();
  if (!s.invoices.ok) throw new Error(invoicesUnreadable(s, toolName));
  return s;
}

function scopeFor(s: SourceSet, client: string, currency: string | undefined): { scope: ClientScope; currency: string } {
  const scope = resolveClient(s, client);
  return { scope, currency: pickCurrency(scope, currency) };
}

const money = (minor: number, currency: string) => formatMoney(minor, currency);

function movementRow(m: Movement, currency: string) {
  return {
    date: m.date, kind: m.kind, reference: m.reference, description: m.description,
    amount: money(m.amount_minor, currency), amount_minor: m.amount_minor,
  };
}

function statementJson(st: Statement, s: SourceSet, record?: StatementRecord) {
  return {
    statement_id: record?.id,
    client: st.client.name,
    client_id: st.client_id,
    currency: st.currency,
    period: { from: st.from, to: st.to },
    opening_balance: money(st.opening_minor, st.currency),
    opening_balance_minor: st.opening_minor,
    invoices_issued: money(st.invoiced_minor, st.currency),
    invoices_issued_minor: st.invoiced_minor,
    payments_received: money(st.paid_minor, st.currency),
    payments_received_minor: st.paid_minor,
    of_which_deposits_applied: money(st.deposits_applied_minor, st.currency),
    of_which_deposits_applied_minor: st.deposits_applied_minor,
    credit_notes: money(st.credited_minor, st.currency),
    credit_notes_minor: st.credited_minor,
    closing_balance: money(st.closing_minor, st.currency),
    closing_balance_minor: st.closing_minor,
    deposit_still_held: money(st.held_deposit_minor, st.currency),
    deposit_still_held_minor: st.held_deposit_minor,
    movements: st.rows.map((m) => movementRow(m, st.currency)),
    basis:
      "closing = opening + invoices issued - payments received - credit notes. Payments received ALREADY includes any deposit applied to an " +
      "invoice, because deposit_apply writes that money onto the invoice itself; of_which_deposits_applied breaks it out and never adds it again. " +
      "Deposit money still held is a memo: it is the client's money, not a payment, until it is applied.",
    sources: sourceReport(s),
    notes: [...degradedNotes(s), ...st.warnings],
  };
}

/* ------------------------------------------------- the register and the cap */

function capRefusal(count: number, month: string, toolName: string): string {
  return `the free tier builds ${FREE_STATEMENTS_PER_MONTH} statements a calendar month and ${count} have already been built in ${month}. ` +
    `statement_aging stays free and unlimited, and any statement already in the register can be rebuilt as often as you like at no cost. ` +
    `Nothing was written. ` + gate.upgradeText("unlimited statements", toolName);
}

/**
 * Register the statement, or refuse it. Returns the stored record.
 *
 * A statement already in the register is UPDATED, never counted again: the meter is on
 * distinct statements, not on renderings. The check and the write are one critical
 * section, so two processes racing the fifth free statement of the month cannot both
 * pass it.
 */
async function register(st: Statement, toolName: string): Promise<StatementRecord> {
  return await locked(() => {
    const list = getStatements();
    const key = statementKey(st.client.name, st.from, st.to, st.currency);
    const existing = findStatement(list, key);
    const now = new Date().toISOString();
    const figures = {
      opening_minor: st.opening_minor, invoiced_minor: st.invoiced_minor, paid_minor: st.paid_minor,
      credited_minor: st.credited_minor, closing_minor: st.closing_minor, movements: st.rows.length,
    };
    if (existing) {
      Object.assign(existing, figures, { updated: now });
      setStatements(list);
      return existing;
    }
    const month = now.slice(0, 7);
    if (!gate.isPro()) {
      const built = list.filter((r) => r.built_month === month).length;
      if (built >= FREE_STATEMENTS_PER_MONTH) throw new Error(capRefusal(built, month, toolName));
    }
    const rec: StatementRecord = {
      id: nextStatementId(st.to.slice(0, 4), list.map((r) => r.id)),
      client_id: st.client_id, client_name: st.client.name,
      from: st.from, to: st.to, currency: st.currency,
      ...figures, built_month: month, built: now, updated: now,
    };
    list.push(rec);
    setStatements(list);
    return rec;
  });
}

/* ------------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-statement-of-account", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const clientArg = str("client", MAX_NAME).min(1, "client is required")
  .describe("Client id from the invoice server, an exact client name, or a name containing this text");
const currencyArg = z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as EUR").optional()
  .describe("Only needed when the client has documents in more than one currency. Currencies are never added together");

server.registerTool("statement_build", {
  title: "Build a statement of account",
  description: "Build one client's statement of account for a period: opening balance, invoices issued, payments received, credit notes, deposits applied and closing balance, in minor units and formatted.",
  inputSchema: {
    client: clientArg,
    from: str("from", 10).describe("First day of the period, YYYY-MM-DD. Everything dated before it becomes the opening balance"),
    to: str("to", 10).describe("Last day of the period, YYYY-MM-DD, inclusive"),
    currency: currencyArg,
  },
}, async (a) => {
  try {
    const s = sources("statement_build");
    const from = checkDate(a.from, "", "from");
    const to = checkDate(a.to, "", "to");
    const { scope, currency } = scopeFor(s, a.client, a.currency);
    const st = buildStatement(scope, currency, from, to);
    const rec = await register(st, "statement_build");
    return json(statementJson(st, s, rec));
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("statement_aging", {
  title: "Age the open invoices",
  description: "Break what is owed into 0-30, 31-60, 61-90 and over 90 days past the invoice due date as at a chosen date, for one client or for every client, per currency. Free and unlimited.",
  inputSchema: {
    client: str("client", MAX_NAME).optional().describe("One client id or name. Omit to age every client in the books"),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe("Only this currency. Omit for every currency, each aged separately"),
    as_of: str("as_of", 10).optional().describe("Age the invoices as at this date, YYYY-MM-DD. Defaults to today"),
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum invoice rows returned, default and ceiling ${MAX_ROWS}`),
  },
}, async (a) => {
  try {
    const s = sources("statement_aging");
    const asOf = checkDate(a.as_of, today(), "as_of");
    const scopes: ClientScope[] = a.client
      ? [resolveClient(s, a.client)]
      : clientNames(s).map((n) => resolveClient(s, n));
    const rows: Array<Record<string, unknown>> = [];
    const invoices: AgedInvoice[] = [];
    for (const scope of scopes) {
      const currencies = a.currency ? [a.currency.toUpperCase()] : scope.currencies;
      for (const cur of currencies) {
        if (!scope.currencies.includes(cur)) continue;
        const aged = ageClient(scope, cur, asOf);
        if (!aged.outstanding_minor && !aged.unapplied_credit_minor) continue;
        invoices.push(...aged.invoices);
        rows.push({
          client: scope.name, currency: cur,
          buckets: Object.fromEntries(BUCKETS.map((b) => [b, {
            amount: money(aged.buckets[b], cur), amount_minor: aged.buckets[b],
            invoices: aged.invoices.filter((i) => i.bucket === b).length,
          }])),
          not_yet_due: money(aged.not_yet_due_minor, cur), not_yet_due_minor: aged.not_yet_due_minor,
          overdue: money(aged.overdue_minor, cur), overdue_minor: aged.overdue_minor,
          outstanding: money(aged.outstanding_minor, cur), outstanding_minor: aged.outstanding_minor,
          unapplied_credit: money(aged.unapplied_credit_minor, cur), unapplied_credit_minor: aged.unapplied_credit_minor,
          oldest_overdue: oldestOverdue(aged.invoices)?.number,
        });
      }
    }
    rows.sort((x, y) => String(x.client).localeCompare(String(y.client)) || String(x.currency).localeCompare(String(y.currency)));
    invoices.sort((x, y) => y.days_overdue - x.days_overdue || x.number.localeCompare(y.number));
    return json({
      as_of: asOf,
      clients: rows.length,
      aging: rows,
      invoices: invoices.slice(0, a.limit ?? MAX_ROWS).map((i) => ({
        ...i,
        total: money(i.total_minor, i.currency), paid: money(i.paid_minor, i.currency),
        credited: money(i.credited_minor, i.currency), open: money(i.open_minor, i.currency),
      })),
      basis:
        "Every figure is as at as_of: an invoice issued after that date is not on the books, a payment made after it has not happened, and a credit " +
        "note issued after it has not been given. An invoice is overdue only once as_of is PAST its due date, so due today sits in not_yet_due and the " +
        "0-30 bucket holds days one to thirty. A credit note reduces the invoice it names and no other, so an open balance floors at zero and any excess " +
        "credit is reported as unapplied_credit rather than cancelling an invoice the client never agreed it against. Currencies are aged separately.",
      sources: sourceReport(s),
      notes: degradedNotes(s),
    });
  } catch (e) { return fail((e as Error).message); }
});

/** Every distinct client name that appears on any document, for the all-clients tools. */
function clientNames(s: SourceSet): string[] {
  const names = new Set<string>();
  for (const i of s.invoices.rows) names.add(i.client.name);
  for (const c of s.credit_notes.rows) names.add(c.client.name);
  for (const d of s.deposits.rows) names.add(d.client.name);
  return [...names].sort();
}

/* -------------------------------------------------------------------- text */

const pad = (t: string, n: number) => (t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length));
const padL = (t: string, n: number) => (t.length >= n ? t : " ".repeat(n - t.length) + t);

function statementLines(st: Statement, day: string, greeting?: string, signOff?: string): string[] {
  const biz = issuer();
  const descW = Math.min(58, Math.max(24, ...st.rows.map((m) => m.description.length), 24));
  const out: string[] = [];
  out.push(greeting ?? `Hello ${st.client.name},`);
  out.push("");
  out.push(`Statement of account ${st.from} to ${st.to}, in ${st.currency}, as at ${day}.`);
  out.push("");
  out.push(`  ${pad("", 10)}  ${pad("Opening balance", descW)}  ${padL(money(st.opening_minor, st.currency), 16)}`);
  for (const m of st.rows) {
    out.push(`  ${pad(m.date, 10)}  ${pad(m.description, descW)}  ${padL(money(m.amount_minor, st.currency), 16)}`);
  }
  out.push("");
  const labelW = descW + 12;
  out.push(`  ${padL("Opening balance", labelW)}  ${padL(money(st.opening_minor, st.currency), 16)}`);
  out.push(`  ${padL("Invoices issued", labelW)}  ${padL(money(st.invoiced_minor, st.currency), 16)}`);
  out.push(`  ${padL("Payments received", labelW)}  ${padL(money(-st.paid_minor, st.currency), 16)}`);
  if (st.deposits_applied_minor > 0) {
    out.push(`  ${padL("of which deposits applied", labelW)}  ${padL(money(-st.deposits_applied_minor, st.currency), 16)}`);
  }
  out.push(`  ${padL("Credit notes", labelW)}  ${padL(money(-st.credited_minor, st.currency), 16)}`);
  out.push(`  ${padL("CLOSING BALANCE", labelW)}  ${padL(money(st.closing_minor, st.currency), 16)}`);
  out.push("");
  out.push(
    st.closing_minor > 0 ? `${money(st.closing_minor, st.currency)} is outstanding on this account.`
      : st.closing_minor < 0 ? `${money(-st.closing_minor, st.currency)} is in your favour on this account.`
        : "Nothing is outstanding on this account.",
  );
  if (st.held_deposit_minor > 0) {
    out.push(`${money(st.held_deposit_minor, st.currency)} of your deposit is still held and is not part of the balance above.`);
  }
  out.push("");
  out.push(signOff ?? (businessMissing() ? "Best regards," : `Best regards,\n${biz.name}`));
  return out;
}

server.registerTool("statement_text", {
  title: "Plain-text statement of account",
  description: "Turn one client's statement into a plain-text ledger with every movement in date order, the opening and closing balances and a sign-off, ready to paste into an email.",
  inputSchema: {
    client: clientArg,
    from: str("from", 10).describe("First day of the period, YYYY-MM-DD"),
    to: str("to", 10).describe("Last day of the period, YYYY-MM-DD, inclusive"),
    currency: currencyArg,
    as_of: str("as_of", 10).optional().describe("Date printed on the statement, YYYY-MM-DD. Defaults to today"),
    greeting: str("greeting", MAX_TEXT).optional().describe('Opening line, default "Hello" and the client name'),
    sign_off: str("sign_off", MAX_TEXT).optional().describe("Closing line, default your business name from the shared profile"),
  },
}, async (a) => {
  try {
    const s = sources("statement_text");
    const from = checkDate(a.from, "", "from");
    const to = checkDate(a.to, "", "to");
    const day = checkDate(a.as_of, today(), "as_of");
    const { scope, currency } = scopeFor(s, a.client, a.currency);
    const st = buildStatement(scope, currency, from, to);
    await register(st, "statement_text");
    const extra = [...degradedNotes(s), ...st.warnings];
    if (businessMissing()) extra.push(NO_BUSINESS_NOTE);
    const text = statementLines(st, day, a.greeting, a.sign_off).join("\n");
    return ok(extra.length ? `${text}\n\n---\n${extra.join("\n")}` : text);
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("statement_pdf", {
  title: "Render the statement of account as a PDF",
  description: "Call this tool to write one client's A4 statement of account and return the file path. Titled STATEMENT OF ACCOUNT, every movement in date order, closing with the balance outstanding. Pro.",
  inputSchema: {
    client: clientArg,
    from: str("from", 10).describe("First day of the period, YYYY-MM-DD"),
    to: str("to", 10).describe("Last day of the period, YYYY-MM-DD, inclusive"),
    currency: currencyArg,
    as_of: str("as_of", 10).optional().describe("Date printed on the statement, YYYY-MM-DD. Defaults to today"),
    out_path: z.string().optional().describe("Where to write the PDF; defaults to this server's data directory under pdf/. Use a .pdf path: the bytes written are always PDF"),
  },
}, async (a) => {
  try {
    if (!gate.isPro()) return fail(gate.upgradeText("the statement of account PDF", "statement_pdf"));
    const s = sources("statement_pdf");
    const from = checkDate(a.from, "", "from");
    const to = checkDate(a.to, "", "to");
    const day = checkDate(a.as_of, today(), "as_of");
    const { scope, currency } = scopeFor(s, a.client, a.currency);
    const st = buildStatement(scope, currency, from, to);
    const rec = await register(st, "statement_pdf");
    const slug = st.client.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `statement-${slug}-${st.currency}-${st.from}-${st.to}.pdf`);
    // The same A4 renderer the invoice, the credit note and the deposit statement use
    // (@theluckystrike/mcp-billing-docs), so a statement looks like the documents it
    // reports on. A movement is a one-off row: quantity 1, its own signed amount, no VAT.
    // The VAT was charged on the invoice; charging it again on the statement of that
    // invoice would double it.
    const lines: ComputedLine[] = [
      {
        description: `${pad("", 12)}Opening balance at ${st.from}`,
        quantity: 1, unit_price_minor: st.opening_minor, tax_rate: 0,
        gross_minor: st.opening_minor, discount_minor: 0, net_minor: st.opening_minor,
        tax_minor: 0, exact_gross_minor: st.opening_minor, round_total: false,
      },
      ...st.rows.map((m) => ({
        description: `${m.date}  ${m.description}`,
        quantity: 1, unit_price_minor: m.amount_minor, tax_rate: 0,
        gross_minor: m.amount_minor, discount_minor: 0, net_minor: m.amount_minor,
        tax_minor: 0, exact_gross_minor: m.amount_minor, round_total: false,
      })),
    ];
    const footer: string[] = [
      `Opening ${money(st.opening_minor, st.currency)}, invoiced ${money(st.invoiced_minor, st.currency)}, ` +
      `received ${money(st.paid_minor, st.currency)}, credited ${money(st.credited_minor, st.currency)}.`,
      `${money(st.closing_minor, st.currency)} outstanding as at ${day}.`,
    ];
    if (st.deposits_applied_minor > 0) {
      footer.push(`${money(st.deposits_applied_minor, st.currency)} of the payments received came from a deposit already held.`);
    }
    if (st.held_deposit_minor > 0) {
      footer.push(`${money(st.held_deposit_minor, st.currency)} of deposit is still held and is not part of the balance.`);
    }
    await renderDocPdf({
      title: "STATEMENT OF ACCOUNT",
      number: rec.id,
      reference: `${st.client.name} (${st.currency}), ${st.from} to ${st.to}`,
      party_label: "CLIENT",
      party: st.client,
      meta: [["Statement date", day], ["Period", `${st.from} to ${st.to}`], ["Currency", st.currency], ["Movements", String(st.rows.length)]],
      currency: st.currency,
      lines,
      subtotal_minor: st.opening_minor + st.rows.reduce((x, m) => x + m.amount_minor, 0),
      discount_percent: 0,
      discount_minor: 0,
      net_minor: st.closing_minor,
      tax_lines: [],
      total_minor: st.closing_minor,
      footer_label: "BALANCE OUTSTANDING",
      footer_lines: footer,
      product: "mcp-statement-of-account",
    }, issuer(), out, { branded: !gate.isPro(), logo: gate.isPro() });
    return json({
      statement_id: rec.id, client: st.client.name, currency: st.currency,
      period: { from: st.from, to: st.to }, path: out,
      document: /\.html?$/i.test(out) ? "HTML statement of account (print to PDF)" : "PDF statement of account",
      closing_balance: money(st.closing_minor, st.currency),
      closing_balance_minor: st.closing_minor,
      sources: sourceReport(s),
      notes: [...degradedNotes(s), ...st.warnings, ...(businessMissing() ? [NO_BUSINESS_NOTE] : [])],
    });
  } catch (e) { return fail((e as Error).message); }
});

/* ----------------------------------------------------------------- dunning */

/**
 * The three levels, as text. What changes between them is the tone and the deadline, and
 * nothing else: the amounts, the invoice list and the bank details are identical at every
 * level, because a chase whose FIGURES escalate is a chase that was wrong at level one.
 *
 * No level invents a late fee, an interest charge or a legal cost. This server holds no
 * contract, no statutory interest rate and no jurisdiction, so any number it added there
 * would be one it made up, and it would be added to a demand for money.
 */
const LEVELS: Record<1 | 2 | 3, { label: string; opening: (n: string) => string; close: string }> = {
  1: {
    label: "reminder",
    opening: (n) => `This is a friendly reminder that the invoices below are past their due date. If payment is already on its way, please ignore this note.`,
    close: "Could you let me know when I can expect payment, or tell me if something is holding it up.",
  },
  2: {
    label: "firm reminder",
    opening: () => `The invoices below are still unpaid and are now well past their due date. This is the second reminder.`,
    close: "Please arrange payment within seven days, or reply with a date you can commit to.",
  },
  3: {
    label: "final demand",
    opening: () => `This is a final demand for the invoices below, which remain unpaid despite earlier reminders.`,
    close: "Please pay in full within seven days. If payment is not received by then I will have to consider the options open to me for recovering it.",
  },
};

/** Bank details from the shared business profile, printed only when they are actually there. */
function bankLines(): string[] {
  const p = readSharedProfile();
  const out: string[] = [];
  if (p.bank?.trim()) out.push(`Bank:  ${p.bank.trim()}`);
  if (p.iban?.trim()) out.push(`IBAN:  ${p.iban.trim()}`);
  if (p.vat_id?.trim()) out.push(`VAT:   ${p.vat_id.trim()}`);
  return out;
}

server.registerTool("dunning_text", {
  title: "Write a dunning letter",
  description: "Write a payment chaser for one client at level 1 friendly, 2 firm or 3 final demand, listing every overdue invoice with its age and total, plus your bank details when the profile has them. Level 3 is Pro.",
  inputSchema: {
    client: clientArg,
    level: z.number().int().min(1, "level is 1, 2 or 3").max(3, "level is 1, 2 or 3")
      .describe("1 friendly reminder, 2 firm reminder, 3 final demand. Level 3 is Pro"),
    currency: currencyArg,
    as_of: str("as_of", 10).optional().describe("Age the invoices as at this date, YYYY-MM-DD. Defaults to today"),
    greeting: str("greeting", MAX_TEXT).optional().describe('Opening line, default "Hello" and the client name'),
    sign_off: str("sign_off", MAX_TEXT).optional().describe("Closing line, default your business name from the shared profile"),
  },
}, async (a) => {
  try {
    const level = a.level as 1 | 2 | 3;
    if (level === 3 && !gate.isPro()) return fail(gate.upgradeText("the level 3 final demand", "dunning_text"));
    const s = sources("dunning_text");
    const day = checkDate(a.as_of, today(), "as_of");
    const { scope, currency } = scopeFor(s, a.client, a.currency);
    const aged = ageClient(scope, currency, day);
    const overdue = aged.invoices.filter((i) => i.bucket !== "not yet due");
    if (!overdue.length) {
      return fail(
        `nothing to chase: ${scope.name} has nothing overdue in ${currency} as at ${day}` +
        (aged.not_yet_due_minor > 0
          ? `: ${money(aged.not_yet_due_minor, currency)} is outstanding but not yet due. A chaser for an invoice that is not late yet is the fastest way to lose a client.`
          : `, and nothing outstanding either. Nothing was written.`),
      );
    }
    const L = LEVELS[level];
    const total = overdue.reduce((x, i) => x + i.open_minor, 0);
    const biz = issuer();
    const numW = Math.max(12, ...overdue.map((i) => i.number.length));
    const out: string[] = [];
    out.push(a.greeting ?? `Hello ${scope.name},`);
    out.push("");
    out.push(L.opening(scope.name));
    out.push("");
    for (const i of overdue) {
      out.push(`  ${pad(i.number, numW)}  issued ${i.issue_date}  due ${i.due_date}  ${padL(`${i.days_overdue} days late`, 16)}  ${padL(money(i.open_minor, currency), 16)}`);
    }
    out.push("");
    out.push(`  ${padL("TOTAL OVERDUE", numW + 54)}  ${padL(money(total, currency), 16)}`);
    out.push("");
    if (aged.not_yet_due_minor > 0) {
      out.push(`A further ${money(aged.not_yet_due_minor, currency)} is on the account but is not yet due, and is not included above.`);
      out.push("");
    }
    const bank = bankLines();
    if (bank.length) {
      out.push("Payment details:");
      for (const b of bank) out.push(`  ${b}`);
      out.push("");
    }
    out.push(L.close);
    out.push("");
    out.push(a.sign_off ?? (businessMissing() ? "Best regards," : `Best regards,\n${biz.name}`));
    const extra = [...degradedNotes(s)];
    if (!bank.length) {
      extra.push(
        "No bank or IBAN is in the shared business profile, so the letter asks for payment without saying where to send it. " +
        "Run business_set {iban, bank} in the invoice server (mcp-invoice) and write it again.",
      );
    }
    extra.push(
      `Level ${level} (${L.label}). No late fee, interest or cost is stated: this server holds no contract terms, no statutory ` +
      `interest rate and no jurisdiction, so any such figure would be invented. Add one yourself if your terms provide for it.`,
    );
    const text = out.join("\n");
    return ok(`${text}\n\n---\n${extra.join("\n")}`);
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("statements_report", {
  title: "What every client owes",
  description: "Show what is outstanding across every client, totalled per currency and aged, with the oldest overdue invoice and the clients carrying it. Pro.",
  inputSchema: {
    as_of: str("as_of", 10).optional().describe("Age the invoices as at this date, YYYY-MM-DD. Defaults to today"),
    limit: z.number().int().min(1).max(200).optional().describe("How many clients to list, worst first. Default 20"),
  },
}, async (a) => {
  try {
    if (!gate.isPro()) return fail(gate.upgradeText("the receivables report", "statements_report"));
    const s = sources("statements_report");
    const day = checkDate(a.as_of, today(), "as_of");
    const limit = a.limit ?? 20;
    const perCurrency = new Map<string, { outstanding: number; overdue: number; buckets: Record<Bucket, number>; clients: Set<string> }>();
    const clients: Array<Record<string, unknown>> = [];
    const everyInvoice: AgedInvoice[] = [];
    for (const name of clientNames(s)) {
      const scope = resolveClient(s, name);
      for (const cur of scope.currencies) {
        const aged = ageClient(scope, cur, day);
        if (!aged.outstanding_minor) continue;
        everyInvoice.push(...aged.invoices);
        const b = perCurrency.get(cur) ?? { outstanding: 0, overdue: 0, buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "over 90": 0 }, clients: new Set<string>() };
        b.outstanding += aged.outstanding_minor;
        b.overdue += aged.overdue_minor;
        for (const k of BUCKETS) b.buckets[k] += aged.buckets[k];
        b.clients.add(scope.name);
        perCurrency.set(cur, b);
        const worst = oldestOverdue(aged.invoices);
        clients.push({
          client: scope.name, currency: cur,
          outstanding: money(aged.outstanding_minor, cur), outstanding_minor: aged.outstanding_minor,
          overdue: money(aged.overdue_minor, cur), overdue_minor: aged.overdue_minor,
          oldest_overdue: worst ? { number: worst.number, due_date: worst.due_date, days_overdue: worst.days_overdue, open: money(worst.open_minor, cur) } : undefined,
        });
      }
    }
    clients.sort((x, y) => Number(y.overdue_minor) - Number(x.overdue_minor) || Number(y.outstanding_minor) - Number(x.outstanding_minor));
    const oldest = oldestOverdue(everyInvoice);
    return json({
      as_of: day,
      clients_with_a_balance: clients.length,
      by_currency: [...perCurrency.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([cur, b]) => ({
        currency: cur, clients: b.clients.size,
        outstanding: money(b.outstanding, cur), outstanding_minor: b.outstanding,
        overdue: money(b.overdue, cur), overdue_minor: b.overdue,
        buckets: Object.fromEntries(BUCKETS.map((k) => [k, { amount: money(b.buckets[k], cur), amount_minor: b.buckets[k] }])),
      })),
      oldest_overdue: oldest
        ? { client: oldest.client, number: oldest.number, currency: oldest.currency, due_date: oldest.due_date, days_overdue: oldest.days_overdue, open: money(oldest.open_minor, oldest.currency) }
        : undefined,
      clients: clients.slice(0, limit),
      statements_built: getStatements().length,
      basis:
        "One total per currency and never one across them: this server holds no exchange rate, so a single number over a EUR ledger and a USD one " +
        "would be invented. Clients are ordered by how much of their balance is overdue, not by how much they owe: a large balance that is not yet due " +
        "is not a collection problem.",
      sources: sourceReport(s),
      notes: degradedNotes(s),
    });
  } catch (e) { return fail((e as Error).message); }
});

gate.registerTools(server as unknown as { registerTool: Function });

/* ------------------------------------------------------ resource and prompt */

server.registerResource("sources", "statement://sources", {
  title: "Where the statement figures come from",
  description: "The three sibling stores this server reads, whether each could be read, and how many rows each holds.",
  mimeType: "application/json",
}, async () => {
  const s = readSources();
  const body = {
    reads: sourceReport(s),
    writes: [{ store: "statement-of-account", file: "statements.json", what: "the register of statements that were built. No figure is ever read back from it." }],
    clients: clientNames(s),
    notes: degradedNotes(s),
  };
  return { contents: [{ uri: "statement://sources", mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
});

server.registerPrompt("chase_overdue", {
  title: "Chase what is overdue",
  description: "Age the receivables, decide who to chase and at what level, then write the letters.",
  argsSchema: {},
}, () => ({
  messages: [{
    role: "user" as const,
    content: {
      type: "text" as const,
      text: [
        "1. Call statement_aging with no client and list what is overdue, per client and per currency.",
        "2. For each client with something in 61-90 or over 90, say how old the oldest invoice is and how much of the balance it is.",
        "3. Pick a dunning level for each: 1 for a first miss, 2 for a client already reminded once, 3 only where earlier reminders were ignored.",
        "4. Call dunning_text for each and give me the letters, and say which clients you decided not to chase and why.",
      ].join("\n"),
    },
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-statement-of-account ready\n");
