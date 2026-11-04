import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppDb } from "@/db";

import db, {
  appDb,
  appPool,
  assertConnectionsAreRestricted,
  assertRoleIsRestricted,
  authPool,
  pool,
  PrivilegedRoleError,
} from "@/db";
import { TENANT_TABLES } from "@/db/schema";
import { pgErrorCode } from "@/lib/db-errors";
import { addMembership, makeFacility, resetDb, signedInUser } from "@/test/helpers";

/** Postgres reports an RLS or privilege refusal as insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = "42501";
/** What the append-only trigger raises. */
const RESTRICT_VIOLATION = "23001";

const PROTECTED_TABLES = ["facilities", ...TENANT_TABLES];

async function errorFrom(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  }
  catch (err) {
    return err;
  }
  throw new Error("Expected the statement to be refused, but it succeeded");
}

/** Runs `fn` on the runtime role with the tenant set, as `withFacility` does. */
function asTenant<T>(facilityId: string, fn: (tx: AppDb) => Promise<T>) {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.facility_id', ${facilityId}, true)`);
    return fn(tx);
  });
}

/**
 * Row-level security, asserted against the database rather than the app.
 *
 * These connect as the runtime role, deliberately fail to set
 * `app.facility_id`, or try to write across a boundary, and require Postgres
 * itself to refuse. They prove that code which forgets the middleware entirely
 * still cannot read another facility's rows.
 */
