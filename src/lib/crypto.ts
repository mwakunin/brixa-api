import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import env from "@/env";

/**
 * Secrets at rest: each facility's Daraja credentials, encrypted with
 * AES-256-GCM under CREDENTIALS_ENCRYPTION_KEY (ported from school-saas-api).
 * The stored form is `v1.iv.tag.ciphertext`, base64url, so a later key or
 * algorithm can be told apart. GCM's tag means a tampered or truncated value
 * fails to decrypt rather than decrypting to something else.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
  }
}

function masterKey(): Buffer {
  if (!env.CREDENTIALS_ENCRYPTION_KEY)
    throw new CryptoError("CREDENTIALS_ENCRYPTION_KEY is not set, so M-Pesa credentials cannot be stored or read");
  const key = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64");
  if (key.length !== KEY_BYTES)
    throw new CryptoError(`CREDENTIALS_ENCRYPTION_KEY must be base64 of ${KEY_BYTES} bytes, got ${key.length}`);
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION)
    throw new CryptoError("Not a value this version encrypted");
  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new CryptoError("Malformed encrypted value");
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  }
  catch (err) {
    throw new CryptoError("Could not decrypt: tampered with, truncated, or under another key", { cause: err });
  }
}

/** Compares two secrets in constant time. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 256 random bits, base64url: the secret in a facility's callback URLs. */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}
