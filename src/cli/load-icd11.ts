/* eslint-disable no-console */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { errorLine } from "@/lib/error-summary";
import { loadIcd11 } from "@/lib/icd11-load";

/**
 * Loads WHO's ICD-11 MMS release into `icd_codes`:
 *
 *   pnpm icd11:load path/to/SimpleTabulation-ICD-11-MMS-en.txt
 *
 * or, from the release image, which has no tsx or TypeScript source
 * (docs/deployment.md §3):
 *
 *   node ./dist/src/cli/load-icd11.js /data/SimpleTabulation-ICD-11-MMS-en.txt
 *
 * The file is the `.txt` in WHO's release zip, unmodified
 * (https://icdcdn.who.int/static/releasefiles/<release>/SimpleTabulation-ICD-11-MMS-en.zip).
 * Run once per environment, and again for each new release. The release is
 * read from the file; an older one than already loaded is refused.
 */
const { positionals } = parseArgs({ allowPositionals: true });
const [file] = positionals;

if (!file) {
  console.error("Usage: load-icd11 <SimpleTabulation-ICD-11-MMS-en.txt>");
  process.exit(2);
}

readFile(file, "utf8")
  .then(text => loadIcd11(text))
  .then(({ release, loaded, retired }) => {
    console.log(`ICD-11 MMS ${release}: ${loaded} codes loaded, ${retired} retired.`);
    process.exit(0);
  }, (err) => {
    // A database error's message carries its SQL parameters (CLAUDE.md rule 10).
    console.error("ICD-11 load failed:", errorLine(err));
    process.exit(1);
  });
