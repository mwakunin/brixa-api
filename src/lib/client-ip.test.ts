import { describe, expect, it } from "vitest";

import { rateLimitBucket, resolveClientIp } from "./client-ip";

/**
 * The attack these guard against: `X-Forwarded-For` is written by the client,
 * so if the leftmost entry is used, rotating the header gives a fresh rate
 * limit counter on every request.
 */
describe("resolveClientIp", () => {
  describe("with no trusted proxies (the default)", () => {
    it("uses the socket address and ignores the forwarded chain", () => {
      expect(resolveClientIp({
        socketAddress: "203.0.113.9",
        xForwardedFor: "1.2.3.4",
      }, 0)).toBe("203.0.113.9");
    });

    it("cannot be moved by a forged header", () => {
      const forged = Array.from({ length: 5 }, (_, i) => `9.9.9.${i}`);
      const seen = new Set(forged.map(ip =>
        resolveClientIp({ socketAddress: "203.0.113.9", xForwardedFor: ip }, 0)));

      // Five different forged headers, still one identity — so still one budget.
      expect(seen).toEqual(new Set(["203.0.113.9"]));
    });

    it("returns undefined when there is no socket either", () => {
      expect(resolveClientIp({ xForwardedFor: "1.2.3.4" }, 0)).toBeUndefined();
    });
  });

  describe("behind one trusted proxy", () => {
    it("takes the address the proxy appended", () => {
      // client -> lb -> app: the lb appends the client's address.
      expect(resolveClientIp({
        socketAddress: "10.0.0.1",
        xForwardedFor: "203.0.113.9",
      }, 1)).toBe("203.0.113.9");
    });

    it("ignores entries the client prepended", () => {
      // The client sent "1.2.3.4"; the proxy appended the real address after
      // it. Reading from the right is what makes the forgery inert.
      expect(resolveClientIp({
        socketAddress: "10.0.0.1",
        xForwardedFor: "1.2.3.4, 203.0.113.9",
      }, 1)).toBe("203.0.113.9");
    });

    it("still yields one identity however much the client prepends", () => {
      const seen = new Set([
        "a.a.a.a, 203.0.113.9",
        "b.b.b.b, c.c.c.c, 203.0.113.9",
        "203.0.113.9",
      ].map(xff => resolveClientIp({ socketAddress: "10.0.0.1", xForwardedFor: xff }, 1)));

      expect(seen).toEqual(new Set(["203.0.113.9"]));
    });
  });

  describe("behind two trusted proxies", () => {
    it("counts from the right, past the inner proxy", () => {
      // client -> lb1 -> lb2 -> app
      expect(resolveClientIp({
        socketAddress: "10.0.0.2",
        xForwardedFor: "203.0.113.9, 10.0.0.1",
      }, 2)).toBe("203.0.113.9");
    });

    it("ignores a client-prepended entry at the same depth", () => {
      expect(resolveClientIp({
        socketAddress: "10.0.0.2",
        xForwardedFor: "evil, 203.0.113.9, 10.0.0.1",
      }, 2)).toBe("203.0.113.9");
    });
  });

  describe("with a trusted proxy allowlist", () => {
    const allow = new Set(["10.0.0.1"]);

    it("believes the chain when it came through an allowed proxy", () => {
      expect(resolveClientIp({
        socketAddress: "10.0.0.1",
        xForwardedFor: "203.0.113.9",
      }, 1, allow)).toBe("203.0.113.9");
    });

    // The attack the allowlist exists for: reaching the app directly and
    // supplying a chain of your own.
    it("ignores the chain from a peer that is not the proxy", () => {
      expect(resolveClientIp({
        socketAddress: "198.51.100.66",
        xForwardedFor: "spoofed",
      }, 1, allow)).toBe("198.51.100.66");
    });

    it("gives a direct attacker one identity however they rotate the chain", () => {
      const seen = new Set(["a", "b, c", "d, e, f"].map(xff =>
        resolveClientIp({ socketAddress: "198.51.100.66", xForwardedFor: xff }, 1, allow)));

      expect(seen).toEqual(new Set(["198.51.100.66"]));
    });

    it("ignores the chain when there is no socket address to check", () => {
      expect(resolveClientIp({ xForwardedFor: "spoofed" }, 1, allow)).toBeUndefined();
    });

    it("believes any peer when the allowlist is empty", () => {
      // The documented default: safe only when nothing can reach the app
      // except through the proxy.
      expect(resolveClientIp({
        socketAddress: "198.51.100.66",
        xForwardedFor: "203.0.113.9",
      }, 1, new Set())).toBe("203.0.113.9");
    });
  });

  describe("fallbacks", () => {
    it("falls back to the socket when the chain is shorter than the hop count", () => {
      // Misconfiguration, or a request that skipped a proxy. The socket
      // address is always real, so it is the safe answer.
      expect(resolveClientIp({
        socketAddress: "10.0.0.1",
        xForwardedFor: "203.0.113.9",
      }, 3)).toBe("10.0.0.1");
    });

    it("tolerates whitespace and empty entries", () => {
      expect(resolveClientIp({
        socketAddress: "10.0.0.1",
        xForwardedFor: "  ,  203.0.113.9  ,  ",
      }, 1)).toBe("203.0.113.9");
    });
  });
});

/**
 * One IPv6 subscriber normally holds a whole /64, so counting single
 * addresses would hand out a fresh budget per address.
 */
describe("rateLimitBucket", () => {
  it.each([
    ["10.1.2.3", "10.1.2.3"],
    ["::ffff:10.1.2.3", "10.1.2.3"],
    ["2001:db8:85a3:1234:5678:8a2e:370:7334", "2001:db8:85a3:1234::/64"],
    ["2001:DB8:0000:0001::ffff", "2001:db8:0:1::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
  ])("counts %s as %s", (ip, bucket) => {
    expect(rateLimitBucket(ip)).toBe(bucket);
  });

  it("puts two addresses in one /64 in the same bucket", () => {
    expect(rateLimitBucket("2001:db8:1:2::a")).toBe(rateLimitBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(rateLimitBucket("2001:db8:1:2::a")).not.toBe(rateLimitBucket("2001:db8:1:3::a"));
  });
});
