import { auth } from "./auth";

/**
 * Accounts made on the server, never by public sign-up (SPEC.md §2).
 *
 * Uses Better Auth's own adapter and password hasher, the same two calls its
 * sign-up endpoint makes, so the rows are exactly what its sign-in expects.
 * They run on Better Auth's connection (role `hospital_auth`), the only one
 * that can write a password hash.
 */

/** Matches Better Auth's own bounds (lib/auth.ts sets the minimum). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** A person set up by an administrator: "admin" is Better Auth's name for it. */
const PROVISIONED = { method: "admin" } as const;

/**
 * Creates an account with a password, its address already proven: the
 * superadmin script and the test harness call this directly, and accepting an
 * invitation (which proves the address) calls it through `claimAccount`.
 */
export async function createAccount(input: {
  email: string;
  name: string;
  password: string;
  role?: "user" | "superadmin";
}) {
  const context = await auth.$context;
  const created = await context.internalAdapter.createUser(
    {
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: true,
      role: input.role ?? "user",
    },
    PROVISIONED,
  );

  await context.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await context.password.hash(input.password),
  });

  return created;
}

/**
 * The account an accepted invitation belongs to: the existing one for that
 * address, or a new one with `password`.
 *
 * Someone who already has an account (a locum invited by a second hospital)
 * keeps their password; the invitation only adds a membership. `null` means a
 * new account was needed and no password was given.
 */
export async function claimAccount(input: {
  email: string;
  name: string;
  password?: string;
}): Promise<{ userId: string; created: boolean } | null> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(input.email, { includeAccounts: true });

  if (found) {
    const hasPassword = found.accounts.some(a => a.providerId === "credential" && a.password);
    if (!hasPassword) {
      if (!input.password)
        return null;
      await context.internalAdapter.linkAccount({
        userId: found.user.id,
        providerId: "credential",
        accountId: found.user.id,
        password: await context.password.hash(input.password),
      });
    }

    // The invitation was delivered to this address, so following its link
    // proves the person controls it.
    if (!found.user.emailVerified)
      await context.internalAdapter.updateUser(found.user.id, { emailVerified: true });

    return { userId: found.user.id, created: false };
  }

  if (!input.password)
    return null;

  const created = await createAccount({ email: input.email, name: input.name, password: input.password });
  return { userId: created.id, created: true };
}
