import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { billableItems, charges, documents, encounters, labTests, memberships, orderItems, orders, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { cancelOrderItemCharge, captureOrderItemCharge, ChargeError } from "./charges";

/**
 * Orders (SCHEMA.md §8, P3 slice 4a): lab tests and services asked for on an
 * encounter, each charged as it is ordered (rule 16; lab charged at order,
 * decided 2026-11-10), by a typed source, `charges.order_item_id`.
 *
 * A clinician orders under a current licence (rule 25). A walk-in lab
 * client's request is entered by a records clerk or a lab member, naming the
 * outside requester, or marked self-requested (decided 2026-11-11).
 *
 * An item is `ordered` until done (a lab test once its specimen is collected,
 * 5a; a service once a clinician marks it performed) or cancelled, which
 * cancels its charge while unbilled. Every change locks the encounter first,
 * then the item (M8).
 */

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
export type Urgency = OrderRow["urgency"];
export type ItemStatus = ItemRow["status"];

/** Who orders: doctors, clinical officers, and nurses in nurse-led clinics. */
export const ORDERING_STAFF = ["doctor", "clinical_officer", "nurse"] as const;
/** Who enters a walk-in's request: records clerks and the lab. */
export const WALK_IN_STAFF = ["records_clerk", "lab_tech", "lab_supervisor"] as const;
/** Who marks a service performed. */
export const PERFORMING_STAFF = ["doctor", "clinical_officer", "nurse", "ward_nurse"] as const;
const LAB_STAFF: readonly MembershipRole[] = ["lab_tech", "lab_supervisor"];
/** What a service order may name. Consumables wait for P4, which tracks their stock. */
const SERVICE_CATEGORIES: readonly string[] = ["procedure", "imaging", "service"];

export type OrderErrorCode
  = | "encounter_not_found"
    | "not_open"
    | "not_outpatient"
    | "test_not_found"
    | "test_inactive"
    | "not_a_service"
    | "duplicate_item"
    | "not_covered"
    | "not_found"
    | "not_ordered"
    | "not_a_service_item"
    | "cancel_the_prescription"
    | "not_yours_to_cancel";

export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode) {
    super({
      encounter_not_found: "No such encounter",
      not_open: "Orders are placed on an open encounter",
      not_outpatient: "A walk-in's request is entered on an outpatient visit",
      test_not_found: "No such lab test",
      test_inactive: "That lab test is not offered now",
      not_a_service: "That item is not an active procedure, imaging or service item",
      duplicate_item: "The same test or service is on this order twice",
      not_covered: "Something on this order has no cash price today; the facility admin sets its price first",
      not_found: "No such order item",
      not_ordered: "This item is already done or cancelled",
      not_a_service_item: "Only a service is marked done: a lab test is done once its specimen is collected, a medicine once dispensed",
      cancel_the_prescription: "A medicine is cancelled with its prescription, which is then written again",
      not_yours_to_cancel: "Only someone who could have placed this order, or the lab for a lab test, cancels it",
    }[code]);
    this.name = "OrderError";
  }
}

export interface OrderActor extends PatientActor {
  roles: readonly MembershipRole[];
}

/** One thing an order asks for: a lab test, or a service's billable item. */
export type ItemInput = { labTestId: string } | { billableItemId: string };

/** Who asked for a walk-in's tests: an outside requester, as their form names them, or the client. */
export type WalkInRequester = { name: string; facility: string; licenceNumber?: string } | "self";

async function lockEncounter(tx: AppDb, id: string) {
  const [encounter] = await tx
    .select({ id: encounters.id, kind: encounters.kind, status: encounters.status })
    .from(encounters)
    .where(eq(encounters.id, id))
    .for("update")
    .limit(1);
  if (!encounter)
    throw new OrderError("encounter_not_found");
  return encounter;
}

interface Resolved {
  input: ItemInput;
  /** What it is charged as: the test's item, or the service's. */
  billableItemId: string;
  code: string;
}

