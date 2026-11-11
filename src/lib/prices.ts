import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, priceChangeLines, priceChanges, priceListItems, priceLists } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate } from "./dates";
import { isUniqueViolation } from "./db-errors";

/**
 * The item catalogue and its prices (SCHEMA.md §7.2).
 *
 * `resolvePrice` is the only place a price is chosen (rule 21). Prices change
 * only through a request a second person approves (rule 24), and each
 * approval records every item's old and new price (CLAUDE.md §6).
 */

type BillableItemRow = typeof billableItems.$inferSelect;
type PriceChangeRow = typeof priceChanges.$inferSelect;
export type ItemCategory = BillableItemRow["category"];

export class PriceError extends Error {
  constructor(readonly code:
    | "code_taken"
    | "item_not_found"
    | "item_inactive"
    | "duplicate_item"
    | "effective_in_past"
    | "change_not_found"
    | "not_pending"
    | "same_person"
    | "not_requester"
    | "no_cash_list") {
    super({
      code_taken: "Another item has that code",
      item_not_found: "No such item",
      item_inactive: "That item is retired",
      duplicate_item: "An item appears twice in one change",
      effective_in_past: "The effective date has passed; choose today or later",
      change_not_found: "No such price change",
      not_pending: "This price change has already been decided",
      same_person: "A price change is approved or rejected by someone other than its requester",
      not_requester: "Only the requester can withdraw a price change",
      no_cash_list: "This facility has no cash price list",
    }[code]);
    this.name = "PriceError";
  }
}

/** The facility's cash list, which prices the patient account. */
export async function cashPriceList(tx: AppDb): Promise<string> {
  const [list] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.kind, "cash")).limit(1);
  if (!list)
    throw new PriceError("no_cash_list");
  return list.id;
}

/**
 * The price of `billableItemId` on `priceListId` for `serviceDate`, or null
 * when the list does not cover it. Never falls back to another list.
 */
export async function resolvePrice(
  tx: AppDb,
  input: { billableItemId: string; priceListId: string; serviceDate: string },
): Promise<{ priceListItemId: string; unitPriceCents: number } | null> {
  const [price] = await tx
    .select({ priceListItemId: priceListItems.id, unitPriceCents: priceListItems.unitPriceCents })
    .from(priceListItems)
    .where(and(
      eq(priceListItems.priceListId, input.priceListId),
      eq(priceListItems.billableItemId, input.billableItemId),
      lte(priceListItems.validFrom, input.serviceDate),
      or(isNull(priceListItems.validTo), gt(priceListItems.validTo, input.serviceDate)),
    ))
    .limit(1);
  return price ?? null;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export async function createBillableItem(
  tx: AppDb,
  facilityId: string,
  input: { code: string; name: string; category: ItemCategory },
  actor: PatientActor,
): Promise<BillableItemRow> {
  try {
    const [item] = await tx.insert(billableItems).values({ facilityId, ...input }).returning();
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "billable_item.created",
      entityType: "billable_item",
      entityId: item.id,
      summary: `Added ${input.code} ${input.name}`,
      detail: { code: input.code, category: input.category },
    });
    return item;
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new PriceError("code_taken");
    throw err;
  }
}

export interface ListedBillableItem {
  id: string;
  code: string;
  name: string;
  category: ItemCategory;
  isActive: boolean;
  cashPriceCents: number | null;
}

/** The catalogue, each item with its cash price today (null when it has none). */
export async function listBillableItems(tx: AppDb, today = businessDate()): Promise<ListedBillableItem[]> {
  const listId = await cashPriceList(tx);
  return tx
    .select({
      id: billableItems.id,
      code: billableItems.code,
      name: billableItems.name,
      category: billableItems.category,
      isActive: billableItems.isActive,
      cashPriceCents: priceListItems.unitPriceCents,
    })
    .from(billableItems)
    .leftJoin(priceListItems, and(
      eq(priceListItems.billableItemId, billableItems.id),
      eq(priceListItems.priceListId, listId),
      lte(priceListItems.validFrom, today),
      or(isNull(priceListItems.validTo), gt(priceListItems.validTo, today)),
    ))
    .orderBy(asc(billableItems.code));
}

// ---------------------------------------------------------------------------
// Price changes
// ---------------------------------------------------------------------------

export async function requestPriceChange(
  tx: AppDb,
  facilityId: string,
  input: { effectiveFrom: string; reason: string; lines: { billableItemId: string; unitPriceCents: number }[] },
  actor: PatientActor,
): Promise<PriceChangeRow> {
  if (input.effectiveFrom < businessDate())
    throw new PriceError("effective_in_past");

  const ids = input.lines.map(l => l.billableItemId);
  if (new Set(ids).size !== ids.length)
    throw new PriceError("duplicate_item");

  const items = await tx.select({ id: billableItems.id, isActive: billableItems.isActive }).from(billableItems).where(inArray(billableItems.id, ids));
  if (items.length !== ids.length)
    throw new PriceError("item_not_found");
  if (items.some(i => !i.isActive))
    throw new PriceError("item_inactive");

  const priceListId = await cashPriceList(tx);
  const [change] = await tx.insert(priceChanges).values({
    facilityId,
    priceListId,
    effectiveFrom: input.effectiveFrom,
    reason: input.reason,
    requestedBy: actor.membershipId,
  }).returning();
  await tx.insert(priceChangeLines).values(input.lines.map(l => ({ facilityId, priceChangeId: change.id, ...l })));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "price_change.requested",
    entityType: "price_change",
    entityId: change.id,
    summary: `Requested ${input.lines.length} price change(s) from ${input.effectiveFrom}`,
    detail: { effectiveFrom: input.effectiveFrom, reason: input.reason, lines: input.lines },
  });
  return change;
}

