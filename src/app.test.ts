import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import { appOrigin } from "@/lib/auth";
import { ONE_LINE } from "@/lib/validation";
import { resetDb, signedInUser } from "@/test/helpers";

/**
 * Every tenant router registers `withFacility` at `/*` on the parent app, so
 * the routes outside any facility stay outside it only because they are
 * mounted first and answer without calling `next()` (src/app.ts). One mounted
 * after the tenant routers would silently start demanding an X-Facility-Id.
 * These requests carry no facility header and must never see that 400.
 */
describe("routes outside any facility", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each(["/", "/health", "/doc"])("serves %s with no session and no facility", async (path) => {
    const res = await app.request(path);

    expect(res.status).toBe(200);
  });

  it("serves the facility picker to a signed-in user with no facility chosen", async () => {
    const person = await signedInUser();

    const res = await app.request("/me/facilities", { headers: person.headers });

    expect(res.status).toBe(200);
  });

  it("serves the internal routes to nobody without a token, rather than asking for a facility", async () => {
    const res = await app.request("/internal/outbox/drain", { method: "POST" });

    expect(res.status).toBe(401);
  });
});

describe("every response", () => {
  function expectHardened(res: Response) {
    // Encryption in transit (docs/certification/encryption.md).
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The staff app's site may read what this API returns; other sites may not.
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
  }

  it("tells browsers to use HTTPS only, and hardens the rest", async () => {
    expectHardened(await app.request("/health"));
  });

  // A preflight is answered by the CORS middleware without going further.
  it("includes a CORS preflight", async () => {
    const res = await app.request("/staff/invitations", {
      method: "OPTIONS",
      headers: { "origin": appOrigin, "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expectHardened(res);
  });
});

describe("the API description", () => {
  interface Operation {
    parameters?: { in: string; name: string }[];
    requestBody?: unknown;
    responses: Record<string, unknown>;
  }

  // Stoker's defaultHook answers any input that fails its schema with a 422,
  // so a route that takes input and does not say so misleads its clients.
  it("declares the 422 of every route that validates a path, query or body", async () => {
    const doc = await (await app.request("/doc")).json() as { paths: Record<string, Record<string, Operation>> };

    const undeclared = Object.entries(doc.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, op]) => (op.requestBody || op.parameters?.some(p => p.in === "path" || p.in === "query")) && !op.responses["422"])
        .map(([method]) => `${method.toUpperCase()} ${path}`));

    expect(undeclared).toEqual([]);
  });

  // A tenant write sent with an Idempotency-Key it already used for another
  // request is refused with a 409 (`idempotency_key_reused`), whatever the
  // route; a route that does not say so misleads its clients.
  it("lets a patient write's 409 be a reused key's, beside a likely duplicate", async () => {
    const doc = await (await app.request("/doc")).json() as { paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: unknown } } }> }>> };

    for (const [path, method] of [["/patients", "post"], ["/patients/{id}/identifiers", "post"]] as const) {
      const schema = JSON.stringify(doc.paths[path][method].responses["409"].content["application/json"].schema);
      expect(schema, `${method.toUpperCase()} ${path}`).toContain("idempotency_key_reused");
      expect(schema, `${method.toUpperCase()} ${path}`).toContain("possible_duplicate");
    }
  });

  it("declares, on every tenant write, a 409 whose shape takes a reused Idempotency-Key's answer", async () => {
    type Schema = Record<string, unknown>;
    const doc = await (await app.request("/doc")).json() as {
      paths: Record<string, Record<string, Operation & { responses: Record<string, { content?: { "application/json"?: { schema: Schema } } }> }>>;
      components?: { schemas?: Record<string, Schema> };
    };
    const writes = new Set(["post", "put", "patch", "delete"]);
    const answer = { message: "This Idempotency-Key was sent with another request.", code: "idempotency_key_reused" };

    // Whether a value fits a schema, for the JSON Schema this description uses.
    const fits = (schema: Schema | undefined, value: unknown): boolean => {
      if (!schema)
        return false;
      if (typeof schema.$ref === "string")
        return fits(doc.components?.schemas?.[schema.$ref.split("/").pop()!], value);
      if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
        return ((schema.anyOf ?? schema.oneOf) as Schema[]).some(s => fits(s, value));
      if ("const" in schema)
        return schema.const === value;
      if (Array.isArray(schema.enum))
        return schema.enum.includes(value);
      if (schema.type === "string")
        return typeof value === "string";
      if (schema.type === "object" && value && typeof value === "object") {
        const properties = (schema.properties ?? {}) as Record<string, Schema>;
        return ((schema.required ?? []) as string[]).every(k => k in value)
          && Object.entries(value).every(([k, v]) => !(k in properties) || fits(properties[k], v));
      }
      return false;
    };

    const unfit = Object.entries(doc.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([method, op]) => writes.has(method) && op.parameters?.some(p => p.in === "header" && p.name === "x-facility-id"))
        .filter(([, op]) => !fits(op.responses["409"]?.content?.["application/json"]?.schema, answer))
        .map(([method]) => `${method.toUpperCase()} ${path}`));

    expect(unfit).toEqual([]);
  });

  // JSON Schema's `pattern` is the regular expression alone. zod-to-openapi 9.1.0 writes a flagged
  // one's source with "/u" or "/i" left on its end, which no text can match.
  it("writes every pattern as JSON Schema reads it, with no regex flags left on its end", async () => {
    const doc = await (await app.request("/doc")).json();
    const patterns: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node))
        return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "pattern" && typeof value === "string")
            patterns.push(value);
          else
            walk(value);
        }
      }
    };
    walk(doc);

    expect(patterns.length).toBeGreaterThan(50);
    expect(patterns.filter(p => /\/[a-z]+$/.test(p))).toEqual([]);
    expect(patterns).toContain(ONE_LINE.source);
  });

  it("says a tenant route's 404 can be what the path names, not only the facility", async () => {
    const doc = await (await app.request("/doc")).json() as { paths: Record<string, Record<string, Operation & { responses: Record<string, { description: string }> }>> };

    expect(doc.paths["/patients/{id}/contacts/{contactId}"].patch.responses["404"].description).toMatch(/what the path names/);
  });
});
