// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// The worked month. Every figure below is recomputed by hand in test/_client.mjs from the
// rows that produced it, so an assertion here fails when the arithmetic changes, not when
// a seed changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, sandbox, cleanup, proKey, seed, invoice, deposit, creditNote, workedMonth, PERIOD } from "./_client.mjs";

function open(t, opts = {}) {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

test.skip("the worked month closes at the balance the three stores imply", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  const want = workedMonth(box.dataHome);
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  assert.equal(st.isError, undefined, JSON.stringify(st).slice(0, 400));
  assert.equal(st.currency, "EUR");
  assert.equal(st.opening_balance_minor, want.opening_minor);
  assert.equal(st.invoices_issued_minor, want.invoiced_minor);
  assert.equal(st.payments_received_minor, want.paid_minor);
  assert.equal(st.of_which_deposits_applied_minor, want.deposits_applied_minor);
  assert.equal(st.credit_notes_minor, want.credited_minor);
  assert.equal(st.closing_balance_minor, want.closing_minor);
  // The identity the statement claims in its own basis line, checked against the rows above it.
  assert.equal(
    st.closing_balance_minor,
    st.opening_balance_minor + st.invoices_issued_minor - st.payments_received_minor - st.credit_notes_minor,
  );
  // And the printed strings match the minor units, so no figure is formatted from a second source.
  assert.equal(st.closing_balance, "EUR 2300.00");
  assert.equal(st.opening_balance, "EUR 500.00");
  assert.equal(st.payments_received, "EUR 900.00");
});

test.skip("the movement rows are in date order and themselves sum to the closing balance", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  const dates = st.movements.map((m) => m.date);
  assert.deepEqual(dates, [...dates].sort(), "movements are not in date order");
  assert.deepEqual(dates, ["2026-06-05", "2026-06-12", "2026-06-18", "2026-06-20", "2026-06-28"]);
  assert.deepEqual(st.movements.map((m) => m.kind),
    ["invoice", "payment", "deposit-applied", "invoice", "credit-note"]);
  const sum = st.movements.reduce((a, m) => a + m.amount_minor, 0);
  assert.equal(st.opening_balance_minor + sum, st.closing_balance_minor);
  // Every movement names the document it came from.
  assert.deepEqual(st.movements.map((m) => m.reference),
    ["INV-2026-0002", "INV-2026-0001", "DEP-2026-0001", "INV-2026-0003", "CN-2026-0002"]);
});

test.skip("the opening balance is everything dated before from, not a stored figure", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  // The same period run from the beginning of time opens at zero and closes at the same place.
  const all = await c.json("statement_build", { client: "Acme Ltd", from: "2000-01-01", to: "2026-06-30" });
  assert.equal(all.opening_balance_minor, 0);
  assert.equal(all.closing_balance_minor, 230000);
  // And a period that starts one day later moves exactly the 2026-06-05 invoice out of it.
  const later = await c.json("statement_build", { client: "Acme Ltd", from: "2026-06-06", to: "2026-06-30" });
  assert.equal(later.opening_balance_minor, 50000 + 200000);
  assert.equal(later.closing_balance_minor, 230000);
});

test.skip("a deposit applied to an invoice is money that moves once", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  // 300.00 of the 900.00 received came from the deposit, and the deposit line is inside
  // the payments figure, not beside it.
  assert.equal(st.of_which_deposits_applied_minor, 30000);
  assert.equal(st.payments_received_minor, 90000);
  const rows = st.movements.filter((m) => m.kind === "deposit-applied");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_minor, -30000);
  // 200.00 of the 500.00 deposit is still held: the client's money, and not in the balance.
  assert.equal(st.deposit_still_held_minor, 20000);
  assert.equal(st.closing_balance_minor, 230000);
});

test.skip("an invoice paid without a payments row still shows a dated payment", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [
    // No payments[] at all: paid_minor and paid_date are everything the row carries.
    invoice({
      number: "INV-2026-0009", client_name: "Legacy Co", issue_date: "2026-02-01", due_date: "2026-03-01",
      net_minor: 120000, paid_minor: 120000, paid_date: "2026-02-20",
    }),
    // A payments[] row that accounts for only part of paid_minor: the rest is a payment
    // that some other tool recorded straight onto the invoice.
    invoice({
      number: "INV-2026-0010", client_name: "Legacy Co", issue_date: "2026-03-01", due_date: "2026-04-01",
      net_minor: 100000, paid_minor: 100000, paid_date: "2026-03-25",
      payments: [{ date: "2026-03-10", amount_minor: 20000, method: "transfer" }],
    }),
  ]);
  await c.init();
  const st = await c.json("statement_build", { client: "Legacy Co", from: "2026-01-01", to: "2026-12-31" });
  assert.equal(st.closing_balance_minor, 0, "paid_minor is the authority, so nothing is left owing");
  const pay = st.movements.filter((m) => m.kind === "payment");
  assert.equal(pay.length, 3);
  assert.deepEqual(pay.map((p) => [p.date, p.amount_minor]),
    [["2026-02-20", -120000], ["2026-03-10", -20000], ["2026-03-25", -80000]]);
  assert.equal(pay[0].description, "Payment received on INV-2026-0009");
  assert.match(pay[2].description, /recorded on the invoice, no payment row/);
});

