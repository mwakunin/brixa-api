import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, documents, invoiceAdjustments } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { approveAdjustment, requestAdjustment } from "@/lib/adjustments";
import { resetDb } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

const YEAR = TODAY.slice(0, 4);

describe("adjustments", () => {
  let h: Hospital;
  let encounterId: string;
  let invoiceId: string;

  /** A finalised invoice for KES 508: a consultation and three tablets. */
  beforeEach(async () => {
    await resetDb();
    h = await hospital();
    encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind: "opd" })).json()).id;
    for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
      await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
    invoiceId = (await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.cashier, { kind: "final" })).json()).id;
    await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.cashier);
  });

  const ask = (body: { kind: string; amountCents: number }, as: Person = h.cashier, invoice = invoiceId) =>
    call("POST", `/invoices/${invoice}/adjustments`, h.facility.id, as, { reason: "Staff discount", ...body });
  const decide = (id: string, decision: "approve" | "reject" | "withdraw", as: Person) =>
    call("POST", `/adjustments/${id}/${decision}`, h.facility.id, as);
  const invoice = async () => (await call("GET", `/invoices/${invoiceId}`, h.facility.id, h.finance)).json();

  async function refusal(res: Response) {
    return [res.status, (await res.json()).code];
  }

  it("take effect only once a second person approves, lowering the balance", async () => {
    const asked = await ask({ kind: "waiver", amountCents: 10_000 });
    expect(asked.status).toBe(201);
    const { id } = await asked.json();
    expect((await invoice()).balanceCents).toBe(50_800);

    const approved = await decide(id, "approve", h.finance);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", decidedBy: h.finance.actor.membershipId, number: null });

    const after = await invoice();
    expect(after).toMatchObject({ totalCents: 50_800, balanceCents: 40_800 });
    expect(after.adjustments).toMatchObject([{ id, kind: "waiver", amountCents: 10_000, status: "approved" }]);
  });

  it("number a credit note when it is approved, and print what it credits", async () => {
    const { id } = await (await ask({ kind: "credit_note", amountCents: 800 })).json();
    const approved = await (await decide(id, "approve", h.admin)).json();

    expect(approved.number).toBe(`CN-${YEAR}-000001`);
    const [row] = await db.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.id, id));
    expect(approved.documentId).toBe(row.documentId);
    const [document] = await db.select().from(documents).where(eq(documents.id, row.documentId!));
    expect(document).toMatchObject({ kind: "credit_note", number: `CN-${YEAR}-000001` });
    expect(document.content).toMatchObject({
      title: "Credit note",
      fields: expect.arrayContaining([
        { label: "Bill to", value: "Test Patient" },
        { label: "Against invoice", value: `INV-${YEAR}-000001` },
        { label: "Reason", value: "Staff discount" },
      ]),
      totals: [{ label: "Invoice total", value: "KES 508.00" }, { label: "Credited", value: "KES 8.00" }],
    });
  });

  it("are never decided by the person who asked", async () => {
    const { id } = await (await ask({ kind: "write_off", amountCents: 800 }, h.finance)).json();

    expect(await refusal(await decide(id, "approve", h.finance))).toEqual([409, "same_person"]);
    expect(await refusal(await decide(id, "reject", h.finance))).toEqual([409, "same_person"]);
    expect((await decide(id, "approve", h.admin)).status).toBe(200);
  });

  it("are approved and rejected by finance or the admin only", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();

    expect((await decide(id, "approve", h.clerk)).status).toBe(403);
    expect((await decide(id, "reject", h.cashier)).status).toBe(403);
    expect((await ask({ kind: "waiver", amountCents: 800 }, h.nurse)).status).toBe(403);

    const rejected = await decide(id, "reject", h.finance);
    expect(await rejected.json()).toMatchObject({ status: "rejected" });
    expect((await invoice()).balanceCents).toBe(50_800);
  });

  it("never take off more than is left on the invoice", async () => {
    expect(await refusal(await ask({ kind: "waiver", amountCents: 50_900 }))).toEqual([409, "exceeds_balance"]);

    // Each fits when asked for; together they do not.
    const first = await (await ask({ kind: "waiver", amountCents: 30_000 })).json();
    const second = await (await ask({ kind: "credit_note", amountCents: 30_000 })).json();
    expect((await decide(first.id, "approve", h.finance)).status).toBe(200);
    expect(await refusal(await decide(second.id, "approve", h.finance))).toEqual([409, "exceeds_balance"]);

    // Exactly what is left is allowed.
    const rest = await (await ask({ kind: "write_off", amountCents: 20_800 })).json();
    expect((await decide(rest.id, "approve", h.finance)).status).toBe(200);
    expect((await invoice()).balanceCents).toBe(0);
  });

  it("are made only against a finalised invoice", async () => {
    const pending = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    await call("POST", `/invoices/${invoiceId}/void`, h.facility.id, h.finance, { reason: "Wrong patient" });

    expect(await refusal(await ask({ kind: "waiver", amountCents: 800 }))).toEqual([409, "not_finalised"]);
    expect(await refusal(await decide(pending.id, "approve", h.finance))).toEqual([409, "not_finalised"]);
  });

  it("keep an adjusted invoice from being voided", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    await decide(id, "approve", h.finance);

    const voided = await call("POST", `/invoices/${invoiceId}/void`, h.facility.id, h.finance, { reason: "Wrong patient" });
    expect(await refusal(voided)).toEqual([409, "has_adjustments"]);
  });

  it("are withdrawn only by the requester, and decided once", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();

    expect(await refusal(await decide(id, "withdraw", h.clerk))).toEqual([409, "not_requester"]);
    expect(await (await decide(id, "withdraw", h.cashier)).json()).toMatchObject({ status: "withdrawn" });
    expect(await refusal(await decide(id, "approve", h.finance))).toEqual([409, "not_pending"]);
  });

  it("queue for approval, readable by those who keep the money", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    const decided = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    await decide(decided.id, "approve", h.finance);

    const queue = await (await call("GET", "/adjustments?status=pending", h.facility.id, h.finance)).json();
    expect(queue.adjustments).toMatchObject([{ id, invoiceNumber: `INV-${YEAR}-000001`, status: "pending", amountCents: 800 }]);
    expect((await call("GET", "/adjustments", h.facility.id, h.nurse)).status).toBe(403);
    const [listed] = await db.select().from(auditLog).where(eq(auditLog.action, "adjustment.listed"));
    expect(listed).toMatchObject({ actorId: h.finance.id, detail: { status: "pending", ids: [id] } });
  });

  it("are audited when asked for and when decided", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    await decide(id, "approve", h.finance);

    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(entries.map(e => [e.action, e.actorId]).sort()).toEqual([
      ["adjustment.approved", h.finance.id],
      ["adjustment.requested", h.cashier.id],
    ]);
  });

  it("are not found from another facility", async () => {
    const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();
    const elsewhere = await hospital();

    expect((await decide(id, "approve", elsewhere.finance)).status).toBe(404);
    expect((await ask({ kind: "waiver", amountCents: 800 }, elsewhere.cashier)).status).toBe(404);
  });

  describe("reversed", () => {
    async function approved(kind = "waiver", amountCents = 10_000) {
      const { id } = await (await ask({ kind, amountCents })).json();
      await decide(id, "approve", h.finance);
      return id as string;
    }
    const reverse = (id: string, as: Person = h.clerk) =>
      call("POST", `/adjustments/${id}/reversals`, h.facility.id, as, { reason: "Approved in error" });
    const decideReversal = (id: string, decision: "approve" | "reject" | "withdraw", as: Person) =>
      call("POST", `/adjustment-reversals/${id}/${decision}`, h.facility.id, as);

    it("only once a second person approves, and the amount owes again", async () => {
      const id = await approved();
      expect((await invoice()).balanceCents).toBe(40_800);

      const asked = await reverse(id);
      expect(asked.status).toBe(201);
      const reversal = await asked.json();
      expect(reversal).toMatchObject({ adjustmentId: id, status: "pending", amountCents: 10_000 });
      expect((await invoice()).balanceCents).toBe(40_800);
      expect(await refusal(await decideReversal(reversal.id, "approve", h.clerk))).toEqual([403, undefined]);

      expect(await (await decideReversal(reversal.id, "approve", h.finance)).json()).toMatchObject({ status: "approved" });
      const after = await invoice();
      expect(after.balanceCents).toBe(50_800);
      expect(after.adjustments).toMatchObject([{ id, status: "approved", reversedAt: expect.any(String) }]);
      expect(await refusal(await reverse(id))).toEqual([409, "already_reversed"]);
      const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "adjustment.reversed"));
      expect(entry).toMatchObject({ actorId: h.finance.id, entityId: id });
    });

    it("never by the person who asked, and one request at a time", async () => {
      const id = await approved();
      const own = await (await reverse(id, h.finance)).json();

      expect(await refusal(await decideReversal(own.id, "approve", h.finance))).toEqual([409, "same_person"]);
      expect(await refusal(await reverse(id))).toEqual([409, "reversal_open"]);
      expect(await refusal(await decideReversal(own.id, "withdraw", h.clerk))).toEqual([409, "not_requester"]);
      expect(await (await decideReversal(own.id, "withdraw", h.finance)).json()).toMatchObject({ status: "withdrawn" });

      const again = await (await reverse(id)).json();
      expect(await (await decideReversal(again.id, "reject", h.admin)).json()).toMatchObject({ status: "rejected" });
      expect((await invoice()).balanceCents).toBe(40_800);

      const pending = await (await ask({ kind: "waiver", amountCents: 800 })).json();
      expect(await refusal(await reverse(pending.id))).toEqual([409, "not_approved"]);
    });

    it("void a credit note's document, which keeps its number", async () => {
      const id = await approved("credit_note", 800);
      const reversal = await (await reverse(id)).json();
      await decideReversal(reversal.id, "approve", h.finance);

      const [row] = await db.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.id, id));
      const [document] = await db.select().from(documents).where(eq(documents.id, row.documentId!));
      expect(document).toMatchObject({ number: `CN-${YEAR}-000001`, voidReason: "Approved in error" });
    });

    it("are listed for the approver, audited", async () => {
      const id = await approved();
      const reversal = await (await reverse(id)).json();

      const listed = await (await call("GET", "/adjustment-reversals?status=pending", h.facility.id, h.finance)).json();
      expect(listed.reversals.map((r: { id: string }) => r.id)).toEqual([reversal.id]);
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "adjustment.reversals_listed"))).toHaveLength(1);
      expect((await call("GET", "/adjustment-reversals", h.facility.id, h.nurse)).status).toBe(403);
    });

    it("free the invoice's room for payments and for voiding", async () => {
      const id = await approved("waiver", 50_800);
      const reversal = await (await reverse(id)).json();
      expect(await refusal(await call("POST", `/invoices/${invoiceId}/void`, h.facility.id, h.finance, { reason: "Wrong patient" }))).toEqual([409, "has_adjustments"]);
      await decideReversal(reversal.id, "approve", h.finance);

      expect((await call("POST", `/invoices/${invoiceId}/void`, h.facility.id, h.finance, { reason: "Wrong patient" })).status).toBe(200);
    });

    it("in the database: once, with a reason, and decided by someone else", async () => {
      const id = await approved();
      await expect(pool.query("UPDATE invoice_adjustments SET reversed_at = now(), reversed_by = decided_by WHERE id = $1", [id]))
        .rejects
        .toMatchObject({ code: "23514" });
      const reversal = await (await reverse(id)).json();
      await expect(pool.query("UPDATE adjustment_reversals SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [reversal.id]))
        .rejects
        .toMatchObject({ code: "23514" });
      await expect(pool.query("UPDATE adjustment_reversals SET reason = 'x' WHERE id = $1", [reversal.id])).rejects.toMatchObject({ code: "23001" });
      await decideReversal(reversal.id, "approve", h.finance);

      await expect(pool.query("UPDATE invoice_adjustments SET reversal_reason = 'Other' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23001" });
      await expect(pool.query("DELETE FROM adjustment_reversals WHERE id = $1", [reversal.id])).rejects.toMatchObject({ code: "23001" });
    });
  });

  describe("in the database", () => {
    async function pendingRow() {
      const { id } = await (await ask({ kind: "waiver", amountCents: 800 })).json();
      return id as string;
    }

    it("are decided once and never edited or removed, whoever writes", async () => {
      const id = await pendingRow();
      await decide(id, "approve", h.finance);

      await expect(pool.query("UPDATE invoice_adjustments SET amount_cents = 100 WHERE id = $1", [id])).rejects.toMatchObject({ code: "23001" });
      await expect(pool.query("UPDATE invoice_adjustments SET status = 'rejected' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23001" });
      await expect(pool.query("DELETE FROM invoice_adjustments WHERE id = $1", [id])).rejects.toMatchObject({ code: "23001" });
    });

    it("are written pending, and approved by someone else, within the total", async () => {
      const id = await pendingRow();
      const [row] = await db.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.id, id));

      await expect(pool.query(
        `INSERT INTO invoice_adjustments (facility_id, invoice_id, account_id, kind, amount_cents, reason, status, requested_by, decided_by, decided_at)
         VALUES ($1, $2, $3, 'waiver', 100, 'x', 'approved', $4, $5, now())`,
        [h.facility.id, invoiceId, row.accountId, row.requestedBy, h.finance.actor.membershipId],
      )).rejects.toMatchObject({ code: "23001" });
      await expect(pool.query("UPDATE invoice_adjustments SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [id]))
        .rejects
        .toMatchObject({ code: "23514" });
      // Withdrawn only with its requester named.
      await expect(pool.query("UPDATE invoice_adjustments SET status = 'withdrawn', decided_at = now() WHERE id = $1", [id]))
        .rejects
        .toMatchObject({ code: "23514" });

      const big = await (await ask({ kind: "waiver", amountCents: 50_800 })).json();
      await decide(id, "approve", h.finance);
      await expect(pool.query("UPDATE invoice_adjustments SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1", [big.id, h.finance.actor.membershipId]))
        .rejects
        .toMatchObject({ code: "23514" });
    });
  });

  it("two approvals at once never take off more than the total", async () => {
    const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);
    const ids = await Promise.all([1, 2, 3].map(() =>
      tx(t => requestAdjustment(t, h.facility.id, { invoiceId, kind: "waiver", amountCents: 30_000, reason: "Charity" }, h.cashier.actor))));

    const results = await Promise.allSettled(ids.map(id => tx(t => approveAdjustment(t, h.facility.id, id, h.finance.actor))));

    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason.code)).toEqual(["exceeds_balance", "exceeds_balance"]);
  });
});
