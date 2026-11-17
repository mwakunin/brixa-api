import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RESET_REQUEST_ANSWER_MS } from "@/lib/auth";
import { sentEmails } from "@/lib/email";
import { createTestAccount, nextEmail, postJson, resetDb } from "@/test/helpers";

/** An email provider far slower than the time a reset request takes to answer. */
const PROVIDER_MS = 4_000;

vi.mock("@/lib/email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...real,
    sendEmail: vi.fn(async (mail: { to: string; subject: string; body: string }) => {
      await sleep(PROVIDER_MS);
      real.sentEmails.push(mail);
    }),
  };
});

/**
 * A reset request for a real account must not take longer to answer than one
 * for an address without one, however slow the email provider is (lib/auth.ts).
 */
describe("resetting a password while the email provider is slow", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("answers a real account in the same fixed time, and the email still goes after the answer", async () => {
    const known = nextEmail();
    await createTestAccount(known);

    for (const email of [known, nextEmail()]) {
      const asked = performance.now();
      const res = await postJson("/api/auth/request-password-reset", { email });
      const took = performance.now() - asked;

      expect(res.status, email).toBe(200);
      // A timer may fire a millisecond early; the database work fits well inside the fixed time.
      expect(took, email).toBeGreaterThanOrEqual(RESET_REQUEST_ANSWER_MS - 2);
      expect(took, email).toBeLessThan(RESET_REQUEST_ANSWER_MS + 400);
    }
    await vi.waitFor(() => expect(sentEmails.map(m => m.to)).toEqual([known]), { timeout: PROVIDER_MS + 2_000, interval: 100 });
  }, 20_000);
});
