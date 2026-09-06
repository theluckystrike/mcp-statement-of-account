/**
 * Deposits live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/deposits/`. The invoices a deposit is
 * applied to are read AND written through the shared engine
 * (@theluckystrike/mcp-invoice/lib), so the payment a deposit makes is the same payment
 * the invoice server's own invoice_mark_paid writes: `paid_minor`, `paid_date`, `status`.
 *
 * Two directories, two locks, always taken in the same order (deposits, then invoice),
 * the same order servers/billing-docs, servers/quotes and servers/recurring use, so no
 * two processes in this repo can deadlock.
 *
 * Reads go through the invoice engine's `readJsonFile`, so a store that is not JSON is
 * quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a `.corrupt` marker
 * beside it, and every later call fails loudly instead of treating a store that is still
 * on disk as "no deposits". Writes are tmp + rename.
 */
export interface Party {
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
}
/** What the money is being held for. Both are held; only the reason differs. */
export type DepositKind = "security" | "retainer";
/**
 * Derived, never asked for: `held` while any of the deposit is still held, otherwise
 * `applied` if any of it went to an invoice and `refunded` if it all went back.
 */
export type DepositStatus = "held" | "applied" | "refunded";
export interface DepositApplication {
    date: string;
    invoice_number: string;
    amount_minor: number;
    note?: string;
}
export interface DepositRefund {
    date: string;
    amount_minor: number;
    method: string;
    note?: string;
}
export interface Deposit {
    /** `DEP-<YYYY>-<NNNN>`, allocated per year. */
    id: string;
    client_id?: string;
    client: Party;
    /** Always POSITIVE, in minor units. What was received. */
    amount_minor: number;
    currency: string;
    decimals: number;
    kind: DepositKind;
    received_date: string;
    /** The bank reference, cheque number or transfer note the money arrived with. */
    reference?: string;
    notes?: string;
    applications: DepositApplication[];
    refunds: DepositRefund[];
    status: DepositStatus;
    created: string;
    updated: string;
    branded: boolean;
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getDeposits(): Deposit[];
export declare function setDeposits(v: Deposit[]): void;
/** Applied, refunded and still held, in minor units, from the movements themselves. */
export declare function movements(d: Deposit): {
    applied_minor: number;
    refunded_minor: number;
    held_minor: number;
};
/**
 * The status is DERIVED from the movements every time one is written, never taken from
 * the caller. A stored status and a movement list that disagree is the class of bug that
 * makes a deposit look returned while the money is still on the books.
 */
export declare function statusOf(d: Deposit): DepositStatus;
/**
 * Allocate the next deposit id: `DEP-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the deposit is stored, so a crash burns
 * an id rather than reusing one. Ids already in the store are also scanned, so a restored
 * or hand-edited store can never hand back an id that is already on a receipt a client
 * has seen. The year is part of the id for the same reason it is part of `INV-YYYY-NNNN`
 * and `CN-YYYY-NNNN`: a bare `DEP-0001` reset every January collides with last January's.
 */
export declare function nextDepositId(year: string, existing: string[]): string;
/**
 * Resolve a deposit by exact id (case-insensitive), then by exact client name, then --
 * only if nothing exact matched -- by partial client name. More than one partial
 * candidate is refused with the list rather than silently picking the first, so
 * deposit_refund cannot pay back the wrong client's money.
 */
export declare function findDeposit(list: Deposit[], ref: string): Deposit | undefined;
