#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, withFileLock } from "@theluckystrike/mcp-license";
import { creditedMinorFor, currencyDecimals, findClient, formatMoney, getBusiness, getInvoices, hasBusiness, invoiceLockPath, setInvoices, } from "@theluckystrike/mcp-invoice/lib";
import { renderDocPdf } from "@theluckystrike/mcp-billing-docs/lib";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import { dataDir, findDeposit, getDeposits, lockPath, movements, nextDepositId, setDeposits, statusOf, } from "./store.js";
/**
 * Free tier: five deposits recorded in a calendar month, counted by received date.
 * Applying, refunding, balances and the text statement are free and unlimited: money
 * already held has to be able to leave the book on any tier, or the free tier would
 * hold a client's deposit hostage.
 */
const FREE_DEPOSITS_PER_MONTH = 5;
/** Guard against 1e308 arriving as an amount and producing an unrepresentable balance. */
const MAX_MINOR = 1e12;
const MAX_PARTY_NAME = 200;
const MAX_NOTES = 10000;
const MAX_ADDRESS = 2000;
const MAX_EMAIL = 320;
const MAX_VAT_ID = 64;
const MAX_REFERENCE = 200;
const MAX_METHOD = 200;
const MAX_ROWS = 2000;
const gate = createLicenseGate({ product: "deposits" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
const str = (field, max) => z.string().max(max, `${field} must be ${max} characters or fewer`);
/**
 * Locks. Every mutation takes this server's lock. `deposit_apply` also writes the payment
 * into the invoice server's store, so it takes the invoice lock too, in that order --
 * deposits, then invoice -- the same order servers/billing-docs, servers/quotes and
 * servers/recurring use, so two processes in this repo cannot deadlock against each other.
 */
function locked(fn) {
    return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}
function lockedWithInvoice(fn) {
    return withFileLock(lockPath(), () => withFileLock(invoiceLockPath(), fn, { timeoutMs: 20000 }), { timeoutMs: 20000 });
}
/**
 * The issuer block comes from the shared business profile, which `business_set` in the
 * invoice server writes. This server has no second copy of it, so one identity prints on
 * the invoice, on the credit note and on the deposit statement. A missing profile never
 * blocks a document: it carries the placeholder issuer and the answer says so.
 */
const PLACEHOLDER_ISSUER = "Your business";
const NO_BUSINESS_NOTE = "No business profile yet: this document shows a placeholder issuer. " +
    "Run business_set {name, address, vat_id, iban} in the invoice server (mcp-invoice) and render again.";
function businessMissing() {
    return !hasBusiness() || !getBusiness().name.trim();
}
function issuer() {
    const b = getBusiness();
    return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
}
function expandPath(p) {
    const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}
/* --------------------------------------------------------------- validation */
const minorAmount = (what) => z.number().int(`${what} must be a whole number of minor units (cents), e.g. 50000 for 500.00 EUR`)
    .positive(`${what} must be greater than zero`)
    .max(MAX_MINOR, `${what} is out of range`);
const isoDay = (field) => z.string().optional().describe(`YYYY-MM-DD${field}`);
function checkDate(value, fallback, field) {
    const d = value ?? fallback;
    if (!isIsoDate(d))
        throw new Error(`${field} "${value}" is not a real date in YYYY-MM-DD form.`);
    return d;
}
/* ------------------------------------------------------------------ display */
function depositSummary(d) {
    const m = movements(d);
    return {
        id: d.id,
        client: d.client.name,
        kind: d.kind,
        received_date: d.received_date,
        currency: d.currency,
        received: formatMoney(d.amount_minor, d.currency),
        received_minor: d.amount_minor,
        applied: formatMoney(m.applied_minor, d.currency),
        applied_minor: m.applied_minor,
        refunded: formatMoney(m.refunded_minor, d.currency),
        refunded_minor: m.refunded_minor,
        held: formatMoney(m.held_minor, d.currency),
        held_minor: m.held_minor,
        status: d.status,
        reference: d.reference,
    };
}
function depositDetail(d) {
    return {
        ...depositSummary(d),
        client_record: d.client,
        applications: d.applications.map((a) => ({ ...a, amount: formatMoney(a.amount_minor, d.currency) })),
        refunds: d.refunds.map((r) => ({ ...r, amount: formatMoney(r.amount_minor, d.currency) })),
        notes: d.notes,
        created: d.created,
        updated: d.updated,
    };
}
function balances(list) {
    const by = new Map();
    for (const d of list) {
        const m = movements(d);
        const b = by.get(d.currency) ?? { currency: d.currency, received_minor: 0, applied_minor: 0, refunded_minor: 0, held_minor: 0 };
        b.received_minor += d.amount_minor;
        b.applied_minor += m.applied_minor;
        b.refunded_minor += m.refunded_minor;
        b.held_minor += m.held_minor;
        by.set(d.currency, b);
    }
    return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
function balanceRow(b) {
    return {
        currency: b.currency,
        received: formatMoney(b.received_minor, b.currency), received_minor: b.received_minor,
        applied: formatMoney(b.applied_minor, b.currency), applied_minor: b.applied_minor,
        refunded: formatMoney(b.refunded_minor, b.currency), refunded_minor: b.refunded_minor,
        held: formatMoney(b.held_minor, b.currency), held_minor: b.held_minor,
    };
}
/** Deposits recorded in one calendar month, by received date, which is what the free cap counts. */
function depositsInMonth(month) {
    return getDeposits().filter((d) => d.received_date.slice(0, 7) === month).length;
}
/**
 * The duplicate fingerprint, D-R19: a create tool with no delete tool that accepts the
 * same record twice holds one client's money twice on the book and, on the free tier,
 * spends one of the five slots the month has with no way back except a Pro key.
 *
 * Normalised so the second call does not have to be byte-identical to be the same
 * deposit: the client name is trimmed, its inner whitespace collapsed and case-folded,
 * the currency and the kind are upper/lower-cased, the reference is trimmed and
 * case-folded, the amount is compared in minor units and the date in YYYY-MM-DD.
 *
 * `notes` is deliberately NOT part of it. Notes are commentary on the same money, so two
 * records that differ only there are still the same deposit; the reference is the field
 * that separates two genuine payments of the same amount on the same day, and it is in.
 */
function fingerprint(p) {
    const norm = (v) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return [
        norm(p.client), String(p.amount_minor), p.currency.trim().toUpperCase(),
        norm(p.kind), p.received_date.trim(), norm(p.reference),
    ].join("\u0000");
}
function fingerprintOf(d) {
    return fingerprint({
        client: d.client.name, amount_minor: d.amount_minor, currency: d.currency,
        kind: d.kind, received_date: d.received_date, reference: d.reference,
    });
}
function duplicateRefusal(dup) {
    return `${dup.id} is already this exact deposit: ${dup.client.name}, ${formatMoney(dup.amount_minor, dup.currency)}, ` +
        `${dup.kind}, received ${dup.received_date}` +
        (dup.reference ? `, reference ${dup.reference}` : ", no reference") + `. Nothing was written. ` +
        `Storing it twice would show that money held twice and would spend one of the ${FREE_DEPOSITS_PER_MONTH} free deposits ` +
        `${dup.received_date.slice(0, 7)} has. If the client really paid twice on the same day, record it again with its own ` +
        `reference. If ${dup.id} was itself the mistake, deposit_delete {"id":"${dup.id}"} removes it and gives that month's slot back.`;
}
/**
 * What stops a deposit being deleted. A deposit is only a mistake while none of its money
 * has moved: an application is a payment this server already wrote onto an invoice in the
 * invoice server's store (`paid_minor`, `paid_date`, `status`), and a refund is money
 * already sent back to the client. Deleting either would leave that payment or that
 * refund with nothing behind it, so both are named and the delete is refused. Those two
 * arrays are the only links a deposit has: the statements are rendered from the deposits
 * on the fly and store nothing that points back at an id.
 */
function dependentsOf(d) {
    const out = [];
    for (const ap of d.applications) {
        out.push(`${formatMoney(ap.amount_minor, d.currency)} applied to invoice ${ap.invoice_number} on ${ap.date}, which is a payment on that invoice in the invoice server's store`);
    }
    for (const r of d.refunds) {
        out.push(`${formatMoney(r.amount_minor, d.currency)} refunded on ${r.date} (${r.method})`);
    }
    return out;
}
function capRefusal(month, toolName) {
    return `the free tier records ${FREE_DEPOSITS_PER_MONTH} deposits a month and ${month} already has ${depositsInMonth(month)}. ` +
        `Applying, refunding and every balance stay free, so nothing already held is stuck. Nothing was stored. ` +
        gate.upgradeText("unlimited deposits", toolName);
}
/** Deposits for one client, matched the way the invoice server matches a client name. */
function forClient(ref, list = getDeposits()) {
    const needle = ref.trim().toLowerCase();
    const byId = list.filter((d) => d.client_id === ref.trim());
    if (byId.length)
        return byId;
    const exact = list.filter((d) => d.client.name.toLowerCase() === needle);
    if (exact.length)
        return exact;
    return list.filter((d) => d.client.name.toLowerCase().includes(needle));
}
/* ------------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-deposits", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.registerTool("deposit_record", {
    title: "Record a deposit received",
    description: "Record a security or retainer deposit received from a client, in minor units, with its currency, the date it arrived and the bank reference. Returns the DEP-YYYY-NNNN id.",
    inputSchema: {
        client: z.string().min(1, "client is required").max(MAX_PARTY_NAME, `client must be ${MAX_PARTY_NAME} characters or fewer`)
            .describe("Client name or client id. A name the invoice server already knows brings its address, email and VAT id onto the deposit"),
        amount_minor: minorAmount("amount_minor")
            .describe("What was received, in MINOR units: 50000 = 500.00 EUR, 50000 = JPY 50000. Never a decimal"),
        kind: z.enum(["security", "retainer"]).describe("security: held against damage or non-payment. retainer: held against work not yet invoiced"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
            .describe("Defaults to your business default currency"),
        received_date: isoDay(", the day the money arrived. Defaults to today"),
        reference: str("reference", MAX_REFERENCE).optional().describe("Bank reference, transfer note or cheque number the money arrived with"),
        notes: str("notes", MAX_NOTES).optional().describe("Free text kept on the record and printed on the statement"),
        client_email: str("client_email", MAX_EMAIL).optional().describe("Only if the user gave it; otherwise the stored client's email is used"),
        client_address: str("client_address", MAX_ADDRESS).optional().describe("Postal address for the statement's client block, newlines allowed"),
        client_vat_id: str("client_vat_id", MAX_VAT_ID).optional().describe("Client VAT / tax registration id"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const received = checkDate(a.received_date, today(), "received_date");
            const biz = issuer();
            const currency = (a.currency ?? biz.default_currency).toUpperCase();
            const stored = findClient(a.client);
            const client = {
                name: stored?.name ?? a.client.trim(),
                address: a.client_address ?? stored?.address,
                email: a.client_email ?? stored?.email,
                vat_id: a.client_vat_id ?? stored?.vat_id,
            };
            const list = getDeposits();
            // D-R19. Checked BEFORE the cap, and on every tier: the same deposit twice is
            // wrong on the book whether or not there is a slot left, and at the cap this is
            // the answer that names the way back.
            const fp = fingerprint({
                client: client.name, amount_minor: a.amount_minor, currency,
                kind: a.kind, received_date: received, reference: a.reference,
            });
            const dup = list.find((x) => fingerprintOf(x) === fp);
            if (dup)
                return fail(duplicateRefusal(dup));
            if (!gate.isPro() && depositsInMonth(received.slice(0, 7)) >= FREE_DEPOSITS_PER_MONTH) {
                return fail(capRefusal(received.slice(0, 7), "deposit_record"));
            }
            const now = new Date().toISOString();
            const d = {
                id: nextDepositId(received.slice(0, 4), list.map((x) => x.id)),
                client_id: stored?.id,
                client,
                amount_minor: a.amount_minor,
                currency,
                decimals: currencyDecimals(currency),
                kind: a.kind,
                received_date: received,
                reference: a.reference,
                notes: a.notes,
                applications: [],
                refunds: [],
                status: "held",
                created: now,
                updated: now,
                branded: !gate.isPro(),
            };
            list.push(d);
            setDeposits(list);
            const out = [];
            if (!stored) {
                out.push(`"${client.name}" is not a stored client record, so the statement will carry ${client.address ? "the address you gave" : "no address"}. ` +
                    `client_add in the invoice server stores it once for every later document.`);
            }
            if (!gate.isPro()) {
                out.push(`Free tier: ${depositsInMonth(received.slice(0, 7))} of ${FREE_DEPOSITS_PER_MONTH} deposits recorded in ${received.slice(0, 7)}. deposit_statement_pdf and deposits_report are Pro.`);
            }
            return json({ recorded: depositDetail(d), notes: out.length ? out : undefined });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposit_list", {
    title: "List deposits",
    description: "List deposits newest first: DEP number, client, kind, date, reference and what was received, applied, refunded and still held, with the same four totalled per currency. Filter by client, status, kind, date.",
    inputSchema: {
        client: z.string().optional().describe("Only deposits for this client id, exact name, or a name containing this text"),
        status: z.enum(["held", "applied", "refunded", "all"]).optional().describe('Default "all". held means some of the money is still held'),
        kind: z.enum(["security", "retainer", "all"]).optional().describe('Default "all"'),
        from: z.string().optional().describe("YYYY-MM-DD, earliest received date"),
        to: z.string().optional().describe("YYYY-MM-DD, latest received date"),
    },
}, async (a) => {
    try {
        let list = a.client ? forClient(a.client) : getDeposits();
        if (a.status && a.status !== "all")
            list = list.filter((d) => d.status === a.status);
        if (a.kind && a.kind !== "all")
            list = list.filter((d) => d.kind === a.kind);
        if (a.from)
            list = list.filter((d) => d.received_date >= a.from);
        if (a.to)
            list = list.filter((d) => d.received_date <= a.to);
        list = [...list].sort((x, y) => y.received_date.localeCompare(x.received_date) || y.id.localeCompare(x.id));
        return json({
            count: list.length,
            balance: balances(list).map(balanceRow),
            deposits: list.slice(0, MAX_ROWS).map(depositSummary),
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposit_apply", {
    title: "Apply a deposit to an invoice",
    description: "Apply part of a held deposit to one invoice: it records that amount as a PAYMENT through the invoice server. amount_minor defaults to the lesser of held and owed. More than either, or a pre-arrival date, is refused.",
    inputSchema: {
        id: z.string().min(1, "id is required").describe("Deposit id such as DEP-2026-0001, or an exact client name"),
        invoice: z.string().min(1, "invoice is required").describe("The invoice number to apply it to, e.g. INV-2026-0001"),
        amount_minor: minorAmount("amount_minor").optional()
            .describe("How much of the deposit to apply, in minor units. Defaults to the smaller of what is held and what the invoice still owes"),
        date: isoDay(", the day the deposit was set against the invoice. Defaults to today"),
        note: str("note", MAX_NOTES).optional().describe("Free text kept on the application row"),
    },
}, async (a) => {
    try {
        return await lockedWithInvoice(() => {
            const list = getDeposits();
            const d = findDeposit(list, a.id);
            if (!d)
                return fail(`no deposit matches "${a.id}". Run deposit_list to see the ids.`);
            const when = checkDate(a.date, today(), "date");
            if (when < d.received_date) {
                return fail(`${when} is before ${d.id} was received on ${d.received_date}. Money cannot be applied before it arrived. Nothing was changed.`);
            }
            const inv = getInvoices().find((i) => i.number.toLowerCase() === a.invoice.trim().toLowerCase());
            if (!inv) {
                const known = getInvoices().slice(-5).map((i) => i.number);
                return fail(`no invoice numbered "${a.invoice}" is in the invoice server's store. ` +
                    (known.length ? `The most recent are ${known.join(", ")}. ` : "That store is empty on this machine. ") +
                    `Nothing was changed.`);
            }
            if (inv.currency.toUpperCase() !== d.currency.toUpperCase()) {
                return fail(`${d.id} is held in ${d.currency} and ${inv.number} is in ${inv.currency}. A deposit is applied at its own currency, never converted here: ` +
                    `refund it and record it again in ${inv.currency}, or apply a ${inv.currency} deposit. Nothing was changed.`);
            }
            const held = movements(d).held_minor;
            // D-R96: total_minor - paid_minor alone ignores a credit note issued against this
            // invoice in the billing-docs store; statement-of-account already nets credit
            // notes the same way (ageClient), this open balance did not, and a deposit could
            // be applied past what the client actually still owes. Read-only, best-effort:
            // no billing-docs store installed reads as zero credit, never an error here.
            const creditedMinor = creditedMinorFor(inv.number, inv.currency);
            const open = Math.max(0, inv.total_minor - inv.paid_minor - creditedMinor);
            if (held <= 0) {
                return fail(`${d.id} has nothing left held: ${formatMoney(d.amount_minor, d.currency)} was received and all of it is already applied or refunded. Nothing was changed.`);
            }
            if (open <= 0) {
                return fail(`${inv.number} is already ${inv.status} in full: ${formatMoney(inv.paid_minor, inv.currency)} of ${formatMoney(inv.total_minor, inv.currency)} received` +
                    (creditedMinor ? ` and ${formatMoney(creditedMinor, inv.currency)} credited` : "") +
                    `, so there is nothing to apply a deposit to. Nothing was changed.`);
            }
            const amount = a.amount_minor ?? Math.min(held, open);
            if (amount > held) {
                return fail(`${d.id} holds ${formatMoney(held, d.currency)} and this would apply ${formatMoney(amount, d.currency)}. ` +
                    `A deposit cannot pay out more than was received. Nothing was changed.`);
            }
            if (amount > open) {
                return fail(`${inv.number} still owes ${formatMoney(open, inv.currency)}` +
                    (creditedMinor ? ` (after ${formatMoney(creditedMinor, inv.currency)} already credited)` : "") +
                    ` and this would apply ${formatMoney(amount, inv.currency)}. ` +
                    `Applying more would show the invoice overpaid and leave the difference owed to the client twice. Nothing was changed.`);
            }
            // The payment is written exactly as the invoice server's own invoice_mark_paid
            // writes one -- paid_minor, paid_date, status -- because there is no recordPayment
            // export to call. The one difference is deliberate: mark_paid SETS paid_minor from
            // the amount it is given, this ADDS to it, so a deposit applied after a part
            // payment does not erase that payment.
            const all = getInvoices();
            const row = all.find((i) => i.number === inv.number);
            if (!row)
                return fail(`${inv.number} disappeared from the invoice store between the read and the write. Nothing was changed.`);
            row.paid_minor += amount;
            row.paid_date = when;
            row.status = row.paid_minor >= row.total_minor ? "paid" : row.paid_minor > 0 ? "partial" : "unpaid";
            setInvoices(all);
            d.applications.push({ date: when, invoice_number: row.number, amount_minor: amount, note: a.note });
            d.status = statusOf(d);
            d.updated = new Date().toISOString();
            setDeposits(list);
            // D-R96: netted the same way `open` above was, so the balance shown here agrees
            // with what invoice_get and invoice_list now show for the same invoice.
            const stillCredited = creditedMinorFor(row.number, row.currency);
            const stillOpen = Math.max(0, row.total_minor - row.paid_minor - stillCredited);
            return json({
                applied: { deposit: d.id, invoice: row.number, date: when, amount: formatMoney(amount, d.currency), amount_minor: amount },
                deposit: depositSummary(d),
                invoice: {
                    number: row.number,
                    total: formatMoney(row.total_minor, row.currency),
                    paid: formatMoney(row.paid_minor, row.currency),
                    credited: stillCredited ? formatMoney(stillCredited, row.currency) : undefined,
                    balance_due: formatMoney(stillOpen, row.currency),
                    balance_due_minor: stillOpen,
                    status: row.status,
                },
                note: `The payment is on ${row.number} in the invoice server's store, so invoice_list and overdue_report already show it. ` +
                    `${d.id} now holds ${formatMoney(movements(d).held_minor, d.currency)}.`,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposit_refund", {
    title: "Refund a deposit",
    description: "Give part or all of a held deposit back to the client, with the date and how it was sent. Refuses more than is still held. The invoice server is not touched: a refund is not a payment.",
    inputSchema: {
        id: z.string().min(1, "id is required").describe("Deposit id such as DEP-2026-0001, or an exact client name"),
        amount_minor: minorAmount("amount_minor").optional().describe("How much to give back, in minor units. Defaults to everything still held"),
        date: isoDay(", the day the money went back. Defaults to today"),
        method: str("method", MAX_METHOD).optional().describe('How it was sent, e.g. "bank transfer to the account it came from". Printed on the statement'),
        note: str("note", MAX_NOTES).optional().describe("Free text kept on the refund row"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const list = getDeposits();
            const d = findDeposit(list, a.id);
            if (!d)
                return fail(`no deposit matches "${a.id}". Run deposit_list to see the ids.`);
            const when = checkDate(a.date, today(), "date");
            if (when < d.received_date) {
                return fail(`${when} is before ${d.id} was received on ${d.received_date}. Money cannot go back before it arrived. Nothing was changed.`);
            }
            const held = movements(d).held_minor;
            if (held <= 0) {
                const m = movements(d);
                return fail(`${d.id} has nothing left held: ${formatMoney(d.amount_minor, d.currency)} was received, ` +
                    `${formatMoney(m.applied_minor, d.currency)} applied to invoices and ${formatMoney(m.refunded_minor, d.currency)} refunded. Nothing was changed.`);
            }
            const amount = a.amount_minor ?? held;
            if (amount > held) {
                return fail(`${d.id} holds ${formatMoney(held, d.currency)} and this would refund ${formatMoney(amount, d.currency)}. ` +
                    `A refund cannot give back money that was never received or is already applied to an invoice. Nothing was changed.`);
            }
            d.refunds.push({ date: when, amount_minor: amount, method: a.method ?? "not stated", note: a.note });
            d.status = statusOf(d);
            d.updated = new Date().toISOString();
            setDeposits(list);
            return json({
                refunded: { deposit: d.id, date: when, amount: formatMoney(amount, d.currency), amount_minor: amount, method: a.method ?? "not stated" },
                deposit: depositSummary(d),
                note: `${d.id} now holds ${formatMoney(movements(d).held_minor, d.currency)}. No invoice was changed: a refund returns the client's own money, it does not pay a bill.`,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * The way back from deposit_record, D-R19. The free cap counts STORED records whose
 * received date falls in the month (`depositsInMonth` reads the store every time and
 * there is no separate month counter), so removing the row is what genuinely gives the
 * slot back: the very next deposit_record in that month is under the cap again.
 *
 * `counter.json` is deliberately NOT rewound. It only ever hands out the next id, and an
 * id a client may already have seen on a receipt must never be issued twice, so deleting
 * DEP-2026-0003 leaves the next deposit as DEP-2026-0004. The cap counts rows, not ids,
 * so the gap costs nothing.
 *
 * Free on every tier: a tool that can only be reached by paying is not a way back.
 */
server.registerTool("deposit_delete", {
    title: "Delete a deposit recorded by mistake",
    description: "Delete a deposit that never moved money, freeing that month's free-tier slot. One with anything applied or refunded is refused, naming it, since a payment or refund would be left with nothing behind it.",
    inputSchema: {
        id: z.string().min(1, "id is required").describe("Deposit id such as DEP-2026-0001, or an exact client name"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const list = getDeposits();
            const d = findDeposit(list, a.id);
            if (!d)
                return fail(`no deposit matches "${a.id}". Run deposit_list to see the ids.`);
            const deps = dependentsOf(d);
            if (deps.length) {
                return fail(`${d.id} cannot be deleted: ${deps.join("; ")}. ` +
                    `Deleting it would leave ${d.applications.length ? "that payment on the invoice" : "that refund"} with no deposit behind it. ` +
                    `Only a deposit that never moved money can be deleted; this one is a real record now, not a mistyped one. Nothing was changed.`);
            }
            const gone = depositDetail(d);
            const month = d.received_date.slice(0, 7);
            setDeposits(list.filter((x) => x.id !== d.id));
            const used = depositsInMonth(month);
            return json({
                deleted: gone,
                free_tier: gate.isPro()
                    ? undefined
                    : `${used} of ${FREE_DEPOSITS_PER_MONTH} deposits now recorded in ${month}, so ${FREE_DEPOSITS_PER_MONTH - used} more can be recorded in that month.`,
                note: `${d.id} is gone from the book and nothing else was touched: it had never been applied to an invoice and never refunded. ` +
                    `The id itself is not reused, so the next deposit gets a new number.`,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposit_balance", {
    title: "What is held for a client",
    description: "Answer \"how much of theirs am I holding?\" for one client or for everyone: received, applied to invoices, refunded and still held, one row per currency, never added across currencies.",
    inputSchema: {
        client: z.string().optional().describe("Client id, exact name or a name containing this text. Leave out for every client"),
        as_of: z.string().optional().describe("YYYY-MM-DD, count only deposits received on or before this day"),
    },
}, async (a) => {
    try {
        let list = a.client ? forClient(a.client) : getDeposits();
        if (a.as_of) {
            if (!isIsoDate(a.as_of))
                return fail(`as_of "${a.as_of}" is not a real date in YYYY-MM-DD form.`);
            list = list.filter((d) => d.received_date <= a.as_of);
        }
        if (a.client && !list.length)
            return fail(`no deposit has ever been recorded for "${a.client}". Run deposit_list to see the clients that have one.`);
        const byClient = new Map();
        for (const d of list) {
            const arr = byClient.get(d.client.name) ?? [];
            arr.push(d);
            byClient.set(d.client.name, arr);
        }
        return json({
            as_of: a.as_of ?? today(),
            deposits: list.length,
            total: balances(list).map(balanceRow),
            by_client: [...byClient.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([client, ds]) => ({
                client, deposits: ds.length, balance: balances(ds).map(balanceRow),
            })),
            basis: "held = received - applied - refunded, per deposit, summed per currency. Applied money is on the invoice it paid; refunded money went back to the client.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * The statement is a ledger, not a priced document: every row is one movement of the
 * client's own money, in date order, and the closing figure is what is still held.
 * Deposits received are positive, money applied to an invoice and money refunded are
 * negative, so the rows sum to the balance on a calculator.
 */
function statementRows(list) {
    const rows = [];
    for (const d of list) {
        rows.push({ date: d.received_date, description: `${d.id} ${d.kind} deposit received${d.reference ? ` (${d.reference})` : ""}`, amount_minor: d.amount_minor });
        for (const ap of d.applications)
            rows.push({ date: ap.date, description: `${d.id} applied to invoice ${ap.invoice_number}`, amount_minor: -ap.amount_minor });
        for (const r of d.refunds)
            rows.push({ date: r.date, description: `${d.id} refunded (${r.method})`, amount_minor: -r.amount_minor });
    }
    return rows.sort((x, y) => x.date.localeCompare(y.date) || x.description.localeCompare(y.description));
}
/**
 * One statement is in ONE currency. A client who paid a EUR deposit and a USD deposit has
 * two balances and adding them would be a made-up number, so the currency is asked for
 * rather than guessed when there is more than one.
 */
function pickCurrency(list, stated, who) {
    const currencies = [...new Set(list.map((d) => d.currency))].sort();
    if (stated) {
        const c = stated.toUpperCase();
        const kept = list.filter((d) => d.currency === c);
        if (!kept.length)
            throw new Error(`${who} has no ${c} deposit. Currencies held: ${currencies.join(", ")}.`);
        return { list: kept, currency: c };
    }
    if (currencies.length > 1) {
        throw new Error(`${who} has deposits in ${currencies.join(" and ")}. One statement is in one currency and the two are not added up: ` +
            `pass currency to choose.`);
    }
    return { list, currency: currencies[0] };
}
function statementFor(clientRef, currency) {
    const list = forClient(clientRef);
    if (!list.length)
        throw new Error(`no deposit has ever been recorded for "${clientRef}". Run deposit_list to see the clients that have one.`);
    const who = list[0].client.name;
    const picked = pickCurrency(list, currency, who);
    const rows = statementRows(picked.list);
    const b = balances(picked.list)[0];
    return { client: picked.list[0].client, who, currency: picked.currency, deposits: picked.list, rows, balance: b };
}
server.registerTool("deposit_statement_text", {
    title: "Plain-text deposit statement",
    description: "Turn one client's deposits into a plain-text statement to paste into an email: every movement in date order and the closing balance held. Pass currency when they have more than one. Free on every tier.",
    inputSchema: {
        client: z.string().min(1, "client is required").describe("Client id, exact name or a name containing this text"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
            .describe("Only needed when the client has deposits in more than one currency"),
        as_of: z.string().optional().describe("YYYY-MM-DD printed as the statement date. Defaults to today"),
        greeting: z.string().optional().describe("Opening line, default \"Hello\" plus the client name"),
        sign_off: z.string().optional().describe("Closing line, default your business name from the shared profile"),
    },
}, async (a) => {
    try {
        const s = statementFor(a.client, a.currency);
        const day = a.as_of ?? today();
        if (!isIsoDate(day))
            return fail(`as_of "${a.as_of}" is not a real date in YYYY-MM-DD form.`);
        const biz = issuer();
        const descW = Math.min(52, Math.max(20, ...s.rows.map((r) => r.description.length)));
        const pad = (t, n) => (t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length));
        const padL = (t, n) => (t.length >= n ? t : " ".repeat(n - t.length) + t);
        const out = [];
        out.push(a.greeting ?? `Hello ${s.who},`);
        out.push("");
        out.push(`Deposit statement as at ${day}, in ${s.currency}.`);
        out.push("");
        for (const r of s.rows)
            out.push(`  ${r.date}  ${pad(r.description, descW)}  ${padL(formatMoney(r.amount_minor, s.currency), 16)}`);
        out.push("");
        const labelW = descW + 12;
        out.push(`  ${padL("Received", labelW)}  ${padL(formatMoney(s.balance.received_minor, s.currency), 16)}`);
        out.push(`  ${padL("Applied to invoices", labelW)}  ${padL(formatMoney(-s.balance.applied_minor, s.currency), 16)}`);
        out.push(`  ${padL("Refunded", labelW)}  ${padL(formatMoney(-s.balance.refunded_minor, s.currency), 16)}`);
        out.push(`  ${padL("HELD", labelW)}  ${padL(formatMoney(s.balance.held_minor, s.currency), 16)}`);
        out.push("");
        out.push(s.balance.held_minor > 0
            ? `${formatMoney(s.balance.held_minor, s.currency)} of yours is still held.`
            : `Nothing of yours is held any more.`);
        out.push("");
        out.push(a.sign_off ?? (biz.name === PLACEHOLDER_ISSUER ? "Best regards," : `Best regards,\n${biz.name}`));
        const text = out.join("\n");
        return ok(businessMissing() ? `${text}\n\n---\n${NO_BUSINESS_NOTE}` : text);
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposit_statement_pdf", {
    title: "Render the deposit statement as a PDF",
    description: "Call this tool to write one client's A4 deposit statement and return the file path. Titled DEPOSIT STATEMENT, every movement in date order, closing with what is still held. Pro.",
    inputSchema: {
        client: z.string().min(1, "client is required").describe("Client id, exact name or a name containing this text"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
            .describe("Only needed when the client has deposits in more than one currency"),
        as_of: z.string().optional().describe("YYYY-MM-DD printed as the statement date. Defaults to today"),
        out_path: z.string().optional().describe("Where to write the PDF; defaults to the deposits data directory under pdf/. Use a .pdf path: the bytes written are always PDF"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("the deposit statement PDF", "deposit_statement_pdf"));
        const s = statementFor(a.client, a.currency);
        const day = a.as_of ?? today();
        if (!isIsoDate(day))
            return fail(`as_of "${a.as_of}" is not a real date in YYYY-MM-DD form.`);
        const slug = s.who.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
        const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `deposits-${slug}-${s.currency}.pdf`);
        // The same page renderer the credit note and the purchase order use
        // (@theluckystrike/mcp-billing-docs/lib), so a statement looks like the other
        // documents in the set. A movement is a one-off row, so it prints as quantity 1 at
        // its own amount with no VAT: a deposit is the client's money moving, not a sale.
        const lines = s.rows.map((r) => ({
            description: `${r.date}  ${r.description}`,
            quantity: 1,
            unit_price_minor: r.amount_minor,
            tax_rate: 0,
            gross_minor: r.amount_minor,
            discount_minor: 0,
            net_minor: r.amount_minor,
            tax_minor: 0,
            exact_gross_minor: r.amount_minor,
            round_total: false,
        }));
        await renderDocPdf({
            title: "DEPOSIT STATEMENT",
            number: `${s.who} (${s.currency})`,
            reference: `as at ${day}`,
            party_label: "CLIENT",
            party: s.client,
            meta: [["Statement date", day], ["Currency", s.currency], ["Deposits", String(s.deposits.length)]],
            currency: s.currency,
            lines,
            subtotal_minor: s.balance.received_minor - s.balance.applied_minor - s.balance.refunded_minor,
            discount_percent: 0,
            discount_minor: 0,
            net_minor: s.balance.held_minor,
            tax_lines: [],
            total_minor: s.balance.held_minor,
            footer_label: "HELD",
            footer_lines: [
                `Received ${formatMoney(s.balance.received_minor, s.currency)}, applied to invoices ${formatMoney(s.balance.applied_minor, s.currency)}, refunded ${formatMoney(s.balance.refunded_minor, s.currency)}.`,
                `${formatMoney(s.balance.held_minor, s.currency)} is still held as at ${day}.`,
            ],
            product: "mcp-deposits",
        }, issuer(), out, { branded: !gate.isPro(), logo: gate.isPro() });
        return json({
            client: s.who, currency: s.currency, path: out,
            document: /\.html?$/i.test(out) ? "HTML deposit statement (print to PDF)" : "PDF deposit statement",
            held: formatMoney(s.balance.held_minor, s.currency),
            notes: businessMissing() ? [NO_BUSINESS_NOTE] : undefined,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("deposits_report", {
    title: "What is held, and for how long",
    description: "The deposit book at a date: held per currency, received, applied and refunded, the oldest holdings with days held, and every deposit older than N days with nothing applied. Pro; deposit_balance is free.",
    inputSchema: {
        older_than_days: z.number().int().min(0).max(36500).optional().describe("Flag deposits received this many days ago or more with nothing applied. Default 90"),
        as_of: z.string().optional().describe("YYYY-MM-DD to count from. Defaults to today"),
        limit: z.number().int().min(1).max(200).optional().describe("How many oldest held deposits to list. Default 10"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("the deposits report", "deposits_report"));
        const day = a.as_of ?? today();
        if (!isIsoDate(day))
            return fail(`as_of "${a.as_of}" is not a real date in YYYY-MM-DD form.`);
        const days = a.older_than_days ?? 90;
        const limit = a.limit ?? 10;
        const all = getDeposits().filter((d) => d.received_date <= day);
        const held = all.filter((d) => movements(d).held_minor > 0);
        const ageOf = (d) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${d.received_date}T00:00:00Z`)) / 86400000);
        const oldest = [...held].sort((x, y) => x.received_date.localeCompare(y.received_date) || x.id.localeCompare(y.id))
            .slice(0, limit)
            .map((d) => ({ ...depositSummary(d), days_held: ageOf(d) }));
        const stale = held.filter((d) => d.applications.length === 0 && ageOf(d) >= days)
            .sort((x, y) => x.received_date.localeCompare(y.received_date))
            .map((d) => ({ ...depositSummary(d), days_held: ageOf(d) }));
        return json({
            as_of: day,
            deposits: all.length,
            held_deposits: held.length,
            held_by_currency: balances(held).map((b) => ({ currency: b.currency, held: formatMoney(b.held_minor, b.currency), held_minor: b.held_minor })),
            all_by_currency: balances(all).map(balanceRow),
            oldest_held: oldest,
            unapplied_older_than_days: days,
            unapplied: stale,
            basis: "A deposit counts as held while received - applied - refunded is above zero. days_held counts from the received date to as_of. " +
                "The unapplied list is deposits with no application at all: a retainer nobody ever billed against, or a security deposit that should have gone back.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
gate.registerTools(server);
/* ------------------------------------------------------ resource and prompt */
server.registerResource("held-deposits", "deposits://held", {
    title: "Held deposits",
    description: "Every deposit with money still held, as JSON.",
    mimeType: "application/json",
}, async () => {
    const held = getDeposits().filter((d) => movements(d).held_minor > 0).map(depositSummary);
    return { contents: [{ uri: "deposits://held", mimeType: "application/json", text: JSON.stringify(held, null, 2) }] };
});
server.registerPrompt("settle_deposits", {
    title: "Settle the deposits that are due back",
    description: "Review what is still held, then decide what to apply to an open invoice and what to refund.",
    argsSchema: {},
}, () => ({
    messages: [{
            role: "user",
            content: {
                type: "text",
                text: [
                    "1. Call deposit_list with status \"held\" and list what is held, per client and per currency.",
                    "2. For each, say how long it has been held and whether any of it was ever applied to an invoice.",
                    "3. Name the ones that should go back to the client and the ones that should be applied to an open invoice.",
                    "4. Give me the deposit_apply or deposit_refund call for each, with the amounts in minor units.",
                ].join("\n"),
            },
        }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-deposits ready\n");
