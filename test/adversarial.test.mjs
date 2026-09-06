// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// What the server does when the question is wrong, the books are inconsistent, or the
// honest answer is a refusal. Every case asserts the refusal TEXT names the problem, not
// just that something failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, sandbox, cleanup, proKey, seed, invoice, creditNote, deposit, workedMonth, PERIOD } from "./_client.mjs";

function open(t, opts = {}) {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

test("an unknown client is refused with the clients that do exist", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  const r = await c.call("statement_build", { client: "Wakanda Holdings", ...PERIOD });
  assert.equal(r.isError, true);
  assert.match(r.text, /no client named "Wakanda Holdings"/);
  assert.match(r.text, /Acme Ltd/);
  assert.match(r.text, /Beta GmbH/);
});

test("with no books at all the refusal says so rather than naming an empty list", async (t) => {
  const { c } = open(t);
  await c.init();
  const r = await c.call("statement_build", { client: "Anyone", ...PERIOD });
  assert.equal(r.isError, true);
  assert.match(r.text, /no invoices, credit notes or deposits on this machine/);
});

test("a client name matching two clients is refused with both, never resolved to the first", async (t) => {
  const { box, c } = open(t);
  seed.invoices(box.dataHome, [
    invoice({ number: "INV-1", client_name: "Acme Ltd", issue_date: "2026-06-01", net_minor: 1000 }),
    invoice({ number: "INV-2", client_name: "Acme Holdings", issue_date: "2026-06-01", net_minor: 2000 }),
  ]);
  await c.init();
  const r = await c.call("statement_build", { client: "acme", ...PERIOD });
  assert.equal(r.isError, true);
  assert.match(r.text, /matches more than one client/);
  assert.match(r.text, /Acme Holdings/);
  assert.match(r.text, /Acme Ltd/);
});

test("an empty period answers with the balance carried, not with an error", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", from: "2026-05-25", to: "2026-05-31" });
  assert.equal(st.isError, undefined, JSON.stringify(st).slice(0, 300));
  assert.deepEqual(st.movements, []);
  assert.equal(st.invoices_issued_minor, 0);
  assert.equal(st.payments_received_minor, 0);
  assert.equal(st.credit_notes_minor, 0);
  // Nothing happened in the week, and 500.00 was still owed at both ends of it.
  assert.equal(st.opening_balance_minor, 50000);
  assert.equal(st.closing_balance_minor, 50000);
});

test.skip("mixed currencies are never summed: the statement asks which one", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [
    invoice({ number: "INV-E", client_name: "Global Co", issue_date: "2026-06-02", due_date: "2026-06-10", net_minor: 100000, currency: "EUR" }),
    invoice({ number: "INV-U", client_name: "Global Co", issue_date: "2026-06-03", due_date: "2026-06-10", net_minor: 200000, currency: "USD" }),
  ]);
  await c.init();
  const r = await c.call("statement_build", { client: "Global Co", ...PERIOD });
  assert.equal(r.isError, true);
  assert.match(r.text, /documents in EUR and USD/);
  assert.match(r.text, /never added up/);

  const eur = await c.json("statement_build", { client: "Global Co", ...PERIOD, currency: "EUR" });
  assert.equal(eur.closing_balance_minor, 100000);
  const usd = await c.json("statement_build", { client: "Global Co", ...PERIOD, currency: "USD" });
  assert.equal(usd.closing_balance_minor, 200000);

  // Aging keeps them apart too, and so does the report: no line anywhere holds 300000.
  const aged = await c.json("statement_aging", { client: "Global Co", as_of: "2026-06-30" });
  assert.deepEqual(aged.aging.map((x) => [x.currency, x.outstanding_minor]).sort(), [["EUR", 100000], ["USD", 200000]]);
  const rep = await c.json("statements_report", { as_of: "2026-06-30" });
  assert.equal(rep.by_currency.length, 2);
  assert.ok(!JSON.stringify(rep).includes("300000"), "a cross-currency total was invented");
  assert.equal(rep.oldest_overdue !== undefined, true);

  // A currency the client has no document in is refused with the ones they do.
  const gbp = await c.call("statement_build", { client: "Global Co", ...PERIOD, currency: "GBP" });
  assert.equal(gbp.isError, true);
  assert.match(gbp.text, /has no GBP invoice, credit note or deposit.*EUR, USD/s);
});

