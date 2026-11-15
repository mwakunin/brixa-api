import { and, eq, inArray, or } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { stockItems, stockMovements, stockTransferBatches, stockTransferItems, stockTransfers, stores } from "@/db/schema";

import type { PatientActor } from "./patients";
import type { TakeLine } from "./stock-allocation";

import { recordAudit } from "./audit";
import { businessDate } from "./dates";
import { issueNumber } from "./number-series";
import { allocate } from "./stock-allocation";

/**
 * Transfers between stores (SCHEMA.md §8, P4 slice 2, decided 2026-11-15):
 * requested by the receiving side, or sent without a request; sent by the
 * sending side, which approves it in the act; received by someone else,
 * with any shortfall explained and accepted by a second person.
 *
 * Lock order: the transfer, then its stores (shared, by id), its items
 * (shared, by id) and its batches (lib/stock-levels.ts).
 */

type TransferRow = typeof stockTransfers.$inferSelect;

/** Who requests, sends and receives, for any store. */
export const TRANSFER_STAFF = ["pharmacist", "pharm_tech", "storekeeper"] as const satisfies readonly MembershipRole[];
/** Who requests for and receives into a ward's store, and no other. */
export const WARD_STAFF = ["nurse", "ward_nurse"] as const satisfies readonly MembershipRole[];
/** Who accepts the loss a short receipt leaves (rule 24): never its receiver. */
export const SHORTFALL_APPROVERS = ["finance_manager", "pharmacist"] as const satisfies readonly MembershipRole[];
export const TRANSFER_READERS = [...TRANSFER_STAFF, ...WARD_STAFF, "facility_admin", "finance_manager", "auditor"] as const satisfies readonly MembershipRole[];

/** A member acting on a transfer, with the roles that decide which stores they may act for. */
export interface StockActor extends PatientActor {
  roles: readonly MembershipRole[];
}

export type TransferErrorCode
  = | "not_found"
    | "store_not_found"
    | "store_retired"
    | "same_store"
    | "ward_store_only"
    | "item_not_found"
    | "item_retired"
    | "not_open"
    | "not_sent"
    | "not_requester"
    | "same_person"
    | "batch_not_in_transfer"
    | "more_than_sent"
    | "shortfall_reason_needed"
    | "no_shortfall";

export class TransferError extends Error {
  constructor(readonly code: TransferErrorCode) {
    super({
      not_found: "No such transfer",
      store_not_found: "No such store",
      store_retired: "That store is retired",
      same_store: "A transfer goes from one store to another",
      ward_store_only: "Nurses request for and receive into a ward's store only",
      item_not_found: "That is not a stock item of this facility",
      item_retired: "That stock item is retired",
      not_open: "This transfer is no longer a request: it has been sent, cancelled or declined",
      not_sent: "This transfer is not on its way: it has not been sent, or has been received",
      not_requester: "Only whoever asked for it may cancel a request; the sending store declines it",
      same_person: "This is for someone other than whoever did the step before it",
      batch_not_in_transfer: "That batch is not on this transfer",
      more_than_sent: "More cannot arrive than was sent",
      shortfall_reason_needed: "Less arrived than was sent: say why",
      no_shortfall: "Nothing on this transfer is waiting to be accepted",
    }[code]);
    this.name = "TransferError";
  }
}

const holdsAny = (actor: StockActor, roles: readonly MembershipRole[]) => actor.roles.some(r => roles.includes(r));

/** Both stores, active and different, held shared so neither is retired while this goes on. */
async function lockStores(tx: AppDb, fromStoreId: string, toStoreId: string): Promise<{ to: { kind: string } }> {
  if (fromStoreId.toLowerCase() === toStoreId.toLowerCase())
    throw new TransferError("same_store");
  const found = await tx
    .select({ id: stores.id, kind: stores.kind, isActive: stores.isActive })
    .from(stores)
    .where(inArray(stores.id, [fromStoreId, toStoreId]))
    .orderBy(stores.id)
    .for("share");
  if (found.length !== 2)
    throw new TransferError("store_not_found");
  if (found.some(s => !s.isActive))
    throw new TransferError("store_retired");
  return { to: found.find(s => s.id === toStoreId.toLowerCase())! };
}

/** A nurse acts only for a ward's store; the stores' own staff for any. */
function checkWardRule(actor: StockActor, toStore: { kind: string }): void {
  if (!holdsAny(actor, TRANSFER_STAFF) && toStore.kind !== "ward")
    throw new TransferError("ward_store_only");
}

async function lockTransfer(tx: AppDb, id: string): Promise<TransferRow> {
  const [transfer] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for("update").limit(1);
  if (!transfer)
    throw new TransferError("not_found");
  return transfer;
}

