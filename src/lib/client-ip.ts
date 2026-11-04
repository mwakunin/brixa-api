/**
 * Identifying the caller for rate limiting.
 *
 * Only `X-Forwarded-For` is ever consulted, and only from the right. Headers
 * without hop structure — `X-Real-IP` and friends — are ignored outright:
 * there is no way to distinguish one your proxy set from one the client sent.
 *
 * `X-Forwarded-For` is written by whoever sends the request, so trusting it
 * blindly makes anonymous rate limiting worthless: rotating the header yields
 * a fresh counter per request. It is only meaningful when you know how many
 * proxies sit in front of you, because each appends the address it received
 * the request *from* — so the trustworthy entry is counted from the RIGHT,
 * where your own edge wrote it, never the left, which the client controls.
 *
 * Default is zero trusted hops: headers ignored, socket address only.
 */

export interface ClientIpSources {
  /** The TCP peer address. Cannot be forged by the client. */
  socketAddress?: string;
  xForwardedFor?: string;
}

/**
 * Addresses permitted to have written the forwarding chain.
 *
 * `TRUST_PROXY_HOPS` alone assumes every request arrived through your proxy.
 * If the app is ALSO reachable directly, an attacker connects straight to it,
 * sends a chain of their own, and the entry we read from the right is theirs —
 * the bypass returns. Restricting the peer closes that, so the header is only
 * believed when it demonstrably came through the expected edge.
 *
 * Empty means "no peer restriction", which is only safe when the network
 * makes direct access impossible. An IPv4 proxy may be listed either as
 * `10.0.0.1` or as `::ffff:10.0.0.1`: both match.
 */
export type TrustedProxies = ReadonlySet<string>;

/**
 * One spelling per address, so two can be compared. A dual-stack listener
 * reports an IPv4 peer as `::ffff:10.0.0.1`, which is the same peer as
 * `10.0.0.1`.
 */
function canonicalAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? lower;
}

function isTrustedProxy(socket: string, trustedProxies: TrustedProxies): boolean {
  const peer = canonicalAddress(socket);
  return [...trustedProxies].some(proxy => canonicalAddress(proxy) === peer);
}

/**
 * @param sources The socket address and any forwarding headers on the request.
 * @param trustedHops How many proxies of your own sit in front of the app.
 *   0 means the app is exposed directly and headers are ignored. 1 means a
 *   single load balancer, and so on. Setting this higher than the real number
 *   lets a client push a forged value into the position we read.
 * @param trustedProxies Addresses allowed to have written that chain. Empty
 *   means any peer is believed, which is only safe if nothing can reach the
 *   app except through your proxy.
 */
export function resolveClientIp(
  sources: ClientIpSources,
  trustedHops: number,
  trustedProxies: TrustedProxies = new Set(),
): string | undefined {
  const socket = sources.socketAddress?.trim() || undefined;

  if (trustedHops <= 0)
    return socket;

  // A chain is only as trustworthy as whoever handed it to us. When an
  // allowlist is configured, a request that did not arrive through it is
  // treated as if it carried no chain at all.
  if (trustedProxies.size > 0 && (!socket || !isTrustedProxy(socket, trustedProxies)))
    return socket;

  const chain = sources.xForwardedFor
    ?.split(",")
    .map(entry => entry.trim())
    .filter(Boolean) ?? [];

  // Count from the right: with client -> lb -> app and one trusted hop, the
  // load balancer appended the client's address as the last entry.
  const candidate = chain[chain.length - trustedHops];
  if (candidate)
    return candidate;

  // Chain missing or shorter than declared — a misconfiguration, or a request
  // that skipped a proxy. Fall back to the socket, which is always real.
  //
  // X-Real-IP is deliberately NOT consulted here. It carries no hop
  // structure, so there is no way to tell one your proxy set from one the
  // client sent, and a client that can reach this branch could rotate it for
  // a fresh counter per request. A proxy that sets only X-Real-IP should be
  // configured to set X-Forwarded-For instead; until then everyone behind it
  // shares the proxy's bucket, which is degraded but not bypassable.
  return socket;
}

/**
 * The unit a rate limit counts an address by.
 *
 * An IPv4 address is itself. An IPv6 address is its /64: one subscriber is
 * normally handed a whole /64, so counting single addresses would let a
 * caller rotate through billions of them for a fresh budget each time. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is its IPv4 address.
 */
export function rateLimitBucket(ip: string): string {
  const address = canonicalAddress(ip);

  if (!address.includes(":"))
    return address;

  // Expand `::` so the first four groups can be read.
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = address.includes("::") && tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = address.includes("::")
    ? [...headGroups, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...tailGroups]
    : headGroups;

  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