/** Each item checked and its billable item found, before anything is written. */
async function resolveItems(tx: AppDb, items: ItemInput[]): Promise<Resolved[]> {
  const keys = items.map(i => ("labTestId" in i ? `lab:${i.labTestId}` : `item:${i.billableItemId}`));
  if (new Set(keys).size !== keys.length)
    throw new OrderError("duplicate_item");

  const resolved: Resolved[] = [];
  for (const input of items) {
    if ("labTestId" in input) {
      const [test] = await tx
        .select({ isActive: labTests.isActive, itemActive: billableItems.isActive, billableItemId: billableItems.id, code: billableItems.code })
        .from(labTests)
        .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
        .where(eq(labTests.id, input.labTestId))
        .limit(1);
      if (!test)
        throw new OrderError("test_not_found");
      if (!test.isActive || !test.itemActive)
        throw new OrderError("test_inactive");
      resolved.push({ input, billableItemId: test.billableItemId, code: test.code });
      continue;
    }
    const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, input.billableItemId)).limit(1);
    if (!item || !SERVICE_CATEGORIES.includes(item.category) || !item.isActive)
      throw new OrderError("not_a_service");
    resolved.push({ input, billableItemId: item.id, code: item.code });
  }
  return resolved;
}

type Requester = Pick<typeof orders.$inferInsert, "orderedBy" | "requesterName" | "requesterFacility" | "requesterLicence" | "selfRequested">;

async function place(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { urgency: Urgency; indication: string | null; items: ItemInput[]; requester: Requester; walkIn: boolean },
  actor: PatientActor,
  at: Date,
): Promise<OrderRow> {
  const encounter = await lockEncounter(tx, encounterId);
  if (encounter.status !== "open")
    throw new OrderError("not_open");
  if (input.walkIn && encounter.kind !== "opd")
    throw new OrderError("not_outpatient");
  const resolved = await resolveItems(tx, input.items);

  const [order] = await tx.insert(orders).values({
    facilityId,
    encounterId,
    urgency: input.urgency,
    indication: input.indication,
    ...input.requester,
    enteredBy: actor.membershipId,
    orderedAt: at,
  }).returning();
  for (const item of resolved) {
    const [row] = await tx.insert(orderItems).values({
      facilityId,
      orderId: order.id,
      labTestId: "labTestId" in item.input ? item.input.labTestId : null,
      billableItemId: "billableItemId" in item.input ? item.input.billableItemId : null,
      status: "ordered",
    }).returning({ id: orderItems.id });
    try {
      await captureOrderItemCharge(tx, facilityId, { encounterId, orderItemId: row.id, billableItemId: item.billableItemId, code: item.code, at }, actor);
    }
    catch (err) {
      // The request's transaction rolls back with the refusal: nothing of the order is kept.
      if (err instanceof ChargeError && err.code === "not_covered")
        throw new OrderError("not_covered");
      throw err;
    }
  }

  const codes = resolved.map(r => r.code);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "order.placed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Ordered ${codes.join(", ")}${input.walkIn ? " for a walk-in" : ""}`,
    // The indication is clinical: it stays in the order (rule 10).
    detail: { orderId: order.id, urgency: order.urgency, items: codes, selfRequested: order.selfRequested },
  });
  return order;
}

/** A clinician's order of lab tests and services on an open encounter, each charged now. */
export async function placeOrder(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { urgency?: Urgency; indication?: string; items: ItemInput[] },
  actor: PatientActor,
  at = new Date(),
): Promise<OrderRow> {
  return place(tx, facilityId, encounterId, {
    urgency: input.urgency ?? "routine",
    indication: input.indication ?? null,
    items: input.items,
    requester: { orderedBy: actor.membershipId },
    walkIn: false,
  }, actor, at);
}

/** A walk-in lab client's tests, from an outside requester's form or asked for by the client, on their outpatient visit. */
export async function placeWalkInOrder(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { requester: WalkInRequester; urgency?: Urgency; indication?: string; labTestIds: string[] },
  actor: PatientActor,
  at = new Date(),
): Promise<OrderRow> {
  const requester: Requester = input.requester === "self"
    ? { selfRequested: true }
    : { requesterName: input.requester.name, requesterFacility: input.requester.facility, requesterLicence: input.requester.licenceNumber ?? null };
  return place(tx, facilityId, encounterId, {
    urgency: input.urgency ?? "routine",
    indication: input.indication ?? null,
    items: input.labTestIds.map(labTestId => ({ labTestId })),
    requester,
    walkIn: true,
  }, actor, at);
}

/** The item, locked after its encounter (M8), with what its order says about who placed it. */
async function lockItem(tx: AppDb, itemId: string) {
  const [found] = await tx
    .select({ encounterId: orders.encounterId, orderedBy: orders.orderedBy })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orderItems.id, itemId))
    .limit(1);
  if (!found)
    throw new OrderError("not_found");
  await lockEncounter(tx, found.encounterId);
  const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, itemId)).for("update").limit(1);
  if (item.status !== "ordered")
    throw new OrderError("not_ordered");
  return { item, encounterId: found.encounterId, walkIn: found.orderedBy === null };
}

