import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Owned by Better Auth. Ported from school-saas-api without the phone-number
// plugin's columns: staff sign in with email+password for now. Regenerate with:
//
//   npx @better-auth/cli@latest generate --config src/lib/auth.ts \
//     --output src/db/auth-schema.ts --yes
//
// Regenerating is a starting point, not a finished file. Better Auth is
// 1.7.15 here; school-saas-api's 1.7.1 needed an `account.issuer` column that
// 1.7.3+ dropped, and this file follows the newer runtime.
//
// Four deliberate deviations — reapply every one after regenerating:
//
//  1. `user.role` has `.notNull()` added. The CLI emits a nullable column,
//     which would force a null-check at every authorization site. The DB
//     default ("user") makes notNull safe.
//  2. The CLI also emits `userRelations` / `sessionRelations` /
//     `accountRelations` at the bottom of the file. They are deleted: a
//     second `relations(user, ...)` elsewhere would collide silently, since
//     db/index.ts spreads both modules into one schema object.
//  3. `.defaultNow()` is added to `session.updatedAt` and
//     `account.updatedAt`. The CLI emits `$onUpdate` alone, which fires on
//     UPDATE and not INSERT, leaving a NOT NULL column with no default.
//  4. `account` gains a unique index on (providerId, accountId), the pair
//     that identifies an account at its provider. The CLI emits no such
//     constraint, so concurrent sign-ins could insert duplicates and make
//     account lookup ambiguous.
//
// Note: these timestamps are `timestamp` (no time zone), unlike the domain
// tables which use timestamptz. That is Better Auth's choice; it stays
// self-consistent because Better Auth both writes and reads them. Keep the
// database and Node process in UTC and it is a non-issue.
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  // Deviation 1: .notNull() added on top of the CLI output.
  role: text("role").default("user").notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Deviation 3: `.defaultNow()` added. The CLI emits $onUpdate only, which
    // fires on UPDATE and not INSERT, leaving a NOT NULL column with no
    // default that any direct insert trips over.
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  table => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Deviation 3, as on `session` above.
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    index("account_user_id_idx").on(table.userId),
    // Deviation 4: one row per account at its provider. Reapply after
    // regenerating.
    uniqueIndex("account_provider_id_account_id_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [index("verification_identifier_idx").on(table.identifier)],
);
