import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import env from "@/env";
import { createRouter } from "@/lib/create-app";
import { storage } from "@/lib/object-storage";
import { LOCAL_FILES_PATH, localContentType, verifyLocalSignature } from "@/lib/storage-local";

/**
 * Serves the local storage driver's signed URLs, so a download in development
 * follows the same path it will on Cloud Storage: a link that works for a few
 * minutes, for one object, with no session. Registered only while
 * STORAGE_DRIVER is `local`, which production refuses (env.ts), and left out
 * of the OpenAPI document.
 */
const router = createRouter();

router.get(`${LOCAL_FILES_PATH}/*`, async (c) => {
  const key = c.req.path.slice(LOCAL_FILES_PATH.length + 1);
  const expires = Number(c.req.query("expires"));
  const signature = c.req.query("signature") ?? "";

  // One answer for a bad link, an expired one and a missing object, so the
  // route says nothing about which keys exist.
  const refused = () => c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

  if (!verifyLocalSignature(env.BETTER_AUTH_SECRET, key, expires, signature))
    return refused();

  const body = await storage.get(key).catch(() => null);
  if (!body)
    return refused();

  return c.body(new Uint8Array(body), HttpStatusCodes.OK, {
    "content-type": await localContentType(env.STORAGE_LOCAL_DIR, key),
    "cache-control": "private, no-store",
  });
});

export default router;
