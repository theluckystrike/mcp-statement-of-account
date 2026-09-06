import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PDFDocument from "pdfkit";
import { formatMoney } from "@theluckystrike/mcp-invoice/lib";
/**
 * The A4 invoice renderer, with the title as an argument.
 *
 * `renderInvoicePdf` in servers/invoice/src/pdf.ts hardcodes "INVOICE" in the header, in
 * the PDF metadata and in the running footer, and takes an `Invoice`, whose `due_date`,
 * `status` and `paid_minor` a credit note and a purchase order do not have. Everything
 * else about the page -- the geometry, the column stops, the fonts, the totals block, the
 * page-break rule and the "every money value carries its currency code" rule -- is the
 * part a reader recognises, so it is reproduced here exactly rather than approximated: a
 * credit note that does not look like the invoice it reverses is harder to match up.
 *
 * The document-specific parts are arguments: the title, the reference line under it, the
 * label on the party block, the date rows on the right, and the block that stands where
 * the invoice prints PAYMENT DETAILS.
 */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const CONTENT_W = PAGE_W - M * 2;
const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";
const COLS = { desc: M, qty: M + 196, unit: M + 244, tax: M + 336, amount: M + 381 };
const COL_W = { desc: 190, qty: 44, unit: 88, tax: 41 };
const RIGHT_EDGE = PAGE_W - M;
function money(minor, currency) { return formatMoney(minor, currency); }
function qtyText(q) {
    return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4)));
}
export async function renderDocPdf(d, biz, outPath, opts) {
    mkdirSync(dirname(outPath), { recursive: true });
    const label = `${d.title.charAt(0)}${d.title.slice(1).toLowerCase()} ${d.number}`;
    const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: {
            Title: label, Author: biz.name || d.title, Subject: label,
        } });
    const stream = createWriteStream(outPath);
    /**
     * The settled promise is built BEFORE the first byte is written, for the reason
     * measured in docs/QUOTES_RESULT.md: a path the process cannot open emits "error" on
     * the stream, and a listener attached one macrotask later is already too late -- the
     * error is unhandled, it takes the process down, and the client sees no response at
     * all rather than a refusal it can read.
     */
    const written = new Promise((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
    });
    doc.pipe(stream);
    let y = M;
    let headerLeftBottom = y;
    if (opts.logo && biz.logo_path && existsSync(biz.logo_path)) {
        try {
            doc.image(biz.logo_path, M, y, { fit: [140, 55] });
            headerLeftBottom = y + 55;
        }
        catch {
            headerLeftBottom = y;
        }
    }
    if (headerLeftBottom === y) {
        doc.font("Helvetica-Bold").fontSize(18).fillColor(INK)
            .text(biz.name || d.title, M, y, { width: 300 });
        headerLeftBottom = doc.y;
    }
    doc.font("Helvetica-Bold").fontSize(24).fillColor(INK)
        .text(d.title, M + 300, y, { width: CONTENT_W - 300, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
        .text(d.number, M + 300, doc.y + 2, { width: CONTENT_W - 300, align: "right" });
    if (d.reference) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED)
            .text(d.reference, M + 300, doc.y + 2, { width: CONTENT_W - 300, align: "right" });
    }
    const headerRightBottom = doc.y;
    y = Math.max(headerLeftBottom, headerRightBottom) + 20;
    const issuerLines = [];
    if (opts.logo && biz.logo_path && existsSync(biz.logo_path) && biz.name)
        issuerLines.push(biz.name);
    if (biz.address)
        issuerLines.push(biz.address);
    if (biz.email)
        issuerLines.push(biz.email);
    if (biz.vat_id)
        issuerLines.push(`VAT ID: ${biz.vat_id}`);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
        .text(issuerLines.join("\n"), M, y, { width: 260 });
    const issuerBottom = doc.y;
    let dy = y;
    for (const [k, v] of d.meta) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, M + 300, dy, { width: 110 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
            .text(v, M + 300, dy, { width: CONTENT_W - 300, align: "right" });
        dy += 14;
    }
    y = Math.max(issuerBottom, dy) + 22;
    // An empty party_label means the document has no second party (a price list is issued, not addressed):
    // the issuer block above already names the business, so the party block is skipped rather than repeated.
    if (d.party_label !== "") {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(d.party_label, M, y);
        y = doc.y + 4;
        const party = [d.party.name];
        if (d.party.address)
            party.push(d.party.address);
        if (d.party.email)
            party.push(d.party.email);
        if (d.party.vat_id)
            party.push(`VAT ID: ${d.party.vat_id}`);
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(party[0], M, y, { width: 300 });
        if (party.length > 1) {
            doc.font("Helvetica").fontSize(9).fillColor(MUTED)
                .text(party.slice(1).join("\n"), M, doc.y + 2, { width: 300 });
        }
        y = doc.y + 24;
    }
    const drawTableHead = (top) => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED);
        doc.text("DESCRIPTION", COLS.desc, top, { width: COL_W.desc });
        doc.text("QTY", COLS.qty, top, { width: COL_W.qty, align: "right" });
        doc.text("UNIT", COLS.unit, top, { width: COL_W.unit, align: "right" });
        doc.text("TAX", COLS.tax, top, { width: COL_W.tax, align: "right" });
        doc.text("AMOUNT", COLS.amount, top, { width: RIGHT_EDGE - COLS.amount, align: "right" });
        const b = top + 14;
        doc.moveTo(M, b).lineTo(RIGHT_EDGE, b).lineWidth(0.8).strokeColor(RULE).stroke();
        return b + 8;
    };
    y = drawTableHead(y);
    const pageBottom = PAGE_H - M - 60;
    doc.font("Helvetica").fontSize(9);
    for (const l of d.lines) {
        const h = Math.max(doc.heightOfString(l.description, { width: COL_W.desc }), 11);
        if (y + h > pageBottom) {
            doc.addPage();
            y = drawTableHead(M);
            doc.font("Helvetica").fontSize(9);
        }
        doc.fillColor(INK).text(l.description, COLS.desc, y, { width: COL_W.desc });
        doc.text(qtyText(l.quantity), COLS.qty, y, { width: COL_W.qty, align: "right" });
        doc.text(money(l.unit_price_minor, d.currency), COLS.unit, y, { width: COL_W.unit, align: "right" });
        doc.text(l.tax_rate ? `${l.tax_rate}%` : "-", COLS.tax, y, { width: COL_W.tax, align: "right" });
        doc.text(money(l.gross_minor, d.currency), COLS.amount, y, { width: RIGHT_EDGE - COLS.amount, align: "right" });
        y += h + 8;
        doc.moveTo(M, y - 4).lineTo(RIGHT_EDGE, y - 4).lineWidth(0.4).strokeColor("#eeeeee").stroke();
    }
    const totalsTop = y + 10;
    if (totalsTop > pageBottom - 90) {
        doc.addPage();
        y = M;
    }
    else {
        y = totalsTop;
    }
    const labelX = M + 215;
    const labelW = 175;
    const valX = labelX + labelW + 5;
    const valW = RIGHT_EDGE - valX;
    const row = (l, value, bold = false) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9)
            .fillColor(bold ? INK : MUTED).text(l, labelX, y, { width: labelW, align: "right" });
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK)
            .text(value, valX, y, { width: valW, align: "right" });
        y += bold ? 18 : 14;
    };
    row("Subtotal", money(d.subtotal_minor, d.currency));
    if (d.discount_minor) {
        row(`Discount ${d.discount_percent}%`, `-${money(Math.abs(d.discount_minor), d.currency)}`);
        row("Net", money(d.net_minor, d.currency));
    }
    for (const t of d.tax_lines) {
        if (!t.rate && !t.tax_minor)
            continue;
        row(`Tax ${t.rate}% on ${money(t.base_minor, d.currency)}`, money(t.tax_minor, d.currency));
    }
    doc.moveTo(labelX, y + 2).lineTo(RIGHT_EDGE, y + 2).lineWidth(0.8).strokeColor(RULE).stroke();
    y += 8;
    row("Total", money(d.total_minor, d.currency), true);
    y += 16;
    if (d.footer_lines.length) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(d.footer_label, M, y);
        doc.font("Helvetica").fontSize(9).fillColor(INK).text(d.footer_lines.join("\n"), M, doc.y + 4, { width: 320 });
        y = doc.y + 12;
    }
    if (d.notes) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", M, y);
        doc.font("Helvetica").fontSize(9).fillColor(INK).text(d.notes, M, doc.y + 4, { width: CONTENT_W });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const fy = PAGE_H - M - 24;
        doc.moveTo(M, fy - 8).lineTo(RIGHT_EDGE, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`${biz.name || ""}${biz.vat_id ? "  |  VAT ID " + biz.vat_id : ""}`, M, fy, { width: 300 });
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`${label}  |  page ${i - range.start + 1} of ${range.count}`, M + 300, fy, { width: CONTENT_W - 300, align: "right" });
        if (opts.branded) {
            doc.font("Helvetica").fontSize(7).fillColor("#999999")
                .text(`Generated with ${d.product} by theluckystrike`, M, fy + 11, { width: CONTENT_W, align: "center" });
        }
    }
    doc.end();
    await written;
    return outPath;
}
