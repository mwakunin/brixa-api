/**
 * Money arithmetic (CLAUDE.md rule 3): integer cents, never floats.
 *
 * A unit price may carry fractional shillings (KES 2.50 a tablet), and a
 * quantity may be fractional (1.5 tablets, 0.25 l). A charge's amount is
 * their product rounded once, at capture, to whole shillings, because
 * neither cash nor M-Pesa carries cents (SPEC.md D2). Exact integer
 * arithmetic throughout, so the rounding is the only place a cent moves.
 */

/** Up to 8 whole digits and 3 decimals: `1`, `1.5`, `0.250`. */
export const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,3})?$/;

/** What a charge row's integer column holds with room to spare: KES 20 million. */
const MAX_CHARGE_CENTS = 2_000_000_000n;

/** `quantity` in thousandths, exactly. */
function thousandths(quantity: string): bigint {
  if (!QUANTITY_PATTERN.test(quantity))
    throw new RangeError(`Not a quantity: ${quantity}`);
  const [whole, fraction = ""] = quantity.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

/** A quantity as printed: `1.500` → `1.5`, `2.000` → `2`. */
export function printedQuantity(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
}

/** Cents as printed on a document: 150000 → `KES 1,500.00`. */
export function formatKes(cents: number): string {
  if (!Number.isSafeInteger(cents))
    throw new RangeError(`Not an amount in cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const whole = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(?:\d{3})+$)/g, ",");
  return `${sign}KES ${whole}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

/**
 * quantity × unit price, rounded half up to whole shillings, in cents:
 * 3 × KES 2.50 = KES 7.50 → KES 8 (800 cents).
 */
export function chargeAmountCents(quantity: string, unitPriceCents: number): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0)
    throw new RangeError(`Not a unit price: ${unitPriceCents}`);

  // thousandths × cents is in thousandths of a cent; a shilling is 100,000 of them.
  const milliCents = thousandths(quantity) * BigInt(unitPriceCents);
  const cents = ((milliCents + 50_000n) / 100_000n) * 100n;
  if (cents > MAX_CHARGE_CENTS)
    throw new RangeError("A single charge cannot exceed KES 20 million");
  return Number(cents);
}
