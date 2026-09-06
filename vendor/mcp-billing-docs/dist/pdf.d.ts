import { type Business, type ComputedLine, type TaxLine } from "@theluckystrike/mcp-invoice/lib";
/** Everything the page needs that is not the business profile. */
export interface RenderDoc {
    /** Printed at 24pt on the right of the header, e.g. "CREDIT NOTE". */
    title: string;
    /** This document's own number, printed under the title. */
    number: string;
    /** Second reference line under the number, e.g. "against invoice INV-2026-0001". */
    reference?: string;
    party_label: string;
    party: {
        name: string;
        address?: string;
        email?: string;
        vat_id?: string;
    };
    /** Label / value rows on the right of the issuer block. */
    meta: [string, string][];
    currency: string;
    lines: ComputedLine[];
    subtotal_minor: number;
    discount_percent: number;
    discount_minor: number;
    net_minor: number;
    tax_lines: TaxLine[];
    total_minor: number;
    /** The block where the invoice prints PAYMENT DETAILS. */
    footer_label: string;
    footer_lines: string[];
    notes?: string;
    /** Named in the free-tier footer credit and in the PDF metadata. */
    product: string;
}
export interface RenderOptions {
    branded: boolean;
    logo: boolean;
}
export declare function renderDocPdf(d: RenderDoc, biz: Business, outPath: string, opts: RenderOptions): Promise<string>;
