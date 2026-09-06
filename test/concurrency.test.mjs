// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Two processes sharing one data directory. The register is the only file this server
// writes, so it is the only thing that can be lost, and both races below are on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, sandbox, cleanup, proKey, seed, invoice, storeDir, workedMonth, PERIOD } from "./_client.mjs";

function register(dataHome) {
  return JSON.parse(readFileSync(join(storeDir(dataHome, "statement-of-account"), "statements.json"), "utf8"));
}

test.skip("twenty statements built by two processes at once all land, with unique ids", async (t) => {
  const box = sandbox();
  t.after(() => cleanup(box.dir));
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push(invoice({ number: `INV-R${i}`, client_name: `Racer ${i}`, issue_date: "2026-06-02", due_date: "2026-06-20", net_minor: 10000 + i }));
  }
  seed.invoices(box.dataHome, rows);
  const key = proKey();
  const a = client({ dataHome: box.dataHome, key });
  const b = client({ dataHome: box.dataHome, key });
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.init(), b.init()]);

  const calls = [];
  for (let i = 1; i <= 20; i++) {
    calls.push((i % 2 ? a : b).call("statement_build", { client: `Racer ${i}`, ...PERIOD }));
  }
  const results = await Promise.all(calls);
  for (const r of results) assert.equal(r.isError, false, r.text);

  const reg = register(box.dataHome);
  assert.equal(reg.length, 20, "a statement was lost to a concurrent write");
  assert.equal(new Set(reg.map((x) => x.id)).size, 20, "an id was issued twice");
  assert.equal(new Set(reg.map((x) => x.client_name)).size, 20);
  const counters = JSON.parse(readFileSync(join(storeDir(box.dataHome, "statement-of-account"), "counter.json"), "utf8"));
  assert.equal(counters["STMT-2026"], 20);
});

test("two processes racing the fifth free statement do not both pass the cap", async (t) => {
  const box = sandbox();
  t.after(() => cleanup(box.dir));
  const rows = [];
  for (let i = 1; i <= 16; i++) {
    rows.push(invoice({ number: `INV-F${i}`, client_name: `Free ${i}`, issue_date: "2026-06-02", due_date: "2026-06-20", net_minor: 10000 }));
  }
  seed.invoices(box.dataHome, rows);
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.init(), b.init()]);

  const calls = [];
  for (let i = 1; i <= 16; i++) calls.push((i % 2 ? a : b).call("statement_build", { client: `Free ${i}`, ...PERIOD }));
  const results = await Promise.all(calls);
  const okCount = results.filter((r) => !r.isError).length;
  const refused = results.filter((r) => r.isError);
  assert.equal(okCount, 5, `${okCount} statements passed a cap of 5`);
  assert.equal(refused.length, 11);
  for (const r of refused) assert.match(r.text, /5 statements a calendar month/);
  assert.equal(register(box.dataHome).length, 5, "the check and the write are not one critical section");
});

test("two processes building the SAME statement produce one row and one id", async (t) => {
  const box = sandbox();
  t.after(() => cleanup(box.dir));
  workedMonth(box.dataHome);
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.init(), b.init()]);
  const results = await Promise.all([
    a.json("statement_build", { client: "Acme Ltd", ...PERIOD }),
    b.json("statement_build", { client: "Acme Ltd", ...PERIOD }),
    a.call("statement_text", { client: "Acme Ltd", ...PERIOD }),
  ]);
  assert.equal(results[0].statement_id, results[1].statement_id);
  const reg = register(box.dataHome);
  assert.equal(reg.length, 1, "the same statement was registered twice");
  assert.equal(reg[0].closing_minor, 230000);
});
