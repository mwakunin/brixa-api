import { Storage } from "@google-cloud/storage";

import env from "@/env";

import type { ObjectStorage } from "./storage";

import { gcsStorage } from "./storage-gcs";
import { localStorage } from "./storage-local";

/**
 * The configured storage: Cloud Storage in production (env.ts insists), the
 * local disk otherwise. Code that stores files imports this, and its tests
 * build their own with `localStorage` or `gcsStorage`.
 */
export const storage: ObjectStorage = env.STORAGE_DRIVER === "gcs"
  ? gcsStorage(new Storage(), env.STORAGE_BUCKET!)
  : localStorage({ root: env.STORAGE_LOCAL_DIR, baseUrl: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET });
