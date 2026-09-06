#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, withFileLock } from "@theluckystrike/mcp-license";
import { computeTotals, currencyDecimals, findClient, formatMoney, getBusiness, getInvoices, hasBusiness, invoiceLockPath, setInvoices, } from "@theluckystrike/mcp-invoice/lib";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { renderDocPdf } from "./pdf.js";
import { bodyLines } from "./text.js";
import { VERSION } from "./version.js";
import { dataDir, findDoc, getCreditNotes, getPurchaseOrders, lockPath, nextDocId, setCreditNotes, setPurchaseOrders, } from "./store.js";
/**
 * Free tier: five documents in a calendar month, credit notes and purchase orders
 * together. A credit note is issued against money already billed, so a month in which a
 * free user needs six of them is a month in which the invoicing went wrong; the cap is
 * on the volume, not on the correctness.
 */
const FREE_DOCS_PER_MONTH = 5;
const MAX_ITEMS = 200;
/** Guard against 1e308 arriving as a price and producing an unrepresentable total. */
const MAX_MINOR = 1e12;
const MAX_PARTY_NAME = 200;
const MAX_DESCRIPTION = 500;
const MAX_NOTES = 10000;
const MAX_ADDRESS = 2000;
const MAX_EMAIL = 320;
const MAX_VAT_ID = 64;
const MAX_REASON = 1000;
const gate = createLicenseGate({ product: "billing-docs" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
const str = (field, max) => z.string().max(max, `${field} must be ${max} characters or fewer`);
/**
 * Locks. Every mutation takes this server's lock. Anything that READS the invoice store
 * to build a credit note, or writes back to it, also takes the invoice server's lock, in
 * that order -- billing-docs, then invoice -- the same order servers/quotes and
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
 * the invoice, on the credit note that reverses it and on the purchase order. A missing
 * profile never blocks a document: it carries the placeholder issuer and the answer says so.
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
const amount = (what) => z.number().finite().min(-MAX_MINOR, `${what} is out of range`).max(MAX_MINOR, `${what} is out of range`);
const itemSchema = z.object({
    description: z.string().min(1, "every line needs a description")
        .max(MAX_DESCRIPTION, `a line description must be ${MAX_DESCRIPTION} characters or fewer`)
        .describe(`every line needs a description, ${MAX_DESCRIPTION} characters or fewer`),
    quantity: amount("quantity").gt(0, "quantity must be greater than zero").describe("Units ordered, must be greater than zero"),
    unit_price_minor: z.number().int("unit_price_minor must be a whole number of minor units (cents), e.g. 9000 for 90.00 EUR")
        .min(0, "unit_price_minor cannot be negative").max(MAX_MINOR, "unit_price_minor is out of range")
        .describe("Price per unit in MINOR units: 9000 = 90.00 EUR, 90 = JPY 90. Never a decimal"),
    tax_rate: z.number().finite().min(0).max(1000).optional().describe("VAT percent for this line, overrides the business default"),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
        .describe("Only to state the line's currency; every line on one document must agree"),
});
/** One currency per document. A mix is refused rather than added up under one heading. */
function resolveCurrency(items, stated, fallback) {
    const stated3 = stated?.toUpperCase();
    const lineCurrencies = [...new Set(items.map((i) => i.currency?.toUpperCase()).filter(Boolean))];
    if (lineCurrencies.length > 1) {
        throw new Error(`the line items carry more than one currency (${lineCurrencies.join(", ")}). ` +
            `One document is issued in ONE currency: convert the amounts yourself and pass every line in that currency.`);
    }
    const lineCurrency = lineCurrencies[0];
    if (stated3 && lineCurrency && stated3 !== lineCurrency) {
        throw new Error(`the document currency is ${stated3} but a line item says ${lineCurrency}. ` +
            `Every line must be in the document's currency; nothing was stored.`);
    }
    return stated3 ?? lineCurrency ?? fallback.toUpperCase();
}
/**
 * Totals come from the invoice engine's `computeTotals`, unchanged: same per-line
 * rounding, same one-tax-line-per-rate grouping, same integer arithmetic. This server
 * takes prices in MINOR units and the engine takes major, so the price is divided by
 * 10^decimals on the way in and every line is checked to have round-tripped before
 * anything is stored. There is no second copy of the VAT maths here.
 */
function totalsFor(items, currency, discountPercent, defaultTaxRate) {
    const f = Math.pow(10, currencyDecimals(currency));
    const engineItems = items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unit_price: i.unit_price_minor / f,
        tax_rate: i.tax_rate,
    }));
    const t = computeTotals(engineItems, currency, discountPercent, defaultTaxRate);
    for (let i = 0; i < t.lines.length; i++) {
        if (t.lines[i].unit_price_minor !== items[i].unit_price_minor) {
            throw new Error(`line ${i + 1} (${items[i].description}) does not round-trip: ${items[i].unit_price_minor} minor units ` +
                `came back as ${t.lines[i].unit_price_minor}. Nothing was stored.`);
        }
    }
    if (!Number.isSafeInteger(t.total_minor) || !Number.isSafeInteger(t.subtotal_minor)) {
        throw new Error("that document totals more than can be represented exactly in minor units. Nothing was stored.");
    }
    return t;
}
/* ------------------------------------------------------------- credit notes */
/**
 * A credit note line is the invoice line with every money field negated. The quantity
 * stays positive, so "10 x EUR -90.00 = EUR -900.00" reproduces on a calculator, and a
 * bookkeeper summing gross_minor over a period's documents gets the net of what was
 * billed without knowing which rows to flip.
 */
function negateLine(l) {
    return {
        ...l,
        unit_price_minor: -l.unit_price_minor,
        gross_minor: -l.gross_minor,
        discount_minor: -l.discount_minor,
        net_minor: -l.net_minor,
        tax_minor: -l.tax_minor,
        exact_gross_minor: -l.exact_gross_minor,
    };
}
/** Group a set of computed lines exactly the way `computeTotals` groups its own. */
function aggregate(lines) {
    const subtotal = lines.reduce((a, l) => a + l.gross_minor, 0);
    const discount = lines.reduce((a, l) => a + l.discount_minor, 0);
    const net = subtotal - discount;
    const byRate = new Map();
    for (const l of lines) {
        const cur = byRate.get(l.tax_rate) ?? { rate: l.tax_rate, base_minor: 0, tax_minor: 0 };
        cur.base_minor += l.net_minor;
        cur.tax_minor += l.tax_minor;
        byRate.set(l.tax_rate, cur);
    }
    const taxLines = [...byRate.values()].sort((a, b) => a.rate - b.rate);
    const tax = taxLines.reduce((a, t) => a + t.tax_minor, 0);
    return { subtotal_minor: subtotal, discount_minor: discount, net_minor: net, tax_lines: taxLines, tax_minor: tax, total_minor: net + tax };
}
function findInvoice(ref) {
    const needle = String(ref).trim().toLowerCase();
    const all = getInvoices();
    return all.find((i) => i.number.toLowerCase() === needle);
}
/** What this invoice has already been credited, in minor units, as a positive number. */
function creditedAgainst(number, notes = getCreditNotes()) {
    return notes.filter((c) => c.invoice_number === number).reduce((a, c) => a - c.total_minor, 0);
}
/**
 * The invoice engine's `Invoice` record has no `credited_minor` field (see
 * servers/invoice/src/store.ts). Rather than adding a field to a record another server
 * owns -- which would be written back by whichever of the two servers saved last -- the
 * credit note holds the link, and `credit_note_list {invoice}` is the query. If a later
 * version of the engine DOES carry the field, this keeps it in step instead of leaving a
 * stale number on the invoice: the field is written only when it is already present.
 */
function syncInvoiceCredited(inv, credited) {
    if (!("credited_minor" in inv))
        return false;
    const all = getInvoices();
    const row = all.find((i) => i.number === inv.number);
    if (!row || !("credited_minor" in row))
        return false;
    row.credited_minor = credited;
    setInvoices(all);
    return true;
}
/**
 * Split a gross amount across the invoice's VAT rates.
 *
 * Every rate on the invoice keeps its share of the credit, weighted by that rate's own
 * share of the invoice total (base + tax), so a partial credit against a mixed-rate
 * invoice never quietly credits it all at the highest rate. Two roundings are corrected:
 * the shares are made to sum to the requested amount exactly, and each share's net is
 * nudged by at most a couple of minor units so that `net + round(net * rate / 100)` --
 * the engine's own tax formula, not a second one -- reproduces the share.
 */
function apportion(inv, gross) {
    const buckets = inv.tax_lines.map((t) => ({ rate: t.rate, weight: t.base_minor + t.tax_minor }));
    const totalWeight = buckets.reduce((a, b) => a + b.weight, 0) || 1;
    const shares = buckets.map((b) => ({ rate: b.rate, share: Math.round(gross * b.weight / totalWeight) }));
    const drift = gross - shares.reduce((a, s) => a + s.share, 0);
    if (drift !== 0 && shares.length) {
        const biggest = shares.reduce((a, b) => (Math.abs(b.share) > Math.abs(a.share) ? b : a));
        biggest.share += drift;
    }
    const out = [];
    for (const s of shares) {
        if (s.share === 0)
            continue;
        let net = Math.round(s.share * 100 / (100 + s.rate));
        for (let k = 0; k < 4; k++) {
            const got = net + Math.round(net * s.rate / 100);
            if (got === s.share)
                break;
            net += got < s.share ? 1 : -1;
        }
        out.push({ rate: s.rate, net_minor: net });
    }
    return out;
}
/* ------------------------------------------------------------------ display */
function creditSummary(c) {
    return {
        id: c.id,
        invoice_number: c.invoice_number,
        client: c.client.name,
        issue_date: c.issue_date,
        basis: c.basis,
        currency: c.currency,
        total: formatMoney(c.total_minor, c.currency),
        total_minor: c.total_minor,
        reason: c.reason,
    };
}
function lineRows(lines, currency) {
    return lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: formatMoney(l.unit_price_minor, currency),
        unit_price_minor: l.unit_price_minor,
        tax_rate: `${l.tax_rate}%`,
        amount: formatMoney(l.gross_minor, currency),
    }));
}
function taxRows(taxLines, currency) {
    return taxLines.filter((t) => t.rate || t.tax_minor)
        .map((t) => `${t.rate}% on ${formatMoney(t.base_minor, currency)} = ${formatMoney(t.tax_minor, currency)}`);
}
function creditDetail(c) {
    return {
        ...creditSummary(c),
        invoice_total: formatMoney(c.invoice_total_minor, c.currency),
        invoice_issue_date: c.invoice_issue_date,
        lines: lineRows(c.lines, c.currency),
        subtotal: formatMoney(c.subtotal_minor, c.currency),
        discount: c.discount_minor ? `${c.discount_percent}% = ${formatMoney(c.discount_minor, c.currency)}` : undefined,
        tax: taxRows(c.tax_lines, c.currency),
        net: formatMoney(c.net_minor, c.currency),
        notes: c.notes,
        created: c.created,
    };
}
function poSummary(p) {
    return {
        id: p.id,
        supplier: p.supplier.name,
        issue_date: p.issue_date,
        expected_delivery_date: p.expected_delivery_date,
        status: p.status,
        currency: p.currency,
        total: formatMoney(p.total_minor, p.currency),
        total_minor: p.total_minor,
        received_date: p.received_date,
    };
}
function poDetail(p) {
    return {
        ...poSummary(p),
        buyer: p.buyer,
        supplier: p.supplier,
        lines: lineRows(p.lines, p.currency),
        subtotal: formatMoney(p.subtotal_minor, p.currency),
        discount: p.discount_minor ? `${p.discount_percent}% = ${formatMoney(p.discount_minor, p.currency)}` : undefined,
        tax: taxRows(p.tax_lines, p.currency),
        net: formatMoney(p.net_minor, p.currency),
        notes: p.notes,
        receipts: p.receipts,
        created: p.created,
        updated: p.updated,
    };
}
/** Documents of both kinds issued in one calendar month, which is what the free cap counts. */
function docsInMonth(month) {
    return getCreditNotes().filter((c) => c.issue_date.slice(0, 7) === month).length
        + getPurchaseOrders().filter((p) => p.issue_date.slice(0, 7) === month).length;
}
function capRefusal(month, toolName) {
    return `the free tier issues ${FREE_DOCS_PER_MONTH} documents a month (credit notes and purchase orders together) ` +
        `and ${month} already has ${docsInMonth(month)}. Nothing was stored. ` +
        gate.upgradeText("unlimited credit notes and purchase orders", toolName);
}
/* ------------------------------------------- duplicates and their dependents */
/**
 * A create tool that takes the same record twice writes two documents, and on free it
 * spends two of the five monthly slots on one order with no way back short of a licence
 * key (docs/DIST_R19_RESULT.md, finding 3). The second call is refused instead, naming
 * the document that is already there and the tool that removes it.
 *
 * The comparison is on the NORMALISED record, never on the raw arguments: text is
 * trimmed, its runs of whitespace collapsed and case-folded, the currency upper-cased,
 * money compared in minor units and dates as calendar dates. So " Widget  Co " and
 * "widget co" are one supplier, and a re-send of the same order is caught whatever the
 * caller's spacing. The id, the created timestamp and the branding flag are left out:
 * they are what the store adds, not what the caller asked for.
 */
