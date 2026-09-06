import { type ComputedLine, type TaxLine } from "@theluckystrike/mcp-invoice/lib";
/**
 * The pasteable plain-text body, shared by credit_note_text and purchase_order_text.
 *
 * The totals block right-aligns its LABEL against a column computed from the line layout
 * rather than against the description width, so the amount column lands in the same place
 * whatever the descriptions are. That is the alignment defect fixed in servers/quotes
 * (docs/QUOTES_RESULT.md): padding the totals against the description column pushed
 * "VAT 23% on EUR 1800.00" twelve characters right of the line amounts in the email.
 */
export interface TextDoc {
    currency: string;
    lines: ComputedLine[];
    subtotal_minor: number;
    discount_percent: number;
    discount_minor: number;
    net_minor: number;
    tax_lines: TaxLine[];
    total_minor: number;
}
export declare function bodyLines(d: TextDoc, totalLabel: string): string[];
