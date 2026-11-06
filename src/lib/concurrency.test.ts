import { beforeEach, describe, expect, it } from "vitest";

import type { AppDb } from "@/db";
import type { Hospital } from "@/test/hospital";

import { runAsFacility } from "@/db/tenant-transaction";
import { allocate } from "@/lib/allocations";
import { draftInvoice } from "@/lib/billing";
import { recordPayment } from "@/lib/payments";
import { approveRefund, requestRefund } from "@/lib/refunds";
import { backendPid, resetDb, waitForBlockedBackend } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/**
 * The P2 exit's concurrency tests (ROADMAP.md P2), in the style of
 * school-saas's allocations.test.ts: one transaction holds its locks, the
 * test asks Postgres that the other is queued behind it (not merely that
 * both ran), then lets the first commit and checks the second sees it.
 */

let h: Hospital;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  await call("POST", "/cashier-shifts", h.facility.id, h.cashier, { openingFloatCents: 0 });
});

const tx = <T>(fn: (t: AppDb) => Promise<T>) => runAsFacility(h.facility.id, fn);

/** Runs `work` in a transaction that stays open, holding its locks, until released. */
async function heldOpen<T>(work: (t: AppDb) => Promise<T>) {
  let pid = 0;
  let release!: () => void;
  let ready!: () => void;
  const mayCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = tx(async (t) => {
    try {
      const result = await work(t);
      pid = await backendPid(t);
      return result;
    }
    finally {
      ready();
      await mayCommit;
    }
  });
  await started;
  return { pid, release, done };
}

/** An open visit with a consultation and three tablets (KES 508). */
async function visit(patientId?: string) {
  const patient = patientId ?? await h.patient();
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: patient, kind: "opd" })).json()).id as string;
  for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
    await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
  return { patientId: patient, encounterId };
}

/** A closed visit with a finalised KES 508 bill. */
async function billed(patientId?: string) {
  const { patientId: patient, encounterId } = await visit(patientId);
  const { id } = await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json();
  await call("POST", `/invoices/${id}/finalise`, h.facility.id, h.clerk);
  await call("POST", `/encounters/${encounterId}/close`, h.facility.id, h.nurse);
  return { patientId: patient, invoiceId: id as string };
}

describe("under concurrency", () => {
  it("an allocation waits for another of the same payment, then sees what is left", async () => {
    const { patientId, invoiceId: first } = await billed();
    const { invoiceId: second } = await billed(patientId);
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 50_000 }, h.cashier.actor));

    const holder = await heldOpen(t => allocate(t, h.facility.id, { paymentId, invoiceId: first, amountCents: 40_000 }, h.clerk.actor));
    const waiter = tx(t => allocate(t, h.facility.id, { paymentId, invoiceId: second, amountCents: 40_000 }, h.clerk.actor));
    try {
      expect(await waitForBlockedBackend(holder.pid)).toBe(true);
    }
    finally {
      holder.release();
    }

    await holder.done;
    await expect(waiter).rejects.toMatchObject({ code: "exceeds_payment" });
  });

  it("a charge is assigned to one draft bill, however many are drafted at once", async () => {
    const { encounterId } = await visit();

    const holder = await heldOpen(t => draftInvoice(t, h.facility.id, { encounterId, kind: "interim" }, h.cashier.actor));
    const waiter = tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "interim" }, h.clerk.actor));
    try {
      expect(await waitForBlockedBackend(holder.pid)).toBe(true);
    }
    finally {
      holder.release();
    }

    await holder.done;
    await expect(waiter).rejects.toMatchObject({ code: "nothing_to_bill" });
  });

  it("a refund approved while the payment is being applied waits, then finds too little left", async () => {
    const { patientId, invoiceId } = await billed();
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 60_000 }, h.cashier.actor));
    const refundId = await tx(t => requestRefund(t, h.facility.id, { paymentId, amountCents: 30_000, reason: "Cover came through" }, h.clerk.actor));

    const holder = await heldOpen(t => allocate(t, h.facility.id, { paymentId, invoiceId, amountCents: 50_800 }, h.clerk.actor));
    const waiter = tx(t => approveRefund(t, h.facility.id, refundId, h.finance.actor));
    try {
      expect(await waitForBlockedBackend(holder.pid)).toBe(true);
    }
    finally {
      holder.release();
    }

    await holder.done;
    await expect(waiter).rejects.toMatchObject({ code: "exceeds_payment" });
  });

  it("two refunds of one payment approved at once never return more than it had", async () => {
    const { patientId } = await billed();
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 50_000 }, h.cashier.actor));
    const [first, second] = [
      await tx(t => requestRefund(t, h.facility.id, { paymentId, amountCents: 30_000, reason: "Cover came through" }, h.clerk.actor)),
      await tx(t => requestRefund(t, h.facility.id, { paymentId, amountCents: 30_000, reason: "Cover came through" }, h.clerk.actor)),
    ];

    const holder = await heldOpen(t => approveRefund(t, h.facility.id, first, h.finance.actor));
    const waiter = tx(t => approveRefund(t, h.facility.id, second, h.admin.actor));
    try {
      expect(await waitForBlockedBackend(holder.pid)).toBe(true);
    }
    finally {
      holder.release();
    }

    await holder.done;
    await expect(waiter).rejects.toMatchObject({ code: "exceeds_payment" });
  });
});
