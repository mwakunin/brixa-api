import { Redis } from "ioredis";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import env from "@/env";
import { createRouter, createTestApp } from "@/lib/create-app";
import { nextEmail, nextIp } from "@/test/helpers";

import { signInLock } from "./sign-in-lock";

/**
 * The lock on wrong passwords while Redis is down and once it is back
 * (sign-in-lock.ts): each instance then counts in its own memory. The lock
 * runs here in front of a stand-in for Better Auth, on a Redis connection
 * that can be cut and restored. The lock as Better Auth meets it is in
 * lib/sign-in-log.test.ts.
 */

const RIGHT = "the-right-password";

const flaky = new Redis(env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
flaky.on("error", () => {});

const router = createRouter();
router.post("/sign-in", signInLock(flaky), async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  return password === RIGHT ? c.json({ ok: true }) : c.json({ message: "Invalid email or password" }, 401);
});
const app = createTestApp(router);

function signIn(email: string, password: string, address: string) {
  return app.request("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ email, password }),
  });
}

async function wrongPasswords(times: number, email: string, address: string) {
  for (let i = 0; i < times; i += 1)
    expect((await signIn(email, "not-the-password", address)).status).toBe(401);
}

async function redisDown() {
  if (flaky.status === "end")
    return;
  const ended = once(flaky, "end");
  flaky.disconnect();
  await ended;
}

async function redisBack() {
  await flaky.connect();
}

describe("the lock on wrong passwords, while Redis is down", () => {
  beforeAll(redisBack);
  afterAll(redisDown);

  it("keeps a lock set while Redis was down until it ends, once Redis is back", async () => {
    const email = nextEmail();
    const address = nextIp();
    await redisDown();
    await wrongPasswords(5, email, address);
    expect((await signIn(email, RIGHT, address)).status).toBe(429);

    await redisBack();

    expect((await signIn(email, RIGHT, address)).status).toBe(429);
  });

  it("forgets wrong passwords counted while Redis was down once the right one is given", async () => {
    const email = nextEmail();
    const address = nextIp();
    await redisDown();
    await wrongPasswords(4, email, address);
    await redisBack();
    expect((await signIn(email, RIGHT, address)).status).toBe(200);

    await redisDown();
    await wrongPasswords(1, email, address);

    expect((await signIn(email, RIGHT, address)).status).toBe(200);
  });
});