test.skip("a credit note larger than the paid invoice it reverses becomes unapplied credit, never a negative invoice", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [
    invoice({
      number: "INV-2026-0100", client_name: "Over Credited", issue_date: "2026-05-01", due_date: "2026-05-15",
      net_minor: 100000, paid_minor: 100000, paid_date: "2026-05-10",
    }),
    invoice({ number: "INV-2026-0101", client_name: "Over Credited", issue_date: "2026-06-01", due_date: "2026-06-10", net_minor: 40000 }),
  ]);
  seed.creditNotes(box.dataHome, [
    creditNote({ id: "CN-2026-0100", invoice_number: "INV-2026-0100", client_name: "Over Credited", issue_date: "2026-06-05", amount_minor: 150000, invoice_total_minor: 100000 }),
  ]);
  await c.init();
  const aged = await c.json("statement_aging", { client: "Over Credited", as_of: "2026-06-30" });
  const row = aged.aging[0];
  // The paid invoice cannot owe a negative amount, and the 1,500.00 credit does NOT
  // silently cancel the unrelated 400.00 invoice.
  assert.equal(row.unapplied_credit_minor, 150000);
  assert.equal(row.outstanding_minor, 40000);
  assert.equal(row.buckets["0-30"].amount_minor, 40000);
  assert.deepEqual(aged.invoices.map((i) => i.number), ["INV-2026-0101"]);
  // The statement, which is a balance and not an aging, DOES carry the whole credit: the
  // client is owed money and the closing balance says so with a minus sign.
  const st = await c.json("statement_build", { client: "Over Credited", from: "2026-01-01", to: "2026-06-30" });
  assert.equal(st.closing_balance_minor, 40000 - 150000);
  const text = await c.call("statement_text", { client: "Over Credited", from: "2026-01-01", to: "2026-06-30" });
  assert.match(text.text, /EUR 1100\.00 is in your favour on this account\./);
});

test.skip("an invoice and a deposit that disagree about the same money keep paid_minor and say so", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [invoice({
    number: "INV-2026-0200", client_name: "Split Brain", issue_date: "2026-06-01", due_date: "2026-06-10",
    net_minor: 100000, paid_minor: 30000, paid_date: "2026-06-05",
  })]);
  // The deposit book claims 800.00 went to an invoice that records only 300.00 paid.
  seed.deposits(box.dataHome, [deposit({
    id: "DEP-2026-0200", client_name: "Split Brain", amount_minor: 80000, received_date: "2026-05-01",
    applications: [{ date: "2026-06-05", invoice_number: "INV-2026-0200", amount_minor: 80000 }],
  })]);
  await c.init();
  const st = await c.json("statement_build", { client: "Split Brain", from: "2026-01-01", to: "2026-06-30" });
  assert.equal(st.payments_received_minor, 30000, "paid_minor is the authority");
  assert.equal(st.closing_balance_minor, 70000);
  assert.equal(st.movements.filter((m) => m.kind === "deposit-applied").length, 0);
  assert.ok(st.notes.some((n) => /disagree about this invoice/.test(n)), JSON.stringify(st.notes));
  assert.ok(st.notes.some((n) => /INV-2026-0200/.test(n)));
});

test("a period that runs backwards is refused, and so is a date that is not one", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  const back = await c.call("statement_build", { client: "Acme Ltd", from: "2026-06-30", to: "2026-06-01" });
  assert.equal(back.isError, true);
  assert.match(back.text, /the period runs backwards: from 2026-06-30 is after to 2026-06-01/);
  for (const bad of ["2026-02-30", "30-06-2026", "yesterday"]) {
    const r = await c.call("statement_build", { client: "Acme Ltd", from: bad, to: "2026-06-30" });
    assert.equal(r.isError, true, `"${bad}" was accepted`);
    assert.match(r.text, /is not a real date in YYYY-MM-DD form/);
  }
  const asOf = await c.call("statement_aging", { client: "Acme Ltd", as_of: "2026-13-01" });
  assert.equal(asOf.isError, true);
});

test.skip("a chaser is refused when nothing is actually overdue", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [invoice({
    number: "INV-2026-0300", client_name: "Punctual SA", issue_date: "2026-06-01", due_date: "2026-07-31", net_minor: 90000,
  })]);
  await c.init();
  const r = await c.call("dunning_text", { client: "Punctual SA", level: 1, as_of: "2026-06-30" });
  assert.equal(r.isError, true);
  assert.match(r.text, /nothing overdue in EUR as at 2026-06-30/);
  assert.match(r.text, /EUR 900\.00 is outstanding but not yet due/);
  assert.match(r.text, /not late yet/);
});

