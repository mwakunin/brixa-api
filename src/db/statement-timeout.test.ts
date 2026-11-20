import type { Pool } from "pg";

import { describe, expect, it } from "vitest";

import { appPool, authPool, pool } from "@/db";

/**
 * How long one query may run on each connection (db/index.ts). Postgres
 * holds the bound and cancels a query that passes it, so a stalled query
 * cannot keep a request, or a connection, without end.
 */
describe("how long a query may run", () => {
  async function bound(target: Pool): Promise<string> {
    const { rows } = await target.query<{ statement_timeout: string }>("SHOW statement_timeout");
    return rows[0].statement_timeout;
  }

  it("is bounded for the roles the API runs as, and not for the owner", async () => {
    expect(await bound(authPool)).toBe("10s");
    expect(await bound(appPool)).toBe("30s");
    // Migrations, the reference-data loads and the nightly jobs may run long.
    expect(await bound(pool)).toBe("0");
  });
});
