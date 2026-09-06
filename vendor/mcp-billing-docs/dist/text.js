import { formatMoney } from "@theluckystrike/mcp-invoice/lib";
const pad = (s, n) => s.length >= n ? s : s + " ".repeat(n - s.length);
const padL = (s, n) => s.length >= n ? s : " ".repeat(n - s.length) + s;
export function bodyLines(d, totalLabel) {
    const cur = d.currency;
    const descW = Math.min(40, Math.max(12, ...d.lines.map((l) => l.description.length)));
    const rows = d.lines.map((l) => `  ${pad(l.description.slice(0, descW), descW)}  ${padL(String(l.quantity), 6)} x ${padL(formatMoney(l.unit_price_minor, cur), 14)}  ${padL(formatMoney(l.gross_minor, cur), 14)}`);
    const labels = ["Subtotal", totalLabel, `Discount ${d.discount_percent}%`, "Net",
        ...d.tax_lines.map((t) => `VAT ${t.rate}% on ${formatMoney(t.base_minor, cur)}`)];
    const labelW = Math.max(descW + 25, ...labels.map((s) => s.length));
    const totalRow = (label, value) => `  ${padL(label, labelW)}  ${padL(value, 14)}`;
    const out = [...rows, ""];
    out.push(totalRow("Subtotal", formatMoney(d.subtotal_minor, cur)));
    if (d.discount_minor) {
        out.push(totalRow(`Discount ${d.discount_percent}%`, formatMoney(-d.discount_minor, cur)));
        out.push(totalRow("Net", formatMoney(d.net_minor, cur)));
    }
    for (const t of d.tax_lines) {
        if (!t.rate && !t.tax_minor)
            continue;
        out.push(totalRow(`VAT ${t.rate}% on ${formatMoney(t.base_minor, cur)}`, formatMoney(t.tax_minor, cur)));
    }
    out.push(totalRow(totalLabel, formatMoney(d.total_minor, cur)));
    return out;
}
