/* eslint-disable node/no-process-env */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Redis } from "ioredis";
import { Pool } from "pg";

/**
 * Runs once before the whole suite: brings the disposable test database
 * (:5439, tmpfs) up to the current migration head. The migrator records what
 * it has applied, so this is idempotent while the container lives.
 *
 * The migrator is called directly rather than through the drizzle-kit binary,
 * so the same setup runs under Windows' cmd.exe and Linux CI alike.
 */
export default async function setup() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test global-setup ran outside NODE_ENV=test");

  const { default: env } = await import("../env");
  const { CONNECTION_TIMEOUT_MS, sslConfigFor } = await import("../db/connection");

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfigFor(env.DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });

  try {
    await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" });
  }
  finally {
    await pool.end();
  }

  // Checked once here, so a missing Redis stops the suite at the start instead of failing every test in turn.
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on("error", () => {});
  // One deadline over both steps: a server that accepts the connection and then says nothing must not hang the run.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no answer within 10 seconds")), 10_000);
  });
  try {
    await Promise.race([redis.connect().then(() => redis.ping()), deadline]);
  }
  catch (err) {
    throw new Error("Redis for the tests is not reachable; start it with `docker compose up -d redis`", { cause: err });
  }
  finally {
    clearTimeout(timer);
    redis.disconnect();
  }
}
