/* eslint-disable no-console */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { errorLine } from "@/lib/error-summary";
import { convertGenericProducts, drugsCsv, reviewCsv } from "@/lib/ppb-generics";

/**
 * Converts PPB's Generic Products list (the FHIR CodeSystem JSON DHA's
 * ePrescription guide publishes) into the drug catalogue's CSV, and a list
 * for a pharmacist to review before it is loaded:
 *
 *   pnpm drugs:convert generic-products-cs.json drugs.csv drugs-review.csv
 *
 * It touches no database. Load `drugs.csv` with `pnpm drugs:load` once the
 * review is done, the controlled schedules are filled in, and PPB's terms
 * for the list allow it (SPEC.md §2).
 */
const { positionals } = parseArgs({ allowPositionals: true });
const [input, output, review] = positionals;

if (!input || !output || !review) {
  console.error("Usage: convert-ppb-generics <generic-products-cs.json> <drugs.csv> <review.csv>");
  process.exit(2);
}

readFile(input, "utf8")
  .then(async (text) => {
    const converted = convertGenericProducts(JSON.parse(text));
    await writeFile(output, drugsCsv(converted.rows));
    await writeFile(review, reviewCsv(converted.review));
    const left = converted.review.filter(r => !r.included).length;
    console.log(`${converted.rows.length} drugs written to ${output}; ${left} left out and ${converted.review.length - left} to check, in ${review}.`);
    console.log("No controlled schedules are set: fill them in from the Pharmacy and Poisons Act before loading.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Conversion failed:", errorLine(err));
    process.exit(1);
  });