async function lockPending(tx: AppDb, id: string) {
  const [change] = await tx.select().from(priceChanges).where(eq(priceChanges.id, id)).for("update").limit(1);
  if (!change)
    throw new PriceError("change_not_found");
  if (change.status !== "pending")
    throw new PriceError("not_pending");
  return change;
}

/**
 * Applies a price change: from its effective day, each item's new price
 * replaces whatever would have applied. An earlier price ends that day; a
 * later one already approved ends on its own start, so it never applies.
 */
export async function approvePriceChange(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<void> {
  const change = await lockPending(tx, id);
  if (change.requestedBy === actor.membershipId)
    throw new PriceError("same_person");
  if (change.effectiveFrom < businessDate())
    throw new PriceError("effective_in_past");

  const lines = await tx
    .select({ billableItemId: priceChangeLines.billableItemId, unitPriceCents: priceChangeLines.unitPriceCents, code: billableItems.code })
    .from(priceChangeLines)
    .innerJoin(billableItems, eq(billableItems.id, priceChangeLines.billableItemId))
    .where(eq(priceChangeLines.priceChangeId, id));

  const from = change.effectiveFrom;
  const applied: { code: string; from: number | null; to: number }[] = [];

  for (const line of lines) {
    const before = await resolvePrice(tx, { billableItemId: line.billableItemId, priceListId: change.priceListId, serviceDate: from });
    const sameItem = and(eq(priceListItems.priceListId, change.priceListId), eq(priceListItems.billableItemId, line.billableItemId));

    // Already-approved prices starting on or after this one never apply.
    await tx.update(priceListItems)
      .set({ validTo: sql`${priceListItems.validFrom}` })
      .where(and(sameItem, gte(priceListItems.validFrom, from), or(isNull(priceListItems.validTo), gt(priceListItems.validTo, priceListItems.validFrom))));
    // The price running into this one ends the day it starts.
    await tx.update(priceListItems)
      .set({ validTo: from })
      .where(and(sameItem, lt(priceListItems.validFrom, from), or(isNull(priceListItems.validTo), gt(priceListItems.validTo, from))));
    await tx.insert(priceListItems).values({
      facilityId,
      priceListId: change.priceListId,
      billableItemId: line.billableItemId,
      unitPriceCents: line.unitPriceCents,
      validFrom: from,
      priceChangeId: id,
    });

    applied.push({ code: line.code, from: before?.unitPriceCents ?? null, to: line.unitPriceCents });
  }

  await tx.update(priceChanges)
    .set({ status: "approved", decidedBy: actor.membershipId, decidedAt: new Date() })
    .where(eq(priceChanges.id, id));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "price_change.approved",
    entityType: "price_change",
    entityId: id,
    summary: `Approved ${applied.length} price change(s) from ${from}`,
    detail: { effectiveFrom: from, prices: applied },
  });
}

export async function rejectPriceChange(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<void> {
  const change = await lockPending(tx, id);
  if (change.requestedBy === actor.membershipId)
    throw new PriceError("same_person");

  await tx.update(priceChanges).set({ status: "rejected", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(priceChanges.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "price_change.rejected",
    entityType: "price_change",
    entityId: id,
    summary: "Rejected a price change",
  });
}

export async function withdrawPriceChange(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<void> {
  const change = await lockPending(tx, id);
  if (change.requestedBy !== actor.membershipId)
    throw new PriceError("not_requester");

  await tx.update(priceChanges).set({ status: "withdrawn", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(priceChanges.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "price_change.withdrawn",
    entityType: "price_change",
    entityId: id,
    summary: "Withdrew a price change",
  });
}

/** One item's new price in a price change. */
export interface PriceChangeLine {
  priceChangeId: string;
  billableItemId: string;
  code: string;
  name: string;
  unitPriceCents: number;
}

export interface ListedPriceChange extends PriceChangeRow {
  lines: PriceChangeLine[];
}

/** Price changes, newest first, each with its lines: all, one status's, or one. */
export async function listPriceChanges(
  tx: AppDb,
  filter: { status?: PriceChangeRow["status"]; id?: string } = {},
): Promise<ListedPriceChange[]> {
  const changes = await tx
    .select()
    .from(priceChanges)
    .where(and(
      filter.status ? eq(priceChanges.status, filter.status) : undefined,
      filter.id ? eq(priceChanges.id, filter.id) : undefined,
    ))
    .orderBy(sql`${priceChanges.requestedAt} DESC`)
    .limit(100);
  if (changes.length === 0)
    return [];

  const lines = await tx
    .select({
      priceChangeId: priceChangeLines.priceChangeId,
      billableItemId: priceChangeLines.billableItemId,
      code: billableItems.code,
      name: billableItems.name,
      unitPriceCents: priceChangeLines.unitPriceCents,
    })
    .from(priceChangeLines)
    .innerJoin(billableItems, eq(billableItems.id, priceChangeLines.billableItemId))
    .where(inArray(priceChangeLines.priceChangeId, changes.map(c => c.id)))
    .orderBy(asc(billableItems.code));

  return changes.map(c => ({ ...c, lines: lines.filter(l => l.priceChangeId === c.id) }));
}
