import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ObjectStorage } from "./storage";

import { assertObjectKey, ObjectExistsError, signedUrlLifetime } from "./storage";

/**
 * Storage on the local disk, for development and tests. Production refuses
 * to start with it (env.ts).
 *
 * A "signed URL" here is the API's own `/local-files/...` route with an
 * expiry and an HMAC, so the download path a client follows behaves like
 * Cloud Storage's: it works without a session, for a few minutes, for one
 * object. The route exists only while this driver is configured.
 */

/** Where the route lives; also what its handler strips to recover the key. */
export const LOCAL_FILES_PATH = "/local-files";

function signature(secret: string, key: string, expires: number): string {
  return createHmac("sha256", secret).update(`local-storage-url:${key}:${expires}`).digest("base64url");
}

/** True if `sig` is a valid, unexpired signature for `key` until `expires`. */
export function verifyLocalSignature(secret: string, key: string, expires: number, sig: string, now = Date.now()): boolean {
  if (!Number.isInteger(expires) || expires * 1000 < now)
    return false;

  const expected = Buffer.from(signature(secret, key, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function localStorage(options: { root: string; baseUrl: string; secret: string }): ObjectStorage {
  const root = path.resolve(options.root);

  /** The object's path, which `assertObjectKey` keeps inside `root`. */
  function fileFor(key: string) {
    const file = path.resolve(root, assertObjectKey(key));
    if (!file.startsWith(root + path.sep))
      throw new Error("Not an object key this system issued");
    return file;
  }

  return {
    async put(key, body, { contentType }) {
      const file = fileFor(key);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        // `wx`: fail rather than overwrite, as Cloud Storage's precondition does.
        await writeFile(file, body, { flag: "wx" });
      }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          throw new ObjectExistsError();
        throw err;
      }
      await writeFile(`${file}.content-type`, contentType);
    },

    async get(key) {
      try {
        return new Uint8Array(await readFile(fileFor(key)));
      }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
          return null;
        throw err;
      }
    },

    async createSignedUrl(key, urlOptions = {}) {
      assertObjectKey(key);
      const expires = Math.floor(Date.now() / 1000) + signedUrlLifetime(urlOptions.expiresInSeconds);
      const url = new URL(`${LOCAL_FILES_PATH}/${key}`, options.baseUrl);
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("signature", signature(options.secret, key, expires));
      return url.toString();
    },

    async delete(key) {
      const file = fileFor(key);
      await rm(file, { force: true });
      await rm(`${file}.content-type`, { force: true });
    },
  };
}

/** The content type `put` recorded, for the route that serves the file. */
export async function localContentType(root: string, key: string): Promise<string> {
  const file = path.resolve(root, assertObjectKey(key));
  try {
    return (await readFile(`${file}.content-type`, "utf8")) || "application/octet-stream";
  }
  catch {
    return "application/octet-stream";
  }
}
