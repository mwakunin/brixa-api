import { randomUUID } from "node:crypto";

/**
 * File storage, behind one small interface (CLAUDE.md §7, SPEC.md §7.6), so
 * the provider changes in one file.
 *
 * What the rest of the code may rely on:
 *
 *   - Keys are tenant-prefixed and random (`newObjectKey`). They name IDs
 *     only, never a patient's name or anything else about them (rule 10).
 *   - The database stores the key, never a URL (rule 11). Access is a
 *     permission check, then an audit entry, then `createSignedUrl`, and the
 *     signed URL is never persisted.
 *   - `put` never overwrites: an object, once written, is what was uploaded.
 *     A corrected file is a new object under a new key.
 *
 * Validating type and size, stripping EXIF and scanning external documents
 * belong to the upload that calls `put`, and arrive with the first one.
 */
export interface ObjectStorage {
  /** Stores a new object. Throws `ObjectExistsError` if the key is taken. */
  put: (key: string, body: Uint8Array, options: { contentType: string }) => Promise<void>;
  /** The object's bytes, or null if there is none. */
  get: (key: string) => Promise<Uint8Array | null>;
  /** A short-lived URL that downloads the object. Never store it. */
  createSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
  /** Removes the object; removing one that is not there is not an error. */
  delete: (key: string) => Promise<void>;
}

export class ObjectExistsError extends Error {
  constructor() {
    super("An object already exists under that key");
    this.name = "ObjectExistsError";
  }
}

/** How long a signed URL works: enough to start a download, not to share one. */
export const SIGNED_URL_DEFAULT_SECONDS = 300;
export const SIGNED_URL_MAX_SECONDS = 900;

export function signedUrlLifetime(requested?: number): number {
  const seconds = requested ?? SIGNED_URL_DEFAULT_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > SIGNED_URL_MAX_SECONDS)
    throw new RangeError(`A signed URL lasts between 1 and ${SIGNED_URL_MAX_SECONDS} seconds`);
  return seconds;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SEGMENT = /^[a-z0-9_-]{1,64}$/;
const KEY = new RegExp(`^tenants/${UUID}(?:/[a-z0-9_-]{1,64})*/${UUID}$`);

/**
 * A fresh key under a facility: `tenants/{facilityId}/{...segments}/{uuid}`,
 * e.g. `newObjectKey(facilityId, "patients", patientId)`.
 *
 * Segments are lowercase identifiers: a category, or an id. The shape is
 * enforced so a name cannot slip in by accident through a careless caller,
 * and so no key can climb out of its prefix (`..`, `/`, `\`).
 */
export function newObjectKey(facilityId: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!SEGMENT.test(segment))
      throw new Error(`Not a key segment: use lowercase ids and categories only`);
  }
  return assertObjectKey(["tenants", facilityId, ...segments, randomUUID()].join("/"));
}

/** Refuses anything `newObjectKey` could not have made. */
export function assertObjectKey(key: string): string {
  if (!KEY.test(key))
    throw new Error("Not an object key this system issued");
  return key;
}
