import { eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import app from "@/app";
import db from "@/db";
import { idempotentRequests, patients, payments } from "@/db/schema";
import { forgetOldKeys } from "@/jobs/idempotency";
import { backendPid, facilityHeaders, nextIp, resetDb, waitForBlockedBackend } from "@/test/helpers";
import { hospital } from "@/test/hospital";

/**
 * A write sent again with the same Idempotency-Key, as a screen does after a
 * dropped connection, is answered with its first answer and done once
 * (decided 2026-11-22: blackouts at the pilot make a retry normal).
 */

let h: Hospital;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
});

function write(path: string, who: Person, body: unknown, key?: string, method = "POST") {
  return app.request(path, {
    method,
    headers: {
      ...facilityHeaders(h.facility.id, who),
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

function newcomer(givenName = "Wanjiru") {
  return {
    givenName,
    familyName: "Kamau",
    sex: "female",
    dateOfBirth: "1990-05-01",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  };
}

/** The body's hash, as the API takes it from the bytes sent. */
function hashOf(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Ends a holder's transaction as a refused request's ends: rolled back. */
class RolledBack extends Error {}

async function registered(givenName: string) {
  return (await db.select({ id: patients.id }).from(patients).where(eq(patients.givenName, givenName))).length;
}

describe("a write sent again with its key", () => {
  it("is answered with its first answer, and done once", async () => {
    const key = randomUUID();

    const first = await write("/patients", h.nurse, newcomer(), key);
    const again = await write("/patients", h.nurse, newcomer(), key);

    expect([first.status, again.status]).toEqual([201, 201]);
    const [a, b] = [await first.json(), await again.json()];
    expect(b).toEqual(a);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(await registered("Wanjiru")).toBe(1);
  });

  it("takes one payment, however many times the cashier's screen sends it", async () => {
    await write("/cashier-shifts", h.cashier, { openingFloatCents: 0 });
    const patientId = await h.patient();
    const key = randomUUID();
    const pay = () => write("/payments", h.cashier, { patientId, method: "cash", amountCents: 50_000 }, key);

    const answers = await Promise.all([pay(), pay(), pay()]);

    expect(answers.map(r => r.status)).toEqual([201, 201, 201]);
    const ids = new Set(await Promise.all(answers.map(async r => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("waits on a request still holding its key, then gives that request's answer", async () => {
    const key = randomUUID();
    const body = newcomer("Wanjiru");
    const first = { id: randomUUID() };
    let retry!: Promise<Response>;

    await db.transaction(async (holder) => {
      // The first request: its key claimed, its answer not yet kept.
      await holder.insert(idempotentRequests).values({ facilityId: h.facility.id, userId: h.nurse.id, key, request: "POST /patients", bodyHash: hashOf(body) });
      retry = Promise.resolve(write("/patients", h.nurse, body, key));
      expect(await waitForBlockedBackend(await backendPid(holder))).toBe(true);
      await holder.update(idempotentRequests).set({ status: 201, answer: JSON.stringify(first), contentType: "application/json" }).where(eq(idempotentRequests.key, key));
    });

    const answered = await retry;
    expect([answered.status, answered.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
    expect(await answered.json()).toEqual(first);
    expect(await registered("Wanjiru")).toBe(0);
  });

  it("waits on a request still holding its key, then does the write itself if that one was refused", async () => {
    const key = randomUUID();
    const body = newcomer("Wanjiru");
    let retry!: Promise<Response>;

    await db.transaction(async (holder) => {
      await holder.insert(idempotentRequests).values({ facilityId: h.facility.id, userId: h.nurse.id, key, request: "POST /patients", bodyHash: hashOf(body) });
      retry = Promise.resolve(write("/patients", h.nurse, body, key));
      expect(await waitForBlockedBackend(await backendPid(holder))).toBe(true);
      // Refused: its transaction rolls back, key and all.
      throw new RolledBack();
    }).catch((err: unknown) => {
      if (!(err instanceof RolledBack))
        throw err;
    });

    const answered = await retry;
    expect([answered.status, answered.headers.get("idempotent-replayed")]).toEqual([201, null]);
    expect(await registered("Wanjiru")).toBe(1);
  });

  it("refuses the key for a different request", async () => {
    const key = randomUUID();
    await write("/patients", h.nurse, newcomer("Wanjiru"), key);

    const other = await write("/patients", h.nurse, newcomer("Akinyi"), key);

    expect(other.status).toBe(409);
    expect((await other.json()).code).toBe("idempotency_key_reused");
    expect(await registered("Akinyi")).toBe(0);
  });

  it("runs again after a refusal, since a refused write keeps nothing", async () => {
    const key = randomUUID();

    const refused = await write("/encounters", h.nurse, { patientId: randomUUID(), kind: "opd" }, key);
    const patientId = await h.patient();
    const opened = await write("/encounters", h.nurse, { patientId, kind: "opd" }, key);

    expect([refused.status, opened.status]).toEqual([404, 201]);
  });

  it("keeps each person's keys apart", async () => {
    const key = randomUUID();

    expect((await write("/patients", h.nurse, newcomer("Wanjiru"), key)).status).toBe(201);
    expect((await write("/patients", h.admin, newcomer("Akinyi"), key)).status).toBe(201);

    expect(await registered("Wanjiru") + await registered("Akinyi")).toBe(2);
  });

  it("refuses a key no screen would make, and leaves a write without one as it was", async () => {
    const bad = await write("/patients", h.nurse, newcomer(), "short");
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.issues[0].path).toEqual(["idempotency-key"]);

    expect((await write("/patients", h.nurse, newcomer("Wanjiru"))).status).toBe(201);
    expect((await write("/patients", h.nurse, newcomer("Wanjiru"))).status).toBe(201);
    expect(await registered("Wanjiru")).toBe(2);
  });

  it("is forgotten after a day, by the nightly close", async () => {
    const old = randomUUID();
    const fresh = randomUUID();
    await write("/patients", h.nurse, newcomer("Wanjiru"), old);
    await write("/patients", h.nurse, newcomer("Akinyi"), fresh);
    await db.update(idempotentRequests).set({ createdAt: sql`now() - interval '25 hours'` }).where(eq(idempotentRequests.key, old));

    expect(await forgetOldKeys()).toEqual({ forgotten: 1 });

    expect((await db.select({ key: idempotentRequests.key }).from(idempotentRequests)).map(k => k.key)).toEqual([fresh]);
  });
});
