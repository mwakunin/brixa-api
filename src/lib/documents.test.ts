import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db, { pool } from "@/db";
import { auditLog, documents, facilities } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addMembership, makeFacility, resetDb, signedInUser } from "@/test/helpers";

import type { PrintedContent } from "./document-content";

import { DocumentVoidError, issueDocument, voidDocument } from "./documents";
import { registerSeries } from "./number-series";
import { VERIFICATION_CODE_PATTERN } from "./verification";

const AT = new Date("2026-11-04T09:00:00Z");

const RECEIPT: PrintedContent = {
  title: "Receipt",
  fields: [{ label: "Received from", value: "Wanjiru Kamau" }],
  table: { columns: [{ label: "Item" }, { label: "Amount (KES)", align: "right" }], rows: [["Consultation", "1,000.00"]] },
  totals: [{ label: "Total paid", value: "KES 1,000.00" }],
};

async function facilityWithReceipts() {
  const facility = await makeFacility({ name: "Amani Hospital" });
  await runAsFacility(facility.id, tx => registerSeries(tx, {
    facilityId: facility.id,
    kind: "receipt",
    prefix: "RCT-",
    resetPeriod: "yearly",
    at: AT,
  }));
  return facility;
}

function issue(facilityId: string, content: PrintedContent = RECEIPT) {
  return runAsFacility(facilityId, tx => issueDocument(tx, { facilityId, kind: "receipt", content, issuedBy: null, at: AT }));
}

/** Postgres's error code, whatever wrapper the driver put around it. */
async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  }
  catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

describe("issuing a document", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("takes gap-free numbers from the facility's series for that kind", async () => {
    const facility = await facilityWithReceipts();

    const first = await issue(facility.id);
    const second = await issue(facility.id);

    expect([first.number, second.number]).toEqual(["RCT-2026-0001", "RCT-2026-0002"]);
  });

  it("spends no number when the transaction that issues it rolls back", async () => {
    const facility = await facilityWithReceipts();

    await expect(runAsFacility(facility.id, async (tx) => {
      await issueDocument(tx, { facilityId: facility.id, kind: "receipt", content: RECEIPT, issuedBy: null, at: AT });
      throw new Error("the payment failed");
    })).rejects.toThrow("the payment failed");

    expect((await issue(facility.id)).number).toBe("RCT-2026-0001");
  });

  it("refuses malformed content before it spends a number", async () => {
    const facility = await facilityWithReceipts();
    const ragged = { ...RECEIPT, table: { columns: [{ label: "Item" }], rows: [["one", "two"]] } };

    await expect(issue(facility.id, ragged)).rejects.toThrow(/one cell per column/);
    expect((await issue(facility.id)).number).toBe("RCT-2026-0001");
  });

  it("freezes the facility's name as it was when issued", async () => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);

    await db.update(facilities).set({ name: "Amani Hospital (renamed)" }).where(eq(facilities.id, facility.id));

    const [stored] = await db.select().from(documents).where(eq(documents.id, issued.id));
    expect(stored.content.issuer).toEqual({ name: "Amani Hospital", kmhfrCode: facility.kmhfrCode, county: null });
  });

  it("mints a distinct unguessable code for each document", async () => {
    const facility = await facilityWithReceipts();

    const codes = [(await issue(facility.id)).verificationCode, (await issue(facility.id)).verificationCode];

    expect(codes.every(code => VERIFICATION_CODE_PATTERN.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(2);
  });

  it("records who issued it, by membership and in the audit log", async () => {
    const facility = await facilityWithReceipts();
    const cashier = await signedInUser();
    const membership = await addMembership(cashier.id, facility.id, ["cashier"]);

    const issued = await runAsFacility(facility.id, tx => issueDocument(tx, {
      facilityId: facility.id,
      kind: "receipt",
      content: RECEIPT,
      issuedBy: { userId: cashier.id, membershipId: membership.id },
      at: AT,
    }));

    expect(issued.issuedBy).toBe(membership.id);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "document.issued"));
    expect(entry).toMatchObject({ actorId: cashier.id, entityId: issued.id, summary: "Receipt RCT-2026-0001 issued" });
  });
});

describe("an issued document", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each([
    ["its content", `UPDATE documents SET content = '{}'::jsonb WHERE id = $1`],
    ["its number", `UPDATE documents SET number = 'RCT-2026-9999' WHERE id = $1`],
    ["its code", `UPDATE documents SET verification_code = repeat('a', 27) WHERE id = $1`],
    ["its existence", `DELETE FROM documents WHERE id = $1`],
  ])("cannot lose %s, even to the owner", async (_what, statement) => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);

    expect(await sqlStateOf(pool.query(statement, [issued.id]))).toBe("23001");
  });

  it("gives the runtime role no way to write anything but the void columns", async () => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);

    const edit = runAsFacility(facility.id, tx => tx.update(documents).set({ number: "RCT-2026-9999" }).where(eq(documents.id, issued.id)));

    expect(await sqlStateOf(edit)).toBe("42501");
  });
});

describe("voiding a document", () => {
  beforeEach(async () => {
    await resetDb();
  });

  function voidIt(facilityId: string, documentId: string, reason = "Payment reversed") {
    return runAsFacility(facilityId, tx => voidDocument(tx, { facilityId, documentId, reason, voidedBy: null }));
  }

  it("keeps its number and content, and records why in the audit log", async () => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);

    const voided = await voidIt(facility.id, issued.id);

    expect(voided.voidedAt).toBeInstanceOf(Date);
    expect(voided).toMatchObject({ number: issued.number, content: issued.content, voidReason: "Payment reversed" });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "document.voided"));
    expect(entry).toMatchObject({ entityId: issued.id, detail: { reason: "Payment reversed" } });
  });

  it("happens once, and a voided document never changes again", async () => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);
    await voidIt(facility.id, issued.id);

    await expect(voidIt(facility.id, issued.id)).rejects.toEqual(new DocumentVoidError("already_voided"));
    // Not even back to standing, by the owner.
    const unvoid = pool.query("UPDATE documents SET voided_at = NULL, void_reason = NULL WHERE id = $1", [issued.id]);
    expect(await sqlStateOf(unvoid)).toBe("23001");
  });

  it("needs a reason", async () => {
    const facility = await facilityWithReceipts();
    const issued = await issue(facility.id);

    expect(await sqlStateOf(voidIt(facility.id, issued.id, "   "))).toBe("23514");
  });

  it("cannot reach another facility's document", async () => {
    const facility = await facilityWithReceipts();
    const other = await facilityWithReceipts();
    const theirs = await issue(other.id);

    await expect(voidIt(facility.id, theirs.id)).rejects.toEqual(new DocumentVoidError("not_found"));
    const [untouched] = await db.select().from(documents).where(eq(documents.id, theirs.id));
    expect(untouched.voidedAt).toBeNull();
  });
});
