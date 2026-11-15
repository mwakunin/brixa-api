import { and, asc, count, desc, eq, inArray, ne, sql, sum } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { billableItems, goodsReceived, memberships, stockBatches, stockItems, stockMovements, stores, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { addDays, businessDate } from "./dates";
import { issueNumber } from "./number-series";
import { lockBatches } from "./stock-levels";

/**
 * Goods received (SCHEMA.md §8, P4 slice 1b, decided 2026-11-15): a
 * delivery into a store, each line its own batch with its own cost, and a
 * `receipt` movement putting it on the store's shelf.
 */

type NoteRow = typeof goodsReceived.$inferSelect;

/** Who receives deliveries and reverses a mistyped line. Not clinical acts, so no licence is asked. */
export const RECEIVERS = ["pharmacist", "pharm_tech", "storekeeper"] as const satisfies readonly MembershipRole[];

/** Who sees what the stores hold and what it cost. */
export const STOCK_READERS = ["facility_admin", "pharmacist", "pharm_tech", "storekeeper", "finance_manager", "auditor"] as const satisfies readonly MembershipRole[];

/** A batch expiring within this many days is taken with a warning (P4 question 10's window). */
export const EXPIRY_WARNING_DAYS = 90;

/** The most base units one line may bring: far beyond any delivery, and inside an integer. */
export const MAX_LINE_QUANTITY = 100_000_000;

/** Notes a page, newest first. */
export const NOTES_PAGE = 50;

export type GoodsReceivedErrorCode
  = | "not_found"
    | "batch_not_found"
    | "store_not_found"
    | "store_retired"
    | "item_not_found"
    | "item_retired"
    | "batch_number_needed"
    | "expiry_needed"
    | "already_expired"
    | "quantity_too_large"
    | "received_in_future"
    | "already_reversed"
    | "batch_moved";

export class GoodsReceivedError extends Error {
  constructor(readonly code: GoodsReceivedErrorCode, readonly line?: number) {
    super(`${line === undefined ? "" : `Line ${line}: `}${{
      not_found: "No such goods-received note",
      batch_not_found: "No such batch",
      store_not_found: "No such store",
      store_retired: "That store is retired",
      item_not_found: "That is not a stock item of this facility",
      item_retired: "That stock item is retired",
      batch_number_needed: "A drug's batch number is needed",
      expiry_needed: "A drug's expiry date is needed",
      already_expired: "This batch has expired; expired stock is not received",
      quantity_too_large: `A line brings at most ${MAX_LINE_QUANTITY.toLocaleString("en")} base units`,
      received_in_future: "The day received cannot be after today",
      already_reversed: "This line has already been reversed",
      batch_moved: "Some of this batch has moved since it was received; correct it with an adjustment instead",
    }[code]}`);
    this.name = "GoodsReceivedError";
  }
}

export interface ReceivedLine {
  stockItemId: string;
  batchNumber?: string | null;
  expiresOn?: string | null;
  /** Whole packs, at the item's pack size; or `units`, in its base unit. Exactly one. */
  packs?: number;
  units?: number;
  totalCostCents: number;
}

export interface Delivery {
  storeId: string;
  supplier: string;
  supplierReference?: string | null;
  /** The Kenyan day it arrived; today unless given. */
  receivedOn?: string;
  lines: ReceivedLine[];
}

export interface ReceiptWarning {
  line: number;
  code: "expires_soon";
  expiresOn: string;
}

interface ItemForReceipt { id: string; drugCode: string | null; packSize: number; isActive: boolean }
type PreparedBatch = Omit<typeof stockBatches.$inferInsert, "facilityId" | "goodsReceivedId">;

/**
 * The store, then the lines' items by id, both held shared: the lock order
 * for stock (lib/stock-levels.ts). Deliveries run side by side; retiring
 * either waits for them.
 */
async function lockStoreAndItems(tx: AppDb, storeId: string, itemIds: string[]): Promise<{ store: { id: string; name: string }; itemOf: Map<string, ItemForReceipt> }> {
  const [store] = await tx.select({ id: stores.id, name: stores.name, isActive: stores.isActive }).from(stores).where(eq(stores.id, storeId)).for("share").limit(1);
  if (!store)
    throw new GoodsReceivedError("store_not_found");
  if (!store.isActive)
    throw new GoodsReceivedError("store_retired");
  const items = await tx
    .select({ id: stockItems.id, drugCode: stockItems.drugCode, packSize: stockItems.packSize, isActive: stockItems.isActive })
    .from(stockItems)
    .where(inArray(stockItems.id, [...new Set(itemIds)].sort()))
    .orderBy(asc(stockItems.id))
    .for("share");
  return { store, itemOf: new Map(items.map(i => [i.id, i])) };
}

/** One line checked and made a batch, or refused naming its line. Warns of one expiring soon. */
function prepareBatch(line: ReceivedLine, number: number, item: ItemForReceipt | undefined, today: string, warnings: ReceiptWarning[]): PreparedBatch {
  if (!item)
    throw new GoodsReceivedError("item_not_found", number);
  if (!item.isActive)
    throw new GoodsReceivedError("item_retired", number);
  const batchNumber = line.batchNumber ?? null;
  const expiresOn = line.expiresOn ?? null;
  if (item.drugCode && !batchNumber)
    throw new GoodsReceivedError("batch_number_needed", number);
  if (item.drugCode && !expiresOn)
    throw new GoodsReceivedError("expiry_needed", number);
  if (expiresOn && expiresOn < today)
    throw new GoodsReceivedError("already_expired", number);
  if (expiresOn && expiresOn < addDays(today, EXPIRY_WARNING_DAYS))
    warnings.push({ line: number, code: "expires_soon", expiresOn });
  const quantity = line.packs !== undefined ? line.packs * item.packSize : line.units!;
  if (quantity > MAX_LINE_QUANTITY)
    throw new GoodsReceivedError("quantity_too_large", number);
  return { line: number, stockItemId: item.id, batchNumber, expiresOn, quantityReceived: quantity, packSize: item.packSize, totalCostCents: line.totalCostCents };
}

/**
 * Receives a delivery: numbers the note, writes each line as a batch, and
 * puts each on the store's shelf with a `receipt` movement. A refused line
 * refuses the whole note, and nothing of it is kept.
 */
export async function receiveGoods(
  tx: AppDb,
  facilityId: string,
  input: Delivery,
  actor: PatientActor,
  today = businessDate(),
): Promise<{ note: NoteRow; warnings: ReceiptWarning[] }> {
  const receivedOn = input.receivedOn ?? today;
  if (receivedOn > today)
    throw new GoodsReceivedError("received_in_future");

  // Postgres answers a uuid in lowercase, however it was asked for.
  const lines = input.lines.map(l => ({ ...l, stockItemId: l.stockItemId.toLowerCase() }));
  const { store, itemOf } = await lockStoreAndItems(tx, input.storeId, lines.map(l => l.stockItemId));
  // Every line is checked before the note takes a number or anything is written.
  const warnings: ReceiptWarning[] = [];
  const batches = lines.map((line, index) => prepareBatch(line, index + 1, itemOf.get(line.stockItemId), today, warnings));

  const [note] = await tx.insert(goodsReceived).values({
    facilityId,
    number: await issueNumber(tx, facilityId, "goods_received"),
    storeId: store.id,
    supplier: input.supplier,
    supplierReference: input.supplierReference ?? null,
    receivedOn,
    receivedBy: actor.membershipId,
  }).returning();
  const inserted = await tx.insert(stockBatches)
    .values(batches.map(b => ({ facilityId, goodsReceivedId: note.id, ...b })))
    .returning({ id: stockBatches.id, quantityReceived: stockBatches.quantityReceived });
  await tx.insert(stockMovements).values(inserted.map(b => ({
    facilityId,
    storeId: store.id,
    batchId: b.id,
    kind: "receipt" as const,
    quantity: b.quantityReceived,
    goodsReceivedId: note.id,
    recordedBy: actor.membershipId,
  })));

  const totalCostCents = batches.reduce((total, b) => total + b.totalCostCents, 0);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "goods.received",
    entityType: "goods_received",
    entityId: note.id,
    summary: `Received ${note.number} into ${store.name}`,
    detail: { number: note.number, storeId: store.id, supplier: note.supplier, lines: batches.length, totalCostCents },
  });
  return { note, warnings };
}