async function chargedCode(tx: AppDb, item: ItemRow): Promise<string> {
  const [row] = await tx
    .select({ code: billableItems.code })
    .from(billableItems)
    .leftJoin(labTests, eq(labTests.billableItemId, billableItems.id))
    .where(item.labTestId ? eq(labTests.id, item.labTestId) : eq(billableItems.id, item.billableItemId!))
    .limit(1);
  return row.code;
}

/**
 * Cancels an item not yet done, for a stated reason, and its charge while
 * unbilled; a billed charge stands, to be credited or refunded. Cancelled by
 * whoever could have placed the order, or the lab for a lab test. Not a
 * clinical act, so no current licence is needed.
 */
export async function cancelOrderItem(tx: AppDb, facilityId: string, itemId: string, reason: string, actor: OrderActor, at = new Date()): Promise<ItemRow> {
  const { item, encounterId, walkIn } = await lockItem(tx, itemId);
  // Its printed prescription would no longer say what stands.
  if (item.drugCode)
    throw new OrderError("cancel_the_prescription");
  const placers: readonly MembershipRole[] = walkIn ? WALK_IN_STAFF : ORDERING_STAFF;
  const may = [...placers, ...(item.labTestId ? LAB_STAFF : [])];
  if (!actor.roles.some(r => may.includes(r)))
    throw new OrderError("not_yours_to_cancel");

  const [cancelled] = await tx.update(orderItems)
    .set({ status: "cancelled", cancelledAt: at, cancelledBy: actor.membershipId, cancellationReason: reason })
    .where(eq(orderItems.id, itemId))
    .returning();
  const chargeCancelled = await cancelOrderItemCharge(tx, facilityId, itemId, reason, actor);

  const code = await chargedCode(tx, item);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "order_item.cancelled",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Cancelled ${code} from an order: ${reason}`,
    detail: { orderItemId: itemId, code, reason, chargeCancelled },
  });
  return cancelled;
}

/** Marks a service performed, by the clinician who did it (rule 25). A lab test is done by its specimen's collection instead. */
export async function markServiceDone(tx: AppDb, facilityId: string, itemId: string, actor: PatientActor, at = new Date()): Promise<ItemRow> {
  const { item, encounterId } = await lockItem(tx, itemId);
  if (!item.billableItemId)
    throw new OrderError("not_a_service_item");

  const [done] = await tx.update(orderItems)
    .set({ status: "done", doneAt: at, doneBy: actor.membershipId })
    .where(eq(orderItems.id, itemId))
    .returning();
  const code = await chargedCode(tx, item);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "order_item.done",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Performed ${code}`,
    detail: { orderItemId: itemId, code },
  });
  return done;
}

/** Whether the encounter has an order item that is not cancelled: care asked for, or done. */
export async function hasStandingOrders(tx: AppDb, encounterId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.encounterId, encounterId), ne(orderItems.status, "cancelled")))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A medicine as prescribed. */
export interface ShownMedicine {
  drugCode: string;
  doseAmount: string;
  doseUnit: string;
  route: NonNullable<ItemRow["route"]>;
  frequency: NonNullable<ItemRow["frequency"]>;
  durationDays: number | null;
  quantity: string;
  instructions: string | null;
  /** Why it was prescribed despite a recorded allergy. */
  allergyOverrideReason: string | null;
}

export interface ShownOrderItem {
  id: string;
  kind: "lab" | "service" | "medication";
  labTestId: string | null;
  /** What it is charged as; none for a medicine, charged when dispensed (P4). */
  billableItemId: string | null;
  /** The item's or drug's code, and its name (a medicine's as prescribed). */
  code: string;
  name: string;
  status: ItemStatus;
  doneAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  /** Its standing charge; null once that is cancelled, or for a medicine. */
  amountCents: number | null;
  medication: ShownMedicine | null;
}

export interface ShownOrder {
  id: string;
  encounterId: string;
  urgency: Urgency;
  indication: string | null;
  orderedAt: Date;
  /** The clinician who ordered it; null for a walk-in's request. */
  orderedBy: { membershipId: string; name: string } | null;
  /** A walk-in's outside requester. */
  requester: { name: string; facility: string; licenceNumber: string | null } | null;
  selfRequested: boolean;
  enteredBy: { membershipId: string; name: string };
  /** A prescription's printed document; `voided` once it is cancelled. */
  prescription: { documentId: string; number: string; voided: boolean } | null;
  items: ShownOrderItem[];
}

