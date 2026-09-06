import type { ComputedLine, TaxLine } from "@theluckystrike/mcp-invoice/lib";
/**
 * Credit notes and purchase orders live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/billing-docs/`. The invoices a credit
 * note is issued against are READ from the invoice server's directory through the shared
 * engine (@theluckystrike/mcp-invoice/lib), so both documents name the same invoice
 * number, the same client and the same currency.
 *
 * Two directories, two locks, always taken in the same order (billing-docs, then
 * invoice), the same order servers/quotes and servers/recurring use, so no two processes
 * in this repo can deadlock.
 *
 * Reads go through the invoice engine's `readJsonFile`, so a store that is not JSON is
 * quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a `.corrupt` marker
 * beside it, and every later call fails loudly instead of treating a store that is still
 * on disk as "no documents". Writes are tmp + rename.
 */
export interface Party {
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
}
/** How much of the invoice this credit note takes back, and on what basis. */
export type CreditBasis = "full" | "amount" | "lines";
export interface CreditNote {
    /** `CN-<YYYY>-<NNNN>`, allocated per year. */
    id: string;
    /** The invoice number this credit note is issued against, e.g. `INV-2026-0001`. */
    invoice_number: string;
    invoice_total_minor: number;
    invoice_issue_date: string;
    basis: CreditBasis;
    client_id?: string;
    client: Party;
    issue_date: string;
    currency: string;
    decimals: number;
    /**
     * Every money field on a credit note line is NEGATIVE, in minor units: a credit note
     * is a negative invoice, and a bookkeeper who sums the documents in a period must get
     * the net of what was billed without knowing which rows to flip.
     */
    lines: ComputedLine[];
    subtotal_minor: number;
    discount_percent: number;
    discount_minor: number;
    net_minor: number;
    tax_lines: TaxLine[];
    tax_minor: number;
    total_minor: number;
    reason: string;
    notes?: string;
    created: string;
    /** Free tier renders a footer credit on the PDF. */
    branded: boolean;
}
export type PoStatus = "open" | "partially_received" | "received";
export interface PoReceipt {
    date: string;
    partial: boolean;
    note?: string;
}
export interface PurchaseOrder {
    /** `PO-<YYYY>-<NNNN>`, allocated per year. */
    id: string;
    /** The ordering party: the shared business profile, never re-typed on the call. */
    buyer: Party;
    supplier_client_id?: string;
    supplier: Party;
    issue_date: string;
    expected_delivery_date?: string;
    currency: string;
    decimals: number;
    lines: ComputedLine[];
    subtotal_minor: number;
    discount_percent: number;
    discount_minor: number;
    net_minor: number;
    tax_lines: TaxLine[];
    tax_minor: number;
    total_minor: number;
    notes?: string;
    status: PoStatus;
    receipts: PoReceipt[];
    received_date?: string;
    created: string;
    updated: string;
    branded: boolean;
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getCreditNotes(): CreditNote[];
export declare function setCreditNotes(v: CreditNote[]): void;
export declare function getPurchaseOrders(): PurchaseOrder[];
export declare function setPurchaseOrders(v: PurchaseOrder[]): void;
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
export declare function nextDocId(prefix: string, year: string, existing: string[]): string;
/**
 * Resolve a document by exact id (case-insensitive), then by exact party name, then --
 * only if nothing exact matched -- by partial party name. More than one partial
 * candidate is refused with the list rather than silently picking the first, so
 * purchase_order_receive cannot mark the wrong order received.
 */
export declare function findDoc<T>(list: T[], ref: string, idOf: (d: T) => string, nameOf: (d: T) => string, label: string): T | undefined;
