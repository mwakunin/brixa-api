import { Scalar } from "@scalar/hono-api-reference";

import type { AppOpenAPI } from "./types";

import packageJSON from "../../package.json" with { type: "json" };

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
    const flags = /\$\/([a-z]+)$/.exec(value)?.[1];
    if (flags === undefined)
      plain[key] = value;
    else if (flags === "u")
      plain[key] = value.slice(0, -2);
  }
  return plain as T;
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
  app.get("/doc", c => c.json(withPlainPatterns(app.getOpenAPIDocument(DOCUMENT))));

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
