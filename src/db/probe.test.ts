import type { AddressInfo, Socket } from "node:net";

import { createServer } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import env from "@/env";

import { checkConnections, probeConnection } from "./index";

describe("the readiness probe", () => {
  it("gives up on a server that never answers, within its deadline", async () => {
    // Accepts the connection and then says nothing, as a stalled server would.
    const sockets: Socket[] = [];
    const server = createServer(socket => sockets.push(socket));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const stalled = new Pool({ host: "127.0.0.1", port, user: "x", database: "x", connectionTimeoutMillis: 60_000 });

    try {
      const started = Date.now();
      const error = await probeConnection(stalled, 200);

      expect(error).toMatchObject({ message: "No answer within 200 ms" });
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    finally {
      sockets.forEach(s => s.destroy());
      server.close();
      await stalled.end().catch(() => {});
    }
  });

  it("says why a connection failed, without what it held", async () => {
    const url = new URL(env.DATABASE_URL);
    url.username = "no_such_role";
    const stranger = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 });

    try {
      const error = await probeConnection(stranger);

      expect(error?.message).toMatch(/no_such_role/);
      expect(error?.message).not.toContain(url.password || "-no-password-");
    }
    finally {
      await stranger.end().catch(() => {});
    }
  });

  it("reports every connection up, with no errors, when all three answer", async () => {
    expect(await checkConnections()).toEqual({ owner: true, app: true, auth: true, errors: {} });
  });
});
