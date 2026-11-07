import { describe, expect, it } from "vitest";

import { EnvSchema } from "./env";

/**
 * A complete production environment, as CI's smoke test runs it, with the
 * given connections. Complete, because the cross-field checks run only once
 * every field is valid: a partial one would pass them by never running them.
 */
function production(app: string, auth: string) {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://hospital:owner-secret@db.example.test/hms",
    APP_DATABASE_URL: app,
    AUTH_DATABASE_URL: auth,
    REDIS_URL: "rediss://cache.example.test:6379",
    APP_URL: "https://app.example.test",
    TRUST_PROXY_HOPS: "1",
    BETTER_AUTH_SECRET: "a-production-secret-that-is-long-enough-32",
    BETTER_AUTH_URL: "https://api.example.test",
    RESEND_API_KEY: "re_x",
    RESEND_FROM_EMAIL: "noreply@example.test",
    STORAGE_DRIVER: "gcs",
    STORAGE_BUCKET: "hms-bucket",
    TASKS_QUEUE: "projects/hms/locations/africa-south1/queues/outbox",
    TASKS_INVOKER_EMAIL: "tasks-invoker@hms.iam.gserviceaccount.com",
    MPESA_ENV: "sandbox",
    CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
}

function issuesAt(input: Record<string, unknown>, key: string) {
  const result = EnvSchema.safeParse(input);
  return result.success ? [] : result.error.issues.filter(i => i.path[0] === key).map(i => i.message);
}

const DEFAULT = "Must not use the development default password from db/roles.sql in production";

describe("production database URLs", () => {
  it("refuse the default passwords db/roles.sql creates", () => {
    const input = production(
      "postgresql://hospital_app:hospital_app@db.example.test/hms",
      "postgresql://hospital_auth:hospital_auth@db.example.test/hms",
    );

    expect(issuesAt(input, "APP_DATABASE_URL")).toContain(DEFAULT);
    expect(issuesAt(input, "AUTH_DATABASE_URL")).toContain(DEFAULT);
  });

  it("accept passwords set out of band", () => {
    const input = production(
      "postgresql://hospital_app:from-secret-manager-1@db.example.test/hms",
      "postgresql://hospital_auth:from-secret-manager-2@db.example.test/hms",
    );

    expect(issuesAt(input, "APP_DATABASE_URL")).not.toContain(DEFAULT);
    expect(issuesAt(input, "AUTH_DATABASE_URL")).not.toContain(DEFAULT);
  });
});
