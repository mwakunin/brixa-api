import { and, asc, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { appointments, billableItems, encounters, memberships, patientNumbers, patients, queueEntries, servicePoints, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { cancelEntryFee, captureConsultationFee, ChargeError } from "./charges";
import { ageInYears, businessDate } from "./dates";
import { isUniqueViolation, pgConstraintName } from "./db-errors";

/**
 * Service points and their queues (SCHEMA.md §8): where an outpatient waits
 * to be triaged or seen, and who saw them.
 *
 * A patient is in one queue at a time. Opening a visit puts them in the
 * facility's triage queue when it has exactly one triage point; staff then
 * call them in, see them, and send them on to the next queue, or take them
 * out if they left unseen or were sent there in error. Joining a clinic with
 * a fee charges it, once per visit; leaving unseen cancels it while it is
 * unbilled. The lab, the pharmacy
 * and the cashier have no queues here: their lists come from the work
 * waiting for them (ROADMAP.md P3).
 *
 * Every change takes the encounter's lock first (lock order M8), then the
 * entry's, so two clinicians calling the same patient queue behind each
 * other and the second is refused, and a visit cannot close while its
 * patient is being queued.
 */

type EntryRow = typeof queueEntries.$inferSelect;
type ServicePointRow = typeof servicePoints.$inferSelect;
export type ServicePointKind = ServicePointRow["kind"];
export type Priority = NonNullable<EntryRow["priority"]>;

const LIVE = ["waiting", "serving"] as const;

/** At most this many in one queue view; more than a Level 4 OPD seats at once. */
const QUEUE_VIEW_LIMIT = 500;

export type QueueErrorCode
  = | "service_point_not_found"
    | "name_taken"
    | "service_point_retired"
    | "still_waiting"
    | "has_appointments"
    | "encounter_not_found"
    | "not_open"
    | "not_a_visit"
    | "already_queued"
    | "entry_not_found"
    | "not_waiting"
    | "not_serving"
    | "being_seen"
    | "priority_at_triage_only"
    | "fee_unpriced"
    | "not_a_clinic"
    | "not_a_consultation_item";

export const QUEUE_NOT_FOUND: ReadonlySet<QueueErrorCode> = new Set(["service_point_not_found", "encounter_not_found", "entry_not_found"]);

export class QueueError extends Error {
  constructor(readonly code: QueueErrorCode) {
    super({
      service_point_not_found: "No such service point",
      name_taken: "A service point already has that name",
      service_point_retired: "That service point is out of use",
      still_waiting: "Patients are still waiting there; see them or take them out of the queue first",
      has_appointments: "Patients are booked at this clinic from today on; move or cancel their appointments first",
      encounter_not_found: "No such visit",
      not_open: "This visit is no longer open",
      not_a_visit: "Only an outpatient visit or emergency attendance joins a queue",
      already_queued: "The patient is already in a queue; finish or take them out of it first",
      entry_not_found: "No such queue entry",
      not_waiting: "The patient is no longer waiting in this queue",
      not_serving: "The patient is not being seen in this queue",
      being_seen: "The patient is being seen; the clinician finishes with them first",
      priority_at_triage_only: "Only triage sets how soon the patient must be seen",
      fee_unpriced: "This clinic's consultation fee has no price today; the facility admin or finance manager sets it",
      not_a_clinic: "Only a clinic charges a consultation fee; triage has none",
      not_a_consultation_item: "That item is not an active consultation item",
    }[code]);
    this.name = "QueueError";
  }
}

// ---------------------------------------------------------------------------
// Service points
// ---------------------------------------------------------------------------

export async function createServicePoint(
  tx: AppDb,
  facilityId: string,
  input: { name: string; kind: ServicePointKind },
  actor: PatientActor,
): Promise<ServicePointRow> {
  let point: ServicePointRow;
  try {
    [point] = await tx.insert(servicePoints).values({ facilityId, name: input.name, kind: input.kind }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new QueueError("name_taken");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "service_point.created",
    entityType: "service_point",
    entityId: point.id,
    summary: `Created ${input.kind} point ${input.name}`,
  });
  return point;
}

/**
 * Renames or retires a service point, or sets a clinic's consultation fee
 * item (null for none). One with patients still in its queue stays in use. A
 * fee change applies to patients who join from now on.
 */
export async function updateServicePoint(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { name?: string; isActive?: boolean; consultationItemId?: string | null },
  actor: PatientActor,
): Promise<ServicePointRow> {
  const [current] = await tx.select().from(servicePoints).where(eq(servicePoints.id, id)).for("update").limit(1);
  if (!current)
    throw new QueueError("service_point_not_found");
  if (input.isActive === false && current.isActive && await liveCount(tx, id) > 0)
    throw new QueueError("still_waiting");
  // A booking share-locks the clinic, so this count waits for one in flight.
  if (input.isActive === false && current.isActive && await bookedFromToday(tx, id))
    throw new QueueError("has_appointments");
  if (input.consultationItemId) {
    if (current.kind !== "consultation")
      throw new QueueError("not_a_clinic");
    const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, input.consultationItemId)).limit(1);
    if (!item || item.category !== "consultation" || !item.isActive)
      throw new QueueError("not_a_consultation_item");
  }

  let point: ServicePointRow;
  try {
    [point] = await tx.update(servicePoints).set(input).where(eq(servicePoints.id, id)).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new QueueError("name_taken");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "service_point.updated",
    entityType: "service_point",
    entityId: id,
    summary: `Updated service point ${point.name}`,
    detail: {
      before: { name: current.name, isActive: current.isActive, consultationItemId: current.consultationItemId },
      after: { name: point.name, isActive: point.isActive, consultationItemId: point.consultationItemId },
    },
  });
  return point;
}

