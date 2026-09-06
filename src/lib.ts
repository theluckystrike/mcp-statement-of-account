/**
 * The statement engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). Everything below it --
 * resolving a client across three stores, turning an invoice's paid_minor into dated
 * payment rows, the movement ledger, the balance identity and the aging buckets -- is
 * generic and is re-exported here so a sibling server can state an account without a
 * second copy of the reconciliation rules.
 *
 * The money formatting, the currency table and the page renderer are NOT re-exported:
 * they live in `@theluckystrike/mcp-invoice/lib` and `@theluckystrike/mcp-billing-docs/lib`
 * and this server has no copy of them. Neither is any writer for the invoice, credit note
 * or deposit stores: this server reads those and never writes them.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-statement-of-account/dist/*.js`
 * deep imports are not.
 */

export type {
  AgedInvoice, AgingRow, Bucket, ClientScope, Movement, MovementKind, Party,
  PaymentAttribution, Statement,
} from "./statement.js";
export {
  ageClient, allMovements, bucketOf, BUCKETS, buildStatement, oldestOverdue, paymentRows,
  pickCurrency, resolveClient,
} from "./statement.js";

export type { Source, SourceSet } from "./sources.js";
export {
  businessMissing, degradedNotes, heldFor, issuer, invoicesUnreadable, NO_BUSINESS_NOTE,
  readSources, sourceReport,
} from "./sources.js";

export type { StatementRecord } from "./store.js";
export {
  dataDir, findStatement, getStatements, lockPath, nextStatementId, setStatements, statementKey,
} from "./store.js";

export { VERSION } from "./version.js";
