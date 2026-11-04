import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "@/app";

import type { ObjectCategory, ObjectStorage } from "./storage";

import { storage } from "./object-storage";
import { assertObjectKey, newObjectKey, ObjectExistsError } from "./storage";
import { localStorage } from "./storage-local";

const FACILITY = randomUUID();
const BYTES = new TextEncoder().encode("%PDF-1.7 synthetic");

/** A fresh key for a synthetic patient's file. */
function aKey() {
  return newObjectKey(FACILITY, "patients", randomUUID());
}

describe("object keys", () => {
  it("are tenant-prefixed and random, naming ids only", () => {
    const patient = randomUUID();

    const key = newObjectKey(FACILITY, "patients", patient);

    expect(key).toMatch(new RegExp(`^tenants/${FACILITY}/patients/${patient}/[0-9a-f-]{36}$`));
    expect(newObjectKey(FACILITY, "patients", patient)).not.toBe(key);
  });

  it.each([
    ["a person's name", "Wanjiru Kamau"],
    ["a lowercase name", "wanjiru"],
    ["a phone number", "254712345678"],
    ["a path climbing out", ".."],
    ["a slash", "a/b"],
  ])("refuse an id that is %s", (_label, id) => {
    expect(() => newObjectKey(FACILITY, "patients", id)).toThrow("every id is a UUID");
  });

  it("refuse a facility that is not an id", () => {
    expect(() => newObjectKey("amani-hospital", "patients")).toThrow("every id is a UUID");
  });

  it("refuse a category outside the list", () => {
    expect(() => newObjectKey(FACILITY, "wanjiru" as ObjectCategory)).toThrow("Not an object category");
  });

  it("refuse a key this system could not have made", () => {
    expect(() => assertObjectKey(`tenants/${FACILITY}/../../etc/${randomUUID()}`)).toThrow();
    expect(() => assertObjectKey(`tenants/${FACILITY}/wanjiru/${randomUUID()}`)).toThrow();
    expect(() => assertObjectKey("tenants/not-a-facility/x")).toThrow();
  });
});

describe("local storage", () => {
  let root: string;
  let local: ObjectStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hms-storage-"));
    local = localStorage({ root, baseUrl: "http://localhost:9999", secret: "s".repeat(32) });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns what was stored", async () => {
    const key = aKey();

    await local.put(key, BYTES, { contentType: "application/pdf" });

    expect(await local.get(key)).toEqual(BYTES);
  });

  it("never overwrites an object", async () => {
    const key = aKey();
    await local.put(key, BYTES, { contentType: "application/pdf" });

    await expect(local.put(key, new Uint8Array([1]), { contentType: "application/pdf" }))
      .rejects
      .toBeInstanceOf(ObjectExistsError);
    expect(await local.get(key)).toEqual(BYTES);
  });

  it("leaves nothing behind when a write fails, so a retry can succeed", async () => {
    const key = aKey();
    // A directory where the content-type record goes makes that write fail.
    await mkdir(path.join(root, `${key}.content-type`), { recursive: true });

    await expect(local.put(key, BYTES, { contentType: "application/pdf" })).rejects.toThrow();
    expect(await local.get(key)).toBeNull();

    await rm(path.join(root, `${key}.content-type`), { recursive: true });
    await expect(local.put(key, BYTES, { contentType: "application/pdf" })).resolves.toBeUndefined();
  });

  it("answers null for a missing object, and deleting one is not an error", async () => {
    const key = aKey();

    expect(await local.get(key)).toBeNull();
    await expect(local.delete(key)).resolves.toBeUndefined();
  });

  it.each([0, 901, 1.5])("refuses a signed URL lasting %s seconds", async (seconds) => {
    await expect(local.createSignedUrl(aKey(), { expiresInSeconds: seconds }))
      .rejects
      .toBeInstanceOf(RangeError);
  });
});

describe("a local signed URL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function stored() {
    const key = aKey();
    await storage.put(key, BYTES, { contentType: "application/pdf" });
    return key;
  }

  /** The path and query of a signed URL, which the test app answers. */
  function fetchUrl(url: string) {
    const { pathname, search } = new URL(url);
    return app.request(`${pathname}${search}`);
  }

  it("downloads the object, with no session, and keeps it out of caches", async () => {
    const key = await stored();

    const res = await fetchUrl(await storage.createSignedUrl(key));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("works for exactly as long as it was signed for", async () => {
    const key = await stored();
    vi.useFakeTimers({ toFake: ["Date"] });
    const issued = Date.now();
    const url = await storage.createSignedUrl(key, { expiresInSeconds: 60 });

    vi.setSystemTime(issued + 59_999);
    expect((await fetchUrl(url)).status).toBe(200);

    vi.setSystemTime(issued + 60_001);
    expect((await fetchUrl(url)).status).toBe(404);
  });

  it("cannot be bent to another object", async () => {
    const key = await stored();
    const other = await stored();
    const url = new URL(await storage.createSignedUrl(key));

    url.pathname = url.pathname.replace(key, other);

    expect((await fetchUrl(url.toString())).status).toBe(404);
  });

  it("refuses a forged signature", async () => {
    const key = await stored();
    const url = new URL(await storage.createSignedUrl(key));

    url.searchParams.set("signature", "A".repeat(43));

    expect((await fetchUrl(url.toString())).status).toBe(404);
  });
});
