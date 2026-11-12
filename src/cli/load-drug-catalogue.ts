/* eslint-disable no-console */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { errorLine } from "@/lib/error-summary";

/**
 * Loads the shared drug catalogue from a CSV file in this system's format
 * (`lib/drug-catalogue-load.ts` describes it):
 *
 *   pnpm drugs:load path/to/drugs.csv
 *
 * or, from the release image, which has no tsx or TypeScript source
 * (docs/deployment.md §3):
 *
 *   node ./dist/src/cli/load-drug-catalogue.js /data/drugs.csv
 *
 * Run once per environment, and again whenever the list changes. A drug the
 * file no longer has is retired, never deleted.
 */
const { positionals } = parseArgs({ allowPositionals: true });
const [file] = positionals;

if (!file) {
  console.error("Usage: load-drug-catalogue <drugs.csv>");
  process.exit(2);
}

readFile(file, "utf8")
  .then(text => loadDrugCatalogue(text))
  .then(({ loaded, retired }) => {
    console.log(`Drug catalogue: ${loaded} drugs loaded, ${retired} retired.`);
    process.exit(0);
  }, (err) => {
    // A database error's message carries its SQL parameters (CLAUDE.md rule 10).
    console.error("Drug catalogue load failed:", errorLine(err));
    process.exit(1);
  });
