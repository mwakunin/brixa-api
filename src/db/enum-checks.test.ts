import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { facilities, memberships } from "@/db/schema";
import { isCheckViolation, isForeignKeyViolation, pgConstraintName } from "@/lib/db-errors";
import { addMembership, makeFacility, resetDb, signedInUser } from "@/test/helpers";

/**
 * Every `.$type<"a" | "b">()` column has a CHECK saying the same thing
 * (CLAUDE.md rule 15), and every `text().array().$type<("a" | "b")[]>()`
 * column has an `allOf` CHECK.
 *
 * Static, like `db-access.test.ts`: the drift this guards against arrives with
 * a column added months from now, in a table no test here knows about.
 * Reading the schema catches it whether or not anything exercises the column.
 */

const SCHEMA = path.resolve(import.meta.dirname, "schema.ts");

/**
 * Columns whose values are the rows of a lookup table, enforced by a foreign
 * key instead of a CHECK. A CHECK on a table this large is rewritten for each
 * new value, and the whole table re-read under a lock that blocks its writes
 * (schema.ts, `auditActions`). Keyed by table and schema property.
 */
const LOOKUP_ENFORCED: Record<string, { lookup: string; column: string }> = {
  "audit_log.action": { lookup: "audit_actions", column: "action" },
};

type Kind = "scalar" | "array";

interface Column {
  table: string;
  property: string;
  kind: Kind;
  /** The members of the TypeScript union, in source order. */
  union: string[];
}

interface Unreadable {
  table: string;
  property: string;
}

interface Constraint {
  table: string;
  property: string;
  kind: Kind;
  name: string;
  values: string[];
}

/**
 * The string literal members of `"a" | "b"`.
 *
 * `null` means "not a union of string literals", a shape this guard has no
 * opinion about. `undefined` means "names a type this guard cannot read",
 * which is reported rather than skipped: silently skipping is how a column
 * with no CHECK gets past a test written to find exactly that.
 */
function unionMembers(node: ts.TypeNode): string[] | null | undefined {
  if (ts.isParenthesizedTypeNode(node))
    return unionMembers(node.type);
  if (ts.isTypeReferenceNode(node))
    return undefined;

  const parts = ts.isUnionTypeNode(node) ? node.types : [node];
  const members: string[] = [];

  for (const part of parts) {
    if (!ts.isLiteralTypeNode(part) || !ts.isStringLiteral(part.literal))
      return null;
    members.push(part.literal.text);
  }

  return members;
}

/** Whether `node` is the call `text()`. */
function isTextCall(node: ts.Expression) {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "text";
}

/**
 * The type argument of `text().$type<...>()` or `text().array().$type<...>()`,
 * with which of the two it was. Not `jsonb()` and not a `pgEnum`.
 */
function textTypeArgument(node: ts.Expression): { kind: Kind; type: ts.TypeNode } | null {
  if (!ts.isCallExpression(node) || node.typeArguments?.length !== 1)
    return null;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "$type")
    return null;

  const base = node.expression.expression;
  if (isTextCall(base))
    return { kind: "scalar", type: node.typeArguments[0] };

  if (
    ts.isCallExpression(base)
    && ts.isPropertyAccessExpression(base.expression)
    && base.expression.name.text === "array"
    && isTextCall(base.expression.expression)
  ) {
    return { kind: "array", type: node.typeArguments[0] };
  }

  return null;
}

/** Unwraps `.notNull().default(...)` back to the `$type` call underneath. */
function chainRoot(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text !== "$type"
  ) {
    current = current.expression.expression;
  }
  return current;
}

/** The members a column's type argument lists, for either kind. */
function membersOf(kind: Kind, type: ts.TypeNode): string[] | null | undefined {
  if (kind === "scalar")
    return unionMembers(type);
  // `("a" | "b")[]`. `Array<"a" | "b">` would need resolving, so it counts as
  // unreadable rather than as no opinion.
  if (ts.isArrayTypeNode(type))
    return unionMembers(type.elementType);
  return undefined;
}

const CHECK_HELPERS: Record<string, Kind> = { oneOf: "scalar", allOf: "array" };