describe("row-level security", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("the configuration that makes it real", () => {
    it.each([
      ["app", appPool],
      ["auth", authPool],
    ])("connects the %s pool as a role that is neither superuser nor BYPASSRLS", async (_name, target) => {
      const { rows } = await target.query<{ usesuper: boolean; usebypassrls: boolean }>(
        "SELECT usesuper, usebypassrls FROM pg_user WHERE usename = current_user",
      );

      // A superuser ignores policies and privileges outright, and FORCE does
      // not change that. If this ever ran as the owner, every other test here
      // would go vacuous while staying green.
      expect(rows[0].usesuper).toBe(false);
      expect(rows[0].usebypassrls).toBe(false);
    });

    it("connects owner, app and auth as three different roles", async () => {
      const names = await Promise.all([pool, appPool, authPool].map(async (target) => {
        const { rows } = await target.query<{ current_user: string }>("SELECT current_user");
        return rows[0].current_user;
      }));

      expect(new Set(names).size).toBe(3);
    });

    it("connects the owner as a role that CAN bypass RLS", async () => {
      // FORCE subjects the owner to the policies too, so the owner connection
      // keeps its cross-tenant reach only as SUPERUSER or BYPASSRLS. Locally
      // it is a superuser; on a managed host it usually is not (db/roles.sql).
      const { rows } = await pool.query<{ usesuper: boolean; usebypassrls: boolean }>(
        "SELECT usesuper, usebypassrls FROM pg_user WHERE usename = current_user",
      );

      expect(
        rows[0].usesuper || rows[0].usebypassrls,
        "DATABASE_URL's role must be SUPERUSER or have BYPASSRLS",
      ).toBe(true);
    });

    it("is not the role that owns the tables", async () => {
      // Asked of the catalogue, not of the other connection: owning a table
      // exempts a role from its policies unless FORCE is set.
      const { rows: [app] } = await appPool.query<{ current_user: string }>("SELECT current_user");
      const { rows } = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE tableowner = $1",
        [app.current_user],
      );

      expect(rows).toEqual([]);
    });

    it("passes the boot check, which refuses a role that could bypass RLS", async () => {
      // Both restricted roles are restricted, so the API would serve...
      await expect(assertConnectionsAreRestricted()).resolves.toBeUndefined();
      // ...and the owner, a superuser here, is exactly what it refuses.
      await expect(assertRoleIsRestricted(pool)).rejects.toBeInstanceOf(PrivilegedRoleError);
    });

    it("gives each protected table exactly one policy, for every command, with both clauses", async () => {
      /*
       * A policy existing is not the same as a policy being right. A later
       * table with `FOR SELECT USING (true)`, or no WITH CHECK, or a second
       * permissive policy (permissive policies OR together, so any one of them
       * widens access) would pass a check for existence alone.
       */
      const { rows } = await pool.query<{
        relname: string;
        polcmd: string;
        polpermissive: boolean;
        using_expr: string | null;
        check_expr: string | null;
      }>(`
        SELECT c.relname, p.polcmd, p.polpermissive,
               pg_get_expr(p.polqual, p.polrelid) AS using_expr,
               pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname
      `, [PROTECTED_TABLES]);

      expect(rows.map(r => r.relname).sort()).toEqual([...PROTECTED_TABLES].sort());

      for (const row of rows) {
        const scope = row.relname === "facilities" ? "id" : "facility_id";
        const expected = `(${scope} = app_current_facility())`;

        expect(row.polcmd, `${row.relname} policy covers every command`).toBe("*");
        expect(row.polpermissive, `${row.relname} policy is permissive`).toBe(true);
        expect(row.using_expr, `${row.relname} USING`).toBe(expected);
        expect(row.check_expr, `${row.relname} WITH CHECK`).toBe(expected);
      }
    });

    it("has RLS enabled AND forced on every tenant table", async () => {
      const { rows } = await pool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
          WHERE relname = ANY($1) AND relkind = 'r'`, [PROTECTED_TABLES]);

      expect(rows).toHaveLength(PROTECTED_TABLES.length);

      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} has RLS enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} FORCEs RLS`).toBe(true);
      }
    });

    it("leaves no table carrying facility_id unprotected", async () => {
      // The realistic omission: a table added later with the facility_id the
      // conventions require, and no policy.
      const { rows } = await pool.query<{ table_name: string }>(`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attname = 'facility_id'
          AND NOT a.attisdropped
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      `);

      expect(rows.map(r => r.table_name)).toEqual([]);
    });

    it("lists every table carrying facility_id in TENANT_TABLES", async () => {
      // TENANT_TABLES drives the checks above, so a table missing from it would
      // escape them.
      const { rows } = await pool.query<{ table_name: string }>(`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attname = 'facility_id' AND NOT a.attisdropped
        ORDER BY 1
      `);

      expect(rows.map(r => r.table_name)).toEqual([...TENANT_TABLES].sort());
    });

    it("denies DELETE on every tenant table, so nothing hard-deletes", async () => {
      // CLAUDE.md rule 5, enforced as a privilege rather than a convention.
      for (const table of PROTECTED_TABLES) {
        const { rows } = await appPool.query<{ has: boolean }>(
          "SELECT has_table_privilege(current_user, $1, 'DELETE') AS has",
          [table],
        );
        expect(rows[0].has, `hospital_app can DELETE from ${table}`).toBe(false);
      }
    });
  });

  describe("reads", () => {
    it("returns nothing at all when no tenant is set", async () => {
      const alpha = await makeFacility();
      const person = await signedInUser();
      await addMembership(person.id, alpha.id, ["doctor"]);

      // Every privilege needed and no WHERE clause, and still zero rows: the
      // database is doing the work.
      const seen = await appDb.execute(sql`SELECT id FROM facilities`);
      const members = await appDb.execute(sql`SELECT id FROM memberships`);

      expect(seen.rows).toEqual([]);
      expect(members.rows).toEqual([]);
    });

    it("shows one facility only its own row", async () => {
      const alpha = await makeFacility({ name: "Alpha Hospital" });
      await makeFacility({ name: "Beta Hospital" });

      const rows = await asTenant(alpha.id, async (tx) => {
        const r = await tx.execute<{ name: string }>(sql`SELECT name FROM facilities`);
        return r.rows;
      });

      expect(rows).toEqual([{ name: "Alpha Hospital" }]);
    });

    it("hides another facility's membership even when asked for by id", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUser();
      const atBeta = await addMembership(person.id, beta.id, ["cashier"]);

      // Not "does a scan leak it" but "can it be fetched at all by someone who
      // already knows the id".
      const rows = await asTenant(alpha.id, async (tx) => {
        const r = await tx.execute(sql`SELECT id FROM memberships WHERE id = ${atBeta.id}`);
        return r.rows;
      });

      expect(rows).toEqual([]);
    });

    it("treats an empty tenant setting as no tenant, not as an error", async () => {
      await makeFacility();

      // `''::uuid` raises; the function's NULLIF turns it into "no rows"
      // instead of a 500 a caller could probe with.
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.facility_id', '', true)`);
        const r = await tx.execute(sql`SELECT id FROM facilities`);
        return r.rows;
      });

      expect(rows).toEqual([]);
    });
  });

  describe("writes", () => {
    it("refuses an insert attributed to another facility", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUser();

      // The more damaging direction, and the one a USING-only policy allows.
      const err = await errorFrom(() => asTenant(alpha.id, tx => tx.execute(sql`
        INSERT INTO memberships (facility_id, user_id, roles)
        VALUES (${beta.id}, ${person.id}, ARRAY['facility_admin'])
      `)));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);

      const { rows } = await pool.query("SELECT 1 FROM memberships");
      expect(rows).toEqual([]);
    });

    it("refuses an insert when no tenant is set", async () => {
      const alpha = await makeFacility();
      const person = await signedInUser();

      const err = await errorFrom(() => appDb.execute(sql`
        INSERT INTO memberships (facility_id, user_id, roles)
        VALUES (${alpha.id}, ${person.id}, ARRAY['facility_admin'])
      `));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot update another facility's row", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUser();
      const atBeta = await addMembership(person.id, beta.id, ["nurse"]);

      const updated = await asTenant(alpha.id, async (tx) => {
        const r = await tx.execute(sql`
          UPDATE memberships SET roles = ARRAY['facility_admin'] WHERE id = ${atBeta.id}
        `);
        return r.rowCount;
      });

      // Not an error: the row is invisible, so the UPDATE matches nothing.
      expect(updated).toBe(0);

      const { rows } = await pool.query<{ roles: string[] }>(
        "SELECT roles FROM memberships WHERE id = $1",
        [atBeta.id],
      );
      expect(rows[0].roles).toEqual(["nurse"]);
    });

    it("cannot change even its own facility row, which the superadmin plane owns", async () => {
      // Read-only to the app: a facility-scoped handler must not be able to
      // lift its own suspension or rewrite its KMHFR code.
      const alpha = await makeFacility({ status: "suspended" });

      const err = await errorFrom(() => asTenant(alpha.id, tx => tx.execute(sql`
        UPDATE facilities SET status = 'active' WHERE id = ${alpha.id}
      `)));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot move its own membership into another facility", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUser();
      const membership = await addMembership(person.id, alpha.id, ["doctor"]);

      // USING admits the row (it is alpha's); WITH CHECK refuses the new value.
      const err = await errorFrom(() => asTenant(alpha.id, tx => tx.execute(sql`
        UPDATE memberships SET facility_id = ${beta.id} WHERE id = ${membership.id}
      `)));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("references across tenants", () => {
    it("leaves no tenant table referencing another without carrying facility_id", async () => {
      /*
       * RLS does not constrain foreign keys: Postgres checks a reference as the
       * table owner. So any foreign key from one tenant table into another
       * must include facility_id (CLAUDE.md §4, layer 4), or a row whose own
       * facility_id is correct could still point at another facility's row.
       * This finds the ones that do not, as tables are added.
       */
      const { rows } = await pool.query<{ child: string; constraint_name: string }>(`
        SELECT c.conrelid::regclass::text AS child, c.conname AS constraint_name
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text = ANY($1)
          AND c.confrelid::regclass::text = ANY($1)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(c.conkey) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE a.attname = 'facility_id'
          )
      `, [[...TENANT_TABLES]]);

      expect(rows.map(r => `${r.child}.${r.constraint_name}`)).toEqual([]);
    });

    it("gives memberships the (facility_id, id) key a composite reference needs", async () => {
      const { rows } = await pool.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'memberships'::regclass AND contype = 'u'
          AND conname = 'memberships_facility_id_id_key'
      `);

      expect(rows).toHaveLength(1);
    });
  });

  describe("identity, which carries no tenant policy", () => {
    /*
     * The auth tables cannot be scoped by facility (one person may work at
     * several), so privileges are what keep them apart: the role tenant
     * handlers run as must not reach a session token or a password hash, and
     * Better Auth's role must not reach a patient's facility.
     */
    it.each([
      ["SELECT token FROM session"],
      ["SELECT password FROM account"],
      ["SELECT value FROM verification"],
      ["SELECT role FROM \"user\""],
    ])("refuses the app role: %s", async (statement) => {
      await signedInUser();

      const err = await errorFrom(() => appPool.query(statement));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("lets the app role see who a person is, for a staff list", async () => {
      const person = await signedInUser({ name: "Achieng Otieno" });

      const { rows } = await appPool.query(
        "SELECT id, name, email FROM \"user\" WHERE id = $1",
        [person.id],
      );

      expect(rows).toEqual([{ id: person.id, name: "Achieng Otieno", email: person.email }]);
    });

    it("gives the app role no write on identity at all", async () => {
      for (const table of ["user", "session", "account", "verification"]) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
          const { rows } = await appPool.query<{ has: boolean }>(
            "SELECT has_table_privilege(current_user, $1, $2) AS has",
            [`"${table}"`, privilege],
          );
          expect(rows[0].has, `hospital_app has ${privilege} on ${table}`).toBe(false);
        }
      }
    });

    it("gives the auth role nothing on any tenant table", async () => {
      for (const table of PROTECTED_TABLES) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const { rows } = await authPool.query<{ has: boolean }>(
            "SELECT has_table_privilege(current_user, $1, $2) AS has",
            [table, privilege],
          );
          expect(rows[0].has, `hospital_auth has ${privilege} on ${table}`).toBe(false);
        }
      }
    });
  });

  describe("the audit log", () => {
    async function auditEntry(facilityId: string) {
      const { rows } = await pool.query<{ id: string }>(`
        INSERT INTO audit_log (facility_id, action, entity_type, summary)
        VALUES ($1, 'facility.created', 'facility', 'Created')
        RETURNING id
      `, [facilityId]);
      return rows[0].id;
    }

    it("denies the runtime role UPDATE on it", async () => {
      const alpha = await makeFacility();
      const id = await auditEntry(alpha.id);

      const err = await errorFrom(() => asTenant(alpha.id, tx => tx.execute(sql`
        UPDATE audit_log SET summary = 'Rewritten' WHERE id = ${id}
      `)));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("refuses UPDATE and DELETE even from the owner", async () => {
      // The privilege covers the app; the trigger covers everyone else, so a
      // migration or a hand-run correction cannot rewrite history either.
      const alpha = await makeFacility();
      const id = await auditEntry(alpha.id);

      const update = await errorFrom(() => db.execute(sql`
        UPDATE audit_log SET summary = 'Rewritten' WHERE id = ${id}
      `));
      const remove = await errorFrom(() => db.execute(sql`
        DELETE FROM audit_log WHERE id = ${id}
      `));

      expect(pgErrorCode(update)).toBe(RESTRICT_VIOLATION);
      expect(pgErrorCode(remove)).toBe(RESTRICT_VIOLATION);

      const { rows } = await pool.query<{ summary: string }>(
        "SELECT summary FROM audit_log WHERE id = $1",
        [id],
      );
      expect(rows).toEqual([{ summary: "Created" }]);
    });

    it("lets the runtime role append within its own facility", async () => {
      const alpha = await makeFacility();

      const rows = await asTenant(alpha.id, async (tx) => {
        const r = await tx.execute(sql`
          INSERT INTO audit_log (facility_id, action, entity_type, summary)
          VALUES (${alpha.id}, 'facility.created', 'facility', 'Created')
          RETURNING summary
        `);
        return r.rows;
      });

      expect(rows).toEqual([{ summary: "Created" }]);
    });

    it("hides another facility's entries, even by id", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const atBeta = await auditEntry(beta.id);

      const rows = await asTenant(alpha.id, async (tx) => {
        const r = await tx.execute(sql`SELECT id FROM audit_log WHERE id = ${atBeta}`);
        return r.rows;
      });

      expect(rows).toEqual([]);
    });

    it("refuses an entry attributed to another facility", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();

      const err = await errorFrom(() => asTenant(alpha.id, tx => tx.execute(sql`
        INSERT INTO audit_log (facility_id, action, entity_type, summary)
        VALUES (${beta.id}, 'facility.created', 'facility', 'Forged')
      `)));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("the transaction boundary", () => {
    it("does not leak the tenant onto the next transaction on the same connection", async () => {
      const alpha = await makeFacility();

      /*
       * One client, held throughout, so the second query provably runs on the
       * connection the first one set the tenant on. Through the pool it might
       * simply have been handed a different connection and passed by luck.
       */
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.facility_id', $1, true)", [alpha.id]);
        const during = await client.query("SELECT id FROM facilities");
        await client.query("COMMIT");

        // Why set_config's third argument is `true`: session-scoped, the
        // setting would outlive the transaction and hand the next borrower of
        // this connection the previous request's facility.
        const after = await client.query("SELECT id FROM facilities");

        expect(during.rows).toHaveLength(1);
        expect(after.rows).toEqual([]);
      }
      finally {
        client.release();
      }
    });
  });
});
