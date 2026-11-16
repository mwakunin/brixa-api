import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import { billableItems, memberships, stockBatches, stockItems, stockTransferBatches, stockTransferItems, stockTransfers, stores, user } from "@/db/schema";

import { TransferError } from "./transfers";

/** Transfers as the stores see them (P4 slice 2). Not patient data, so not audited. */

type TransferRow = typeof stockTransfers.$inferSelect;
export type TransferStatus = TransferRow["status"];

/** Transfers a page, newest first. */
export const TRANSFERS_PAGE = 50;

const fromStore = alias(stores, "from_store");
const toStore = alias(stores, "to_store");

export interface ListedTransfer {
  id: string;
  number: string;
  status: TransferStatus;
  fromStore: { id: string; name: string };
  toStore: { id: string; name: string };
  createdAt: Date;
  sentAt: Date | null;
  receivedAt: Date | null;
  /** Received short, the loss not yet accepted by a second person. */
  awaitingAcceptance: boolean;
}

function listed(row: { transfer: TransferRow; fromName: string; toName: string }): ListedTransfer {
  const t = row.transfer;
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    fromStore: { id: t.fromStoreId, name: row.fromName },
    toStore: { id: t.toStoreId, name: row.toName },
    createdAt: t.createdAt,
    sentAt: t.sentAt,
    receivedAt: t.receivedAt,
    awaitingAcceptance: t.shortfallReason !== null && t.shortfallAcceptedBy === null,
  };
}

/** Transfers from or to a store if given, of a status if given, or those awaiting a shortfall's acceptance. */
export async function listTransfers(
  tx: AppDb,
  filter: { storeId?: string; status?: TransferStatus; awaitingAcceptance?: boolean; offset?: number; id?: string } = {},
): Promise<ListedTransfer[]> {
  const rows = await tx
    .select({ transfer: stockTransfers, fromName: fromStore.name, toName: toStore.name })
    .from(stockTransfers)
    .innerJoin(fromStore, eq(fromStore.id, stockTransfers.fromStoreId))
    .innerJoin(toStore, eq(toStore.id, stockTransfers.toStoreId))
    .where(and(
      filter.id ? eq(stockTransfers.id, filter.id) : undefined,
      filter.storeId ? or(eq(stockTransfers.fromStoreId, filter.storeId), eq(stockTransfers.toStoreId, filter.storeId)) : undefined,
      filter.status ? eq(stockTransfers.status, filter.status) : undefined,
      filter.awaitingAcceptance ? and(isNotNull(stockTransfers.shortfallReason), isNull(stockTransfers.shortfallAcceptedBy)) : undefined,
    ))
    .orderBy(desc(stockTransfers.createdAt), desc(stockTransfers.number))
    .limit(TRANSFERS_PAGE)
    .offset(filter.offset ?? 0);
  return rows.map(listed);
}

interface Step { byName: string; at: Date }

export interface ShownTransfer extends ListedTransfer {
  requested: Step | null;
  sent: Step | null;
  received: Step | null;
  shortfallReason: string | null;
  shortfallAccepted: Step | null;
  closed: (Step & { reason: string }) | null;
  /** What the request asked for; none when sent without one. */
  items: { stockItemId: string; code: string; name: string; baseUnit: string; quantityRequested: number }[];
  /** What was sent, and once received what arrived, per batch. */
  batches: {
    batchId: string;
    stockItemId: string;
    code: string;
    name: string;
    batchNumber: string | null;
    expiresOn: string | null;
    quantitySent: number;
    quantityReceived: number | null;
  }[];
}

async function namesOf(tx: AppDb, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0)
    return new Map();
  const rows = await tx.select({ id: memberships.id, name: user.name }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(inArray(memberships.id, wanted));
  return new Map(rows.map(r => [r.id, r.name]));
}

/** One transfer: who did each step, what was asked for, and what each batch sent and received. */
export async function transferShown(tx: AppDb, id: string): Promise<ShownTransfer> {
  // Its state from one read; the list row only names its stores, which never change.
  const [row] = await listTransfers(tx, { id });
  if (!row)
    throw new TransferError("not_found");
  // Held shared, so a step being written (each locks the transfer) commits before it is read, or after: its batches read below match it.
  const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for("share");
  const state = listed({ transfer: t, fromName: row.fromStore.name, toName: row.toStore.name });
  const names = await namesOf(tx, [t.requestedBy, t.sentBy, t.receivedBy, t.shortfallAcceptedBy, t.closedBy]);
  const step = (by: string | null, at: Date | null): Step | null => by && at ? { byName: names.get(by) ?? "", at } : null;

  const items = await tx
    .select({ stockItemId: stockTransferItems.stockItemId, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit, quantityRequested: stockTransferItems.quantityRequested })
    .from(stockTransferItems)
    .innerJoin(stockItems, eq(stockItems.id, stockTransferItems.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(eq(stockTransferItems.transferId, id))
    .orderBy(asc(billableItems.code));
  const batches = await tx
    .select({
      batchId: stockTransferBatches.batchId,
      stockItemId: stockBatches.stockItemId,
      code: billableItems.code,
      name: billableItems.name,
      batchNumber: stockBatches.batchNumber,
      expiresOn: stockBatches.expiresOn,
      quantitySent: stockTransferBatches.quantitySent,
      quantityReceived: stockTransferBatches.quantityReceived,
    })
    .from(stockTransferBatches)
    .innerJoin(stockBatches, eq(stockBatches.id, stockTransferBatches.batchId))
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(eq(stockTransferBatches.transferId, id))
    .orderBy(asc(billableItems.code), asc(stockBatches.expiresOn));

  const closed = step(t.closedBy, t.closedAt);
  return {
    ...state,
    requested: step(t.requestedBy, t.requestedAt),
    sent: step(t.sentBy, t.sentAt),
    received: step(t.receivedBy, t.receivedAt),
    shortfallReason: t.shortfallReason,
    shortfallAccepted: step(t.shortfallAcceptedBy, t.shortfallAcceptedAt),
    closed: closed && { ...closed, reason: t.closeReason! },
    items,
    batches,
  };
}