const normText = (s) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function lineFingerprint(lines) {
    return lines
        .map((l) => [normText(l.description), l.quantity, l.unit_price_minor, l.tax_rate, l.gross_minor, l.net_minor, l.tax_minor].join("~"))
        .join("|");
}
function creditFingerprint(c) {
    return [
        normText(c.invoice_number), c.issue_date, c.currency.toUpperCase(), c.basis,
        normText(c.reason), normText(c.notes),
        c.total_minor, c.tax_minor, c.discount_percent, lineFingerprint(c.lines),
    ].join("\u0000");
}
function poFingerprint(p) {
    return [
        normText(p.supplier.name), normText(p.supplier.address), normText(p.supplier.email), normText(p.supplier.vat_id),
        p.issue_date, p.expected_delivery_date ?? "", p.currency.toUpperCase(), normText(p.notes),
        p.total_minor, p.tax_minor, p.discount_percent, lineFingerprint(p.lines),
    ].join("\u0000");
}
function duplicateRefusal(existing, kind, same, getTool, deleteTool) {
    return (`${existing} is already this ${kind}, field for field: ${same}. Nothing was written and no free-tier document slot was used. ` +
        `Read it with ${getTool} {id: "${existing}"}. If it is wrong, remove it with ${deleteTool} {id: "${existing}"} and issue it again.`);
}
/**
 * What a document has left behind that a delete cannot take back.
 *
 * Only the files the PDF tools write to their DEFAULT path can be seen from here: a
 * caller who passed `out_path` put the render somewhere this server never recorded, so
 * the refusal says where it looked.
 */
function exportedFiles(id) {
    const dir = join(dataDir(), "pdf");
    return ["pdf", "html", "htm"].map((ext) => join(dir, `${id}.${ext}`)).filter((f) => existsSync(f));
}
/**
 * A credit note is deletable while it is only a record here. It stops being one when it
 * has been POSTED -- `syncInvoiceCredited` has written `credited_minor` back onto the
 * invoice the engine owns -- or when it has been EXPORTED, because a rendered credit
 * note is a document a client may already hold and a deleted record cannot be shown
 * against it.
 */
function creditNoteDependents(c) {
    const out = [];
    const inv = getInvoices().find((i) => i.number === c.invoice_number);
    if (inv && "credited_minor" in inv && (inv.credited_minor ?? 0) !== 0) {
        out.push(`invoice ${inv.number} carries credited_minor ${inv.credited_minor}, so this credit note is posted against it`);
    }
    for (const f of exportedFiles(c.id))
        out.push(`${f} was rendered from it`);
    return out;
}
/**
 * A purchase order is deletable while nothing has come in against it: no receipt, full
 * or partial, and no render. A receipt is the record that goods arrived, and deleting
 * the order would delete that fact with it.
 */
