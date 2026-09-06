// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Shared stdio JSON-RPC client and store seeders for the mcp-statement-of-account suites.
// One sandboxed data dir per client, so no test can see another's books.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..");

export function proKey(product = "statement-of-account") {
  return "";
}

export function sandbox(prefix = "mcp-statement-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-statement-")), "data");
  const env = { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "..", "config") };
  if (key) env.MCP_LICENSE_KEY = key; else delete env.MCP_LICENSE_KEY;
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  const stdoutLines = [];
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      stdoutLines.push(line);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    home, send, stdoutLines,
    get tail() { return buf; },
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    async tools() { return (await send("tools/list", {})).result.tools; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
    },
    async json(name, args) { const r = await this.call(name, args); return r.isError ? r : JSON.parse(r.text); },
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

export function storeDir(dataHome, name) { return join(dataHome, "mcp-servers", name); }

function put(dataHome, server, file, value) {
  const dir = storeDir(dataHome, server);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

/**
 * The three sibling stores are seeded on disk directly rather than through their own
 * servers. Spawning mcp-invoice to create an invoice would test mcp-invoice; what this
 * suite has to pin down is what THIS server computes from a given set of rows, so the
 * rows are written in the exact shape servers/invoice/src/store.ts, servers/billing-docs
 * and servers/deposits define, and a contract test asserts those shapes still match.
 */
export const seed = {
  invoices: (dataHome, rows) => put(dataHome, "invoice", "invoices.json", rows),
  clients: (dataHome, rows) => put(dataHome, "invoice", "clients.json", rows),
  business: (dataHome, biz) => put(dataHome, "invoice", "business.json", biz),
  creditNotes: (dataHome, rows) => put(dataHome, "billing-docs", "credit-notes.json", rows),
  deposits: (dataHome, rows) => put(dataHome, "deposits", "deposits.json", rows),
  profile: (dataHome, p) => put(dataHome, "profile", "business.json", { ...p, updated: new Date().toISOString() }),
  raw: put,
};

let lineSeq = 0;

/** One computed invoice line in the shape servers/invoice writes, VAT included. */
export function line(description, netMinor, taxRate = 0) {
  const tax = Math.round(netMinor * taxRate / 100);
  lineSeq += 1;
  return {
    description, quantity: 1, unit_price_minor: netMinor, tax_rate: taxRate,
    gross_minor: netMinor, discount_minor: 0, net_minor: netMinor,
    tax_minor: tax, exact_gross_minor: netMinor, round_total: false,
  };
}

/** An invoice in the shape servers/invoice/src/store.ts stores one. */
export function invoice(o) {
  const netMinor = o.net_minor ?? 100000;
  const taxRate = o.tax_rate ?? 0;
  const tax = Math.round(netMinor * taxRate / 100);
  const paid = o.paid_minor ?? 0;
  return {
    number: o.number,
    client_id: o.client_id,
    client: o.client ?? { name: o.client_name ?? "Acme Ltd" },
    issue_date: o.issue_date,
    due_date: o.due_date ?? o.issue_date,
    currency: o.currency ?? "EUR",
    decimals: 2,
    lines: [line(o.description ?? "Consulting", netMinor, taxRate)],
    subtotal_minor: netMinor,
    discount_percent: 0,
    discount_minor: 0,
    net_minor: netMinor,
    tax_lines: taxRate ? [{ rate: taxRate, base_minor: netMinor, tax_minor: tax }] : [],
    tax_minor: tax,
    total_minor: netMinor + tax,
    status: paid <= 0 ? "unpaid" : paid >= netMinor + tax ? "paid" : "partial",
    paid_date: o.paid_date,
    paid_minor: paid,
    payments: o.payments,
    created: `${o.issue_date}T09:00:00.000Z`,
    branded: true,
  };
}

/** A credit note in the shape servers/billing-docs stores one: every money field NEGATIVE. */
export function creditNote(o) {
  const amount = o.amount_minor;
  return {
    id: o.id,
    invoice_number: o.invoice_number,
    invoice_total_minor: o.invoice_total_minor ?? amount,
    invoice_issue_date: o.invoice_issue_date ?? o.issue_date,
    basis: "amount",
    client_id: o.client_id,
    client: o.client ?? { name: o.client_name ?? "Acme Ltd" },
    issue_date: o.issue_date,
    currency: o.currency ?? "EUR",
    decimals: 2,
    lines: [line(o.reason ?? "Credit", -amount, 0)],
    subtotal_minor: -amount,
    discount_percent: 0,
    discount_minor: 0,
    net_minor: -amount,
    tax_lines: [],
    tax_minor: 0,
    total_minor: -amount,
    reason: o.reason ?? "Goodwill",
    created: `${o.issue_date}T09:00:00.000Z`,
    branded: true,
  };
}

/** A deposit in the shape servers/deposits stores one. */
export function deposit(o) {
  const applications = o.applications ?? [];
  const refunds = o.refunds ?? [];
  const applied = applications.reduce((a, x) => a + x.amount_minor, 0);
  const refunded = refunds.reduce((a, x) => a + x.amount_minor, 0);
  const held = o.amount_minor - applied - refunded;
  return {
    id: o.id,
    client_id: o.client_id,
    client: o.client ?? { name: o.client_name ?? "Acme Ltd" },
    amount_minor: o.amount_minor,
    currency: o.currency ?? "EUR",
    decimals: 2,
    kind: o.kind ?? "retainer",
    received_date: o.received_date,
    reference: o.reference,
    applications, refunds,
    status: held > 0 ? "held" : applied > 0 ? "applied" : "refunded",
    created: `${o.received_date}T09:00:00.000Z`,
    updated: `${o.received_date}T09:00:00.000Z`,
    branded: true,
  };
}

/**
 * The worked month the unit suite asserts against, in one place so the expected closing
 * balance can be recomputed by hand from these rows.
 *
 * Acme Ltd, EUR, statement period 2026-06-01 to 2026-06-30.
 *
 *   before the period
 *     INV-2026-0001  issued 2026-04-10, due 2026-05-10, 1,000.00, paid 400.00 on 2026-05-02
 *     CN-2026-0001   issued 2026-05-20 against INV-2026-0001, 100.00
 *     opening balance = 1000.00 - 400.00 - 100.00 = 500.00
 *   in the period
 *     INV-2026-0002  issued 2026-06-05, due 2026-07-05, 2,000.00
 *     INV-2026-0003  issued 2026-06-20, due 2026-06-25,   750.00
 *     payment 600.00 on 2026-06-12 against INV-2026-0001 (a payments[] row)
 *     DEP-2026-0001  500.00 received 2026-03-01, 300.00 applied to INV-2026-0002 on 2026-06-18
 *     CN-2026-0002   issued 2026-06-28 against INV-2026-0003, 50.00
 *     closing = 500.00 + 2750.00 - 900.00 - 50.00 = 2,300.00
 */
export function workedMonth(dataHome) {
  seed.clients(dataHome, [
    { id: "CL-1", name: "Acme Ltd", address: "1 Road, Warsaw", email: "ap@acme.example", created: "2026-01-01T00:00:00.000Z" },
    { id: "CL-2", name: "Beta GmbH", created: "2026-01-01T00:00:00.000Z" },
  ]);
  seed.invoices(dataHome, [
    invoice({
      number: "INV-2026-0001", client_id: "CL-1", client: { name: "Acme Ltd", address: "1 Road, Warsaw", email: "ap@acme.example" },
      issue_date: "2026-04-10", due_date: "2026-05-10", net_minor: 100000,
      paid_minor: 100000, paid_date: "2026-06-12",
      payments: [
        { date: "2026-05-02", amount_minor: 40000, method: "transfer" },
        { date: "2026-06-12", amount_minor: 60000, method: "transfer" },
      ],
    }),
    invoice({
      number: "INV-2026-0002", client_id: "CL-1", client: { name: "Acme Ltd" },
      issue_date: "2026-06-05", due_date: "2026-07-05", net_minor: 200000,
      paid_minor: 30000, paid_date: "2026-06-18",
    }),
    invoice({
      number: "INV-2026-0003", client_id: "CL-1", client: { name: "Acme Ltd" },
      issue_date: "2026-06-20", due_date: "2026-06-25", net_minor: 75000,
    }),
    invoice({
      number: "INV-2026-0004", client_id: "CL-2", client: { name: "Beta GmbH" },
      issue_date: "2026-06-01", due_date: "2026-06-15", net_minor: 50000,
    }),
  ]);
  seed.creditNotes(dataHome, [
    creditNote({ id: "CN-2026-0001", invoice_number: "INV-2026-0001", client_id: "CL-1", client_name: "Acme Ltd", issue_date: "2026-05-20", amount_minor: 10000, invoice_total_minor: 100000 }),
    creditNote({ id: "CN-2026-0002", invoice_number: "INV-2026-0003", client_id: "CL-1", client_name: "Acme Ltd", issue_date: "2026-06-28", amount_minor: 5000, invoice_total_minor: 75000 }),
  ]);
  seed.deposits(dataHome, [
    deposit({
      id: "DEP-2026-0001", client_id: "CL-1", client_name: "Acme Ltd", amount_minor: 50000,
      received_date: "2026-03-01",
      applications: [{ date: "2026-06-18", invoice_number: "INV-2026-0002", amount_minor: 30000 }],
    }),
  ]);
  seed.profile(dataHome, {
    name: "Studio One", address: "5 Street, Warsaw", email: "me@studio.example",
    vat_id: "PL1234567890", iban: "PL61109010140000071219812874", bank: "Bank Polski",
    default_currency: "EUR", timezone: "Europe/Warsaw",
  });
  return {
    opening_minor: 50000,
    invoiced_minor: 275000,
    paid_minor: 90000,
    deposits_applied_minor: 30000,
    credited_minor: 5000,
    closing_minor: 230000,
  };
}

export const PERIOD = { from: "2026-06-01", to: "2026-06-30" };
