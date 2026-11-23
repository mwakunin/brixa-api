import { Scalar } from "@scalar/hono-api-reference";

import type { AppOpenAPI } from "./types";

import packageJSON from "../../package.json" with { type: "json" };

/**
 * The flags zod-to-openapi left on a pattern, if any. It writes a flagged
 * regex as `source/flags`. A source writes every slash it matches as `\/`
 * outside a character class, and a class ends with `]`, so a slash with an
 * even run of backslashes before it, followed only by flags, is the one it
 * left: anchored or not.
 */
function flagsOf(pattern: string): { source: string; flags: string } | null {
  const found = /\/([dgimsuvy]+)$/.exec(pattern);
  if (!found)
    return null;
  let backslashes = 0;
  for (let i = found.index - 1; i >= 0 && pattern[i] === "\\"; i--)
    backslashes += 1;
  return backslashes % 2 === 0 ? { source: pattern.slice(0, found.index), flags: found[1] } : null;
}

/**
 * A JSON Schema `pattern` is the regular expression alone, read with Unicode
 * semantics. zod-to-openapi 9.1.0 writes a flagged regex's source with its
 * flags left on (`…$/u`), which no text matches. `/u` is dropped, being how a
 * pattern is read anyway. A pattern with another flag, such as `/i`, cannot be
 * written in JSON Schema, so it is left out rather than stated stricter than
 * the API checks; its length limits stay.
 */
export function withPlainPatterns<T>(node: T): T {
  if (Array.isArray(node))
    return node.map(withPlainPatterns) as T;
  if (!node || typeof node !== "object")
    return node;
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== "pattern" || typeof value !== "string") {
      plain[key] = withPlainPatterns(value);
      continue;
    }
    const flagged = flagsOf(value);
    if (!flagged)
      plain[key] = value;
    else if (flagged.flags === "u")
      plain[key] = flagged.source;
  }
  return plain as T;
}

/** What this reads of an OpenAPI document: each operation's parameters and responses. */
type Paths = Record<string, Record<string, { parameters?: { in?: string; name?: string }[]; responses?: Record<string, { description?: string }> }>>;

const WRITES = new Set(["post", "put", "patch", "delete"]);
const KEY_REUSED = "idempotency_key_reused";

/**
 * Every tenant write may be refused with a 409 before its route runs: an
 * Idempotency-Key already sent with another request (`middlewares/tenant.ts`).
 * Each route's 409 schema takes that answer (app.test.ts checks), but its
 * description is the route's own conflict, said in some fifty ways: the key's
 * case is named here, once for them all.
 */
export function withKeyReuseNamed<T extends { paths?: object }>(doc: T): T {
  const paths = Object.fromEntries(Object.entries((doc.paths ?? {}) as Paths).map(([path, operations]) => [
    path,
    Object.fromEntries(Object.entries(operations).map(([method, operation]) => {
      const conflict = operation.responses?.["409"];
      const tenantWrite = WRITES.has(method) && operation.parameters?.some(p => p.in === "header" && p.name === "x-facility-id");
      if (!tenantWrite || !conflict || conflict.description?.includes(KEY_REUSED))
        return [method, operation];
      const description = `${conflict.description}; or an Idempotency-Key already sent with another request (\`${KEY_REUSED}\`)`;
      return [method, { ...operation, responses: { ...operation.responses, 409: { ...conflict, description } } }];
    })),
  ]));
  return { ...doc, paths };
}

const DOCUMENT = {
  openapi: "3.0.0",
  info: {
    version: packageJSON.version,
    title: "Brixa HMIS API",
    description:
      "Multi-tenant hospital management for Kenyan Level 4 hospitals. Each "
      + "facility is a tenant; a tenant request names its facility in the "
      + "X-Facility-Id header, and the caller must hold an active membership "
      + "there.",
  },
};

export default function configureOpenAPI(app: AppOpenAPI): void {
  app.get("/doc", c => c.json(withKeyReuseNamed(withPlainPatterns(app.getOpenAPIDocument(DOCUMENT)))));

  app.get(
    "/reference",
    Scalar({
      url: "/doc",
      theme: "kepler",
      layout: "classic",
      defaultHttpClient: {
        targetKey: "js",
        clientKey: "fetch",
      },
    }),
  );
}
