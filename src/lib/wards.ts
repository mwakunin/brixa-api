import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { beds, bedStays, wards } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";

/**
 * Wards and their beds: set up by the facility admin, chosen at admission and
 * transfer. Occupancy is derived from open bed stays, never stored (rule 4).
 */

export class WardError extends Error {
  constructor(readonly code: "ward_not_found" | "name_taken" | "label_taken") {
    super({
      ward_not_found: "No such ward",
      name_taken: "A ward already has that name",
      label_taken: "That ward already has a bed with that label",
    }[code]);
    this.name = "WardError";
  }
}

export async function createWard(tx: AppDb, facilityId: string, name: string, actor: PatientActor) {
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

export async function addBed(tx: AppDb, facilityId: string, wardId: string, label: string, actor: PatientActor) {
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

/** Every ward with its beds, and whether each bed is occupied now. */
export async function listWards(tx: AppDb) {
  const rows = await tx
    .select({
      wardId: wards.id,
      wardName: wards.name,
      wardActive: wards.isActive,
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

  const byWard = new Map<string, { id: string; name: string; isActive: boolean; beds: { id: string; label: string; isActive: boolean; occupied: boolean }[] }>();
  for (const row of rows) {
    const ward = byWard.get(row.wardId) ?? { id: row.wardId, name: row.wardName, isActive: row.wardActive, beds: [] };
    if (row.bedId)
      ward.beds.push({ id: row.bedId, label: row.label!, isActive: row.bedActive!, occupied: row.occupied });
    byWard.set(row.wardId, ward);
  }
  return [...byWard.values()];
}

/** The bed and its ward, if it exists here. */
export async function bedWithWard(tx: AppDb, bedId: string) {
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
