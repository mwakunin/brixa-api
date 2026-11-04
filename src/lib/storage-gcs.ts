import type { Storage } from "@google-cloud/storage";

import { Buffer } from "node:buffer";

import type { ObjectStorage } from "./storage";

import { assertObjectKey, ObjectExistsError, signedUrlLifetime } from "./storage";

/**
 * Google Cloud Storage (SPEC.md §7.6).
 *
 * The bucket is configured, never chosen here (rule 11), and is set up with
 * public access prevention, uniform access, versioning and soft delete
 * (docs/deployment.md). Signed URLs are V4 and signed through the service
 * account's IAM `signBlob` permission: on Cloud Run the client has no key
 * file to sign with, and asks IAM instead, so no private key ever exists.
 */

/** The HTTP status a Cloud Storage error carries, if any. */
function statusOf(err: unknown): number | undefined {
  return (err as { code?: unknown }).code as number | undefined;
}

export function gcsStorage(client: Pick<Storage, "bucket">, bucketName: string): ObjectStorage {
  const bucket = client.bucket(bucketName);

  return {
    async put(key, body, { contentType }) {
      try {
        await bucket.file(assertObjectKey(key)).save(Buffer.from(body), {
          contentType,
          resumable: false,
          // Only if nothing is there yet: an object is never overwritten.
          preconditionOpts: { ifGenerationMatch: 0 },
          // Patient files: no cache between Google and the reader keeps one.
          metadata: { cacheControl: "private, no-store" },
        });
      }
      catch (err) {
        if (statusOf(err) === 412)
          throw new ObjectExistsError();
        throw err;
      }
    },

    async get(key) {
      try {
        const [contents] = await bucket.file(assertObjectKey(key)).download();
        return new Uint8Array(contents);
      }
      catch (err) {
        if (statusOf(err) === 404)
          return null;
        throw err;
      }
    },

    async createSignedUrl(key, options = {}) {
      const [url] = await bucket.file(assertObjectKey(key)).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + signedUrlLifetime(options.expiresInSeconds) * 1000,
      });
      return url;
    },

    async delete(key) {
      await bucket.file(assertObjectKey(key)).delete({ ignoreNotFound: true });
    },
  };
}
