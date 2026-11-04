/**
 * Phone numbers, stored E.164 (CLAUDE.md rule 13). Ported from
 * school-saas-api's lib/phone.ts.
 *
 * Kenyan numbers arrive in at least four shapes: `0712345678`,
 * `+254712345678`, `254712345678` and `712345678`, often with spaces, dashes
 * or brackets. The same number must be stored one way however it was typed,
 * so a search finds it and an M-Pesa prompt reaches it: normalise on write.
 *
 * Kenyan mobile national significant numbers are 9 digits beginning with 7
 * or 1 (the newer 011x range). A foreign number is accepted only when typed
 * with its `+` country code, since without one there is no telling which
 * country it belongs to: refugees and visitors are patients too.
 */

const KENYA_COUNTRY_CODE = "254";
const KENYAN_NSN = /^[71]\d{8}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/** The number in E.164 (`+2547XXXXXXXX`), or null if it is not one we accept. */
export function normalizePhone(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-()./]/g, "");
  if (!/^\+?\d+$/.test(cleaned))
    return null;

  const international = cleaned.startsWith("+");
  let digits = international ? cleaned.slice(1) : cleaned;

  if (international && !digits.startsWith(KENYA_COUNTRY_CODE))
    return E164.test(cleaned) ? cleaned : null;

  if (digits.startsWith(KENYA_COUNTRY_CODE))
    digits = digits.slice(KENYA_COUNTRY_CODE.length);
  else if (digits.startsWith("0"))
    digits = digits.slice(1);

  return KENYAN_NSN.test(digits) ? `+${KENYA_COUNTRY_CODE}${digits}` : null;
}
