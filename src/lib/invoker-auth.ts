import { OAuth2Client } from "google-auth-library";

/**
 * Who may call the internal routes: Cloud Tasks and Cloud Scheduler, and
 * nobody else (CLAUDE.md §7).
 *
 * Both attach a Google-signed identity token minted for one service account
 * and one audience. The API itself is public, because the staff app calls it
 * from browsers, so Cloud Run's own IAM check cannot be the guard; this is.
 * A token passes only if Google signed it (the library fetches and caches
 * Google's public keys), it has not expired, it was minted for this API, and
 * it belongs to the configured service account, with that address verified.
 */
export interface InvokerVerifier {
  /** True for a valid `Authorization: Bearer <token>` from an allowed account. */
  verify: (authorization: string | undefined) => Promise<boolean>;
}

export function googleInvokerVerifier(options: {
  audience: string;
  allowedEmails: ReadonlySet<string>;
  /** Overridable so tests can verify tokens signed with their own key. */
  client?: OAuth2Client;
}): InvokerVerifier {
  const client = options.client ?? new OAuth2Client();

  return {
    async verify(authorization) {
      const token = authorization?.match(/^Bearer ([\w.-]+)$/)?.[1];
      if (!token || options.allowedEmails.size === 0)
        return false;

      try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: options.audience });
        const payload = ticket.getPayload();
        return Boolean(payload?.email && payload.email_verified && options.allowedEmails.has(payload.email));
      }
      catch {
        // Bad signature, wrong audience or issuer, expired, malformed: all
        // the same answer, and none of it worth echoing to the caller.
        return false;
      }
    },
  };
}