async function bookedFromToday(tx: AppDb, servicePointId: string): Promise<boolean> {
  const [booked] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.servicePointId, servicePointId), eq(appointments.status, "booked"), gte(appointments.scheduledOn, businessDate())))
    .limit(1);
  return booked !== undefined;
}

async function liveCount(tx: AppDb, servicePointId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(queueEntries)
    .where(and(eq(queueEntries.servicePointId, servicePointId), inArray(queueEntries.status, LIVE)));
  return row.n;
}

export interface ListedServicePoint {
  id: string;
  name: string;
  kind: ServicePointKind;
  consultationItemId: string | null;
  isActive: boolean;
  /** How many are waiting there now. */
  waiting: number;
}

/** Every service point, triage first, then by name, with how many are waiting at each. */
export async function listServicePoints(tx: AppDb): Promise<ListedServicePoint[]> {
  const waiting = tx
    .select({ servicePointId: queueEntries.servicePointId, n: count().as("n") })
    .from(queueEntries)
    .where(eq(queueEntries.status, "waiting"))
    .groupBy(queueEntries.servicePointId)
    .as("waiting");

  return tx
    .select({
      id: servicePoints.id,
      name: servicePoints.name,
      kind: servicePoints.kind,
      consultationItemId: servicePoints.consultationItemId,
      isActive: servicePoints.isActive,
      waiting: sql<number>`coalesce(${waiting.n}, 0)::int`,
    })
    .from(servicePoints)
    .leftJoin(waiting, eq(waiting.servicePointId, servicePoints.id))
    .orderBy(desc(sql`${servicePoints.kind} = 'triage'`), asc(servicePoints.name));
}

/** The triage point a new visit joins unless told otherwise: the facility's only one in use, if it has exactly one. */
export async function defaultTriagePoint(tx: AppDb): Promise<string | null> {
  const points = await tx
    .select({ id: servicePoints.id })
    .from(servicePoints)
    .where(and(eq(servicePoints.kind, "triage"), eq(servicePoints.isActive, true)))
    .limit(2);
  return points.length === 1 ? points[0].id : null;
}

// ---------------------------------------------------------------------------
// Joining, serving, finishing
// ---------------------------------------------------------------------------

async function lockEncounterRow(tx: AppDb, id: string) {
  const [encounter] = await tx
    .select({ id: encounters.id, kind: encounters.kind, status: encounters.status })
    .from(encounters)
    .where(eq(encounters.id, id))
    .for("update")
    .limit(1);
  if (!encounter)
    throw new QueueError("encounter_not_found");
  return encounter;
}

/**
 * Puts a visit the caller has already locked (or just created) in a queue.
 * The partial unique index is the backstop for "one queue at a time".
 */
