import type { Storage } from "@google-cloud/storage";

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { newObjectKey, ObjectExistsError } from "./storage";
import { gcsStorage } from "./storage-gcs";

/**
 * Cloud Storage cannot be reached from a test, so these check that each call
 * asks for what it must: no overwrite, a short V4 read URL, and errors mapped
 * to what the interface promises.
 */
function fakeFile(overrides: Record<string, unknown> = {}) {
  return {
    save: vi.fn(async () => {}),
    download: vi.fn(async () => [Buffer.from("bytes")]),
    getSignedUrl: vi.fn(async () => ["https://storage.googleapis.com/signed"]),
    delete: vi.fn(async () => [{}]),
    ...overrides,
  };
}

/** A call failing as Google's client does: an Error carrying the HTTP status as `code`. */
function failing(message: string, code: number) {
  return vi.fn(async () => {
    throw Object.assign(new Error(message), { code });
  });
}

function storageWith(file: ReturnType<typeof fakeFile>) {
  const bucket = { file: vi.fn(() => file) };
  const client = { bucket: vi.fn(() => bucket) } as unknown as Pick<Storage, "bucket">;
  return { gcs: gcsStorage(client, "hms-test-bucket"), bucket, client };
}

const KEY = newObjectKey(randomUUID(), "test");

describe("cloud storage", () => {
  it("writes only where nothing exists yet, and keeps the object out of caches", async () => {
    const file = fakeFile();
    const { gcs, bucket } = storageWith(file);

    await gcs.put(KEY, new Uint8Array([1, 2]), { contentType: "application/pdf" });

    expect(bucket.file).toHaveBeenCalledWith(KEY);
    expect(file.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contentType: "application/pdf",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: "private, no-store" },
    }));
  });

  it("reports an existing object as such", async () => {
    const file = fakeFile({ save: failing("precondition", 412) });

    await expect(storageWith(file).gcs.put(KEY, new Uint8Array([1]), { contentType: "text/plain" }))
      .rejects
      .toBeInstanceOf(ObjectExistsError);
  });

  it("answers null for a missing object, and passes on any other failure", async () => {
    const missing = fakeFile({ download: failing("gone", 404) });
    const broken = fakeFile({ download: failing("denied", 403) });

    expect(await storageWith(missing).gcs.get(KEY)).toBeNull();
    await expect(storageWith(broken).gcs.get(KEY)).rejects.toThrow("denied");
  });

  it("signs a V4 read URL that expires within minutes", async () => {
    const file = fakeFile();
    const before = Date.now();

    const url = await storageWith(file).gcs.createSignedUrl(KEY, { expiresInSeconds: 120 });

    expect(url).toBe("https://storage.googleapis.com/signed");
    const [config] = file.getSignedUrl.mock.calls[0] as unknown as [{ version: string; action: string; expires: number }];
    expect(config).toMatchObject({ version: "v4", action: "read" });
    expect(config.expires - before).toBeGreaterThanOrEqual(120_000);
    expect(config.expires - before).toBeLessThan(121_000);
  });

  it("deletes without minding a missing object", async () => {
    const file = fakeFile();

    await storageWith(file).gcs.delete(KEY);

    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("refuses a key this system could not have made, before calling Google", async () => {
    const file = fakeFile();
    const { gcs, bucket } = storageWith(file);

    await expect(gcs.get("tenants/../secrets")).rejects.toThrow();
    expect(bucket.file).not.toHaveBeenCalled();
  });
});
