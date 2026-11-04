import type { Content } from "pdfmake/interfaces";

import { eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";

import type { PrintedContent } from "@/lib/document-content";
import type { MembershipRole } from "@/lib/types";

import app from "@/app";
import db from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { documentDefinition } from "@/lib/document-pdf";
import { issueDocument, voidDocument } from "@/lib/documents";
import { registerSeries } from "@/lib/number-series";
import { facilityHeaders, makeFacility, nextIp, resetDb, signedInUserAt } from "@/test/helpers";

const RECEIPT: PrintedContent = {
  title: "Receipt",
  fields: [
    { label: "Received from", value: "Wanjiru Kamau" },
    { label: "Patient no.", value: "OP0042" },
  ],
  totals: [{ label: "Total paid", value: "KES 1,500.00" }],
};

async function receiptAt(facilityName = "Amani Hospital") {
  const facility = await makeFacility({ name: facilityName });
  const document = await runAsFacility(facility.id, async (tx) => {
    await registerSeries(tx, { facilityId: facility.id, kind: "receipt", prefix: "RCT-", resetPeriod: "yearly" });
    return issueDocument(tx, { facilityId: facility.id, kind: "receipt", content: RECEIPT, issuedBy: null });
  });
  return { facility, document };
}

async function openAs(facilityId: string, documentId: string, roles: MembershipRole[]) {
  const person = await signedInUserAt(facilityId, roles);
  const res = await app.request(`/documents/${documentId}/pdf`, { headers: facilityHeaders(facilityId, person) });
  return { person, res };
}

function verify(code: string) {
  return app.request(`/verify/${code}`, { headers: { "x-forwarded-for": nextIp() } });
}

function viewsOf(documentId: string) {
  return db.select().from(auditLog).where(eq(auditLog.entityId, documentId));
}

describe("printing a document", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("gives a cashier the receipt as a PDF, and records that they opened it", async () => {
    const { facility, document } = await receiptAt();

    const { person, res } = await openAs(facility.id, document.id, ["cashier"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${document.number}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const viewed = (await viewsOf(document.id)).filter(e => e.action === "document.viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ actorId: person.id, facilityId: facility.id });
  });

  it("refuses a member whose roles may not open receipts, and records no opening", async () => {
    const { facility, document } = await receiptAt();

    const { res } = await openAs(facility.id, document.id, ["nurse"]);

    expect(res.status).toBe(403);
    expect((await viewsOf(document.id)).some(e => e.action === "document.viewed")).toBe(false);
  });

  it("does not find another facility's document", async () => {
    const { document } = await receiptAt();
    const elsewhere = await makeFacility();

    const { res } = await openAs(elsewhere.id, document.id, ["cashier"]);

    expect(res.status).toBe(404);
  });
});

describe("verifying a document", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("confirms who issued it, its number and date, and nothing about the patient", async () => {
    const { facility, document } = await receiptAt();

    const res = await verify(document.verificationCode);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      verified: true,
      kind: "receipt",
      title: "Receipt",
      number: document.number,
      issuedAt: document.issuedAt.toISOString(),
      issuer: { name: "Amani Hospital", kmhfrCode: facility.kmhfrCode },
      status: "valid",
      withdrawnAt: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/Wanjiru|OP0042|1,500/);
  });

  it("records each check in the facility's audit log, with no actor", async () => {
    const { document } = await receiptAt();

    await verify(document.verificationCode);

    const checks = (await viewsOf(document.id)).filter(e => e.action === "document.verified");
    expect(checks).toHaveLength(1);
    expect(checks[0].actorId).toBeNull();
  });

  it("answers withdrawn once the document is voided, without saying why", async () => {
    const { facility, document } = await receiptAt();
    await runAsFacility(facility.id, tx => voidDocument(tx, {
      facilityId: facility.id,
      documentId: document.id,
      reason: "Payment reversed",
      voidedBy: null,
    }));

    const res = await verify(document.verificationCode);
    const body = await res.json();

    expect(body).toMatchObject({ verified: true, status: "withdrawn" });
    expect(body.withdrawnAt).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("reversed");
  });

  it("knows no document by a code nobody was given", async () => {
    const res = await verify("a".repeat(27));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ verified: false });
  });

  it("refuses something that is not a code at all", async () => {
    expect((await verify("short")).status).toBe(422);
  });

  it("is what the QR on the printed receipt opens", async () => {
    const { document } = await receiptAt();
    const footer = documentDefinition(document).footer as (current: number, count: number) => Content;
    const qr = JSON.stringify(footer(1, 1)).match(/"qr":"([^"]+)"/)?.[1];

    const code = new URL(qr!).pathname.replace("/verify/", "");
    const res = await verify(code);

    expect(res.status).toBe(200);
    expect((await res.json()).number).toBe(document.number);
  });

  it("limits how fast one address can check", async () => {
    const { document } = await receiptAt();
    const ip = nextIp();
    const check = () => app.request(`/verify/${document.verificationCode}`, { headers: { "x-forwarded-for": ip } });

    for (let i = 0; i < 30; i += 1)
      expect((await check()).status).toBe(200);

    expect((await check()).status).toBe(429);
  });
});