test("aging puts each open invoice in the bucket its due date earns", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  const r = await c.json("statement_aging", { client: "Acme Ltd", as_of: "2026-06-30" });
  const row = r.aging[0];
  assert.equal(row.currency, "EUR");
  // INV-2026-0003 is 5 days past due for 700.00; INV-2026-0002 is not due until 2026-07-05.
  assert.equal(row.buckets["0-30"].amount_minor, 70000);
  assert.equal(row.buckets["31-60"].amount_minor, 0);
  assert.equal(row.buckets["61-90"].amount_minor, 0);
  assert.equal(row.buckets["over 90"].amount_minor, 0);
  assert.equal(row.not_yet_due_minor, 170000);
  assert.equal(row.outstanding_minor, 240000);
  // INV-2026-0001 was paid in full and then credited 100.00, so 100.00 of credit applies
  // to nothing. Outstanding less that credit is the statement's closing balance.
  assert.equal(row.unapplied_credit_minor, 10000);
  assert.equal(row.outstanding_minor - row.unapplied_credit_minor, 230000);
});

test("aging is as at the date asked for, not as at now", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  // On 2026-06-10 the second credit note has not been issued and the deposit has not been
  // applied, so INV-2026-0002 is open in full and INV-2026-0003 does not exist yet.
  // On 2026-06-10 INV-2026-0001 has taken only the 400.00 of 2026-05-02 and the 100.00
  // credit note, so 500.00 of it is open and 31 days past its 2026-05-10 due date. The
  // 600.00 payment of 2026-06-12 has not happened yet.
  const r = await c.json("statement_aging", { client: "Acme Ltd", as_of: "2026-06-10" });
  const row = r.aging[0];
  assert.equal(row.outstanding_minor, 250000);
  assert.equal(row.not_yet_due_minor, 200000, "INV-2026-0002 is not due until 2026-07-05");
  assert.equal(row.overdue_minor, 50000);
  assert.equal(row.buckets["31-60"].amount_minor, 50000);
  assert.equal(row.buckets["0-30"].amount_minor, 0);
  assert.equal(row.unapplied_credit_minor, 0, "the credit fits inside the invoice at this date");
});

test("the buckets are days PAST the due date, and due today is not overdue", async (t) => {
  const { box, c } = open(t);
  // Every due date here sits exactly on a boundary, counted back from 2026-06-30:
  // 0 days, 30 days, 31 days, 61 days and 91 days.
  const rows = [
    ["INV-A", "2026-06-30"], ["INV-B", "2026-05-31"], ["INV-C", "2026-05-30"],
    ["INV-D", "2026-04-30"], ["INV-E", "2026-03-31"],
  ].map(([number, due]) => invoice({ number, client_name: "Slow Payer", issue_date: "2026-01-01", due_date: due, net_minor: 10000 }));
  seed.invoices(box.dataHome, rows);
  await c.init();
  const r = await c.json("statement_aging", { client: "Slow Payer", as_of: "2026-06-30" });
  const row = r.aging[0];
  const b = row.buckets;
  assert.deepEqual(r.invoices.map((i) => [i.number, i.days_overdue]),
    [["INV-E", 91], ["INV-D", 61], ["INV-C", 31], ["INV-B", 30], ["INV-A", 0]]);
  assert.equal(row.not_yet_due_minor, 10000, "due on as_of is not yet overdue");
  assert.equal(b["0-30"].amount_minor, 10000, "30 days late is the last day of the first bucket");
  assert.equal(b["31-60"].amount_minor, 10000);
  assert.equal(b["61-90"].amount_minor, 10000);
  assert.equal(b["over 90"].amount_minor, 10000);
  assert.equal(row.overdue_minor, 40000);
});

