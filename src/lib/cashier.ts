import { sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";

/**
 * The cashier's "due now" list (ROADMAP.md P3, slice 1c): every open
 * outpatient visit or emergency attendance with money to collect from the
 * patient. That is the charges no live invoice asks for yet (`unbilled`),
 * plus what its finalised patient bills still owe (`owed`).
 *
 * Patients may pay at each point or once at the end, side by side, so the
 * list does not ask which: whatever is due is due. Derived, never stored
 * (rule 4), with the same "live" as everywhere else: an assignment is live
 * while its invoice is not void, an allocation while neither it nor its
 * payment is reversed, an adjustment while approved and not reversed.
 * Admissions keep their own running bill and are not listed.
 */

/** A page: more than a Level 4 outpatient department usually has open at once. */
const DUE_LIMIT = 200;

export interface DueVisit {
  encounterId: string;
  kind: "opd" | "emergency";
  startedAt: Date;
  patient: { id: string; name: string; opNumber: string | null };
  unbilledCents: number;
  owedCents: number;
  dueCents: number;
}

interface DueRow extends Record<string, unknown> {
  encounter_id: string;
  kind: "opd" | "emergency";
  started_at: Date;
  patient_id: string;
  given_name: string;
  middle_names: string | null;
  family_name: string;
  op_number: string | null;
  unbilled_cents: string;
  owed_cents: string;
}

/** One page of the list, oldest visit first; `offset` skips that many for the next. */
export async function dueNow(tx: AppDb, facilityId: string, actor: PatientActor, offset = 0): Promise<DueVisit[]> {
  const { rows } = await tx.execute<DueRow>(sql`
    WITH visits AS (
      SELECT id, patient_id, kind, started_at FROM encounters
      WHERE status = 'open' AND kind IN ('opd', 'emergency')
    ),
    assigned AS (
      SELECT ca.charge_id, sum(ca.amount_cents) AS cents
      FROM charge_assignments ca
      JOIN invoice_lines il ON il.id = ca.invoice_line_id
      JOIN invoices i ON i.id = il.invoice_id
      WHERE i.status <> 'void' AND i.encounter_id IN (SELECT id FROM visits)
      GROUP BY ca.charge_id
    ),
    unbilled AS (
      SELECT c.encounter_id, sum(c.amount_cents - coalesce(a.cents, 0)) AS cents
      FROM charges c
      LEFT JOIN assigned a ON a.charge_id = c.id
      WHERE c.cancelled_at IS NULL AND c.encounter_id IN (SELECT id FROM visits)
      GROUP BY c.encounter_id
    ),
    owed AS (
      SELECT i.encounter_id, sum(
        i.total_cents
        - coalesce((SELECT sum(al.amount_cents) FROM allocations al JOIN payments p ON p.id = al.payment_id
            WHERE al.invoice_id = i.id AND al.reversed_at IS NULL AND p.reversed_at IS NULL), 0)
        - coalesce((SELECT sum(ad.amount_cents) FROM invoice_adjustments ad
            WHERE ad.invoice_id = i.id AND ad.status = 'approved' AND ad.reversed_at IS NULL), 0)
      ) AS cents
      FROM invoices i
      JOIN accounts ac ON ac.id = i.account_id AND ac.kind = 'patient'
      WHERE i.status = 'finalised' AND i.encounter_id IN (SELECT id FROM visits)
      GROUP BY i.encounter_id
    )
    SELECT v.id AS encounter_id, v.kind, v.started_at,
      p.id AS patient_id, p.given_name, p.middle_names, p.family_name, pn.number AS op_number,
      coalesce(u.cents, 0) AS unbilled_cents, coalesce(o.cents, 0) AS owed_cents
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN patient_numbers pn ON pn.patient_id = p.id AND pn.kind = 'outpatient'
    LEFT JOIN unbilled u ON u.encounter_id = v.id
    LEFT JOIN owed o ON o.encounter_id = v.id
    WHERE coalesce(u.cents, 0) > 0 OR coalesce(o.cents, 0) > 0
    ORDER BY v.started_at, v.id
    LIMIT ${DUE_LIMIT} OFFSET ${offset}
  `);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "billing.due_listed",
    entityType: "facility",
    entityId: facilityId,
    summary: `Listed the visits with money due (${rows.length}${offset ? `, from ${offset + 1}` : ""})`,
  });

  return rows.map((r) => {
    const unbilledCents = Number(r.unbilled_cents);
    const owedCents = Number(r.owed_cents);
    return {
      encounterId: r.encounter_id,
      kind: r.kind,
      startedAt: new Date(r.started_at),
      patient: {
        id: r.patient_id,
        name: [r.given_name, r.middle_names, r.family_name].filter(Boolean).join(" "),
        opNumber: r.op_number,
      },
      unbilledCents,
      owedCents,
      dueCents: unbilledCents + owedCents,
    };
  });
}
