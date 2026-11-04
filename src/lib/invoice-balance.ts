import { and, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { allocations, invoiceAdjustments, payments } from "@/db/schema";

/**
 * What has been taken off an invoice, derived and never stored (rule 4):
 * approved adjustments and live allocations share its total (M3). An
 * allocation is live while neither it nor its payment is reversed.
 */

/** Σ approved adjustments of an invoice. */
export async function adjustedCents(tx: AppDb, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${invoiceAdjustments.amountCents}), 0)`.mapWith(Number) })
    .from(invoiceAdjustments)
    .where(and(eq(invoiceAdjustments.invoiceId, invoiceId), eq(invoiceAdjustments.status, "approved")));
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

/** What is still owed on a finalised invoice of `totalCents`. */
export async function balanceCents(tx: AppDb, invoice: { id: string; totalCents: number | null }): Promise<number> {
  return (invoice.totalCents ?? 0) - await adjustedCents(tx, invoice.id) - await allocatedCents(tx, invoice.id);
}