export async function joinLocked(
  tx: AppDb,
  facilityId: string,
  encounter: { id: string; kind: string; status: string },
  servicePointId: string,
  actor: PatientActor,
  at = new Date(),
): Promise<EntryRow> {
  if (encounter.kind === "ipd")
    throw new QueueError("not_a_visit");
  if (encounter.status !== "open")
    throw new QueueError("not_open");

  // Shared, so retiring the point (which locks it for update, then counts
  // its queue) waits for this join, and a join waits for a retirement.
  const [point] = await tx.select().from(servicePoints).where(eq(servicePoints.id, servicePointId)).for("share").limit(1);
  if (!point)
    throw new QueueError("service_point_not_found");
  if (!point.isActive)
    throw new QueueError("service_point_retired");

  let entry: EntryRow;
  try {
    [entry] = await tx.insert(queueEntries).values({
      facilityId,
      encounterId: encounter.id,
      servicePointId,
      joinedAt: at,
      joinedBy: actor.membershipId,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err) && pgConstraintName(err) === "queue_entries_one_live_per_encounter")
      throw new QueueError("already_queued");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "queue.joined",
    entityType: "queue_entry",
    entityId: entry.id,
    summary: `Joined the queue at ${point.name}`,
    detail: { encounterId: encounter.id, servicePointId },
  });

  if (point.kind === "consultation" && point.consultationItemId) {
    try {
      await captureConsultationFee(tx, facilityId, {
        encounterId: encounter.id,
        queueEntryId: entry.id,
        servicePointId,
        billableItemId: point.consultationItemId,
        at,
      }, actor);
    }
    catch (err) {
      if (err instanceof ChargeError && err.code === "not_covered")
        throw new QueueError("fee_unpriced");
      throw err;
    }
  }
  return entry;
}

/** Puts an open visit in a queue: back to a clinic after lab results, or straight to one. */
export async function joinQueue(tx: AppDb, facilityId: string, encounterId: string, servicePointId: string, actor: PatientActor, at = new Date()): Promise<EntryRow> {
  const encounter = await lockEncounterRow(tx, encounterId);
  return joinLocked(tx, facilityId, encounter, servicePointId, actor, at);
}

/** The entry, locked after its encounter (M8). */
async function lockEntry(tx: AppDb, entryId: string): Promise<EntryRow> {
  const [found] = await tx.select({ encounterId: queueEntries.encounterId }).from(queueEntries).where(eq(queueEntries.id, entryId)).limit(1);
  if (!found)
    throw new QueueError("entry_not_found");
  await lockEncounterRow(tx, found.encounterId);
  const [entry] = await tx.select().from(queueEntries).where(eq(queueEntries.id, entryId)).for("update").limit(1);
  return entry;
}

/** Calls a waiting patient in. Whoever does is the clinician who saw them there. */
export async function serve(tx: AppDb, facilityId: string, entryId: string, actor: PatientActor, at = new Date()): Promise<EntryRow> {
  const entry = await lockEntry(tx, entryId);
  if (entry.status !== "waiting")
    throw new QueueError("not_waiting");

  const [serving] = await tx.update(queueEntries)
    .set({ status: "serving", servingAt: at, servedBy: actor.membershipId })
    .where(eq(queueEntries.id, entryId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "queue.served",
    entityType: "queue_entry",
    entityId: entryId,
    summary: "Called the patient in",
    detail: { encounterId: entry.encounterId, servicePointId: entry.servicePointId },
  });
  return serving;
}

/**
 * Finishes with a patient, and sends them on to `nextServicePointId` if
 * given, in one step. Triage also says how soon they must be seen
 * (`priority`), which orders the clinic queues for the rest of the visit.
 */
export async function finish(
  tx: AppDb,
  facilityId: string,
  entryId: string,
  input: { nextServicePointId?: string; priority?: Priority },
  actor: PatientActor,
  at = new Date(),
): Promise<{ finished: EntryRow; next: EntryRow | null }> {
  const entry = await lockEntry(tx, entryId);
  if (entry.status !== "serving")
    throw new QueueError("not_serving");
  if (input.priority) {
    const [point] = await tx.select({ kind: servicePoints.kind }).from(servicePoints).where(eq(servicePoints.id, entry.servicePointId));
    if (point.kind !== "triage")
      throw new QueueError("priority_at_triage_only");
  }
  const nextServicePointId = input.nextServicePointId;

  const [finished] = await tx.update(queueEntries)
    .set({ status: "done", endedAt: at, endedBy: actor.membershipId, priority: input.priority ?? null })
    .where(eq(queueEntries.id, entryId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "queue.finished",
    entityType: "queue_entry",
    entityId: entryId,
    summary: "Finished with the patient",
    detail: { encounterId: entry.encounterId, servicePointId: entry.servicePointId, nextServicePointId: nextServicePointId ?? null, priority: input.priority ?? null },
  });

  if (!nextServicePointId)
    return { finished, next: null };
  const [encounter] = await tx.select({ id: encounters.id, kind: encounters.kind, status: encounters.status }).from(encounters).where(eq(encounters.id, entry.encounterId));
  const next = await joinLocked(tx, facilityId, encounter, nextServicePointId, actor, at);
  return { finished, next };
}

