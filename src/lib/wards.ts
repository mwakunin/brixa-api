import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { beds, bedStays, billableItems, wards } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";

/**
 * Wards and their beds: set up by the facility admin, chosen at admission and
 * transfer. Occupancy is derived from open bed stays, never stored (rule 4).
 */

type WardRow = typeof wards.$inferSelect;
type BedRow = typeof beds.$inferSelect;

export class WardError extends Error {
  constructor(readonly code: "ward_not_found" | "name_taken" | "label_taken" | "not_a_bed_day_item") {
    super({
      ward_not_found: "No such ward",
      name_taken: "A ward already has that name",
      label_taken: "That ward already has a bed with that label",
      not_a_bed_day_item: "That item is not an active bed-day item",
    }[code]);
    this.name = "WardError";
  }
}

/**
 * Sets what a night in the ward is charged as. Its price comes from the
 * price list on each night's date, so a ward's rate changes by price change,
 * not by editing the ward.
 */
export async function setBedDayItem(tx: AppDb, facilityId: string, wardId: string, itemId: string, actor: PatientActor): Promise<WardRow> {
  const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, itemId)).limit(1);
  if (!item || item.category !== "bed_day" || !item.isActive)
    throw new WardError("not_a_bed_day_item");

  const [ward] = await tx.update(wards).set({ bedDayItemId: itemId }).where(eq(wards.id, wardId)).returning();
  if (!ward)
    throw new WardError("ward_not_found");

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "ward.bed_day_item_set",
    entityType: "ward",
    entityId: wardId,
    summary: `${ward.name} is now charged as ${item.code}`,
    detail: { code: item.code },
  });
  return ward;
}

export async function createWard(tx: AppDb, facilityId: string, name: string, actor: PatientActor): Promise<WardRow> {
  try {
    const [ward] = await tx.insert(wards).values({ facilityId, name }).returning();
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "ward.created",
      entityType: "ward",
      entityId: ward.id,
      summary: `Created ward ${name}`,
    });
    return ward;
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new WardError("name_taken");
    throw err;
  }
}

export async function addBed(tx: AppDb, facilityId: string, wardId: string, label: string, actor: PatientActor): Promise<BedRow> {
  const [ward] = await tx.select({ id: wards.id, name: wards.name }).from(wards).where(eq(wards.id, wardId)).limit(1);
  if (!ward)
    throw new WardError("ward_not_found");

  try {
    const [bed] = await tx.insert(beds).values({ facilityId, wardId, label }).returning();
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "bed.created",
      entityType: "bed",
      entityId: bed.id,
      summary: `Added bed ${label} to ${ward.name}`,
    });
    return bed;
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new WardError("label_taken");
    throw err;
  }
}

export interface ListedWard {
  id: string;
  name: string;
  isActive: boolean;
  bedDayItemId: string | null;
  beds: { id: string; label: string; isActive: boolean; occupied: boolean }[];
}

/** Every ward with its beds, and whether each bed is occupied now. */
export async function listWards(tx: AppDb): Promise<ListedWard[]> {
  const rows = await tx
    .select({
      wardId: wards.id,
      wardName: wards.name,
      wardActive: wards.isActive,
      bedDayItemId: wards.bedDayItemId,
      bedId: beds.id,
      label: beds.label,
      bedActive: beds.isActive,
      occupied: sql<boolean>`EXISTS (
        SELECT 1 FROM ${bedStays} WHERE ${bedStays.bedId} = ${beds.id} AND ${bedStays.endedAt} IS NULL
      )`,
    })
    .from(wards)
    .leftJoin(beds, eq(beds.wardId, wards.id))
    .orderBy(asc(wards.name), asc(beds.label));

  const byWard = new Map<string, ListedWard>();
  for (const row of rows) {
    const ward = byWard.get(row.wardId)
      ?? { id: row.wardId, name: row.wardName, isActive: row.wardActive, bedDayItemId: row.bedDayItemId, beds: [] };
    if (row.bedId)
      ward.beds.push({ id: row.bedId, label: row.label!, isActive: row.bedActive!, occupied: row.occupied });
    byWard.set(row.wardId, ward);
  }
  return [...byWard.values()];
}

export interface BedWithWard {
  id: string;
  label: string;
  isActive: boolean;
  wardName: string;
  wardActive: boolean;
}

/** The bed and its ward, if it exists here. */
export async function bedWithWard(tx: AppDb, bedId: string): Promise<BedWithWard | null> {
  const [bed] = await tx
    .select({ id: beds.id, label: beds.label, isActive: beds.isActive, wardName: wards.name, wardActive: wards.isActive })
    .from(beds)
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .where(eq(beds.id, bedId))
    .limit(1);
  return bed ?? null;
}

/** Whether someone is in this bed now. */
export async function bedOccupied(tx: AppDb, bedId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: bedStays.id })
    .from(bedStays)
    .where(and(eq(bedStays.bedId, bedId), isNull(bedStays.endedAt)))
    .limit(1);
  return Boolean(open);
}
