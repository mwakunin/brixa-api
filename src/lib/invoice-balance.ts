import { and, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { allocations, invoiceAdjustments, payments } from "@/db/schema";

/**
 * What has been taken off an invoice, derived and never stored (rule 4):
 * approved adjustments not reversed and live allocations share its total (M3). An
 * allocation is live while neither it nor its payment is reversed.
 */

/** Σ approved adjustments of an invoice that are not reversed. */
export async function adjustedCents(tx: AppDb, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${invoiceAdjustments.amountCents}), 0)`.mapWith(Number) })
    .from(invoiceAdjustments)
    .where(and(eq(invoiceAdjustments.invoiceId, invoiceId), eq(invoiceAdjustments.status, "approved"), isNull(invoiceAdjustments.reversedAt)));
  return row.cents;
}

/** Σ live allocations to an invoice. */
export async function allocatedCents(tx: AppDb, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${allocations.amountCents}), 0)`.mapWith(Number) })
    .from(allocations)
    .innerJoin(payments, eq(payments.id, allocations.paymentId))
    .where(and(eq(allocations.invoiceId, invoiceId), isNull(allocations.reversedAt), isNull(payments.reversedAt)));
  return row.cents;
}

/**
 * Both totals in one statement, so they come from one snapshot. Read one
 * after the other, a waiver reversed and its restored balance paid in between
 * could show the invoice as overpaid.
 */
export async function takenOffCents(tx: AppDb, invoiceId: string): Promise<{ adjustedCents: number; allocatedCents: number }> {
  const { rows } = await tx.execute<{ adjusted: string; allocated: string }>(sql`
    SELECT
      (SELECT coalesce(sum(${invoiceAdjustments.amountCents}), 0) FROM ${invoiceAdjustments}
        WHERE ${invoiceAdjustments.invoiceId} = ${invoiceId} AND ${invoiceAdjustments.status} = 'approved' AND ${invoiceAdjustments.reversedAt} IS NULL) AS adjusted,
      (SELECT coalesce(sum(${allocations.amountCents}), 0) FROM ${allocations}
        JOIN ${payments} ON ${payments.id} = ${allocations.paymentId}
        WHERE ${allocations.invoiceId} = ${invoiceId} AND ${allocations.reversedAt} IS NULL AND ${payments.reversedAt} IS NULL) AS allocated
  `);
  return { adjustedCents: Number(rows[0].adjusted), allocatedCents: Number(rows[0].allocated) };
}

/** What is still owed on each of these finalised invoices, in one statement. */
export async function balancesCents(tx: AppDb, invoices: { id: string; totalCents: number | null }[]): Promise<Map<string, number>> {
  if (invoices.length === 0)
    return new Map();
  const ids = invoices.map(i => i.id);
  const { rows } = await tx.execute<{ invoice_id: string; taken: string }>(sql`
    SELECT i.id AS invoice_id,
      coalesce((SELECT sum(${invoiceAdjustments.amountCents}) FROM ${invoiceAdjustments}
        WHERE ${invoiceAdjustments.invoiceId} = i.id AND ${invoiceAdjustments.status} = 'approved' AND ${invoiceAdjustments.reversedAt} IS NULL), 0)
      + coalesce((SELECT sum(${allocations.amountCents}) FROM ${allocations}
        JOIN ${payments} ON ${payments.id} = ${allocations.paymentId}
        WHERE ${allocations.invoiceId} = i.id AND ${allocations.reversedAt} IS NULL AND ${payments.reversedAt} IS NULL), 0) AS taken
    FROM (VALUES ${sql.join(ids.map(id => sql`(${id}::uuid)`), sql`, `)}) AS i(id)
  `);
  const taken = new Map(rows.map(r => [r.invoice_id, Number(r.taken)]));
  return new Map(invoices.map(i => [i.id, (i.totalCents ?? 0) - (taken.get(i.id) ?? 0)]));
}

/** What is still owed on a finalised invoice of `totalCents`. */
export async function balanceCents(tx: AppDb, invoice: { id: string; totalCents: number | null }): Promise<number> {
  const taken = await takenOffCents(tx, invoice.id);
  return (invoice.totalCents ?? 0) - taken.adjustedCents - taken.allocatedCents;
}
