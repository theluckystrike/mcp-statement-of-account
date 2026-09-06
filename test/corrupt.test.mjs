// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// A store that is on disk and unreadable is never read as an empty one. The three sibling
// stores degrade differently on purpose, and this suite pins down which is which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { client, sandbox, cleanup, proKey, seed, storeDir, workedMonth, PERIOD } from "./_client.mjs";

function open(t, opts = {}) {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

const wreck = (dataHome, server, file) =>
  writeFileSync(join(storeDir(dataHome, server), file), "{ this is not json");

test.skip("a corrupt credit note store degrades the statement and names what is missing", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  wreck(box.dataHome, "billing-docs", "credit-notes.json");
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  assert.equal(st.isError, undefined, JSON.stringify(st).slice(0, 300));
  // Without the credit notes the balance is too high by exactly the two of them.
  assert.equal(st.credit_notes_minor, 0);
  assert.equal(st.closing_balance_minor, 230000 + 5000 + 10000);
  const src = st.sources.find((x) => x.store === "billing-docs credit notes");
  assert.equal(src.read, false);
  assert.match(src.error, /corrupt/);
  assert.ok(st.notes.some((n) => /credit note store could not be read/.test(n)), JSON.stringify(st.notes));
  assert.ok(st.notes.some((n) => /not an empty store; it is an unreadable one/.test(n)));
  // The file was quarantined byte for byte, and the marker is beside it.
  const dir = storeDir(box.dataHome, "billing-docs");
  assert.ok(existsSync(join(dir, "credit-notes.json.corrupt")), "no marker was written");
  const marker = JSON.parse(readFileSync(join(dir, "credit-notes.json.corrupt"), "utf8"));
  assert.equal(readFileSync(marker.quarantined, "utf8"), "{ this is not json");
});

test.skip("a corrupt deposit store still counts the money, and says the label is what is lost", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  wreck(box.dataHome, "deposits", "deposits.json");
  await c.init();
  const st = await c.json("statement_build", { client: "Acme Ltd", ...PERIOD });
  // The 300.00 deposit application is on the invoice as paid_minor, so the balance is
  // unchanged; what is lost is the row that said it came from a deposit.
  assert.equal(st.closing_balance_minor, 230000);
  assert.equal(st.payments_received_minor, 90000);
  assert.equal(st.of_which_deposits_applied_minor, 0);
  assert.equal(st.deposit_still_held_minor, 0);
  assert.ok(st.notes.some((n) => /deposit store could not be read/.test(n)), JSON.stringify(st.notes));
  assert.ok(st.notes.some((n) => /is still counted, because/.test(n)));
});

test.skip("a corrupt invoice store refuses every tool by name and answers nothing", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  wreck(box.dataHome, "invoice", "invoices.json");
  await c.init();
  for (const [tool, args] of [
    ["statement_build", { client: "Acme Ltd", ...PERIOD }],
    ["statement_text", { client: "Acme Ltd", ...PERIOD }],
    ["statement_pdf", { client: "Acme Ltd", ...PERIOD }],
    ["statement_aging", {}],
    ["dunning_text", { client: "Acme Ltd", level: 1 }],
    ["statements_report", {}],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} answered over a corrupt invoice ledger`);
    assert.match(r.text, /the invoice store could not be read/, tool);
    assert.match(r.text, new RegExp(tool), `${tool} does not name itself in the refusal`);
    assert.match(r.text, /cannot answer at all rather than answer with nothing owed/);
  }
});

test("a corrupt statement register blocks building a new statement but not aging", async (t) => {
  const { box, c } = open(t);
  workedMonth(box.dataHome);
  await c.init();
  // Build one so the register directory exists, then wreck it.
  assert.equal((await c.call("statement_build", { client: "Acme Ltd", ...PERIOD })).isError, false);
  wreck(box.dataHome, "statement-of-account", "statements.json");
  const build = await c.call("statement_build", { client: "Beta GmbH", ...PERIOD });
  assert.equal(build.isError, true);
  assert.match(build.text, /corrupt/);
  assert.match(build.text, /nothing was written/i);
  // Aging never touches the register, so it keeps working: the receivables question is
  // still answerable when the record of what was sent is not.
  const aged = await c.call("statement_aging", { as_of: "2026-06-30" });
  assert.equal(aged.isError, false, aged.text);
  assert.match(aged.text, /INV-2026-0003/);
});

test.skip("a corrupt shared profile does not stop a statement, it drops the issuer", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  workedMonth(box.dataHome);
  seed.raw(box.dataHome, "profile", "business.json", "not json at all");
  await c.init();
  const r = await c.call("statement_text", { client: "Acme Ltd", ...PERIOD });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /CLOSING BALANCE\s+EUR 2300\.00/);
  assert.match(r.text, /No business profile yet/);
  assert.ok(!/Studio One/.test(r.text), "a quarantined profile was still printed");
});
