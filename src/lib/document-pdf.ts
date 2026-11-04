import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

import type { documents } from "@/db/schema";

import type { DocumentContent } from "./document-content";

import { printedDateTime } from "./dates";
import { verificationUrl } from "./verification";

/**
 * The printed page every document shares: the facility at the top, the
 * document's title, number and date, its own content, and a footer on every
 * page with the QR code that verifies it.
 *
 * Built from the stored document alone (rule 7). Nothing here reads the
 * facility or the module that issued it, so a reprint years later says what
 * the original said.
 */

type IssuedDocument = typeof documents.$inferSelect;

const QR_SIZE = 64;
const MARGIN = 40;

const styles = {
  issuer: { fontSize: 16, bold: true },
  title: { fontSize: 14, bold: true },
  muted: { color: "#555555", fontSize: 8 },
  label: { color: "#555555" },
  tableHeader: { bold: true },
  void: { bold: true, color: "#b00020", margin: [0, 16, 0, 0] as [number, number, number, number] },
};

function fieldsBlock(fields: DocumentContent["fields"]): Content[] {
  if (fields.length === 0)
    return [];

  return [{
    table: {
      widths: ["auto", "*"],
      body: fields.map(f => [{ text: f.label, style: "label" }, f.value]),
    },
    layout: "noBorders",
    margin: [0, 0, 0, 12],
  }];
}

function tableBlock(table: DocumentContent["table"]): Content[] {
  if (!table)
    return [];

  const header = table.columns.map(col => ({ text: col.label, style: "tableHeader", alignment: col.align }));
  const rows = table.rows.map(row => row.map((cell, i) => ({ text: cell, alignment: table.columns[i].align })));

  return [{
    table: {
      headerRows: 1,
      widths: table.columns.map(col => (col.align === "right" ? "auto" : "*")),
      body: [header, ...rows],
    },
    layout: "lightHorizontalLines",
    margin: [0, 0, 0, 12],
  }];
}

function totalsBlock(totals: DocumentContent["totals"]): Content[] {
  if (totals.length === 0)
    return [];

  return [{
    columns: [
      { width: "*", text: "" },
      {
        width: "auto",
        table: {
          body: totals.map(t => [
            { text: t.label, alignment: "right" },
            { text: t.value, alignment: "right", bold: true },
          ]),
        },
        layout: "noBorders",
      },
    ],
    margin: [0, 0, 0, 12],
  }];
}

function voidBlock(doc: IssuedDocument): Content[] {
  if (!doc.voidedAt)
    return [];

  return [{
    text: `Voided on ${printedDateTime(doc.voidedAt)}. This document is no longer valid.`,
    style: "void",
  }];
}

/** The footer: the QR and its address, and the page count. */
function footerFor(url: string) {
  return (currentPage: number, pageCount: number): Content => ({
    margin: [MARGIN, 10, MARGIN, 0],
    columns: [
      { width: QR_SIZE + 8, qr: url, fit: QR_SIZE, eccLevel: "M" },
      {
        width: "*",
        margin: [0, 8, 0, 0],
        stack: [
          { text: "Scan to check this document is genuine", bold: true, fontSize: 9 },
          { text: url, style: "muted" },
        ],
      },
      { width: "auto", margin: [0, 8, 0, 0], text: `Page ${currentPage} of ${pageCount}`, style: "muted" },
    ],
  });
}

export function documentDefinition(doc: IssuedDocument): TDocumentDefinitions {
  const { content } = doc;
  const issuerLine = [`KMHFR ${content.issuer.kmhfrCode}`, content.issuer.county].filter(Boolean).join(" · ");

  return {
    info: { title: `${content.title} ${doc.number}` },
    pageSize: "A4",
    pageMargins: [MARGIN, MARGIN, MARGIN, 100],
    defaultStyle: { font: "Roboto", fontSize: 10 },
    styles,
    watermark: doc.voidedAt ? { text: "VOID", opacity: 0.12, bold: true } : undefined,
    content: [
      { text: content.issuer.name, style: "issuer" },
      { text: issuerLine, style: "muted", margin: [0, 0, 0, 16] },
      {
        columns: [
          { width: "*", text: content.title, style: "title" },
          { width: "auto", alignment: "right", stack: [`No. ${doc.number}`, printedDateTime(doc.issuedAt)] },
        ],
        margin: [0, 0, 0, 12],
      },
      ...fieldsBlock(content.fields),
      ...tableBlock(content.table),
      ...totalsBlock(content.totals),
      ...content.notes.map((note): Content => ({ text: note, style: "muted", margin: [0, 0, 0, 4] })),
      ...voidBlock(doc),
    ],
    footer: footerFor(verificationUrl(doc.verificationCode)),
  };
}