async function audit(tx: AppDb, transfer: TransferRow, actor: PatientActor, action: `stock_transfer.${"requested" | "sent" | "received" | "shortfall_accepted" | "cancelled" | "declined"}`, summary: string, detail: Record<string, unknown>): Promise<void> {
  await recordAudit(tx, { facilityId: transfer.facilityId, actorId: actor.userId, action, entityType: "stock_transfer", entityId: transfer.id, summary: `${summary} ${transfer.number}`, detail: { number: transfer.number, ...detail } });
}

/** Asks another store for stock, per item in base units. */
export async function requestTransfer(
  tx: AppDb,
  facilityId: string,
  input: { fromStoreId: string; toStoreId: string; items: { stockItemId: string; quantity: number }[] },
  actor: StockActor,
): Promise<TransferRow> {
  const { to } = await lockStores(tx, input.fromStoreId, input.toStoreId);
  checkWardRule(actor, to);
  const ids = input.items.map(i => i.stockItemId.toLowerCase());
  const items = await tx.select({ id: stockItems.id, isActive: stockItems.isActive }).from(stockItems).where(inArray(stockItems.id, ids));
  if (items.length !== new Set(ids).size)
    throw new TransferError("item_not_found");
  if (items.some(i => !i.isActive))
    throw new TransferError("item_retired");

  const [transfer] = await tx.insert(stockTransfers).values({
    facilityId,
    number: await issueNumber(tx, facilityId, "stock_transfer"),
    fromStoreId: input.fromStoreId,
    toStoreId: input.toStoreId,
    status: "requested",
    requestedBy: actor.membershipId,
    requestedAt: new Date(),
  }).returning();
  await tx.insert(stockTransferItems).values(input.items.map((i, n) => ({ facilityId, transferId: transfer.id, stockItemId: ids[n], quantityRequested: i.quantity })));
  await audit(tx, transfer, actor, "stock_transfer.requested", "Requested", { items: input.items.length });
  return transfer;
}

/** Takes the lines' stock out of the sending store and onto the transfer, and audits it as sent. */
async function moveOut(tx: AppDb, transfer: TransferRow, lines: TakeLine[], actor: StockActor, today: string): Promise<void> {
  const taken = (await allocate(tx, transfer.facilityId, transfer.fromStoreId, lines, today)).flat();
  // One row per batch, though two lines of one item drew on it.
  const perBatch = new Map<string, number>();
  for (const t of taken)
    perBatch.set(t.batchId, (perBatch.get(t.batchId) ?? 0) + t.quantity);
  const batches = [...perBatch].map(([batchId, quantity]) => ({ batchId, quantity }));

  await tx.insert(stockTransferBatches).values(batches.map(b => ({ facilityId: transfer.facilityId, transferId: transfer.id, batchId: b.batchId, quantitySent: b.quantity })));
  await tx.insert(stockMovements).values(batches.map(b => ({
    facilityId: transfer.facilityId,
    storeId: transfer.fromStoreId,
    batchId: b.batchId,
    kind: "transfer_out" as const,
    quantity: -b.quantity,
    transferId: transfer.id,
    recordedBy: actor.membershipId,
  })));
  await audit(tx, transfer, actor, "stock_transfer.sent", "Sent", { batches, requested: transfer.requestedBy !== null });
}

/** Sends what a request asked for, or less: its rest is a new request. */
export async function sendTransfer(tx: AppDb, facilityId: string, id: string, lines: TakeLine[], actor: StockActor, today = businessDate()): Promise<TransferRow> {
  const transfer = await lockTransfer(tx, id);
  if (transfer.status !== "requested")
    throw new TransferError("not_open");
  await lockStores(tx, transfer.fromStoreId, transfer.toStoreId);
  const [sent] = await tx.update(stockTransfers)
    .set({ status: "sent", sentBy: actor.membershipId, sentAt: new Date() })
    .where(eq(stockTransfers.id, transfer.id))
    .returning();
  await moveOut(tx, sent, lines, actor, today);
  return sent;
}

/** Sends stock to another store without a request: the main store topping up a ward. */
export async function sendDirect(
  tx: AppDb,
  facilityId: string,
  input: { fromStoreId: string; toStoreId: string; lines: TakeLine[] },
  actor: StockActor,
  today = businessDate(),
): Promise<TransferRow> {
  await lockStores(tx, input.fromStoreId, input.toStoreId);
  const [transfer] = await tx.insert(stockTransfers).values({
    facilityId,
    number: await issueNumber(tx, facilityId, "stock_transfer"),
    fromStoreId: input.fromStoreId,
    toStoreId: input.toStoreId,
    status: "sent",
    sentBy: actor.membershipId,
    sentAt: new Date(),
  }).returning();
  await moveOut(tx, transfer, input.lines, actor, today);
  return transfer;
}

export interface Receipt {
  /** What arrived of each batch; a batch not named arrived whole. */
  received?: { batchId: string; quantity: number }[];
  shortfallReason?: string;
}

