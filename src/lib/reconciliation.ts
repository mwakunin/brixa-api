import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import type { AppDb } from "@/db";

/**
 * The money identities (SCHEMA.md §7.6), checked for one facility inside its
 * tenant transaction, so row-level security limits every query to it.
 *
 * The invariants are enforced as rows are written (services under locks,
 * triggers for every role). This is the independent second look the nightly
 * job takes, and that the P2 exit test runs after a scripted admission:
 * anything it finds means a guard was bypassed or is wrong.
 *
 * - M2: a payment's live allocations and live refunds never exceed it.
 * - M3: an invoice's live allocations and standing adjustments never exceed
 *   its total.
 * - M4: a charge's live assignments never exceed it; once an encounter's
 *   final bill is out, every live charge captured before it is fully billed.
 * - M-Pesa: a placed transaction has exactly one live payment, of its
 *   amount; one not placed has none.
 *
 * M7 is the sum of these: with no drift, Σ payments = Σ allocations +
 * Σ refunds + credit, and Σ invoiced = Σ allocations + Σ adjustments + Σ owed.
 * Drift names only ids (rule 10).
 */

export type Identity = "M2" | "M3" | "M4" | "M4_final" | "mpesa";

export interface Drift {
  identity: Identity;
  subjectId: string;
  detail: string;
}

const LIVE_ALLOCATIONS = sql`
  SELECT a.payment_id, a.invoice_id, a.amount_cents
  FROM allocations a JOIN payments p ON p.id = a.payment_id
  WHERE a.reversed_at IS NULL AND p.reversed_at IS NULL`;

const LIVE_REFUNDS = sql`SELECT payment_id, amount_cents FROM refunds WHERE status = 'approved' AND reversed_at IS NULL`;

const STANDING_ADJUSTMENTS = sql`SELECT invoice_id, amount_cents FROM invoice_adjustments WHERE status = 'approved' AND reversed_at IS NULL`;

const LIVE_ASSIGNMENTS = sql`
  SELECT ca.charge_id, ca.amount_cents
  FROM charge_assignments ca
  JOIN invoice_lines l ON l.id = ca.invoice_line_id
  JOIN invoices i ON i.id = l.invoice_id
  WHERE i.status <> 'void'`;

const CHECKS: { identity: Identity; query: SQL }[] = [
  {
    identity: "M2",
    query: sql`
      SELECT p.id AS subject, p.amount_cents AS cap, coalesce(al.used, 0) + coalesce(rf.used, 0) AS used
      FROM payments p
      LEFT JOIN (SELECT payment_id, sum(amount_cents) AS used FROM (${LIVE_ALLOCATIONS}) x GROUP BY payment_id) al ON al.payment_id = p.id
      LEFT JOIN (SELECT payment_id, sum(amount_cents) AS used FROM (${LIVE_REFUNDS}) x GROUP BY payment_id) rf ON rf.payment_id = p.id
      WHERE p.reversed_at IS NULL AND coalesce(al.used, 0) + coalesce(rf.used, 0) > p.amount_cents`,
  },
  {
    identity: "M3",
    query: sql`
      SELECT i.id AS subject, i.total_cents AS cap, coalesce(al.used, 0) + coalesce(ad.used, 0) AS used
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, sum(amount_cents) AS used FROM (${LIVE_ALLOCATIONS}) x GROUP BY invoice_id) al ON al.invoice_id = i.id
      LEFT JOIN (SELECT invoice_id, sum(amount_cents) AS used FROM (${STANDING_ADJUSTMENTS}) x GROUP BY invoice_id) ad ON ad.invoice_id = i.id
      WHERE i.status = 'finalised' AND coalesce(al.used, 0) + coalesce(ad.used, 0) > i.total_cents`,
  },
  {
    identity: "M4",
    query: sql`
      SELECT c.id AS subject, c.amount_cents AS cap, sum(x.amount_cents) AS used
      FROM charges c JOIN (${LIVE_ASSIGNMENTS}) x ON x.charge_id = c.id
      GROUP BY c.id, c.amount_cents
      HAVING sum(x.amount_cents) > c.amount_cents`,
  },
  {
    identity: "M4_final",
    query: sql`
      SELECT c.id AS subject, c.amount_cents AS cap, coalesce(sum(x.amount_cents), 0) AS used
      FROM charges c
      LEFT JOIN (${LIVE_ASSIGNMENTS}) x ON x.charge_id = c.id
      WHERE c.cancelled_at IS NULL
        -- Captured before the final bill went out; a later one waits for a supplementary bill.
        AND EXISTS (SELECT 1 FROM invoices f WHERE f.encounter_id = c.encounter_id AND f.kind = 'final' AND f.status = 'finalised' AND c.captured_at <= f.finalised_at)
      GROUP BY c.id, c.amount_cents
      HAVING coalesce(sum(x.amount_cents), 0) < c.amount_cents`,
  },
  {
    identity: "mpesa",
    query: sql`
      SELECT t.id AS subject, t.amount_cents AS cap, coalesce(sum(p.amount_cents), 0) AS used
      FROM mpesa_transactions t
      LEFT JOIN payments p ON p.mpesa_transaction_id = t.id AND p.reversed_at IS NULL
      GROUP BY t.id, t.amount_cents, t.status
      HAVING (t.status = 'allocated' AND (count(p.id) <> 1 OR coalesce(sum(p.amount_cents), 0) <> t.amount_cents))
          OR (t.status <> 'allocated' AND count(p.id) > 0)`,
  },
];