/** Takes a waiting patient out of the queue: they left unseen, or were sent there in error. */
export async function removeFromQueue(
  tx: AppDb,
  facilityId: string,
  entryId: string,
  outcome: "left" | "cancelled",
  actor: PatientActor,
  at = new Date(),
): Promise<EntryRow> {
  const entry = await lockEntry(tx, entryId);
  if (entry.status !== "waiting")
    throw new QueueError("not_waiting");

  const [removed] = await tx.update(queueEntries)
    .set({ status: outcome, endedAt: at, endedBy: actor.membershipId })
    .where(eq(queueEntries.id, entryId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "queue.removed",
    entityType: "queue_entry",
    entityId: entryId,
    summary: outcome === "left" ? "The patient left without being seen" : "Taken out of a queue they were sent to in error",
    detail: { encounterId: entry.encounterId, servicePointId: entry.servicePointId, outcome },
  });
  await cancelEntryFee(tx, facilityId, entryId, outcome === "left" ? "Left without being seen" : "Sent to this clinic in error", actor);
  return removed;
}

/**
 * Ends an encounter's live entry as the encounter ends: the caller holds the
 * encounter's lock. Cancelling a visit opened in error cancels its waiting
 * entry, and is refused while a clinician is seeing the patient: once seen,
 * the visit is no longer simply a mistake. The nightly run (no actor) marks a
 * waiting patient as having left and a patient still being seen as done.
 */
export async function endLiveEntry(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor | null, at: Date): Promise<void> {
  const [live] = await tx.select().from(queueEntries).where(and(eq(queueEntries.encounterId, encounterId), inArray(queueEntries.status, LIVE))).for("update");
  if (!live)
    return;
  if (actor && live.status === "serving")
    throw new QueueError("being_seen");
  const status = actor ? "cancelled" : live.status === "serving" ? "done" : "left";
  await tx.update(queueEntries)
    .set({ status, endedAt: at, endedBy: actor?.membershipId ?? null })
    .where(eq(queueEntries.id, live.id));
  // A fee stands only for a patient who was seen.
  if (status !== "done")
    await cancelEntryFee(tx, facilityId, live.id, actor ? "The visit was cancelled" : "Left without being seen; closed by the nightly run", actor);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The visit's priority from triage: its latest triage entry's, derived per
 * row rather than copied onto each later entry, so a patient sent back to a
 * clinic after the lab keeps it.
 */
const triagePriority = sql<Priority | null>`(
  SELECT t.priority FROM queue_entries t
  JOIN service_points tp ON tp.id = t.service_point_id
  WHERE t.encounter_id = ${queueEntries.encounterId} AND tp.kind = 'triage' AND t.status = 'done' AND t.priority IS NOT NULL
  ORDER BY t.ended_at DESC LIMIT 1
)`;

/**
 * A service point's queue: those being seen, then those waiting, the most
 * urgent first (emergency, urgent, then routine or not triaged), each by
 * arrival. Audited, since it names patients and where they are (rule 9).
 */
export async function viewQueue(tx: AppDb, facilityId: string, servicePointId: string, actor: PatientActor, today?: string): Promise<QueueView> {
  const [point] = await tx.select().from(servicePoints).where(eq(servicePoints.id, servicePointId)).limit(1);
  if (!point)
    throw new QueueError("service_point_not_found");

  const rows = await tx
    .select({
      entryId: queueEntries.id,
      encounterId: queueEntries.encounterId,
      status: queueEntries.status,
      joinedAt: queueEntries.joinedAt,
      servingAt: queueEntries.servingAt,
      servedBy: queueEntries.servedBy,
      servedByName: user.name,
      priority: triagePriority,
      patientId: patients.id,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      opNumber: patientNumbers.number,
    })
    .from(queueEntries)
    .innerJoin(encounters, eq(encounters.id, queueEntries.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .leftJoin(memberships, eq(memberships.id, queueEntries.servedBy))
    .leftJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(queueEntries.servicePointId, servicePointId), inArray(queueEntries.status, LIVE)))
    .orderBy(
      desc(sql`${queueEntries.status} = 'serving'`),
      asc(sql`CASE ${triagePriority} WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`),
      asc(queueEntries.joinedAt),
      asc(queueEntries.id),
    )
    .limit(QUEUE_VIEW_LIMIT);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "queue.viewed",
    entityType: "service_point",
    entityId: servicePointId,
    summary: `Viewed the queue at ${point.name} (${rows.length})`,
  });

  return {
    servicePoint: { id: point.id, name: point.name, kind: point.kind, consultationItemId: point.consultationItemId, isActive: point.isActive },
    entries: rows.map(r => ({
      entryId: r.entryId,
      encounterId: r.encounterId,
      status: r.status,
      joinedAt: r.joinedAt,
      servingAt: r.servingAt,
      servedBy: r.servedBy && r.servedByName ? { membershipId: r.servedBy, name: r.servedByName } : null,
      priority: r.priority,
      patient: {
        id: r.patientId,
        name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "),
        opNumber: r.opNumber,
        sex: r.sex,
        ageYears: ageInYears(r.dateOfBirth, today),
      },
    })),
  };
}