function purchaseOrderDependents(p) {
    const out = [];
    if (p.receipts.length) {
        const last = p.receipts[p.receipts.length - 1];
        out.push(`${p.receipts.length} receipt${p.receipts.length === 1 ? "" : "s"} recorded against it, the last on ${last.date}` +
            `${last.note ? ` ("${last.note}")` : ""}`);
    }
    else if (p.status !== "open") {
        out.push(`its status is ${p.status}`);
    }
    for (const f of exportedFiles(p.id))
        out.push(`${f} was rendered from it`);
    return out;
}
function dependentRefusal(id, kind, deps, advice) {
    return (`${id} has ${deps.length === 1 ? "something" : "things"} depending on it: ${deps.join("; ")}. ` +
        `Nothing was removed. ${advice} ` +
        `A render under your own out_path is not visible from here, so only ${join(dataDir(), "pdf")} was checked for a ${kind} file.`);
}
/* ------------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-billing-docs", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.registerTool("credit_note_create", {
    title: "Credit an invoice",
    description: "Issue a credit note against one invoice: the whole invoice, a gross amount, or named lines with quantities. Line totals are stored negative in minor units and the invoice's VAT rates are reused.",
    inputSchema: {
        invoice: z.string().min(1, "invoice is required").describe("The invoice number to credit, e.g. INV-2026-0001"),
        reason: z.string().min(1, "reason is required").max(MAX_REASON, `reason must be ${MAX_REASON} characters or fewer`)
            .describe("Why the money is being given back, e.g. \"returned goods\" or \"billed twice\". Printed on the document"),
        amount_minor: z.number().int("amount_minor must be a whole number of minor units (cents)").positive("amount_minor must be greater than zero")
            .max(MAX_MINOR, "amount_minor is out of range").optional()
            .describe("Credit this GROSS amount, VAT included, in minor units. Split across the invoice's VAT rates in proportion to each rate's share of the total"),
        lines: z.array(z.object({
            line: z.number().int().positive().describe("1-based position of the line on the invoice, as shown by invoice_get"),
            quantity: amount("quantity").gt(0, "quantity must be greater than zero").optional().describe("Credit only this many units. Defaults to the whole line"),
        })).min(1).max(MAX_ITEMS).optional().describe("Credit only these invoice lines. Leave out with amount_minor for a full credit note"),
        issue_date: z.string().optional().describe("YYYY-MM-DD, defaults to today in your business profile's timezone"),
        notes: str("notes", MAX_NOTES).optional().describe("Free text printed under the totals"),
    },
}, async (a) => {
    try {
        return await lockedWithInvoice(() => {
            const day = today();
            const issue = a.issue_date ?? day;
            if (!isIsoDate(issue))
                return fail(`issue_date "${a.issue_date}" is not a real date in YYYY-MM-DD form.`);
            if (a.amount_minor !== undefined && a.lines) {
                return fail("pass amount_minor or lines, not both: they are two different ways of saying how much to credit. Nothing was stored.");
            }
            const notes = getCreditNotes();
            const inv = findInvoice(a.invoice);
            if (!inv) {
                const known = getInvoices().slice(-5).map((i) => i.number);
                return fail(`no invoice numbered "${a.invoice}" is in the invoice server's store. ` +
                    (known.length ? `The most recent are ${known.join(", ")}. ` : "That store is empty on this machine. ") +
                    `A credit note is always issued against an invoice, so nothing was stored.`);
            }
            const already = creditedAgainst(inv.number, notes);
            const remaining = inv.total_minor - already;
            let lines;
            let agg;
            let basis;
            let discountPercent = inv.discount_percent;
            if (a.lines) {
                basis = "lines";
                const seen = new Set();
                const picked = [];
                for (const sel of a.lines) {
                    if (sel.line > inv.lines.length) {
                        return fail(`${inv.number} has ${inv.lines.length} line(s), so there is no line ${sel.line}. Nothing was stored.`);
                    }
                    if (seen.has(sel.line))
                        return fail(`line ${sel.line} was given twice. Credit it once, with the total quantity. Nothing was stored.`);
                    seen.add(sel.line);
                    const src = inv.lines[sel.line - 1];
                    const qty = sel.quantity ?? src.quantity;
                    if (qty > src.quantity) {
                        return fail(`line ${sel.line} (${src.description}) was invoiced with a quantity of ${src.quantity}, so ${qty} cannot be credited. ` +
                            `Nothing was stored.`);
                    }
                    if (qty === src.quantity) {
                        // The whole line: COPY it. The client agreed to these numbers and the invoice
                        // printed them; recomputing from a rounded unit price is how a document and
                        // the credit note that reverses it come to differ by a cent.
                        picked.push({ ...src });
                    }
                    else {
                        const t = totalsFor([{ description: src.description, quantity: qty, unit_price_minor: src.unit_price_minor, tax_rate: src.tax_rate }], inv.currency, inv.discount_percent, src.tax_rate);
                        picked.push(t.lines[0]);
                    }
                }
                lines = picked;
                agg = aggregate(lines);
            }
            else if (a.amount_minor !== undefined) {
                basis = "amount";
                if (a.amount_minor > remaining) {
                    return fail(overCredit(inv, already, remaining, a.amount_minor));
                }
                const parts = apportion(inv, a.amount_minor);
                if (!parts.length) {
                    return fail(`${formatMoney(a.amount_minor, inv.currency)} is too small to split across ${inv.number}'s VAT rates. Nothing was stored.`);
                }
                const multi = parts.length > 1;
                const t = totalsFor(parts.map((p) => ({
                    description: `Credit against ${inv.number}${multi ? ` (VAT ${p.rate}%)` : ""}`,
                    quantity: 1, unit_price_minor: p.net_minor, tax_rate: p.rate,
                })), inv.currency, 0, 0);
                discountPercent = 0;
                lines = t.lines;
                agg = aggregate(lines);
            }
            else {
                basis = "full";
                // The whole invoice: its stored lines and its stored totals, copied and negated.
                lines = inv.lines.map((l) => ({ ...l }));
                agg = {
                    subtotal_minor: inv.subtotal_minor, discount_minor: inv.discount_minor, net_minor: inv.net_minor,
                    tax_lines: inv.tax_lines.map((t) => ({ ...t })), tax_minor: inv.tax_minor, total_minor: inv.total_minor,
                };
            }
            if (agg.total_minor > remaining) {
                return fail(overCredit(inv, already, remaining, agg.total_minor));
            }
            if (agg.total_minor <= 0)
                return fail("that credit note would be for nothing. Nothing was stored.");
            const c = {
                // Allocated below, once the record is known to be new and to fit the free cap:
                // nextDocId writes the counter, and a burnt number for a refused document is a
                // gap in the CN series a bookkeeper has to explain.
                id: "",
                invoice_number: inv.number,
                invoice_total_minor: inv.total_minor,
                invoice_issue_date: inv.issue_date,
                basis,
                client_id: inv.client_id,
                client: { ...inv.client },
                issue_date: issue,
                currency: inv.currency,
                decimals: inv.decimals,
                lines: lines.map(negateLine),
                subtotal_minor: -agg.subtotal_minor,
                discount_percent: discountPercent,
                discount_minor: -agg.discount_minor,
                net_minor: -agg.net_minor,
                tax_lines: agg.tax_lines.map((t) => ({ rate: t.rate, base_minor: -t.base_minor, tax_minor: -t.tax_minor })),
                tax_minor: -agg.tax_minor,
                total_minor: -agg.total_minor,
                reason: a.reason,
                notes: a.notes,
                created: new Date().toISOString(),
                branded: !gate.isPro(),
            };
            const dup = notes.find((x) => creditFingerprint(x) === creditFingerprint(c));
            if (dup) {
                return fail(duplicateRefusal(dup.id, "credit note", `same invoice ${dup.invoice_number}, same issue date ${dup.issue_date}, same reason, the same lines and the same ` +
                    `total ${formatMoney(dup.total_minor, dup.currency)}`, "credit_note_get", "credit_note_delete"));
            }
            if (!gate.isPro() && docsInMonth(issue.slice(0, 7)) >= FREE_DOCS_PER_MONTH) {
                return fail(capRefusal(issue.slice(0, 7), "credit_note_create"));
            }
            c.id = nextDocId("CN", issue.slice(0, 4), notes.map((n) => n.id));
            notes.push(c);
            setCreditNotes(notes);
            const creditedNow = already + agg.total_minor;
            const synced = syncInvoiceCredited(inv, creditedNow);
            const out = [];
            if (a.amount_minor !== undefined && agg.total_minor !== a.amount_minor) {
                out.push(`Asked for ${formatMoney(a.amount_minor, inv.currency)}, credited ${formatMoney(agg.total_minor, inv.currency)}: ` +
                    `the split across ${inv.number}'s VAT rates cannot land on the asked amount to the minor unit.`);
            }
            out.push(synced
                ? `${inv.number}'s credited_minor is now ${creditedNow}.`
                : `The link is held on the credit note, not on the invoice: the invoice engine's record has no credited_minor field, ` +
                    `so nothing in the invoice server's store was changed. credit_note_list {invoice: "${inv.number}"} is the query.`);
            if (businessMissing())
                out.push(NO_BUSINESS_NOTE);
            if (!gate.isPro()) {
                out.push(`Free tier: ${docsInMonth(issue.slice(0, 7))} of ${FREE_DOCS_PER_MONTH} documents used in ${issue.slice(0, 7)}. credit_note_pdf and billing_docs_report are Pro.`);
            }
            return json({
                created: creditDetail(c),
                invoice: {
                    number: inv.number,
                    total: formatMoney(inv.total_minor, inv.currency),
                    credited_total: formatMoney(creditedNow, inv.currency),
                    still_creditable: formatMoney(inv.total_minor - creditedNow, inv.currency),
                    still_creditable_minor: inv.total_minor - creditedNow,
                },
                notes: out,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
function overCredit(inv, already, remaining, asked) {
    return (`${inv.number} totals ${formatMoney(inv.total_minor, inv.currency)}` +
        (already ? ` and ${formatMoney(already, inv.currency)} of it has already been credited` : "") +
        `, so at most ${formatMoney(remaining, inv.currency)} can still be credited; this credit note is for ` +
        `${formatMoney(asked, inv.currency)}. A credit note that gives back more than was billed is a refund, not a credit note. ` +
        `Nothing was stored.`);
}
server.registerTool("credit_note_list", {
    title: "List credit notes",
    description: "Every credit note with its invoice, client, reason and negative total. Filter by invoice number, by client or by issue date range.",
    inputSchema: {
        invoice: z.string().optional().describe("Only credit notes issued against this invoice number"),
        client: z.string().optional().describe("Only credit notes for clients whose name contains this text"),
        from: z.string().optional().describe("YYYY-MM-DD, earliest issue date"),
        to: z.string().optional().describe("YYYY-MM-DD, latest issue date"),
    },
}, async (a) => {
    try {
        let list = getCreditNotes();
        if (a.invoice) {
            const needle = a.invoice.trim().toLowerCase();
            list = list.filter((c) => c.invoice_number.toLowerCase() === needle);
        }
        if (a.client) {
            const needle = a.client.trim().toLowerCase();
            list = list.filter((c) => c.client.name.toLowerCase().includes(needle));
        }
        if (a.from)
            list = list.filter((c) => c.issue_date >= a.from);
        if (a.to)
            list = list.filter((c) => c.issue_date <= a.to);
        list = [...list].sort((x, y) => y.issue_date.localeCompare(x.issue_date) || y.id.localeCompare(x.id));
        const byCurrency = new Map();
        for (const c of list)
            byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.total_minor);
        return json({
            count: list.length,
            credited: [...byCurrency.entries()].sort().map(([currency, minor]) => ({ currency, total: formatMoney(minor, currency), total_minor: minor })),
            credit_notes: list.map(creditSummary),
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("credit_note_get", {
    title: "Show one credit note",
    description: "The full stored record for one credit note: every negated line, the VAT lines, the totals, the reason and the invoice it was issued against.",
    inputSchema: { id: z.string().describe("Credit note id such as CN-2026-0001, or an exact client name") },
}, async (a) => {
    try {
        const c = findDoc(getCreditNotes(), a.id, (x) => x.id, (x) => x.client.name, "credit note");
        if (!c)
            return fail(`no credit note matches "${a.id}". Run credit_note_list to see the ids.`);
        return json(creditDetail(c));
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("credit_note_pdf", {
    title: "Render the credit note as a PDF",
    description: "Call this tool to write the A4 PDF of one credit note and return the file path. The invoice layout, titled CREDIT NOTE and carrying the invoice number it reverses. Pro.",
    inputSchema: {
        id: z.string().describe("Credit note id such as CN-2026-0001"),
        out_path: z.string().optional().describe("Where to write the file. Defaults to the billing-docs data directory under pdf/"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("credit note PDF", "credit_note_pdf"));
        const c = findDoc(getCreditNotes(), a.id, (x) => x.id, (x) => x.client.name, "credit note");
        if (!c)
            return fail(`no credit note matches "${a.id}". Run credit_note_list to see the ids.`);
        const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `${c.id}.pdf`);
        await renderDocPdf({
            title: "CREDIT NOTE",
            number: c.id,
            reference: `against invoice ${c.invoice_number}`,
            party_label: "CREDIT TO",
            party: c.client,
            meta: [["Issue date", c.issue_date], ["Invoice", c.invoice_number], ["Invoice date", c.invoice_issue_date]],
            currency: c.currency,
            lines: c.lines,
            subtotal_minor: c.subtotal_minor,
            discount_percent: c.discount_percent,
            discount_minor: c.discount_minor,
            net_minor: c.net_minor,
            tax_lines: c.tax_lines,
            total_minor: c.total_minor,
            footer_label: "REASON",
            footer_lines: [c.reason, `This credit note reduces invoice ${c.invoice_number} of ${c.invoice_issue_date}.`],
            notes: c.notes,
            product: "mcp-billing-docs",
        }, issuer(), out, { branded: !gate.isPro(), logo: gate.isPro() });
        return json({
            credit_note: c.id, path: out,
            document: /\.html?$/i.test(out) ? "HTML credit note (print to PDF)" : "PDF credit note",
            total: formatMoney(c.total_minor, c.currency),
            notes: businessMissing() ? [NO_BUSINESS_NOTE] : undefined,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("credit_note_text", {
    title: "Plain-text credit note to paste into email",
    description: "Turn a credit note into a plain-text summary with the negated line table, the VAT lines, the total and the invoice it reverses, ready to paste into an email. Free on every tier.",
    inputSchema: {
        id: z.string().describe("Credit note id such as CN-2026-0001"),
        greeting: z.string().optional().describe("Opening line, default \"Hello\" plus the client name"),
        sign_off: z.string().optional().describe("Closing line, default your business name from the shared profile"),
    },
}, async (a) => {
    try {
        const c = findDoc(getCreditNotes(), a.id, (x) => x.id, (x) => x.client.name, "credit note");
        if (!c)
            return fail(`no credit note matches "${a.id}". Run credit_note_list to see the ids.`);
        const biz = issuer();
        const out = [];
        out.push(a.greeting ?? `Hello ${c.client.name},`);
        out.push("");
        out.push(`Here is credit note ${c.id}, dated ${c.issue_date}, against invoice ${c.invoice_number} of ${c.invoice_issue_date}.`);
        out.push("");
        out.push(...bodyLines(c, "TOTAL CREDITED"));
        out.push("");
        out.push(`Reason: ${c.reason}`);
        if (c.notes) {
            out.push("");
            out.push(c.notes);
        }
        out.push("");
        out.push(`${formatMoney(-c.total_minor, c.currency)} comes off what is owed on ${c.invoice_number}.`);
        out.push("");
        out.push(a.sign_off ?? (biz.name === PLACEHOLDER_ISSUER ? "Best regards," : `Best regards,\n${biz.name}`));
        const text = out.join("\n");
        return ok(businessMissing() ? `${text}\n\n---\n${NO_BUSINESS_NOTE}` : text);
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("credit_note_delete", {
    title: "Delete a credit note",
    description: "Remove a credit note that was never posted to its invoice and never rendered to a file: the invoice becomes creditable again and the free monthly document slot comes back. One with a dependent is refused.",
    inputSchema: { id: z.string().describe("Credit note id such as CN-2026-0001, or an exact client name") },
}, async (a) => {
    try {
        return await lockedWithInvoice(() => {
            const list = getCreditNotes();
            const c = findDoc(list, a.id, (x) => x.id, (x) => x.client.name, "credit note");
            if (!c)
                return fail(`no credit note matches "${a.id}". Run credit_note_list to see the ids.`);
            const deps = creditNoteDependents(c);
            if (deps.length) {
                return fail(dependentRefusal(c.id, "credit note", deps, "A credit note that has been posted or sent to the client is undone by issuing a document against it, not by deleting the record."));
            }
            const month = c.issue_date.slice(0, 7);
            const kept = list.filter((x) => x.id !== c.id);
            setCreditNotes(kept);
            const inv = findInvoice(c.invoice_number);
            const stillCreditable = inv ? inv.total_minor - creditedAgainst(inv.number, kept) : undefined;
            const out = [
                `${c.id} is gone from the store. Its number is not handed out again: the CN series only counts up, so no two ` +
                    `documents can ever carry the same id.`,
            ];
            if (!gate.isPro()) {
                out.push(`Free tier: ${docsInMonth(month)} of ${FREE_DOCS_PER_MONTH} documents used in ${month}. The cap counts the ` +
                    `documents in the store, so the slot ${c.id} held is free again.`);
            }
            return json({
                deleted: creditSummary(c),
                invoice: inv ? {
                    number: inv.number,
                    still_creditable: formatMoney(stillCreditable, inv.currency),
                    still_creditable_minor: stillCreditable,
                } : undefined,
                notes: out,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/* --------------------------------------------------------- purchase orders */