function parseSchema(source: string) {
  const file = ts.createSourceFile(SCHEMA, source, ts.ScriptTarget.Latest, true);
  const columns: Column[] = [];
  const unreadable: Unreadable[] = [];
  const constraints: Constraint[] = [];

  const collectConstraints = (table: string, inner: ts.Node) => {
    if (
      ts.isCallExpression(inner)
      && ts.isIdentifier(inner.expression)
      && inner.expression.text in CHECK_HELPERS
      && inner.arguments.length === 3
      && ts.isStringLiteral(inner.arguments[0])
      && ts.isPropertyAccessExpression(inner.arguments[1])
      && ts.isArrayLiteralExpression(inner.arguments[2])
    ) {
      constraints.push({
        table,
        property: inner.arguments[1].name.text,
        kind: CHECK_HELPERS[inner.expression.text],
        name: inner.arguments[0].text,
        values: inner.arguments[2].elements.map(e =>
          ts.isStringLiteral(e) ? e.text : "<not a literal>",
        ),
      });
    }
    ts.forEachChild(inner, child => collectConstraints(table, child));
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "pgTable"
      && node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const table = node.arguments[0].text;
      const shape = node.arguments[1];

      if (ts.isObjectLiteralExpression(shape)) {
        for (const member of shape.properties) {
          if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name))
            continue;

          const typed = textTypeArgument(chainRoot(member.initializer));
          if (!typed)
            continue;

          const union = membersOf(typed.kind, typed.type);
          if (union === undefined)
            unreadable.push({ table, property: member.name.text });
          else if (union)
            columns.push({ table, property: member.name.text, kind: typed.kind, union });
        }
      }

      if (node.arguments[2])
        collectConstraints(table, node.arguments[2]);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return { columns, unreadable, constraints };
}

async function schema() {
  return parseSchema(await readFile(SCHEMA, "utf8"));
}