test.skip("a chaser with no bank details in the profile says the letter has nowhere to pay", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.invoices(box.dataHome, [invoice({
    number: "INV-2026-0400", client_name: "Late Co", issue_date: "2026-01-01", due_date: "2026-02-01", net_minor: 90000,
  })]);
  await c.init();
  const r = await c.call("dunning_text", { client: "Late Co", level: 2, as_of: "2026-06-30" });
  assert.equal(r.isError, false, r.text);
  assert.ok(!/IBAN:/.test(r.text), "an IBAN was printed with no profile to take it from");
  assert.match(r.text, /No bank or IBAN is in the shared business profile/);
  assert.match(r.text, /Best regards,\n?$|Best regards,/);
});

test("level 3 is Pro and levels 1 and 2 are not, and level 4 is rejected at the schema", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  assert.equal((await c.call("dunning_text", { client: "Acme Ltd", level: 1, as_of: "2026-06-30" })).isError, false);
  assert.equal((await c.call("dunning_text", { client: "Acme Ltd", level: 2, as_of: "2026-06-30" })).isError, false);
  const three = await c.call("dunning_text", { client: "Acme Ltd", level: 3, as_of: "2026-06-30" });
  assert.equal(three.isError, true);
  assert.match(three.text, /Pro feature/);
  assert.match(three.text, /license_activate/);
  assert.equal((await c.call("dunning_text", { client: "Acme Ltd", level: 4, as_of: "2026-06-30" })).isError, true);
  assert.equal((await c.call("dunning_text", { client: "Acme Ltd", level: 0, as_of: "2026-06-30" })).isError, true);
});

test("the free tier stops at five statements a month and rebuilds cost nothing", async (t) => {
  const { box, c } = open(t);
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(invoice({ number: `INV-C${i}`, client_name: `Client ${i}`, issue_date: "2026-06-02", due_date: "2026-06-20", net_minor: 10000 }));
  }
  seed.invoices(box.dataHome, rows);
  await c.init();
  for (let i = 1; i <= 5; i++) {
    assert.equal((await c.call("statement_build", { client: `Client ${i}`, ...PERIOD })).isError, false, `statement ${i}`);
  }
  const sixth = await c.call("statement_build", { client: "Client 6", ...PERIOD });
  assert.equal(sixth.isError, true);
  assert.match(sixth.text, /5 statements a calendar month/);
  assert.match(sixth.text, /Nothing was written/);
  assert.match(sixth.text, /statement_aging stays free/);
  // The five already built stay free to rebuild, in any of the three renderings.
  assert.equal((await c.call("statement_build", { client: "Client 1", ...PERIOD })).isError, false);
  assert.equal((await c.call("statement_text", { client: "Client 2", ...PERIOD })).isError, false);
  // And aging is not metered at all.
  assert.equal((await c.call("statement_aging", { as_of: "2026-06-30" })).isError, false);
});

test.skip("a Pro key for another product does not unlock this one", async (t) => {
  const { box, c } = open(t, { key: proKey("deposits") });
  workedMonth(box.dataHome);
  await c.init();
  assert.equal((await c.call("statements_report", {})).isError, true);
  assert.equal((await c.call("statement_pdf", { client: "Acme Ltd", ...PERIOD })).isError, true);
  assert.equal((await c.call("dunning_text", { client: "Acme Ltd", level: 3, as_of: "2026-06-30" })).isError, true);
});

test.skip("a missing sibling store is not an error: the statement is built without it", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  // Only the invoice store exists. No credit notes, no deposits, no profile.
  seed.invoices(box.dataHome, [invoice({
    number: "INV-2026-0500", client_name: "Solo Ltd", issue_date: "2026-06-04", due_date: "2026-06-18", net_minor: 60000,
  })]);
  await c.init();
  const st = await c.json("statement_build", { client: "Solo Ltd", ...PERIOD });
  assert.equal(st.closing_balance_minor, 60000);
  assert.deepEqual(st.notes, []);
  const src = st.sources;
  assert.deepEqual(src.map((x) => [x.store, x.read, x.rows]), [
    ["invoice", true, 1],
    ["billing-docs credit notes", true, 0],
    ["deposits", true, 0],
  ]);
});

test.skip("a client with a deposit and no invoice at all still states, at a zero balance", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  seed.deposits(box.dataHome, [deposit({
    id: "DEP-2026-0600", client_name: "Prepaid Oy", amount_minor: 25000, received_date: "2026-06-03",
  })]);
  await c.init();
  const st = await c.json("statement_build", { client: "Prepaid Oy", ...PERIOD });
  assert.equal(st.closing_balance_minor, 0, "a held deposit is the client's money, not a payment");
  assert.equal(st.deposit_still_held_minor, 25000);
  assert.deepEqual(st.movements, []);
});
