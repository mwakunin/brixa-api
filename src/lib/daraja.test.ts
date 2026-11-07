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
  });
});