describe("union-typed columns", () => {
  it("finds the columns it is supposed to be checking", async () => {
    const { columns } = await schema();

    // A parser that quietly matched nothing would make every assertion below
    // vacuous while staying green.
    expect(columns.length).toBeGreaterThanOrEqual(3);
    expect(columns).toContainEqual({
      table: "facilities",
      property: "status",
      kind: "scalar",
      union: ["active", "suspended"],
    });
    expect(columns.find(c => c.table === "memberships" && c.property === "roles"))
      .toMatchObject({ kind: "array" });
  });

  it("can read every union it is asked to check", async () => {
    const { unreadable } = await schema();

    // A named type on a text column escapes this guard entirely, so the union
    // goes inline and any alias is DERIVED from the column.
    expect(
      unreadable.map(u => `${u.table}.${u.property}`),
      "write the union inline; derive any alias from the column, not the reverse",
    ).toEqual([]);
  });

  it("has a CHECK for each one, of the right kind, listing exactly the same values", async () => {
    const { columns, constraints } = await schema();

    for (const column of columns) {
      if (`${column.table}.${column.property}` in LOOKUP_ENFORCED)
        continue;

      const found = constraints.find(
        con => con.table === column.table && con.property === column.property,
      );

      const helper = column.kind === "scalar" ? "oneOf" : "allOf";
      expect(
        found,
        `${column.table}.${column.property} has a TypeScript union and no CHECK: `
        + `add ${helper}("${column.table}_${column.property}_known", t.${column.property}, [...])`,
      ).toBeDefined();

      // `oneOf` on an array column would compare the whole array to a string.
      expect(found!.kind, `${found!.name} uses the wrong helper for a ${column.kind} column`)
        .toBe(column.kind);

      // Order included: a mismatch is the two lists having drifted, and
      // sorting first would hide a value that moved rather than changed.
      expect(found!.values, `${found!.name} does not list the same values as the type`)
        .toEqual(column.union);
    }
  });

  it("has applied every one of them to the database, validated, with the same values", async () => {
    const { constraints } = await schema();

    const { rows } = await db.$client.query<{ conname: string; convalidated: boolean; def: string }>(
      "SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c'",
    );
    const applied = new Map(rows.map(r => [r.conname, r]));

    for (const constraint of constraints) {
      const found = applied.get(constraint.name);

      // schema.ts and the migrations are separate artefacts; declaring a
      // constraint and forgetting to generate one is otherwise a silent no-op.
      expect(found, `${constraint.name} is in schema.ts but no migration`).toBeDefined();
      expect(found!.convalidated, `${constraint.name} is NOT VALID`).toBe(true);

      /*
       * And the database lists the same values. A hand-edited migration with a
       * different list would otherwise pass on its name alone. Postgres
       * renders both `IN (...)` and `ARRAY[...]` as `'value'::text` items.
       */
      const inDatabase = [...found!.def.matchAll(/'([^']*)'::text/g)].map(m => m[1]);
      expect(inDatabase, `${constraint.name} in the database differs from schema.ts`)
        .toEqual(constraint.values);
    }
  });

  describe("enforced by a lookup table", () => {
    it("references its lookup table, validated", async () => {
      for (const [key, { lookup, column }] of Object.entries(LOOKUP_ENFORCED)) {
        const table = key.split(".")[0];
        const { rows } = await db.$client.query<{ convalidated: boolean; def: string }>(`
          SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND conrelid = $1::regclass AND confrelid = $2::regclass
        `, [table, lookup]);

        expect(rows.map(r => r.def), `${key} has no foreign key to ${lookup}`)
          .toEqual([`FOREIGN KEY (${column}) REFERENCES ${lookup}(${column})`]);
        expect(rows[0].convalidated, `${key}'s foreign key is NOT VALID`).toBe(true);
      }
    });

    it("holds exactly the values the column's type lists", async () => {
      const { columns } = await schema();

      for (const [key, { lookup, column }] of Object.entries(LOOKUP_ENFORCED)) {
        const typed = columns.find(c => `${c.table}.${c.property}` === key);
        expect(typed, `${key} has no union to compare ${lookup} with`).toBeDefined();

        const { rows } = await db.$client.query<{ value: string }>(
          `SELECT ${column} AS value FROM ${lookup} ORDER BY 1`,
        );

        // Rows have no order, so both sides are sorted. A value in the type
        // and not the table is one a migration forgot to insert.
        expect(
          rows.map(r => r.value),
          `${lookup} differs from ${key}'s type: insert the new value into ${lookup} in a migration`,
        ).toEqual([...typed!.union].sort());
      }
    });
  });

  describe("in the database", () => {
    beforeEach(async () => {
      await resetDb();
    });

    /** On the owner connection: the nearest thing to a hand-run correction. */
    async function refusalOf(write: () => Promise<unknown>) {
      return write().then(() => null, (e: unknown) => e);
    }

    it("refuses a facility status no part of this codebase would recognise", async () => {
      const facility = await makeFacility();

      const err = await refusalOf(() => db.update(facilities)
        .set({ status: "closed" as never })
        .where(eq(facilities.id, facility.id)));

      expect(isCheckViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("facilities_status_known");
    });

    it("refuses an audit action no part of this codebase would recognise", async () => {
      const facility = await makeFacility();

      const err = await refusalOf(() => db.$client.query(
        "INSERT INTO audit_log (facility_id, action, entity_type, summary) VALUES ($1, 'patient.deleted', 'patient', 'Deleted')",
        [facility.id],
      ));

      expect(isForeignKeyViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("audit_log_action_audit_actions_action_fk");
    });

    it("refuses a role no guard would recognise, even alongside a real one", async () => {
      const facility = await makeFacility();
      const person = await signedInUser();
      const membership = await addMembership(person.id, facility.id, ["doctor"]);

      // `surgeon` passes no role check and fails every one: a person the
      // facility thinks is staff who can do nothing.
      const err = await refusalOf(() => db.update(memberships)
        .set({ roles: ["doctor", "surgeon"] as never })
        .where(eq(memberships.id, membership.id)));

      expect(isCheckViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("memberships_roles_known");
    });

    it("refuses a membership with no roles at all", async () => {
      const facility = await makeFacility();
      const person = await signedInUser();
      // Not a clinical role: emptying a doctor's roles would also break the
      // licence CHECK, and Postgres names whichever it checks first.
      const membership = await addMembership(person.id, facility.id, ["cashier"]);

      const err = await refusalOf(() => db.update(memberships)
        .set({ roles: [] })
        .where(eq(memberships.id, membership.id)));

      expect(isCheckViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("memberships_roles_not_empty");
    });
  });
});
