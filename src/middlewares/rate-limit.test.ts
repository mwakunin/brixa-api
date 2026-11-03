import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import realApp from "@/app";
import { createRouter, createTestApp } from "@/lib/create-app";
import { redis } from "@/lib/redis";
import { nextIp, resetDb } from "@/test/helpers";

import { rateLimit } from "./rate-limit";

/**
 * Three requests a minute, so the boundary is quick to reach. Every test uses
 * fresh addresses: the in-memory first layer remembers a blocked key for the
 * whole window, which resetDb (Redis only) does not clear.
 */
const router = createRouter();
router.get("/limited", rateLimit({ points: 3, duration: 60, keyPrefix: "test" }), c => c.json({ ok: true }));

/** Points at a Redis that is not there, to exercise the memory fallback. */
const deadRedis = new Redis("redis://127.0.0.1:1", {
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  retryStrategy: () => null,
  lazyConnect: true,
});
deadRedis.on("error", () => {});
router.get(
  "/limited-offline",
  rateLimit({ points: 3, duration: 60, keyPrefix: "offline", client: deadRedis }),
  c => c.json({ ok: true }),
);

const app = createTestApp(router);

function from(ip: string) {
  return { headers: { "x-forwarded-for": ip } };
}

describe("rate limiting", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(() => {
    deadRedis.disconnect();
  });

  it("allows requests up to the limit, then refuses with 429 and a retry hint", async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i += 1)
      expect((await app.request("/limited", from(ip))).status).toBe(200);

    const res = await app.request("/limited", from(ip));
    expect(res.status).toBe(429);

    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await res.json()).retryAfterSeconds).toBe(retryAfter);
  });

  it("counts per caller, not globally", async () => {
    const one = nextIp();
    const two = nextIp();
    for (let i = 0; i < 4; i += 1)
      await app.request("/limited", from(one));

    expect((await app.request("/limited", from(one))).status).toBe(429);
    expect((await app.request("/limited", from(two))).status).toBe(200);
  });

  it("cannot be bypassed by prepending to the forwarded chain", async () => {
    // One trusted hop (.env.test): the last entry is what our edge wrote, and
    // whatever the client puts before it is ignored.
    const edgeSaw = nextIp();
    for (let i = 0; i < 3; i += 1)
      await app.request("/limited", from(`${nextIp()}, ${edgeSaw}`));

    expect((await app.request("/limited", from(`${nextIp()}, ${edgeSaw}`))).status).toBe(429);
  });

  it("stores no address in Redis, only a hash", async () => {
    const ip = nextIp();
    await app.request("/limited", from(ip));

    const keys = await redis.keys("rl:test*");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys)
      expect(key).not.toContain(ip);
  });

  it("keeps limiting in memory when Redis is unreachable", async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i += 1)
      expect((await app.request("/limited-offline", from(ip))).status).toBe(200);

    expect((await app.request("/limited-offline", from(ip))).status).toBe(429);
  });

  it("limits sign-in attempts on one account even when they come from many addresses", async () => {
    const email = `target-${nextIp()}@example.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await realApp.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
        body: JSON.stringify({ email, password: "wrong-password-1" }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("limits sign-in attempts", async () => {
    const ip = nextIp();
    const attempt = () => realApp.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-1" }),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push((await attempt()).status);

    expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