server.registerTool("purchase_order_create", {
    title: "Raise a purchase order",
    description: "Order from a supplier: line items with quantity and unit price in minor units, VAT, a currency and an expected delivery date. You are the buyer, from the shared business profile.",
    inputSchema: {
        supplier: z.string().min(1, "supplier is required").max(MAX_PARTY_NAME, `supplier must be ${MAX_PARTY_NAME} characters or fewer`)
            .describe("Supplier name or client id. A name the invoice server already knows brings its address, email and VAT id onto the order"),
        items: z.array(itemSchema).min(1, "a purchase order needs at least one line item").max(MAX_ITEMS, `a purchase order can carry at most ${MAX_ITEMS} line items`).describe("What is being ordered"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional().describe("Defaults to your business default currency"),
        expected_delivery_date: z.string().optional().describe("YYYY-MM-DD, when the goods or work are due"),
        issue_date: z.string().optional().describe("YYYY-MM-DD, defaults to today in your business profile's timezone"),
        discount_percent: z.number().finite().min(0).max(100).optional().describe("Discount applied to every line, in percent"),
        tax_rate: z.number().finite().min(0).max(1000).optional().describe("VAT percent for lines with no rate of their own. Defaults to the business default"),
        notes: str("notes", MAX_NOTES).optional().describe("Free text printed under the totals, e.g. delivery address or terms"),
        supplier_email: str("supplier_email", MAX_EMAIL).optional().describe("Only if the user gave it; otherwise the stored client's email is used"),
        supplier_address: str("supplier_address", MAX_ADDRESS).optional().describe("Postal address for the SUPPLIER block, newlines allowed"),
        supplier_vat_id: str("supplier_vat_id", MAX_VAT_ID).optional().describe("Supplier VAT / tax registration id"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const issue = a.issue_date ?? day;
            if (!isIsoDate(issue))
                return fail(`issue_date "${a.issue_date}" is not a real date in YYYY-MM-DD form.`);
            if (a.expected_delivery_date !== undefined && !isIsoDate(a.expected_delivery_date)) {
                return fail(`expected_delivery_date "${a.expected_delivery_date}" is not a real date in YYYY-MM-DD form.`);
            }
            if (a.expected_delivery_date !== undefined && a.expected_delivery_date < issue) {
                return fail(`expected_delivery_date ${a.expected_delivery_date} is before the order date ${issue}. Nothing was stored.`);
            }
            const biz = issuer();
            const currency = resolveCurrency(a.items, a.currency, biz.default_currency);
            const totals = totalsFor(a.items, currency, a.discount_percent ?? 0, a.tax_rate ?? biz.default_tax_rate);
            const stored = findClient(a.supplier);
            const list = getPurchaseOrders();
            const p = {
                // Allocated below, after the duplicate and cap checks, for the same reason as
                // the CN series: nextDocId writes the counter, so a refused order must not burn
                // a number.
                id: "",
                buyer: { name: biz.name, address: biz.address, email: biz.email, vat_id: biz.vat_id },
                supplier_client_id: stored?.id,
                supplier: {
                    name: stored?.name ?? a.supplier.trim(),
                    address: a.supplier_address ?? stored?.address,
                    email: a.supplier_email ?? stored?.email,
                    vat_id: a.supplier_vat_id ?? stored?.vat_id,
                },
                issue_date: issue,
                expected_delivery_date: a.expected_delivery_date,
                currency,
                decimals: totals.decimals,
                lines: totals.lines,
                subtotal_minor: totals.subtotal_minor,
                discount_percent: totals.discount_percent,
                discount_minor: totals.discount_minor,
                net_minor: totals.net_minor,
                tax_lines: totals.tax_lines,
                tax_minor: totals.tax_minor,
                total_minor: totals.total_minor,
                notes: a.notes,
                status: "open",
                receipts: [],
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
                branded: !gate.isPro(),
            };
            const dup = list.find((x) => poFingerprint(x) === poFingerprint(p));
            if (dup) {
                return fail(duplicateRefusal(dup.id, "purchase order", `same supplier ${dup.supplier.name}, same order date ${dup.issue_date}, the same lines and the same ` +
                    `total ${formatMoney(dup.total_minor, dup.currency)}`, "purchase_order_get", "purchase_order_delete"));
            }
            if (!gate.isPro() && docsInMonth(issue.slice(0, 7)) >= FREE_DOCS_PER_MONTH) {
                return fail(capRefusal(issue.slice(0, 7), "purchase_order_create"));
            }
            p.id = nextDocId("PO", issue.slice(0, 4), list.map((x) => x.id));
            list.push(p);
            setPurchaseOrders(list);
            const out = [];
            if (businessMissing()) {
                out.push("No business profile yet, so this order names a placeholder BUYER. A supplier cannot ship against that: " +
                    "run business_set {name, address, vat_id} in the invoice server (mcp-invoice) and render again.");
            }
            if (!stored) {
                out.push(`"${p.supplier.name}" is not a stored record, so the SUPPLIER block has ${p.supplier.address ? "the address you gave" : "no address"}. ` +
                    `client_add in the invoice server stores it once for every later document.`);
            }
            if (!gate.isPro()) {
                out.push(`Free tier: ${docsInMonth(issue.slice(0, 7))} of ${FREE_DOCS_PER_MONTH} documents used in ${issue.slice(0, 7)}. purchase_order_pdf and billing_docs_report are Pro.`);
            }
            return json({ created: poDetail(p), notes: out.length ? out : undefined });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_list", {
    title: "List purchase orders",
    description: "Every purchase order with its supplier, total, expected delivery date and status (open, partially received or received). Filter by status, by supplier or by order date range.",
    inputSchema: {
        status: z.enum(["open", "partially_received", "received", "all"]).optional().describe('Default "all"'),
        supplier: z.string().optional().describe("Only orders to suppliers whose name contains this text"),
        from: z.string().optional().describe("YYYY-MM-DD, earliest order date"),
        to: z.string().optional().describe("YYYY-MM-DD, latest order date"),
    },
}, async (a) => {
    try {
        let list = getPurchaseOrders();
        if (a.status && a.status !== "all")
            list = list.filter((p) => p.status === a.status);
        if (a.supplier) {
            const needle = a.supplier.trim().toLowerCase();
            list = list.filter((p) => p.supplier.name.toLowerCase().includes(needle));
        }
        if (a.from)
            list = list.filter((p) => p.issue_date >= a.from);
        if (a.to)
            list = list.filter((p) => p.issue_date <= a.to);
        list = [...list].sort((x, y) => y.issue_date.localeCompare(x.issue_date) || y.id.localeCompare(x.id));
        return json({ count: list.length, purchase_orders: list.map(poSummary) });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_get", {
    title: "Show one purchase order",
    description: "The full stored record for one purchase order: the buyer and supplier blocks, every line with its unit price and VAT, the totals, the expected delivery date and what has been received.",
    inputSchema: { id: z.string().describe("Purchase order id such as PO-2026-0001, or an exact supplier name") },
}, async (a) => {
    try {
        const p = findDoc(getPurchaseOrders(), a.id, (x) => x.id, (x) => x.supplier.name, "purchase order");
        if (!p)
            return fail(`no purchase order matches "${a.id}". Run purchase_order_list to see the ids.`);
        return json(poDetail(p));
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_pdf", {
    title: "Render the purchase order as a PDF",
    description: "Call this tool to write the A4 PDF of one purchase order and return the file path. The invoice layout, titled PURCHASE ORDER, with the buyer, the supplier and the delivery date. Pro.",
    inputSchema: {
        id: z.string().describe("Purchase order id such as PO-2026-0001"),
        out_path: z.string().optional().describe("Where to write the file. Defaults to the billing-docs data directory under pdf/"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("purchase order PDF", "purchase_order_pdf"));
        const p = findDoc(getPurchaseOrders(), a.id, (x) => x.id, (x) => x.supplier.name, "purchase order");
        if (!p)
            return fail(`no purchase order matches "${a.id}". Run purchase_order_list to see the ids.`);
        const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `${p.id}.pdf`);
        const meta = [["Order date", p.issue_date], ["Status", p.status.replace(/_/g, " ").toUpperCase()]];
        if (p.expected_delivery_date)
            meta.splice(1, 0, ["Delivery by", p.expected_delivery_date]);
        const footer = [
            p.expected_delivery_date ? `Deliver by ${p.expected_delivery_date}.` : "No delivery date agreed.",
            `Quote ${p.id} on the delivery note and on your invoice.`,
        ];
        if (p.received_date)
            footer.push(`Received ${p.received_date}.`);
        await renderDocPdf({
            title: "PURCHASE ORDER",
            number: p.id,
            party_label: "SUPPLIER",
            party: p.supplier,
            meta,
            currency: p.currency,
            lines: p.lines,
            subtotal_minor: p.subtotal_minor,
            discount_percent: p.discount_percent,
            discount_minor: p.discount_minor,
            net_minor: p.net_minor,
            tax_lines: p.tax_lines,
            total_minor: p.total_minor,
            footer_label: "DELIVERY",
            footer_lines: footer,
            notes: p.notes,
            product: "mcp-billing-docs",
        }, issuer(), out, { branded: !gate.isPro(), logo: gate.isPro() });
        return json({
            purchase_order: p.id, path: out,
            document: /\.html?$/i.test(out) ? "HTML purchase order (print to PDF)" : "PDF purchase order",
            total: formatMoney(p.total_minor, p.currency),
            notes: businessMissing() ? [NO_BUSINESS_NOTE] : undefined,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_text", {
    title: "Plain-text purchase order to paste into email",
    description: "Turn a purchase order into a plain-text summary with the line table, the VAT lines, the total and the delivery date, ready to paste into an email to the supplier. Free on every tier.",
    inputSchema: {
        id: z.string().describe("Purchase order id such as PO-2026-0001"),
        greeting: z.string().optional().describe("Opening line, default \"Hello\" plus the supplier name"),
        sign_off: z.string().optional().describe("Closing line, default your business name from the shared profile"),
    },
}, async (a) => {
    try {
        const p = findDoc(getPurchaseOrders(), a.id, (x) => x.id, (x) => x.supplier.name, "purchase order");
        if (!p)
            return fail(`no purchase order matches "${a.id}". Run purchase_order_list to see the ids.`);
        const biz = issuer();
        const out = [];
        out.push(a.greeting ?? `Hello ${p.supplier.name},`);
        out.push("");
        out.push(`Please treat this as purchase order ${p.id}, dated ${p.issue_date}.`);
        out.push("");
        out.push(...bodyLines(p, "TOTAL"));
        out.push("");
        out.push(p.expected_delivery_date
            ? `Please deliver by ${p.expected_delivery_date} and quote ${p.id} on the delivery note and your invoice.`
            : `Please quote ${p.id} on the delivery note and your invoice.`);
        if (p.notes) {
            out.push("");
            out.push(p.notes);
        }
        out.push("");
        out.push(a.sign_off ?? (biz.name === PLACEHOLDER_ISSUER ? "Best regards," : `Best regards,\n${biz.name}`));
        const text = out.join("\n");
        return ok(businessMissing() ? `${text}\n\n---\n${NO_BUSINESS_NOTE}` : text);
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_receive", {
    title: "Mark a purchase order received",
    description: "Record that a purchase order arrived, in full or in part. A partial receipt keeps the order open and is kept on the record with its date and note; a full receipt closes it.",
    inputSchema: {
        id: z.string().describe("Purchase order id such as PO-2026-0001"),
        partial: z.boolean().optional().describe("True when only some of the order arrived. The order stays open and can be received again. Default false"),
        date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
        note: str("note", MAX_NOTES).optional().describe("What arrived, e.g. \"8 of 10 units, 2 back-ordered\""),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const list = getPurchaseOrders();
            const p = findDoc(list, a.id, (x) => x.id, (x) => x.supplier.name, "purchase order");
            if (!p)
                return fail(`no purchase order matches "${a.id}". Run purchase_order_list to see the ids.`);
            if (p.status === "received") {
                return fail(`${p.id} was already received in full on ${p.received_date}. Marking it again would say the goods arrived twice, ` +
                    `so nothing was changed. Raise a new order if more was delivered.`);
            }
            const when = a.date ?? day;
            if (!isIsoDate(when))
                return fail(`date "${a.date}" is not a real date in YYYY-MM-DD form.`);
            if (when < p.issue_date)
                return fail(`${when} is before the order date ${p.issue_date}. Nothing was changed.`);
            const partial = a.partial === true;
            p.receipts.push({ date: when, partial, note: a.note });
            p.status = partial ? "partially_received" : "received";
            if (!partial)
                p.received_date = when;
            p.updated = new Date().toISOString();
            setPurchaseOrders(list);
            return json({
                received: poSummary(p),
                receipts: p.receipts,
                note: partial
                    ? `${p.id} stays open: a partial receipt is on the record and the order can be received again.`
                    : `${p.id} is closed. Its full value is out of the open-orders figure in billing_docs_report.`,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("purchase_order_delete", {
    title: "Delete a purchase order",
    description: "Remove a purchase order with nothing received against it that was never rendered to a file: the free monthly document slot comes back. An order with a receipt is refused, naming that receipt.",
    inputSchema: { id: z.string().describe("Purchase order id such as PO-2026-0001, or an exact supplier name") },
}, async (a) => {
    try {
        return await locked(() => {
            const list = getPurchaseOrders();
            const p = findDoc(list, a.id, (x) => x.id, (x) => x.supplier.name, "purchase order");
            if (!p)
                return fail(`no purchase order matches "${a.id}". Run purchase_order_list to see the ids.`);
            const deps = purchaseOrderDependents(p);
            if (deps.length) {
                return fail(dependentRefusal(p.id, "purchase order", deps, "An order that has already been delivered against stays on the record; raise a credit note or a new order for what changed."));
            }
            const month = p.issue_date.slice(0, 7);
            setPurchaseOrders(list.filter((x) => x.id !== p.id));
            const out = [
                `${p.id} is gone from the store and out of the open-orders figure in billing_docs_report. Its number is not handed ` +
                    `out again: the PO series only counts up.`,
            ];
            if (!gate.isPro()) {
                out.push(`Free tier: ${docsInMonth(month)} of ${FREE_DOCS_PER_MONTH} documents used in ${month}. The cap counts the ` +
                    `documents in the store, so the slot ${p.id} held is free again.`);
            }
            return json({ deleted: poSummary(p), notes: out });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("billing_docs_report", {
    title: "Credited money and open orders",
    description: "What has been credited back per currency, against how many invoices, and what is still on order per currency, with the purchase orders whose delivery date has passed. Pro.",
    inputSchema: {
        from: z.string().optional().describe("YYYY-MM-DD, earliest document date to count"),
        to: z.string().optional().describe("YYYY-MM-DD, latest document date to count"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("the credited and open-orders report", "billing_docs_report"));
        const day = today();
        const inRange = (d) => (!a.from || d >= a.from) && (!a.to || d <= a.to);
        const notes = getCreditNotes().filter((c) => inRange(c.issue_date));
        const orders = getPurchaseOrders().filter((p) => inRange(p.issue_date));
        const credited = new Map();
        for (const c of notes) {
            const b = credited.get(c.currency) ?? { count: 0, total_minor: 0, invoices: new Set() };
            b.count += 1;
            b.total_minor += c.total_minor;
            b.invoices.add(c.invoice_number);
            credited.set(c.currency, b);
        }
        const open = orders.filter((p) => p.status !== "received");
        const onOrder = new Map();
        for (const p of open) {
            const b = onOrder.get(p.currency) ?? { count: 0, total_minor: 0 };
            b.count += 1;
            b.total_minor += p.total_minor;
            onOrder.set(p.currency, b);
        }
        const overdue = open
            .filter((p) => p.expected_delivery_date && p.expected_delivery_date < day)
            .sort((x, y) => (x.expected_delivery_date ?? "").localeCompare(y.expected_delivery_date ?? ""))
            .map((p) => ({ ...poSummary(p), days_late: Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${p.expected_delivery_date}T00:00:00Z`)) / 86400000) }));
        return json({
            as_of: day,
            from: a.from, to: a.to,
            credit_notes: notes.length,
            credited_by_currency: [...credited.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([currency, b]) => ({
                currency, credit_notes: b.count, invoices_credited: b.invoices.size,
                credited: formatMoney(b.total_minor, currency), credited_minor: b.total_minor,
            })),
            purchase_orders: orders.length,
            open_purchase_orders: open.length,
            on_order_by_currency: [...onOrder.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([currency, b]) => ({
                currency, orders: b.count, on_order: formatMoney(b.total_minor, currency), on_order_minor: b.total_minor,
            })),
            overdue_deliveries: overdue,
            basis: "Credited totals are negative, the sign they are stored with. An order counts as on order until it is received in full; a partial receipt does not reduce it, because how much arrived is a note, not a quantity.",
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
gate.registerTools(server);
/* ------------------------------------------------------ resource and prompt */
server.registerResource("open-purchase-orders", "billing-docs://open-orders", {
    title: "Open purchase orders",
    description: "Every purchase order that has not been received in full, as JSON.",
    mimeType: "application/json",
}, async () => {
    const open = getPurchaseOrders().filter((p) => p.status !== "received").map(poSummary);
    return { contents: [{ uri: "billing-docs://open-orders", mimeType: "application/json", text: JSON.stringify(open, null, 2) }] };
});
server.registerPrompt("chase_deliveries", {
    title: "Chase the late deliveries",
    description: "Review which purchase orders are late, then draft the chaser to each supplier.",
    argsSchema: {},
}, () => ({
    messages: [{
            role: "user",
            content: {
                type: "text",
                text: [
                    "1. Call purchase_order_list with status \"open\" and list them by expected delivery date.",
                    "2. Name every order whose delivery date has already passed, with how late it is.",
                    "3. For the latest one, call purchase_order_text and draft a short chaser around it.",
                    "4. Tell me which suppliers to chase today and what to say, in one line each.",
                ].join("\n"),
            },
        }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-billing-docs ready\n");
