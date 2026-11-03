import { defineConfig } from "drizzle-kit";

import env from "@/env";

export default defineConfig({
  // schema.ts re-exports the Better-Auth-owned tables from auth-schema.ts, so
  // listing it alone covers both without registering them twice.
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
