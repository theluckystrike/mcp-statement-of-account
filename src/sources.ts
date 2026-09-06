import {
  getBusiness, getClients, getInvoices, hasBusiness,
  type Business, type Client, type Invoice,
} from "@theluckystrike/mcp-invoice/lib";
import { getCreditNotes, type CreditNote } from "@theluckystrike/mcp-billing-docs/lib";
import { getDeposits, movements, type Deposit } from "@theluckystrike/mcp-deposits/lib";

/**
 * The three sibling stores, read READ-ONLY and BEST EFFORT.
 *
 * A statement of account is assembled from books this server does not own. Two rules
 * follow, and both are load-bearing:
 *
 * 1. Nothing here writes. Not a payment, not a status, not a counter. `deposit_apply`
 *    already writes the payment onto the invoice, `credit_note_issue` already stores the
 *    credit; a statement that also wrote would double the money in the books it is
 *    supposed to be reporting on.
 *
 * 2. A sibling store that is missing, empty or QUARANTINED is reported, never fatal. The
 *    common case on a real machine is that the user runs mcp-invoice and has never
 *    installed mcp-deposits: their statement is still correct, it simply has no deposit
 *    line. A corrupt store is different -- there is money on disk that could not be read
 *    -- so the failure is carried into every answer as a named source error rather than
 *    silently read as zero. The one thing never done is treating an unreadable file as
 *    an empty one, because that turns a balance that could not be computed into a
 *    balance of nothing owed.
 *
 * The invoice store is the exception to "never fatal": with no invoices there is no
 * statement at all, so a corrupt INVOICE store refuses the tool by name. A corrupt
 * credit note or deposit store degrades the statement and says so on every figure.
 */

export interface Source<T> {
  /** What was read. Empty when the store is missing, empty or unreadable. */
  rows: T[];
  /** Present only when the store exists on disk and could not be read. */
  error?: string;
  /** True when the store was read successfully, whether or not it had rows. */
  ok: boolean;
}

export interface SourceSet {
  invoices: Source<Invoice>;
  credit_notes: Source<CreditNote>;
  deposits: Source<Deposit>;
  clients: Source<Client>;
}

function attempt<T>(read: () => T[]): Source<T> {
  try {
    return { rows: read(), ok: true };
  } catch (e) {
    return { rows: [], ok: false, error: (e as Error).message };
  }
}

export function readSources(): SourceSet {
  return {
    invoices: attempt(getInvoices),
    credit_notes: attempt(getCreditNotes),
    deposits: attempt(getDeposits),
    clients: attempt(getClients),
  };
}

/** One line per store, for the `sources` field every answer carries. */
export function sourceReport(s: SourceSet): Array<{ store: string; read: boolean; rows: number; error?: string }> {
  return [
    { store: "invoice", read: s.invoices.ok, rows: s.invoices.rows.length, error: s.invoices.error },
    { store: "billing-docs credit notes", read: s.credit_notes.ok, rows: s.credit_notes.rows.length, error: s.credit_notes.error },
    { store: "deposits", read: s.deposits.ok, rows: s.deposits.rows.length, error: s.deposits.error },
  ];
}

/**
 * The sentence that goes into an answer when a sibling store could not be read. It names
 * the store and says which figure is therefore incomplete, because a statement short one
 * credit note is not wrong by a rounding error, it is wrong by the credit note.
 */
export function degradedNotes(s: SourceSet): string[] {
  const out: string[] = [];
  if (!s.credit_notes.ok) {
    out.push(
      `The credit note store could not be read (${s.credit_notes.error}). Credit notes are therefore MISSING from ` +
      `every figure below, so the closing balance is too high by whatever was credited. This is not an empty store; it is an unreadable one.`,
    );
  }
  if (!s.deposits.ok) {
    out.push(
      `The deposit store could not be read (${s.deposits.error}). A deposit applied to an invoice is still counted, because ` +
      `deposit_apply writes it onto the invoice as paid_minor; what is missing is the label saying which payment came from a deposit, ` +
      `and the memo of what is still held.`,
    );
  }
  if (!s.clients.ok) {
    out.push(`The client list could not be read (${s.clients.error}). Clients are matched by the name stored on each document instead.`);
  }
  return out;
}

/** Refusal text for the one store a statement cannot be built without. */
export function invoicesUnreadable(s: SourceSet, toolName: string): string {
  return `the invoice store could not be read (${s.invoices.error}). ` +
    `A statement of account is a view over the invoice ledger, so ${toolName} cannot answer at all rather than answer with nothing owed. ` +
    `Nothing was written.`;
}

const PLACEHOLDER_ISSUER = "Your business";

export const NO_BUSINESS_NOTE =
  "No business profile yet: this document shows a placeholder issuer and no bank details. " +
  "Run business_set {name, address, vat_id, iban, bank} in the invoice server (mcp-invoice) and render again.";

/** Never throws: an unreadable business profile degrades to the placeholder issuer. */
export function issuer(): Business {
  try {
    const b = getBusiness();
    return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
  } catch {
    return {
      name: PLACEHOLDER_ISSUER, default_currency: "EUR", default_tax_rate: 0,
      payment_terms_days: 14, invoice_prefix: "INV",
    };
  }
}

export function businessMissing(): boolean {
  try { return !hasBusiness() || !getBusiness().name.trim(); } catch { return true; }
}

/** Still-held deposit money per currency for one client, a memo line on the statement. */
export function heldFor(deposits: Deposit[], currency: string): number {
  return deposits
    .filter((d) => d.currency.toUpperCase() === currency.toUpperCase())
    .reduce((a, d) => a + movements(d).held_minor, 0);
}
