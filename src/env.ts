/* eslint-disable node/no-process-env */
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import path from "node:path";
import { z } from "zod";

expand(config({
  path: path.resolve(
    process.cwd(),
    process.env.NODE_ENV === "test" ? ".env.test" : ".env",
  ),
  quiet: true,
}));

/** Credentials production cannot run without. */
const PRODUCTION_REQUIRED = [
  // Without mail, sign-up cannot prove an address belongs to the registrant.
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
] as const;

/** The username from a DSN, or undefined if it isn't parseable. */
function parseRole(dsn: string | undefined): string | undefined {
  if (!dsn)
    return undefined;
  try {
    return decodeURIComponent(new URL(dsn).username) || undefined;
  }
  catch {
    return undefined;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(9999),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),

  // --- Data stores ---
  /**
   * The OWNER connection: migrations, the test harness, tenant bootstrap and
   * the superadmin plane. Exempt from row-level security, so nothing that
   * serves a tenant request may use it (CLAUDE.md rule 2).
   */
  DATABASE_URL: z.url(),
  /**
   * The unprivileged runtime connection (`hospital_app`, db/roles.sql).
   * Required to be a different role from DATABASE_URL: if both are the owner,
   * every policy still exists and none of them applies.
   */
  APP_DATABASE_URL: z.url(),
  /**
   * Better Auth's own connection (`hospital_auth`, db/roles.sql): the only
   * role that can read sessions and password hashes. A third role so the one
   * tenant handlers run as cannot reach them.
   */
  AUTH_DATABASE_URL: z.url(),
  TEST_DATABASE_URL: z.url().optional(),
  TEST_APP_DATABASE_URL: z.url().optional(),
  TEST_AUTH_DATABASE_URL: z.url().optional(),

  /** Rate-limit counters only: no patient data and no job queues (CLAUDE.md §7). */
  REDIS_URL: z.url(),

  // --- Auth (Better Auth) ---
  BETTER_AUTH_SECRET: z.string().min(32, "Must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),

  /**
   * The staff app's origin, which links in emails point at (an invitation's
   * accept page). Not the API's own URL.
   */
  APP_URL: z.url().default("http://localhost:3000"),

  /**
   * How many of your own proxies sit in front of the app. 0 means it is
   * exposed directly, so X-Forwarded-For is ignored: trusting it would let
   * anyone reset their own rate limit by rotating the header. Set to the real
   * hop count behind a load balancer; too high reintroduces the bypass.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Comma-separated addresses allowed to have written X-Forwarded-For. Needed
   * unless the network makes direct access to the app impossible.
   */
  TRUSTED_PROXY_IPS: z.string().optional(),

  // --- Email (Resend) ---
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),

  // --- File storage (CLAUDE.md §7) ---
  /**
   * `gcs` is Google Cloud Storage, and production must use it. `local`
   * writes under STORAGE_LOCAL_DIR, for development and tests only.
   */
  STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  /**
   * One bucket per environment. Its location cannot change once created and
   * waits on the data-residency answer (SPEC.md §4), so it is configuration,
   * never code.
   */
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_LOCAL_DIR: z.string().default(".storage"),

  // --- Background jobs (Cloud Tasks and Cloud Scheduler, CLAUDE.md §7) ---
  /**
   * `projects/P/locations/L/queues/Q`. When set, every commit that queues an
   * outbox job also creates a Cloud Task to drain it at once.
   */
  TASKS_QUEUE: z.string().regex(/^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/, "projects/P/locations/L/queues/Q").optional(),
  /**
   * The service account Cloud Tasks and Cloud Scheduler sign their identity
   * tokens as: the only caller the internal routes accept.
   */
  TASKS_INVOKER_EMAIL: z.email().optional(),
})
  .superRefine((input, ctx) => {
    if (input.NODE_ENV === "production") {
      for (const key of PRODUCTION_REQUIRED) {
        if (!input[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Must be set when NODE_ENV is 'production'",
          });
        }
      }

      /*
       * Must be stated, never defaulted, in production. Behind Cloud Run every
       * request reaches the app from Google's front end, so with the default
       * of 0 every caller shares one address: one person's eleven sign-in
       * attempts would lock every member of staff out.
       */
      if (process.env.TRUST_PROXY_HOPS === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["TRUST_PROXY_HOPS"],
          message:
            "Must be set explicitly in production: the number of your own "
            + "proxies in front of the app (1 behind Cloud Run alone)",
        });
      }

      // The default points at a developer's machine, so an invitation sent
      // from production would carry a link nobody can open.
      if (!process.env.APP_URL || !input.APP_URL.startsWith("https://")) {
        ctx.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message: "Must be set to the staff app's HTTPS origin in production",
        });
      }

      // Encryption in transit (docs/certification/encryption.md). Cloud
      // Tasks also calls this URL, carrying an identity token.
      if (!input.BETTER_AUTH_URL.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_URL"], message: "Must be the API's HTTPS URL in production" });
      }
      if (!input.REDIS_URL.startsWith("rediss://")) {
        ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "Must use TLS (rediss://) in production" });
      }

      // Local files would vanish with the container, and would be served by
      // a route that exists for development only.
      if (input.STORAGE_DRIVER !== "gcs") {
        ctx.addIssue({ code: "custom", path: ["STORAGE_DRIVER"], message: "Must be 'gcs' in production" });
      }

      // Without these the outbox is never drained in production.
      for (const key of ["TASKS_QUEUE", "TASKS_INVOKER_EMAIL"] as const) {
        if (!input[key])
          ctx.addIssue({ code: "custom", path: [key], message: "Must be set when NODE_ENV is 'production'" });
      }
    }

    if (input.STORAGE_DRIVER === "gcs" && !input.STORAGE_BUCKET) {
      ctx.addIssue({ code: "custom", path: ["STORAGE_BUCKET"], message: "Must be set when STORAGE_DRIVER is 'gcs'" });
    }

    // A queue whose tasks carry no identity token would be refused by the
    // internal routes on every call.
    if (input.TASKS_QUEUE && !input.TASKS_INVOKER_EMAIL) {
      ctx.addIssue({ code: "custom", path: ["TASKS_INVOKER_EMAIL"], message: "Must be set when TASKS_QUEUE is" });
    }

    // Half a pair silently disables the feature, which is exactly the failure
    // worth catching locally too.
    if (Boolean(input.RESEND_API_KEY) !== Boolean(input.RESEND_FROM_EMAIL)) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_FROM_EMAIL"],
        message: "Set both RESEND_API_KEY and RESEND_FROM_EMAIL, or neither",
      });
    }

    // A stray `pnpm test` must never truncate the development database.
    for (const key of ["TEST_DATABASE_URL", "TEST_APP_DATABASE_URL", "TEST_AUTH_DATABASE_URL"] as const) {
      if (input.NODE_ENV === "test" && !input[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Must be set when NODE_ENV is 'test'",
        });
      }
    }

    /*
     * The three connections must be three different roles, and each must name
     * its role. A DSN without a username falls back to PGUSER or the OS user,
     * so two such DSNs would silently be the same role with nothing to compare.
     *
     *   app = owner   the owner bypasses RLS: tenant isolation is gone
     *   auth = owner  Better Auth could read every tenant table
     *   auth = app    tenant handlers could read session tokens again
     */
    const roles = [
      ["DATABASE_URL", parseRole(input.DATABASE_URL)],
      ["APP_DATABASE_URL", parseRole(input.APP_DATABASE_URL)],
      ["AUTH_DATABASE_URL", parseRole(input.AUTH_DATABASE_URL)],
    ] as const;

    for (const [key, role] of roles) {
      if (!role) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Must name its role explicitly (postgresql://ROLE:password@host/db)",
        });
      }
    }

    for (const [index, [key, role]] of roles.entries()) {
      const earlier = roles.slice(0, index).find(([, other]) => role && other === role);
      if (earlier) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            `Must connect as a different role from ${earlier[0]} (both are '${role}'). `
            + "Each connection's role is what separates the owner, tenant "
            + "requests and Better Auth from one another. See db/roles.sql.",
        });
      }
    }
  })
  .transform(input => ({
    ...input,
    // Downstream code reads DATABASE_URL / APP_DATABASE_URL / AUTH_DATABASE_URL
    // only; in test they resolve to the disposable test database.
    DATABASE_URL: input.NODE_ENV === "test" && input.TEST_DATABASE_URL
      ? input.TEST_DATABASE_URL
      : input.DATABASE_URL,
    APP_DATABASE_URL: input.NODE_ENV === "test" && input.TEST_APP_DATABASE_URL
      ? input.TEST_APP_DATABASE_URL
      : input.APP_DATABASE_URL,
    AUTH_DATABASE_URL: input.NODE_ENV === "test" && input.TEST_AUTH_DATABASE_URL
      ? input.TEST_AUTH_DATABASE_URL
      : input.AUTH_DATABASE_URL,
  }));

export type env = z.infer<typeof EnvSchema>;

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(z.flattenError(error).fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