/** A patient in a queue, as the queue screen shows them. */
export interface QueuedPatient {
  entryId: string;
  encounterId: string;
  status: EntryRow["status"];
  joinedAt: Date;
  servingAt: Date | null;
  servedBy: { membershipId: string; name: string } | null;
  priority: Priority | null;
  patient: {
    id: string;
    name: string;
    opNumber: string | null;
    sex: (typeof patients.$inferSelect)["sex"];
    ageYears: number;
  };
}

export interface QueueView {
  servicePoint: Omit<ListedServicePoint, "waiting">;
  entries: QueuedPatient[];
}

export interface LiveEntry {
  entryId: string;
  servicePointId: string;
  servicePointName: string;
  status: "waiting" | "serving";
  joinedAt: Date;
  servingAt: Date | null;
}

/** The queue each encounter's patient is in now, for those in one: one query for a page of encounters. */
export async function liveEntryOfEach(tx: AppDb, encounterIds: string[]): Promise<Map<string, LiveEntry>> {
  if (encounterIds.length === 0)
    return new Map();
  const rows = await tx
    .select({
      encounterId: queueEntries.encounterId,
      entryId: queueEntries.id,
      servicePointId: queueEntries.servicePointId,
      servicePointName: servicePoints.name,
      status: queueEntries.status,
      joinedAt: queueEntries.joinedAt,
      servingAt: queueEntries.servingAt,
    })
    .from(queueEntries)
    .innerJoin(servicePoints, eq(servicePoints.id, queueEntries.servicePointId))
    .where(and(inArray(queueEntries.encounterId, encounterIds), inArray(queueEntries.status, LIVE)));
  return new Map(rows.map(({ encounterId, ...live }) => [encounterId, { ...live, status: live.status as LiveEntry["status"] }]));
}

/** The queue an encounter's patient is in now, if any. */
export async function liveEntryOf(tx: AppDb, encounterId: string): Promise<LiveEntry | null> {
  return (await liveEntryOfEach(tx, [encounterId])).get(encounterId) ?? null;
}

export interface Attending {
  membershipId: string;
  name: string;
}

/**
 * Each encounter's attending clinician, derived rather than stored (rule 4):
 * whoever most recently called the patient in at a consultation point. One
 * query for a page of encounters; one nobody has seen is left out.
 */
export async function attendingOfEach(tx: AppDb, encounterIds: string[]): Promise<Map<string, Attending>> {
  if (encounterIds.length === 0)
    return new Map();
  const rows = await tx
    .selectDistinctOn([queueEntries.encounterId], { encounterId: queueEntries.encounterId, membershipId: memberships.id, name: user.name })
    .from(queueEntries)
    .innerJoin(servicePoints, eq(servicePoints.id, queueEntries.servicePointId))
    .innerJoin(memberships, eq(memberships.id, queueEntries.servedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(inArray(queueEntries.encounterId, encounterIds), eq(servicePoints.kind, "consultation"), isNotNull(queueEntries.servedBy)))
    .orderBy(queueEntries.encounterId, desc(queueEntries.servingAt));
  return new Map(rows.map(({ encounterId, ...who }) => [encounterId, who]));
}

/** The encounter's attending clinician (see `attendingOfEach`), if anyone has seen the patient. */
export async function attendingOf(tx: AppDb, encounterId: string): Promise<Attending | null> {
  return (await attendingOfEach(tx, [encounterId])).get(encounterId) ?? null;
}
