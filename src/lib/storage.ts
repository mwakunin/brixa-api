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

/**
 * What a stored file belongs to: the folder under a facility. Added as the
 * modules that store files land, like a number series kind.
 */
export const OBJECT_CATEGORIES = ["patients"] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isCategory(value: string | undefined): value is ObjectCategory {
  return OBJECT_CATEGORIES.includes(value as ObjectCategory);
}

/**
 * A fresh key under a facility: `tenants/{facilityId}/{category}/{...ids}/{uuid}`,
 * e.g. `newObjectKey(facilityId, "patients", patientId)`.
 *
 * Every id must be a UUID and the category must be one of a fixed list, so
 * nothing a person typed (a name, a phone number) can become part of a key
 * (rule 10), and no key can climb out of its prefix.
 */
export function newObjectKey(facilityId: string, category: ObjectCategory, ...ids: string[]): string {
  if (!isCategory(category))
    throw new Error("Not an object category");
  if (![facilityId, ...ids].every(id => IS_UUID.test(id)))
    throw new Error("Object keys hold ids only, and every id is a UUID");
  return assertObjectKey(["tenants", facilityId, category, ...ids, randomUUID()].join("/"));
}

/**
 * Refuses anything `newObjectKey` could not have made: `tenants`, a facility
 * id, a known category, then one or more ids, every id a UUID.
 */
export function assertObjectKey(key: string): string {
  const [root, facilityId, category, ...ids] = key.split("/");
  const issued = root === "tenants"
    && IS_UUID.test(facilityId ?? "")
    && isCategory(category)
    && ids.length > 0
    && ids.every(id => IS_UUID.test(id));

  if (!issued)
    throw new Error("Not an object key this system issued");
  return key;
}