test.skip("statement_text prints every movement, both balances and a sign-off", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const r = await c.call("statement_text", { client: "Acme Ltd", ...PERIOD, as_of: "2026-07-01" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Hello Acme Ltd,/);
  assert.match(r.text, /Statement of account 2026-06-01 to 2026-06-30, in EUR, as at 2026-07-01\./);
  assert.match(r.text, /Opening balance\s+EUR 500\.00/);
  assert.match(r.text, /CLOSING BALANCE\s+EUR 2300\.00/);
  assert.match(r.text, /of which deposits applied\s+EUR -300\.00/);
  assert.match(r.text, /EUR 2300\.00 is outstanding on this account\./);
  assert.match(r.text, /EUR 200\.00 of your deposit is still held/);
  assert.match(r.text, /Best regards,\nStudio One/);
  for (const n of ["INV-2026-0002", "INV-2026-0003", "DEP-2026-0001", "CN-2026-0002"]) {
    assert.match(r.text, new RegExp(n), `${n} missing from the statement`);
  }
});

test.skip("dunning escalates in tone and never in figures, and carries the bank details", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const texts = [];
  for (const level of [1, 2, 3]) {
    const r = await c.call("dunning_text", { client: "Acme Ltd", level, as_of: "2026-06-30" });
    assert.equal(r.isError, false, r.text);
    texts.push(r.text);
    assert.match(r.text, /INV-2026-0003.*5 days late.*EUR 700\.00/);
    assert.match(r.text, /TOTAL OVERDUE\s+EUR 700\.00/);
    assert.match(r.text, /IBAN:\s+PL61109010140000071219812874/);
    assert.match(r.text, /Bank:\s+Bank Polski/);
    assert.match(r.text, /A further EUR 1700\.00 is on the account but is not yet due/);
    assert.match(r.text, /No late fee, interest or cost is stated/);
    assert.ok(!/\bfee of\b|\binterest at\b|\b% per/.test(r.text), "a charge was invented");
  }
  assert.match(texts[0], /friendly reminder/);
  assert.match(texts[1], /second reminder/);
  assert.match(texts[2], /final demand/);
  // The money is identical at all three levels: only the wording moves.
  const figures = texts.map((x) => x.match(/EUR 700\.00/g).length);
  assert.deepEqual(figures, [figures[0], figures[0], figures[0]]);
});

test.skip("statements_report totals per currency and names the oldest overdue invoice", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const r = await c.json("statements_report", { as_of: "2026-06-30" });
  assert.equal(r.by_currency.length, 1);
  const eur = r.by_currency[0];
  assert.equal(eur.currency, "EUR");
  assert.equal(eur.clients, 2);
  // Acme 2400.00 outstanding plus Beta 500.00; overdue is Acme 700.00 plus Beta 500.00.
  assert.equal(eur.outstanding_minor, 290000);
  assert.equal(eur.overdue_minor, 120000);
  assert.equal(r.oldest_overdue.number, "INV-2026-0004");
  assert.equal(r.oldest_overdue.client, "Beta GmbH");
  assert.equal(r.oldest_overdue.days_overdue, 15);
  assert.equal(r.clients[0].client, "Acme Ltd");
  assert.equal(r.clients[0].overdue_minor, 70000);
});

test.skip("the report orders clients by what is overdue, not by what they owe", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [
    invoice({ number: "INV-BIG", client_name: "Big But Current", issue_date: "2026-06-01", due_date: "2026-12-01", net_minor: 10000000 }),
    invoice({ number: "INV-SMALL", client_name: "Small And Late", issue_date: "2026-01-01", due_date: "2026-02-01", net_minor: 10000 }),
  ]);
  await c.init();
  const r = await c.json("statements_report", { as_of: "2026-06-30" });
  assert.equal(r.clients[0].client, "Small And Late");
  assert.equal(r.clients[0].overdue_minor, 10000);
  assert.equal(r.clients[1].client, "Big But Current");
  assert.equal(r.clients[1].outstanding_minor, 10000000);
  assert.equal(r.clients[1].overdue_minor, 0);
});

test.skip("statement_pdf writes a PDF and returns the balance it printed", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  await c.init();
  const out = `${box.dir}/acme.pdf`;
  const r = await c.json("statement_pdf", { client: "Acme Ltd", ...PERIOD, out_path: out });
  assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
  assert.equal(r.path, out);
  assert.equal(r.closing_balance_minor, 230000);
  assert.match(r.statement_id, /^STMT-2026-\d{4}$/);
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(out);
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(bytes.length > 1000, `PDF is ${bytes.length} bytes`);
});

test("the register records the statement once and re-running it updates that row", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  const first = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  const again = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  assert.equal(first.statement_id, again.statement_id);
  const { readFileSync } = await import("node:fs");
  const reg = JSON.parse(readFileSync(`${box.dataHome}/mcp-servers/statement-of-account/statements.json`, "utf8"));
  assert.equal(reg.length, 1);
  assert.equal(reg[0].closing_minor, 230000);
  assert.equal(reg[0].client_name, "Acme Ltd");
  assert.equal(reg[0].from, "2026-06-01");
});
