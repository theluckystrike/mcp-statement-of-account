import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-invoice/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "deposits");
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function lockPath() { return join(dataDir(), ".lock"); }
function read(file, empty) {
    return readJsonFile(join(dataDir(), file), empty);
}
/** Atomic: per-process temp name, then rename over the target. */
function write(file, value) {
    const p = join(dataDir(), file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
}
export function getDeposits() { return read("deposits.json", []); }
export function setDeposits(v) { write("deposits.json", v); }
/** Applied, refunded and still held, in minor units, from the movements themselves. */
export function movements(d) {
    const applied = d.applications.reduce((a, x) => a + x.amount_minor, 0);
    const refunded = d.refunds.reduce((a, x) => a + x.amount_minor, 0);
    return { applied_minor: applied, refunded_minor: refunded, held_minor: d.amount_minor - applied - refunded };
}
/**
 * The status is DERIVED from the movements every time one is written, never taken from
 * the caller. A stored status and a movement list that disagree is the class of bug that
 * makes a deposit look returned while the money is still on the books.
 */
export function statusOf(d) {
    const m = movements(d);
    if (m.held_minor > 0)
        return "held";
    return m.applied_minor > 0 ? "applied" : "refunded";
}
/**
 * Allocate the next deposit id: `DEP-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the deposit is stored, so a crash burns
 * an id rather than reusing one. Ids already in the store are also scanned, so a restored
 * or hand-edited store can never hand back an id that is already on a receipt a client
 * has seen. The year is part of the id for the same reason it is part of `INV-YYYY-NNNN`
 * and `CN-YYYY-NNNN`: a bare `DEP-0001` reset every January collides with last January's.
 */
export function nextDepositId(year, existing) {
    const counters = read("counter.json", {});
    const key = `DEP-${year}`;
    let n = counters[key] ?? 0;
    const used = new Set(existing);
    do {
        n += 1;
    } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
    counters[key] = n;
    write("counter.json", counters);
    return `${key}-${String(n).padStart(4, "0")}`;
}
/**
 * Resolve a deposit by exact id (case-insensitive), then by exact client name, then --
 * only if nothing exact matched -- by partial client name. More than one partial
 * candidate is refused with the list rather than silently picking the first, so
 * deposit_refund cannot pay back the wrong client's money.
 */
export function findDeposit(list, ref) {
    const needle = String(ref).trim().toLowerCase();
    const byId = list.find((d) => d.id.toLowerCase() === needle);
    if (byId)
        return byId;
    const exact = list.filter((d) => d.client.name.toLowerCase() === needle);
    if (exact.length === 1)
        return exact[0];
    const pool = exact.length ? exact : list.filter((d) => d.client.name.toLowerCase().includes(needle));
    if (pool.length > 1) {
        throw new Error(`"${ref}" matches more than one deposit: ${pool.map((d) => `${d.id} (${d.client.name})`).join(", ")}. Pass the exact id.`);
    }
    return pool[0];
}
