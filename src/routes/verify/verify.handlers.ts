import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import { verifyDocument as verify } from "@/lib/verify-document";

import type { VerifyDocumentRoute } from "./verify.routes";

export const verifyDocument: AppRouteHandler<VerifyDocumentRoute> = async (c) => {
  const { code } = c.req.valid("param");
  // The answer changes when a document is voided; nobody may serve a stale "valid".
  c.header("cache-control", "no-store");

  const document = await verify(code);
  if (!document) {
    return c.json(
      { verified: false as const, message: "No document with this code was issued here." },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json({
    verified: true as const,
    ...document,
    issuedAt: document.issuedAt.toISOString(),
    withdrawnAt: document.withdrawnAt?.toISOString() ?? null,
  }, HttpStatusCodes.OK);
};
