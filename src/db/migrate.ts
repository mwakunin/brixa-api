/* eslint-disable no-console */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import env from "@/env";

import { CONNECTION_TIMEOUT_MS, sslConfigFor } from "./connection";

/**
 * Applies migrations at deploy time.
 *
 * Uses drizzle-orm's migrator rather than `drizzle-kit migrate`, because
 * drizzle-kit is a devDependency and the production image is installed with
 * `--prod`. It reads the same journal, so a database migrated either way stays
 * consistent.
 */
async function main() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfigFor(env.DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });

  try {
    console.log(`Applying migrations (NODE_ENV=${env.NODE_ENV})...`);
    await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" });
    console.log("Migrations applied.");
  }
  finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
