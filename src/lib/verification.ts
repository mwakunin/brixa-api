import { randomBytes } from "node:crypto";

import env from "@/env";

/**
 * Codes that let a printed document prove it is genuine (ported from
 * school-saas-api's lib/verification.ts).
 *
 * A pharmacy handed a prescription, an insurer handed a receipt, or a patient
 * disputing a payment can scan the QR and see that this hospital issued this
 * number on this date, and whether it still stands. A photocopy edited in a
 * phone app cannot pass that check.
 */

/** 160 bits: the public verify endpoint has no session, so the code is the whole credential. */
const CODE_BYTES = 20;

/** 20 bytes of base64url. The database CHECK holds the same shape. */
export const VERIFICATION_CODE_PATTERN = /^[\w-]{27}$/;

/**
 * A code for a document being issued. Random rather than sequential, so
 * finding one code tells nobody how to reach another. base64url so it
 * survives a URL and a QR payload without escaping.
 */
export function mintVerificationCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

/**
 * The address the QR carries and the page prints under it: the staff app's
 * public verify page, which asks this API (`GET /verify/{code}`).
 */
export function verificationUrl(code: string): string {
  return `${new URL(env.APP_URL).origin}/verify/${code}`;
}
