import { describe, expect, it, vi } from "vitest";

import { createStartupGate } from "./startup-gate";

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
});