/** An encounter's orders, oldest first, each with its items. Not audited. */
export async function ordersOf(tx: AppDb, encounterId: string, filter: { orderId?: string } = {}): Promise<ShownOrder[]> {
  const rows = await tx
    .select({ order: orders, enteredByName: user.name, documentNumber: documents.number, documentVoidedAt: documents.voidedAt })
    .from(orders)
    .innerJoin(memberships, eq(memberships.id, orders.enteredBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .leftJoin(documents, eq(documents.id, orders.documentId))
    .where(and(eq(orders.encounterId, encounterId), filter.orderId ? eq(orders.id, filter.orderId) : undefined))
    .orderBy(asc(orders.orderedAt), asc(orders.id));
  if (rows.length === 0)
    return [];

  const labItem = alias(billableItems, "lab_item");
  const items = await tx
    .select({
      item: orderItems,
      billableItemId: sql<string | null>`coalesce(${billableItems.id}, ${labItem.id})`,
      code: sql<string>`coalesce(${billableItems.code}, ${labItem.code}, ${orderItems.drugCode})`,
      name: sql<string>`coalesce(${billableItems.name}, ${labItem.name}, ${orderItems.drugDescription})`,
      amountCents: charges.amountCents,
    })
    .from(orderItems)
    .leftJoin(billableItems, eq(billableItems.id, orderItems.billableItemId))
    .leftJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .leftJoin(labItem, eq(labItem.id, labTests.billableItemId))
    .leftJoin(charges, and(eq(charges.orderItemId, orderItems.id), sql`${charges.cancelledAt} IS NULL`))
    .where(inArray(orderItems.orderId, rows.map(r => r.order.id)))
    .orderBy(sql`coalesce(${billableItems.code}, ${labItem.code}, ${orderItems.drugCode})`, asc(orderItems.id));

  return rows.map(({ order: o, enteredByName, documentNumber, documentVoidedAt }) => {
    const enteredBy = { membershipId: o.enteredBy, name: enteredByName };
    return {
      id: o.id,
      encounterId: o.encounterId,
      urgency: o.urgency,
      indication: o.indication,
      orderedAt: o.orderedAt,
      orderedBy: o.orderedBy ? enteredBy : null,
      requester: o.requesterName ? { name: o.requesterName, facility: o.requesterFacility!, licenceNumber: o.requesterLicence } : null,
      selfRequested: o.selfRequested,
      enteredBy,
      prescription: o.documentId ? { documentId: o.documentId, number: documentNumber!, voided: documentVoidedAt !== null } : null,
      items: items.filter(i => i.item.orderId === o.id).map(({ item: i, billableItemId, code, name, amountCents }) => ({
        id: i.id,
        kind: i.labTestId ? "lab" as const : i.drugCode ? "medication" as const : "service" as const,
        labTestId: i.labTestId,
        billableItemId,
        code,
        name,
        status: i.status,
        doneAt: i.doneAt,
        cancelledAt: i.cancelledAt,
        cancellationReason: i.cancellationReason,
        amountCents,
        medication: i.drugCode
          ? {
              drugCode: i.drugCode,
              doseAmount: i.doseAmount!,
              doseUnit: i.doseUnit!,
              route: i.route!,
              frequency: i.frequency!,
              durationDays: i.durationDays,
              quantity: i.quantity!,
              instructions: i.instructions,
              allergyOverrideReason: i.allergyOverrideReason,
            }
          : null,
      })),
    };
  });
}

/** As `ordersOf`, with an audit entry: orders are part of the record (rule 9). */
export async function listOrders(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor): Promise<ShownOrder[]> {
  const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!encounter)
    throw new OrderError("encounter_not_found");

  const listed = await ordersOf(tx, encounterId);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Viewed orders (${listed.length})`,
  });
  return listed;
}

/** The order an item belongs to, as `ordersOf` shows it. */
export async function orderOfItem(tx: AppDb, itemId: string): Promise<ShownOrder> {
  const [found] = await tx
    .select({ orderId: orderItems.orderId, encounterId: orders.encounterId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orderItems.id, itemId))
    .limit(1);
  if (!found)
    throw new OrderError("not_found");
  const [order] = await ordersOf(tx, found.encounterId, { orderId: found.orderId });
  return order;
}
