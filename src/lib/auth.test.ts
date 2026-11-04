import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { user } from "@/db/schema";
import { AccountExistsError } from "@/lib/accounts";
import { auth } from "@/lib/auth";
import { createTestAccount, nextEmail, postJson, resetDb, TEST_PASSWORD } from "@/test/helpers";

/**
 * Accounts are invite-only (lib/auth.ts): a hospital's staff are known to it,
 * so nobody may create an account by visiting the sign-up endpoint.
 */
describe("accounts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses public sign-up and creates no user", async () => {
    const res = await postJson("/api/auth/sign-up/email", {
      email: nextEmail(),
      password: "correct-horse-battery",
      name: "Stranger",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(await db.select().from(user)).toEqual([]);
  });

  it("signs in an account created on the server", async () => {
    const email = nextEmail();
    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("session_token");
  });

  it("finishes an account a failed run left without a password, instead of colliding with it", async () => {
    const email = nextEmail();
    // What a run that died between its two writes leaves behind.
    const context = await auth.$context;
    await context.internalAdapter.createUser({ email, name: "Half Made", emailVerified: true }, { method: "admin" });

    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    // A finished account is not made twice.
    await expect(createTestAccount(email)).rejects.toBeInstanceOf(AccountExistsError);
  });

  it("refuses a wrong password", async () => {
    const email = nextEmail();
    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: "not-the-password" });

    expect(res.status).toBe(401);
  });
});
