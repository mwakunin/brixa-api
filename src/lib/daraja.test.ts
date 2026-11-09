import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerC2bUrls, resetDarajaTokens } from "./daraja";

/** Daraja's token endpoint mints a token per Basic credential; the bearer each later call carries is recorded. */
function daraja() {
  const bearers: string[] = [];
  let minted = 0;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("/oauth/v1/generate")) {
      minted += 1;
      return Response.json({ access_token: `token-for-${auth.slice("Basic ".length)}`, expires_in: "3599" });
    }
    bearers.push(auth);
    return Response.json({ ResponseCode: "0" });
  });
  return { fetch, bearers, minted: () => minted };
}

function register(consumerKey: string, consumerSecret: string) {
  return registerC2bUrls({
    shortcode: "600123",
    credentials: { consumerKey, consumerSecret, passkey: "p" },
    confirmationUrl: "https://example.test/c",
    validationUrl: "https://example.test/v",
  });
}

describe("daraja access tokens", () => {
  beforeEach(() => {
    resetDarajaTokens();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are reused only by a caller holding the same key and secret", async () => {
    const stub = daraja();

    await register("shared-key", "secret-a");
    await register("shared-key", "secret-a");
    expect(stub.minted()).toBe(1);

    // Another facility's key with a guessed secret is not handed the cached token.
    await register("shared-key", "guessed");

    expect(stub.minted()).toBe(2);
    expect(stub.bearers[2]).not.toBe(stub.bearers[0]);

    // Nor a different key that happens to share the secret.
    await register("other-key", "secret-a");

    expect(stub.minted()).toBe(3);
    expect(stub.bearers[3]).not.toBe(stub.bearers[0]);
  });

  it("are dropped when Daraja refuses one, so the next call mints a fresh token", async () => {
    let minted = 0;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/oauth/v1/generate")) {
        minted += 1;
        return Response.json({ access_token: `token-${minted}`, expires_in: "3599" });
      }
      calls += 1;
      return calls === 1 ? Response.json({ errorMessage: "Invalid Access Token" }, { status: 401 }) : Response.json({ ResponseCode: "0" });
    });

    await expect(register("revoked-key", "s")).rejects.toThrow();
    await register("revoked-key", "s");

    expect(minted).toBe(2);
  });

  it("are asked for once by callers that miss the cache together", async () => {
    const stub = daraja();

    await Promise.all([register("busy-key", "s"), register("busy-key", "s"), register("busy-key", "s")]);

    expect(stub.minted()).toBe(1);
    expect(new Set(stub.bearers).size).toBe(1);
  });

  it("are asked for again after a failed request, which is never cached", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/oauth/v1/generate")) {
        attempts += 1;
        return attempts === 1 ? new Response("down", { status: 503 }) : Response.json({ access_token: "second", expires_in: "3599" });
      }
      return Response.json({ ResponseCode: "0" });
    });

    await expect(register("flaky-key", "s")).rejects.toThrow("Daraja token request failed (503)");
    await register("flaky-key", "s");

    expect(attempts).toBe(2);
  });
});
