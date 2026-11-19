/**
 * An authenticator secret as an otpauth:// address carries it (base32) back
 * to the plain secret Better Auth works codes out from, as an authenticator
 * app does when it scans the setup page's QR code.
 */
export function decodeSecret(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get("secret")!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of encoded.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
