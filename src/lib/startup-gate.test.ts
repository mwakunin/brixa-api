import { describe, expect, it, vi } from "vitest";

import { appOrigin } from "./auth";
import { startingUpResponse } from "./starting-up";
import { createStartupGate, STARTING_UP_MESSAGE } from "./startup-gate";

class Fatal extends Error {}

const inner = async () => new Response("served");
const request = (path: string) => new Request(`http://localhost${path}`);

describe("the startup gate", () => {
  it("serves at once when the first check passes", async () => {
    const gate = createStartupGate({ verify: async () => {}, isFatal: () => false, onFatal: () => {} });
    await gate.start();

    const res = await gate.wrap(inner)(request("/facility"));

    expect(await res.text()).toBe("served");
  });

  it("refuses traffic but answers /health until a retried check passes", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const gate = createStartupGate({
        verify: async () => {
          calls += 1;
          if (calls < 3)
            throw new Error("connect ECONNREFUSED");
        },
        isFatal: () => false,
        onFatal: () => {},
        retryMs: 1000,
      });
      const fetch = gate.wrap(inner);

      await gate.start();
      expect((await fetch(request("/facility"))).status).toBe(503);
      expect(await (await fetch(request("/health"))).text()).toBe("served");

      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.isReady()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);

      expect(calls).toBe(3);
      expect(gate.isReady()).toBe(true);
      expect(await (await fetch(request("/facility"))).text()).toBe("served");
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying and reports a failure retrying cannot fix", async () => {
    const onFatal = vi.fn();
    const gate = createStartupGate({
      verify: async () => {
        throw new Fatal("privileged role");
      },
      isFatal: err => err instanceof Fatal,
      onFatal,
    });

    await gate.start();

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(gate.isReady()).toBe(false);
    expect((await gate.wrap(inner)(request("/"))).status).toBe(503);
  });

  // The server's refusal (src/index.ts): the gate answers before the app does.
  it("refuses with the app's hardened headers, as every response carries them", async () => {
    const gate = createStartupGate({
      verify: async () => {
        throw new Fatal("never verified");
      },
      isFatal: () => true,
      onFatal: () => {},
      refuse: startingUpResponse,
    });
    await gate.start();

    const res = await gate.wrap(inner)(request("/facility"));

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ message: STARTING_UP_MESSAGE });
  });

  it("lets the staff app read the refusal, so it can say the server is starting", async () => {
    const res = await startingUpResponse(new Request("http://localhost/facility", { headers: { origin: appOrigin } }));

    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
