import { and, eq, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { numberSeries, numberSeriesCounters } from "@/db/schema";

import { businessDate } from "./dates";

/**
 * Human-facing sequential numbers: OP0042, ADM-2026-0153, L-20261103-017
 * (SCHEMA.md §6).
 *
 * Issued inside the caller's transaction, from a counter row: the row lock
 * serializes issuance per series and period, and a rolled-back transaction
 * takes its increment with it, so a series has no gaps to explain. For a
 * fiscal document that transaction is the one that freezes it (rule 20), and
 * nothing slow may run while it is open (rule 18).
 */

type Series = typeof numberSeries.$inferSelect;
export type SeriesKind = Series["kind"];
export type ResetPeriod = Series["resetPeriod"];

/** A series kind this facility has not registered: a setup error, not a user one. */
export class SeriesNotRegisteredError extends Error {
  constructor(kind: SeriesKind) {
    super(`No ${kind} number series is registered for this facility`);
    this.name = "SeriesNotRegisteredError";
  }
}

/**
 * Which counter `at` falls in, and how the period appears in the number.
 * Computed in Africa/Nairobi (rule 26): an admission at 01:00 on 1 January is
 * the new year's, though UTC still says December.
 */
export function periodOf(resetPeriod: ResetPeriod, at: Date): { key: string; label: string | null } {
  if (resetPeriod === "never")
    return { key: "all", label: null };

  const day = businessDate(at);
  if (resetPeriod === "yearly")
    return { key: day.slice(0, 4), label: day.slice(0, 4) };

  return { key: day, label: day.replaceAll("-", "") };
}

/**
 * `OP` + 42 at width 4 gives `OP0042`; `ADM-` + 2026 + 153 gives
 * `ADM-2026-0153`. A value wider than the padding grows; it never truncates.
 */
export function formatNumber(prefix: string, label: string | null, value: number, padding: number): string {
  return `${prefix}${label ? `${label}-` : ""}${String(value).padStart(padding, "0")}`;
}

/**
 * Registers a series and its first counter, at facility onboarding.
 *
 * `startAt` lets a hospital moving from a paper register continue from its
 * current number, so generated numbers cannot collide with legacy ones
 * (SCHEMA.md §6).
 */
export async function registerSeries(
  tx: AppDb,
  input: {
    facilityId: string;
    kind: SeriesKind;
    prefix: string;
    padding?: number;
    resetPeriod: ResetPeriod;
    startAt?: number;
    at?: Date;
  },
): Promise<void> {
  const [series] = await tx
    .insert(numberSeries)
    .values({
      facilityId: input.facilityId,
      kind: input.kind,
      prefix: input.prefix,
      padding: input.padding ?? 4,
      resetPeriod: input.resetPeriod,
    })
    .returning({ id: numberSeries.id });

  await tx.insert(numberSeriesCounters).values({
    facilityId: input.facilityId,
    seriesId: series.id,
    periodKey: periodOf(input.resetPeriod, input.at ?? new Date()).key,
    nextValue: input.startAt ?? 1,
  });
}

/**
 * Issues the next number of `kind` at this facility.
 *
 * The counter for a new period is created on first use; `ON CONFLICT DO
 * NOTHING` lets two transactions race to create it and then queue on the
 * same row. The UPDATE takes the row lock, so a second issuer waits for the
 * first to commit or roll back rather than reading a stale value.
 */
export async function issueNumber(
  tx: AppDb,
  facilityId: string,
  kind: SeriesKind,
  at: Date = new Date(),
): Promise<string> {
  const [series] = await tx
    .select()
    .from(numberSeries)
    .where(and(eq(numberSeries.facilityId, facilityId), eq(numberSeries.kind, kind)))
    .limit(1);

  if (!series)
    throw new SeriesNotRegisteredError(kind);

  const period = periodOf(series.resetPeriod, at);

  await tx
    .insert(numberSeriesCounters)
    .values({ facilityId, seriesId: series.id, periodKey: period.key })
    .onConflictDoNothing({ target: [numberSeriesCounters.seriesId, numberSeriesCounters.periodKey] });

  const [counter] = await tx
    .update(numberSeriesCounters)
    .set({ nextValue: sql`${numberSeriesCounters.nextValue} + 1` })
    .where(and(
      eq(numberSeriesCounters.seriesId, series.id),
      eq(numberSeriesCounters.periodKey, period.key),
    ))
    .returning({ issued: sql<number>`${numberSeriesCounters.nextValue} - 1` });

  return formatNumber(series.prefix, period.label, Number(counter.issued), series.padding);
}
