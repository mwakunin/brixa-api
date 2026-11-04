import type { Buffer } from "node:buffer";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

import { createRequire } from "node:module";
import pdfmake from "pdfmake";

/**
 * PDF rendering (SPEC.md §2: pdfmake, no headless browser).
 *
 * Roboto, embedded from pdfmake's own copy, rather than the standard PDF
 * fonts: those cover only the Windows-1252 code page, and a patient's name
 * outside it would print as gaps.
 *
 * pdfmake can fetch a URL or read a file that a document definition names
 * (an image, a font). Nothing here prints anything but text and a QR code, so
 * both are shut: no URL at all, and no file but the four fonts. A definition
 * built from stored text can then never be turned into a request to an
 * internal address or a read of a file on this machine.
 */

const require = createRequire(import.meta.url);

const ROBOTO = {
  normal: require.resolve("pdfmake/fonts/Roboto/Roboto-Regular.ttf"),
  bold: require.resolve("pdfmake/fonts/Roboto/Roboto-Medium.ttf"),
  italics: require.resolve("pdfmake/fonts/Roboto/Roboto-Italic.ttf"),
  bolditalics: require.resolve("pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf"),
};

const FONT_FILES: ReadonlySet<string> = new Set(Object.values(ROBOTO));

pdfmake.setFonts({ Roboto: ROBOTO });
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(path => FONT_FILES.has(path));

export async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return pdfmake.createPdf(definition).getBuffer();
}
