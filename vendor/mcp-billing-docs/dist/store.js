import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-invoice/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "billing-docs");
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
export function getCreditNotes() { return read("credit-notes.json", []); }
export function setCreditNotes(v) { write("credit-notes.json", v); }
export function getPurchaseOrders() { return read("purchase-orders.json", []); }
export function setPurchaseOrders(v) { write("purchase-orders.json", v); }
/**
 * Allocate the next document id: `<PREFIX>-<YYYY>-<NNNN>`.
 *
 * The counter is per prefix and per year and is written BEFORE the document is stored,
 * so a crash burns an id rather than reusing one. Ids already in the store are also
 * scanned, so a restored or hand-edited store can never hand back an id that is already
 * on a document a client or a supplier has seen. The year is part of the id for the same
 * reason it is part of `INV-YYYY-NNNN` and `Q-YYYY-NNNN`: a bare `CN-0001` reset every
 * January collides with last January's credit note, and the two are different documents.
 */
export function nextDocId(prefix, year, existing) {
    const counters = read("counter.json", {});
    const key = `${prefix}-${year}`;
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
 * Resolve a document by exact id (case-insensitive), then by exact party name, then --
 * only if nothing exact matched -- by partial party name. More than one partial
 * candidate is refused with the list rather than silently picking the first, so
 * purchase_order_receive cannot mark the wrong order received.
 */
export function findDoc(list, ref, idOf, nameOf, label) {
    const needle = String(ref).trim().toLowerCase();
    const byId = list.find((d) => idOf(d).toLowerCase() === needle);
    if (byId)
        return byId;
    const exact = list.filter((d) => nameOf(d).toLowerCase() === needle);
    if (exact.length === 1)
        return exact[0];
    const pool = exact.length ? exact : list.filter((d) => nameOf(d).toLowerCase().includes(needle));
    if (pool.length > 1) {
        throw new Error(`"${ref}" matches more than one ${label}: ${pool.map((d) => `${idOf(d)} (${nameOf(d)})`).join(", ")}. ` +
            `Pass the exact id.`);
    }
    return pool[0];
}