export interface Totals {
  /** Live charges. */
  chargedCents: number;
  /** Totals of finalised invoices. */
  invoicedCents: number;
  /** Approved adjustments not reversed. */
  adjustedCents: number;
  /** Live payments. */
  receivedCents: number;
  /** Live allocations of live payments. */
  allocatedCents: number;
  /** Approved refunds not reversed. */
  refundedCents: number;
  /** received − allocated − refunded: the patient-deposits liability (§7.4). */
  creditCents: number;
  /** invoiced − allocated − adjusted: what finalised bills still owe. */
  owedCents: number;
}

async function totals(tx: AppDb): Promise<Totals> {
  const { rows } = await tx.execute(sql`
    SELECT
      (SELECT coalesce(sum(amount_cents), 0) FROM charges WHERE cancelled_at IS NULL) AS charged,
      (SELECT coalesce(sum(total_cents), 0) FROM invoices WHERE status = 'finalised') AS invoiced,
      (SELECT coalesce(sum(amount_cents), 0) FROM (${STANDING_ADJUSTMENTS}) x) AS adjusted,
      (SELECT coalesce(sum(amount_cents), 0) FROM payments WHERE reversed_at IS NULL) AS received,
      (SELECT coalesce(sum(amount_cents), 0) FROM (${LIVE_ALLOCATIONS}) x) AS allocated,
      (SELECT coalesce(sum(amount_cents), 0) FROM (${LIVE_REFUNDS}) x) AS refunded`);
  const row = rows[0] as Record<string, string | number>;
  const n = (key: string) => Number(row[key]);
  return {
    chargedCents: n("charged"),
    invoicedCents: n("invoiced"),
    adjustedCents: n("adjusted"),
    receivedCents: n("received"),
    allocatedCents: n("allocated"),
    refundedCents: n("refunded"),
    creditCents: n("received") - n("allocated") - n("refunded"),
    owedCents: n("invoiced") - n("allocated") - n("adjusted"),
  };
}

/** Checks one facility's money: its totals, and every place an identity fails. */
export async function reconcile(tx: AppDb): Promise<{ totals: Totals; drift: Drift[] }> {
  const drift: Drift[] = [];
  for (const check of CHECKS) {
    const { rows } = await tx.execute(check.query);
    for (const row of rows as { subject: string; cap: string | number; used: string | number }[])
      drift.push({ identity: check.identity, subjectId: row.subject, detail: `${check.identity}: ${Number(row.used)} against ${Number(row.cap)}` });
  }
  return { totals: await totals(tx), drift };
}
