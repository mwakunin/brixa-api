import type { Content } from "pdfmake/interfaces";

import { describe, expect, it } from "vitest";

import type { IssuedDocument } from "./documents";

import { documentContentSchema } from "./document-content";
import { documentDefinition } from "./document-pdf";
import { renderPdf } from "./pdf";
import { verificationUrl } from "./verification";

const CODE = "abcdefghijklmnopqrstuvwxyzA";

function receipt(overrides: Partial<IssuedDocument> = {}, rows = 2): IssuedDocument {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    facilityId: "00000000-0000-4000-8000-000000000002",
    kind: "receipt",
    number: "RCT-2026-0001",
    verificationCode: CODE,
    content: documentContentSchema.parse({
      issuer: { name: "Amani Hospital", kmhfrCode: "12345", county: "Nakuru" },
      title: "Receipt",
      fields: [{ label: "Received from", value: "Wanjiru Kamau" }],
      table: {
        columns: [{ label: "Item" }, { label: "Amount (KES)", align: "right" }],
        rows: Array.from({ length: rows }, (_, i) => [`Item ${i + 1}`, "100.00"]),
      },
      totals: [{ label: "Total paid", value: "KES 200.00" }],
      notes: ["Thank you."],
    }),
    issuedAt: new Date("2026-11-04T09:00:00Z"),
    issuedBy: null,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  };
}

/** Every string a definition prints, wherever it sits. */
function printedText(node: unknown): string {
  return JSON.stringify(node);
}

function footerOf(document: IssuedDocument, page = 1, pages = 1) {
  const footer = documentDefinition(document).footer as (current: number, count: number) => Content;
  return footer(page, pages);
}

describe("a document's printed page", () => {
  it("prints the facility as issued, the title, the number and the time in Kenya", () => {
    const text = printedText(documentDefinition(receipt()).content);

    expect(text).toContain("Amani Hospital");
    expect(text).toContain("KMHFR 12345 · Nakuru");
    expect(text).toContain("Receipt");
    expect(text).toContain("No. RCT-2026-0001");
    // 09:00 UTC is 12:00 in Nairobi.
    expect(text).toContain("4 Nov 2026, 12:00");
    expect(text).toContain("Wanjiru Kamau");
    expect(text).toContain("KES 200.00");
  });

  it("carries the QR that opens this document's verification, on every page", () => {
    for (const page of [1, 2]) {
      const footer = printedText(footerOf(receipt(), page, 2));

      expect(footer).toContain(`"qr":"${verificationUrl(CODE)}"`);
      expect(footer).toContain(`Page ${page} of 2`);
    }
  });

  it("prints VOID across a voided document, and says when", () => {
    const definition = documentDefinition(receipt({
      voidedAt: new Date("2026-11-05T07:30:00Z"),
      voidReason: "Payment reversed",
    }));

    expect(definition.watermark).toMatchObject({ text: "VOID" });
    expect(printedText(definition.content)).toContain("Voided on 5 Nov 2026, 10:30");
    // The reason stays in the record; the paper only says it no longer stands.
    expect(printedText(definition)).not.toContain("Payment reversed");
  });

  it("carries no watermark on a document that stands", () => {
    expect(documentDefinition(receipt()).watermark).toBeUndefined();
  });
});

describe("rendering", () => {
  it("produces a PDF, with a long table carried across pages", async () => {
    const pdf = await renderPdf(documentDefinition(receipt({}, 120)));

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Page objects sit outside the compressed streams, so they can be counted.
    // `\b` keeps the page tree (`/Type /Pages`) out of the count.
    const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  // pdfmake would otherwise fetch a URL or read a file a definition names.
  it("refuses to fetch a URL a definition names", async () => {
    const definition = { content: [{ image: "logo" }], images: { logo: "http://169.254.169.254/latest/meta-data" } };

    await expect(renderPdf(definition)).rejects.toThrow(/Access to URL denied by resource access policy/);
  });

  it.each(["/etc/passwd", "C:/Windows/win.ini"])("refuses to read the file %s", async (src) => {
    await expect(renderPdf({ content: [{ image: src }] })).rejects.toThrow(/local file denied by resource access policy/);
  });
});
