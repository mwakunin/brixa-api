import { sql } from "drizzle-orm";
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { resetDb, signedInUser } from "@/test/helpers";

import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  pgConstraintName,
  pgErrorCode,
} from "./db-errors";

/**
 * These assert against errors drizzle actually throws, not hand-built objects.
 * Drizzle buries the pg error under `DrizzleQueryError.cause`, so a change to
 * how it wraps errors would silently turn every mapped 409/422 back into a
 * 500 — and only a real error can catch that.
 *
 * The constraints are exercised against a scratch table created here, not a
 * domain table. That is deliberate: this
 * module is about SQLSTATE plumbing, and pinning its tests to whichever domain
 * table happens to carry an EXCLUDE constraint is what made the previous
 * version break when the domain changed.
 */
const probe = pgTable("db_error_probe", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  slot: text("slot").notNull(),
  code: text("code"),
});

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  }
  catch (err) {
    return err;
  }
  throw new Error("Expected the query to throw, but it succeeded");
}

describe("db error classification", () => {
  beforeAll(async () => {
    // btree_gist is what lets an EXCLUDE constraint use plain equality; the
    // domain schema will need it too, for the same reason.
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS db_error_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        amount_cents integer NOT NULL,
        slot text NOT NULL,
        code text,
        CONSTRAINT db_error_probe_amount_whole
          CHECK (amount_cents % 100 = 0 AND amount_cents >= 0),
        -- On separate columns deliberately: both constraints on one column
        -- means whichever Postgres happens to check first is the only one
        -- ever observed, and the other assertion silently tests nothing.
        CONSTRAINT db_error_probe_code_unique UNIQUE (code),
        CONSTRAINT db_error_probe_no_overlap EXCLUDE USING gist (slot WITH =)
      )
    `);
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS db_error_probe`);
  });

  it("detects a foreign key violation (23503)", async () => {
    const err = await captureError(() => db.insert(probe).values({
      // No such user — user_id is a restricted FK.
      userId: "4651e634-a530-4484-9b09-9616a28f35e3",
      amountCents: 100_000,
      slot: "a",
    }));

    expect(pgErrorCode(err)).toBe("23503");
    expect(isForeignKeyViolation(err)).toBe(true);
    expect(isCheckViolation(err)).toBe(false);
    expect(isExclusionViolation(err)).toBe(false);
  });

  it("detects a check violation (23514) and names the constraint", async () => {
    const person = await signedInUser();

    const err = await captureError(() => db.insert(probe).values({
      userId: person.id,
      // Not a whole number of shillings — CLAUDE.md §3 rule 3.
      amountCents: 12_345,
      slot: "b",
    }));

    expect(pgErrorCode(err)).toBe("23514");
    expect(isCheckViolation(err)).toBe(true);
    // Handlers map the constraint name to a field-specific message.
    expect(pgConstraintName(err)).toBe("db_error_probe_amount_whole");
  });

  it("detects an exclusion violation (23P01)", async () => {
    const person = await signedInUser();
    const row = { userId: person.id, amountCents: 100_000, slot: "c" };

    await db.insert(probe).values(row);
    const err = await captureError(() => db.insert(probe).values(row));

    expect(pgErrorCode(err)).toBe("23P01");
    expect(isExclusionViolation(err)).toBe(true);
    expect(isUniqueViolation(err)).toBe(false);
    expect(pgConstraintName(err)).toBe("db_error_probe_no_overlap");
  });

  it("detects a unique violation (23505) and names the constraint", async () => {
    const person = await signedInUser();
    const base = { userId: person.id, amountCents: 100_000, code: "ADM-118" };

    await db.insert(probe).values({ ...base, slot: "d" });
    // A different slot, so the EXCLUDE constraint cannot be what rejects it.
    const err = await captureError(() =>
      db.insert(probe).values({ ...base, slot: "e" }));

    expect(pgErrorCode(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
    expect(isExclusionViolation(err)).toBe(false);
    expect(pgConstraintName(err)).toBe("db_error_probe_code_unique");
  });

  it("survives errors that carry no SQLSTATE", () => {
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(pgConstraintName({})).toBeUndefined();
  });

  it("does not loop forever on a self-referencing cause chain", () => {
    const err: { code?: string; cause?: unknown } = {};
    err.cause = err;
    expect(pgErrorCode(err)).toBeUndefined();
  });
});