/**
 * Takes a mistyped line back off the shelf, whole, while none of its stock
 * has moved (decided 2026-11-15): it is then entered again correctly. A line
 * some of whose stock has moved is corrected by an adjustment (slice 3b).
 * Answers with the note's id.
 */
export async function reverseBatch(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor): Promise<string> {
  // One spelling of the id, so every request for this batch takes the same lock.
  const batchId = id.toLowerCase();
  await lockBatches(tx, facilityId, [batchId]);
  const [batch] = await tx
    .select({ id: stockBatches.id, line: stockBatches.line, quantity: stockBatches.quantityReceived, goodsReceivedId: stockBatches.goodsReceivedId, number: goodsReceived.number, storeId: goodsReceived.storeId })
    .from(stockBatches)
    .innerJoin(goodsReceived, eq(goodsReceived.id, stockBatches.goodsReceivedId))
    .where(eq(stockBatches.id, batchId))
    .limit(1);
  if (!batch)
    throw new GoodsReceivedError("batch_not_found");

  const others = await tx
    .select({ kind: stockMovements.kind })
    .from(stockMovements)
    .where(and(eq(stockMovements.batchId, batchId), ne(stockMovements.kind, "receipt")));
  if (others.some(m => m.kind === "receipt_reversed"))
    throw new GoodsReceivedError("already_reversed");
  if (others.length > 0)
    throw new GoodsReceivedError("batch_moved");

  await tx.insert(stockMovements).values({
    facilityId,
    storeId: batch.storeId,
    batchId,
    kind: "receipt_reversed",
    quantity: -batch.quantity,
    goodsReceivedId: batch.goodsReceivedId,
    reason,
    recordedBy: actor.membershipId,
  });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_batch.reversed",
    entityType: "goods_received",
    entityId: batch.goodsReceivedId,
    summary: `Reversed line ${batch.line} of ${batch.number}`,
    detail: { batchId, line: batch.line, quantity: batch.quantity, reason },
  });
  return batch.goodsReceivedId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListedNote {
  id: string;
  number: string;
  storeId: string;
  storeName: string;
  supplier: string;
  supplierReference: string | null;
  receivedOn: string;
  receivedByName: string;
  createdAt: Date;
  lines: number;
  /** As delivered, reversed lines included. */
  totalCostCents: number;
}

