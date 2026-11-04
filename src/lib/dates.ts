/**
 * Business dates, computed in one place (CLAUDE.md rule 26).
 *
 * Service dates, bed-day dates, number-series periods and report days are
 * Kenyan calendar days. Kenya is UTC+3, so for the first three hours of each
 * Kenyan day UTC still reports yesterday: an invoice finalised at 01:00 on
 * 1 January would take the previous year's number if the year were read in
 * UTC.
 *
 * The zone is passed explicitly rather than read from TZ, because the
 * container sets `TZ=UTC` on purpose (the database is UTC). Only this
 * calendar question is local. Ported from school-saas-api's lib/dates.ts.
 */
export const BUSINESS_TIME_ZONE = "Africa/Nairobi";

const dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  // Pinned so the parts are Gregorian and written in Latin digits whatever the
  // host's defaults are.
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The Kenyan calendar day of `at`, as `YYYY-MM-DD`, the shape `date` columns
 * store and compare as strings.
 *
 * Assembled from typed parts rather than read off a formatted string: a
 * locale that silently falls back would print `11/3/2026`, which compares
 * wrongly against a date column instead of failing.
 */
export function businessDate(at: Date = new Date()): string {
  const parts = dayParts.formatToParts(at);
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}

const printedParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * `at` as printed on a document, in Kenyan time: `4 Nov 2026, 14:05`.
 * Assembled from parts for the same reason as `businessDate`: the layout must
 * not depend on how the host's ICU punctuates a locale.
 */
export function printedDateTime(at: Date): string {
  const parts = printedParts.formatToParts(at);
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  return `${value("day")} ${value("month")} ${value("year")}, ${value("hour")}:${value("minute")}`;
}