/** What arrived of each batch on the transfer, refusing a batch it does not carry or more than was sent. */
function arrivals(sent: { id: string; batchId: string; quantitySent: number }[], receipt: Receipt): Map<string, number> {
  const arrived = new Map(sent.map(b => [b.batchId, b.quantitySent]));
  for (const r of receipt.received ?? []) {
    const batchId = r.batchId.toLowerCase();
    const was = sent.find(b => b.batchId === batchId);
    if (!was)
      throw new TransferError("batch_not_in_transfer");
    if (r.quantity > was.quantitySent)
      throw new TransferError("more_than_sent");
    arrived.set(batchId, r.quantity);
  }
  return arrived;
}

/** Receives a transfer once, by someone other than its sender; a shortfall needs its reason. */
export async function receiveTransfer(tx: AppDb, facilityId: string, id: string, receipt: Receipt, actor: StockActor): Promise<TransferRow> {
  const transfer = await lockTransfer(tx, id);
  if (transfer.status !== "sent")
    throw new TransferError("not_sent");
  if (transfer.sentBy === actor.membershipId)
    throw new TransferError("same_person");
  const { to } = await lockStores(tx, transfer.fromStoreId, transfer.toStoreId);
  checkWardRule(actor, to);

  const sent = await tx.select({ id: stockTransferBatches.id, batchId: stockTransferBatches.batchId, quantitySent: stockTransferBatches.quantitySent })
    .from(stockTransferBatches)
    .where(eq(stockTransferBatches.transferId, id));
  const arrived = arrivals(sent, receipt);
  const short = sent.filter(b => arrived.get(b.batchId)! < b.quantitySent);
  if (short.length > 0 && !receipt.shortfallReason)
    throw new TransferError("shortfall_reason_needed");

  for (const b of sent)
    await tx.update(stockTransferBatches).set({ quantityReceived: arrived.get(b.batchId)! }).where(eq(stockTransferBatches.id, b.id));
  const into = sent.filter(b => arrived.get(b.batchId)! > 0);
  if (into.length > 0) {
    await tx.insert(stockMovements).values(into.map(b => ({
      facilityId,
      storeId: transfer.toStoreId,
      batchId: b.batchId,
      kind: "transfer_in" as const,
      quantity: arrived.get(b.batchId)!,
      transferId: id,
      recordedBy: actor.membershipId,
    })));
  }
  const [received] = await tx.update(stockTransfers)
    .set({ status: "received", receivedBy: actor.membershipId, receivedAt: new Date(), shortfallReason: short.length > 0 ? receipt.shortfallReason! : null })
    .where(eq(stockTransfers.id, id))
    .returning();
  await audit(tx, received, actor, "stock_transfer.received", "Received", {
    shortfall: short.map(b => ({ batchId: b.batchId, sent: b.quantitySent, received: arrived.get(b.batchId) })),
    reason: received.shortfallReason,
  });
  return received;
}

/** A second person accepts the loss a short receipt left (rule 24). */
export async function acceptShortfall(tx: AppDb, facilityId: string, id: string, actor: StockActor): Promise<TransferRow> {
  const transfer = await lockTransfer(tx, id);
  if (transfer.status !== "received" || !transfer.shortfallReason || transfer.shortfallAcceptedBy)
    throw new TransferError("no_shortfall");
  if (transfer.receivedBy === actor.membershipId)
    throw new TransferError("same_person");
  const [accepted] = await tx.update(stockTransfers)
    .set({ shortfallAcceptedBy: actor.membershipId, shortfallAcceptedAt: new Date() })
    .where(eq(stockTransfers.id, id))
    .returning();
  await audit(tx, accepted, actor, "stock_transfer.shortfall_accepted", "Accepted the shortfall on", { reason: accepted.shortfallReason });
  return accepted;
}

/** Closes a request before it is sent: cancelled by its requester, or declined by the sending store. */
export async function closeRequest(tx: AppDb, facilityId: string, id: string, how: "cancelled" | "declined", reason: string, actor: StockActor): Promise<TransferRow> {
  const transfer = await lockTransfer(tx, id);
  if (transfer.status !== "requested")
    throw new TransferError("not_open");
  if (how === "cancelled" && transfer.requestedBy !== actor.membershipId)
    throw new TransferError("not_requester");
  const [closed] = await tx.update(stockTransfers)
    .set({ status: how, closedBy: actor.membershipId, closedAt: new Date(), closeReason: reason })
    .where(eq(stockTransfers.id, id))
    .returning();
  await audit(tx, closed, actor, `stock_transfer.${how}`, how === "cancelled" ? "Cancelled" : "Declined", { reason });
  return closed;
}

/** Whether a store has a transfer still open from or to it: a request, or stock on its way. */
export async function hasOpenTransfers(tx: AppDb, storeId: string): Promise<boolean> {
  const [open] = await tx.select({ id: stockTransfers.id }).from(stockTransfers).where(and(
    inArray(stockTransfers.status, ["requested", "sent"]),
    or(eq(stockTransfers.fromStoreId, storeId), eq(stockTransfers.toStoreId, storeId)),
  )).limit(1);
  return open !== undefined;
}
