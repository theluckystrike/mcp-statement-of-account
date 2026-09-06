/**
 * The credit note and purchase order stores, as a stable public API for other servers in
 * this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). What is re-exported
 * here is everything a sibling server would need to read or write these documents in the
 * SAME data directory, under the same lock and the same `CN-<YYYY>-<NNNN>` /
 * `PO-<YYYY>-<NNNN>` series: the record types, the store accessors, the id allocator, the
 * lock path and the A4 renderer.
 *
 * The money and VAT arithmetic is NOT re-exported: it lives in
 * `@theluckystrike/mcp-invoice/lib` and this server has no copy of it. Import
 * `computeTotals`, `formatMoney` and `currencyDecimals` from there, and `today` /
 * `isIsoDate` from `@theluckystrike/mcp-quotes/lib`.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-billing-docs/dist/*.js`
 * deep imports are not.
 */
export { dataDir, findDoc, getCreditNotes, getPurchaseOrders, lockPath, nextDocId, setCreditNotes, setPurchaseOrders, } from "./store.js";
export { renderDocPdf } from "./pdf.js";
export { bodyLines } from "./text.js";