/** Notes, newest first, `NOTES_PAGE` at a time. Not patient data, so not audited. */
export async function listNotes(tx: AppDb, filter: { storeId?: string; offset?: number; id?: string } = {}): Promise<ListedNote[]> {
  const rows = await tx
    .select({
      note: goodsReceived,
      storeName: stores.name,
      receivedByName: user.name,
      lines: count(stockBatches.id),
      totalCostCents: sum(stockBatches.totalCostCents),
    })
    .from(goodsReceived)
    .innerJoin(stores, eq(stores.id, goodsReceived.storeId))
    .innerJoin(memberships, eq(memberships.id, goodsReceived.receivedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .innerJoin(stockBatches, eq(stockBatches.goodsReceivedId, goodsReceived.id))
    .where(and(
      filter.storeId ? eq(goodsReceived.storeId, filter.storeId) : undefined,
      filter.id ? eq(goodsReceived.id, filter.id) : undefined,
    ))
    .groupBy(goodsReceived.id, stores.name, user.name)
    .orderBy(desc(goodsReceived.createdAt), desc(goodsReceived.number))
    .limit(NOTES_PAGE)
    .offset(filter.offset ?? 0);

  return rows.map(({ note, storeName, receivedByName, lines, totalCostCents }) => ({
    id: note.id,
    number: note.number,
    storeId: note.storeId,
    storeName,
    supplier: note.supplier,
    supplierReference: note.supplierReference,
    receivedOn: note.receivedOn,
    receivedByName,
    createdAt: note.createdAt,
    lines,
    totalCostCents: Number(totalCostCents),
  }));
}

export interface ShownLine {
  batchId: string;
  line: number;
  stockItemId: string;
  code: string;
  name: string;
  batchNumber: string | null;
  expiresOn: string | null;
  /** In base units. */
  quantity: number;
  packSize: number;
  totalCostCents: number;
  /** Set once the line was taken back off the shelf. */
  reversal: { at: Date; reason: string } | null;
}

export interface ShownNote extends ListedNote {
  items: ShownLine[];
}

/** One note with its lines in order. */
export async function noteShown(tx: AppDb, id: string): Promise<ShownNote> {
  const [note] = await listNotes(tx, { id });
  if (!note)
    throw new GoodsReceivedError("not_found");

  const lines = await tx
    .select({ batch: stockBatches, code: billableItems.code, name: billableItems.name })
    .from(stockBatches)
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(eq(stockBatches.goodsReceivedId, id))
    .orderBy(asc(stockBatches.line));
  const reversals = await tx
    .select({ batchId: stockMovements.batchId, at: stockMovements.recordedAt, reason: sql<string>`${stockMovements.reason}` })
    .from(stockMovements)
    .where(and(eq(stockMovements.goodsReceivedId, id), eq(stockMovements.kind, "receipt_reversed")));
  const reversalOf = new Map(reversals.map(r => [r.batchId, { at: r.at, reason: r.reason }]));

  return {
    ...note,
    items: lines.map(({ batch, code, name }) => ({
      batchId: batch.id,
      line: batch.line,
      stockItemId: batch.stockItemId,
      code,
      name,
      batchNumber: batch.batchNumber,
      expiresOn: batch.expiresOn,
      quantity: batch.quantityReceived,
      packSize: batch.packSize,
      totalCostCents: batch.totalCostCents,
      reversal: reversalOf.get(batch.id) ?? null,
    })),
  };
}
