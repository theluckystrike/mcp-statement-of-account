/**
 * The deposit store, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). What is re-exported
 * here is everything a sibling server would need to read or write deposits in the SAME
 * data directory, under the same lock and the same `DEP-<YYYY>-<NNNN>` series: the record
 * types, the store accessors, the movement arithmetic, the id allocator and the lock path.
 *
 * The money formatting, the currency table and the page renderer are NOT re-exported:
 * they live in `@theluckystrike/mcp-invoice/lib` and `@theluckystrike/mcp-billing-docs/lib`
 * and this server has no copy of them.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-deposits/dist/*.js`
 * deep imports are not.
 */
export { dataDir, findDeposit, getDeposits, lockPath, movements, nextDepositId, setDeposits, statusOf, } from "./store.js";
