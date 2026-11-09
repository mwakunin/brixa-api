import app from "@/app";
import { addDays, businessDate, startOfBusinessDay } from "@/lib/dates";

import { addMembership, facilityHeaders, makeOnboardedFacility, nextIp, signedInUser } from "./helpers";

/**
 * A working hospital for billing tests: a priced catalogue, wards whose
 * nights are charged, and the staff to work it, all set up through the API.
 */

export type Person = Awaited<ReturnType<typeof signedInUser>>;

export function call(method: string, path: string, facilityId: string, person: Person, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...facilityHeaders(facilityId, person), "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The Kenyan date each test works in. Re-read whenever a hospital is set up,
 * so a long run that crosses midnight in Nairobi starts each test on the
 * right day: a date fixed when the file loaded would make prices start
 * yesterday, which approval refuses as backdated. A live binding, so
 * importers see the update.
 */
// eslint-disable-next-line import/no-mutable-exports
export let TODAY = businessDate();

/** `hours` after the start of the Kenyan day `offset` days from today. */
export function at(offset: number, hours: number) {
  return new Date(startOfBusinessDay(addDays(TODAY, offset)).getTime() + hours * 3_600_000);
}

/**
 * A facility with a priced catalogue (a consultation at KES 500, a tablet at
 * KES 2.50, and two bed-days), two wards whose nights are charged at those
 * rates and one whose are not, and the staff to work it.
 */
export async function hospital() {
  TODAY = businessDate();
  const facility = await makeOnboardedFacility();
  const person = async (roles: Parameters<typeof addMembership>[2]) => {
    const user = await signedInUser();
    const membership = await addMembership(user.id, facility.id, roles);
    return { ...user, actor: { userId: user.id, membershipId: membership.id } };
  };
  const admin = await person(["facility_admin"]);
  const finance = await person(["finance_manager"]);
  const clerk = await person(["billing_clerk"]);
  const cashier = await person(["cashier"]);
  const auditor = await person(["auditor"]);
  const nurse = await person(["nurse", "records_clerk"]);

  const item = async (code: string, category: string) =>
    (await (await call("POST", "/billable-items", facility.id, admin, { code, name: code, category })).json()).id as string;
  const items = {
    consultation: await item("CONS", "consultation"),
    tablet: await item("PCM-500", "drug"),
    generalNight: await item("BED-GEN", "bed_day"),
    privateNight: await item("BED-PVT", "bed_day"),
    unpriced: await item("XRAY", "imaging"),
  };
  const change = await (await call("POST", "/price-changes", facility.id, admin, {
    effectiveFrom: TODAY,
    reason: "Initial tariff",
    lines: [
      { billableItemId: items.consultation, unitPriceCents: 50_000 },
      { billableItemId: items.tablet, unitPriceCents: 250 },
      { billableItemId: items.generalNight, unitPriceCents: 250_000 },
      { billableItemId: items.privateNight, unitPriceCents: 600_000 },
    ],
  })).json();
  await call("POST", `/price-changes/${change.id}/approve`, facility.id, finance);

  const ward = async (name: string, night: string | null) => {
    const w = await (await call("POST", "/wards", facility.id, admin, { name })).json();
    if (night)
      await call("PATCH", `/wards/${w.id}`, facility.id, admin, { bedDayItemId: night });
    return (await (await call("POST", `/wards/${w.id}/beds`, facility.id, admin, { label: `${name[0]}1` })).json()).id as string;
  };
  const beds = {
    general: await ward("General", items.generalNight),
    private: await ward("Private", items.privateNight),
    unrated: await ward("Unrated", null),
  };

  const patient = async () => (await (await call("POST", "/patients", facility.id, nurse, {
    givenName: "Test",
    familyName: "Patient",
    sex: "male",
    dateOfBirth: "1980-01-01",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  })).json()).id as string;

  return { facility, admin, finance, clerk, cashier, auditor, nurse, items, beds, patient };
}

export type Hospital = Awaited<ReturnType<typeof hospital>>;
