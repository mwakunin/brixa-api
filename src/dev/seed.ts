import { count } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";

import app from "@/app";
import db, { connectionHosts } from "@/db";
import { isLocalHostName } from "@/db/connection";
import { facilities } from "@/db/schema";
import env from "@/env";
import { AccountExistsError, createAccount } from "@/lib/accounts";
import { addDays, businessDate } from "@/lib/dates";
import { drugCatalogueSize, drugCodeOf, loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { loadIcd11 } from "@/lib/icd11-load";
import { invitationToken } from "@/lib/invitations";

/**
 * A made-up hospital for development (`pnpm db:seed`): a facility, one
 * member of staff per desk, a priced catalogue, a stocked pharmacy, and
 * invented patients spread across the desks, so each screen of the staff
 * app has something to show (brixa-web `docs/outpatient-journey.md`).
 *
 * The hospital is built through the API as the staff app would drive it, so
 * every rule, charge and audit entry is real. Three things are not, as no
 * route makes them: the superadmin account (`createAccount`) and the shared
 * drug and ICD-11 catalogues (their lib loaders). Synthetic data only, and
 * never a message sent: it refuses to run with email or SMS credentials set,
 * against a database that is not on this machine, or in production
 * (CLAUDE.md §8).
 */

export const SEED_FACILITY = "Sample Hospital";
/** Every seeded account's password. A development database only. */
export const SEED_PASSWORD = "brixa-dev-password";
const SUPERADMIN = "superadmin@brixa.test";
const FIXTURES = path.resolve(import.meta.dirname, "../test/fixtures");

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

/**
 * The connections that reach a database not on this machine, by name and
 * host. A socket directory is this machine's; a connection naming no host
 * could reach PGHOST anywhere, so it counts as remote.
 */
export function remoteConnections(hosts: Record<string, string | null>): string[] {
  return Object.entries(hosts)
    .filter(([, host]) => !(host && (isLocalHostName(host) || host.startsWith("/"))))
    .map(([name, host]) => `${name} (${host ?? "no host named"})`);
}

/**
 * Refuses anything but an empty development database on this machine,
 * through every connection, with no way to send a real message. Empty
 * matters as much as local: a staging or production database tunnelled to
 * localhost (an SSH tunnel, the Cloud SQL proxy) passes every host check,
 * and would get a superadmin with the seed's public password.
 */
export async function assertSafeToSeed(): Promise<void> {
  if (env.NODE_ENV === "production")
    throw new SeedError("Not in production.");
  const remote = remoteConnections(connectionHosts);
  if (remote.length > 0)
    throw new SeedError(`Not on this machine: ${remote.join(", ")}. The seed writes only to local databases.`);
  const senders = (["RESEND_API_KEY", "AT_API_KEY", "TASKS_QUEUE"] as const).filter(k => env[k]);
  if (senders.length > 0)
    throw new SeedError(`${senders.join(", ")} set: the seed would send real email or SMS. Unset them first.`);
  const [{ n }] = await db.select({ n: count() }).from(facilities);
  if (n > 0)
    throw new SeedError("This database holds a facility already: it is seeded already, or it is not a development database. The seed writes only to one with none (docs/development.md).");
}

// ---------------------------------------------------------------------------
// Calling the API
// ---------------------------------------------------------------------------

interface Session { cookie: string }
interface Caller { session: Session; facilityId?: string }

let address = 0;
/** A distinct forwarded address per request, so the API's per-address limits see many callers, not one. */
function nextAddress(): string {
  address += 1;
  return `10.254.${(address >> 8) & 255}.${address & 255}`;
}

async function send(method: string, route: string, as: Caller | null, body?: unknown) {
  const res = await app.request(route, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextAddress(),
      ...(as ? { cookie: as.session.cookie } : {}),
      ...(as?.facilityId ? { "x-facility-id": as.facilityId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const answer = await res.json().catch(() => ({})) as { code?: string; message?: string };
    throw new SeedError(`${method} ${route} answered ${res.status}${answer.code ? ` (${answer.code})` : ""}: ${answer.message ?? ""}`);
  }
  return res.status === 204 ? null : res.json();
}

async function signIn(email: string): Promise<Session> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextAddress() },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (!res.ok || !setCookie)
    throw new SeedError(`Signing in as ${email} answered ${res.status}`);
  return { cookie: setCookie.split(/,(?=\s*[^;=\s]+=)/).map(c => c.split(";")[0].trim()).join("; ") };
}

// ---------------------------------------------------------------------------
// The facility and its staff
// ---------------------------------------------------------------------------

type Role = "facility_admin" | "records_clerk" | "nurse" | "doctor" | "lab_tech" | "lab_supervisor" | "pharmacist" | "storekeeper" | "cashier" | "finance_manager";
type Profession = "medical_practitioner" | "nurse" | "laboratory" | "pharmacy";

interface Member { name: string; email: string; roles: Role[]; licence?: { profession: Profession; number: string } }

/** One member of staff per desk, named as in the sketched journey. */
export const SEED_STAFF = {
  admin: { name: "Ruth Odhiambo", email: "admin@sample-hospital.test", roles: ["facility_admin"] },
  clerk: { name: "Joyce Mwangi", email: "frontdesk@sample-hospital.test", roles: ["records_clerk"] },
  nurse: { name: "Grace Achieng", email: "triage@sample-hospital.test", roles: ["nurse"], licence: { profession: "nurse", number: "NCK-DEV-0001" } },
  doctor: { name: "Daniel Kamau", email: "doctor@sample-hospital.test", roles: ["doctor"], licence: { profession: "medical_practitioner", number: "KMPDC-DEV-0001" } },
  labTech: { name: "Peter Njoroge", email: "lab@sample-hospital.test", roles: ["lab_tech"], licence: { profession: "laboratory", number: "KMLTTB-DEV-0001" } },
  labSupervisor: { name: "Lucy Wambui", email: "labsupervisor@sample-hospital.test", roles: ["lab_supervisor"], licence: { profession: "laboratory", number: "KMLTTB-DEV-0002" } },
  pharmacist: { name: "Faith Atieno", email: "pharmacy@sample-hospital.test", roles: ["pharmacist"], licence: { profession: "pharmacy", number: "PPB-DEV-0001" } },
  storekeeper: { name: "Moses Kiprotich", email: "stores@sample-hospital.test", roles: ["storekeeper"] },
  cashier: { name: "Mercy Wairimu", email: "cashier@sample-hospital.test", roles: ["cashier"] },
  finance: { name: "Ann Wekesa", email: "finance@sample-hospital.test", roles: ["finance_manager"] },
} as const satisfies Record<string, Member>;

type StaffKey = keyof typeof SEED_STAFF;
type Staff = Record<StaffKey, Caller>;

async function accept(invitationId: string): Promise<void> {
  await send("POST", "/invitations/accept", null, { token: invitationToken(invitationId), password: SEED_PASSWORD });
}

/** The facility, onboarded by a superadmin, with its admin and every other member invited and signed in. */
async function facilityAndStaff(): Promise<{ facilityId: string; staff: Staff }> {
  try {
    await createAccount({ email: SUPERADMIN, name: "Platform Superadmin", password: SEED_PASSWORD, role: "superadmin" });
  }
  catch (err) {
    if (err instanceof AccountExistsError)
      throw new SeedError("This database is seeded already. To start again, recreate the dev database (docs/development.md).");
    throw err;
  }
  const superadmin = { session: await signIn(SUPERADMIN) };
  const { admin } = SEED_STAFF;
  const facility = await send("POST", "/superadmin/facilities", superadmin, { name: SEED_FACILITY, kmhfrCode: "DEV-00001", kephLevel: 4, county: "Nairobi", admin: { name: admin.name, email: admin.email } });
  await accept(facility.adminInvitationId);
  const staff = { admin: { session: await signIn(admin.email), facilityId: facility.id } } as Staff;

  const expiresOn = addDays(businessDate(), 365);
  for (const [key, member] of Object.entries(SEED_STAFF) as [StaffKey, Member][]) {
    if (key === "admin")
      continue;
    const invited = await send("POST", "/staff/invitations", staff.admin, { name: member.name, email: member.email, roles: member.roles, ...(member.licence ? { licence: { ...member.licence, expiresOn } } : {}) });
    await accept(invited.id);
    staff[key] = { session: await signIn(member.email), facilityId: facility.id };
  }
  return { facilityId: facility.id, staff };
}

// ---------------------------------------------------------------------------
// What the facility sells, tests and stocks
// ---------------------------------------------------------------------------

/** The two medicines the pharmacy stocks, by their catalogue codes, whichever catalogue is loaded: the sample's or PPB's. */
interface Medicines { coartem: string; paracetamol: string }

interface Setup {
  triage: string;
  generalClinic: string;
  pharmacy: string;
  tests: { mrdt: { id: string; analyte: string }; fbc: { id: string; analytes: Record<"HB" | "WBC" | "PLT", string> } };
  stock: { coartem: string; paracetamol: string };
  drugs: Medicines;
}

/**
 * The two medicines, found before anything is written, so a catalogue
 * without them stops the seed with nothing half done. An empty catalogue
 * gets the test fixtures' sample; any other is used as it is.
 */
async function medicines(): Promise<Medicines> {
  if (await drugCatalogueSize() === 0)
    await loadDrugCatalogue(await readFile(path.join(FIXTURES, "drug-catalogue-sample.csv"), "utf8"));
  const wanted = [["coartem", "Artemether/Lumefantrine", "20 mg/120 mg"], ["paracetamol", "Paracetamol", "500 mg"]] as const;
  const found: Partial<Medicines> = {};
  for (const [key, name, strength] of wanted) {
    const code = await drugCodeOf(name, strength, "Tablet");
    if (!code)
      throw new SeedError(`The drug catalogue has no ${name} ${strength} Tablet: load one that does (docs/drug-catalogue.md).`);
    found[key] = code;
  }
  return found as Medicines;
}

/** The diagnoses' codes, from the test fixtures, unless some are loaded already. */
async function catalogues(staff: Staff): Promise<void> {
  if ((await send("GET", "/icd-codes?q=malaria", staff.doctor)).codes.length === 0)
    await loadIcd11(await readFile(path.join(FIXTURES, "icd11-mms-sample.txt"), "utf8"));
}

/** Items at their cash prices: asked for by the admin, approved by the finance manager (rule 24). */
async function pricedItems(staff: Staff): Promise<Record<string, string>> {
  const items = [
    ["CONS-GEN", "Consultation, General OPD", "consultation", 50_000],
    ["CONS-DEN", "Consultation, Dental clinic", "consultation", 80_000],
    ["MRDT", "Malaria rapid test", "lab", 30_000],
    ["FBC", "Full blood count", "lab", 80_000],
    ["AL-24", "Artemether/lumefantrine 20/120 mg tablets", "drug", 2_500],
    ["PCM-500", "Paracetamol 500 mg tablets", "drug", 250],
  ] as const;
  const ids: Record<string, string> = {};
  for (const [code, name, category] of items)
    ids[code] = (await send("POST", "/billable-items", staff.admin, { code, name, category })).id;
  const change = await send("POST", "/price-changes", staff.admin, { effectiveFrom: businessDate(), reason: "Opening tariff", lines: items.map(([code, , , cents]) => ({ billableItemId: ids[code], unitPriceCents: cents })) });
  await send("POST", `/price-changes/${change.id}/approve`, staff.finance);
  return ids;
}

async function clinics(staff: Staff, ids: Record<string, string>): Promise<{ triage: string; generalClinic: string }> {
  const triage = (await send("POST", "/service-points", staff.admin, { name: "Triage", kind: "triage" })).id;
  const generalClinic = (await send("POST", "/service-points", staff.admin, { name: "General OPD", kind: "consultation" })).id;
  await send("PATCH", `/service-points/${generalClinic}`, staff.admin, { consultationItemId: ids["CONS-GEN"] });
  const dental = (await send("POST", "/service-points", staff.admin, { name: "Dental clinic", kind: "consultation" })).id;
  await send("PATCH", `/service-points/${dental}`, staff.admin, { consultationItemId: ids["CONS-DEN"] });
  return { triage, generalClinic };
}

async function labTests(staff: Staff, ids: Record<string, string>): Promise<Setup["tests"]> {
  const mrdt = await send("POST", "/lab-tests", staff.admin, {
    billableItemId: ids.MRDT,
    specimenType: "blood",
    analytes: [{ code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }],
  });
  const fbc = await send("POST", "/lab-tests", staff.admin, {
    billableItemId: ids.FBC,
    specimenType: "blood",
    analytes: [
      { code: "HB", name: "Haemoglobin", resultType: "numeric", unit: "g/dL", criticalLow: 7, ranges: [{ sex: "any", low: 12, high: 16 }] },
      { code: "WBC", name: "White cells", resultType: "numeric", unit: "x10^9/L", ranges: [{ sex: "any", low: 4, high: 11 }] },
      { code: "PLT", name: "Platelets", resultType: "numeric", unit: "x10^9/L", criticalLow: 20, ranges: [{ sex: "any", low: 150, high: 400 }] },
    ],
  });
  const analyte = (code: string) => fbc.analytes.find((a: { code: string }) => a.code === code).id as string;
  return { mrdt: { id: mrdt.id, analyte: mrdt.analytes[0].id }, fbc: { id: fbc.id, analytes: { HB: analyte("HB"), WBC: analyte("WBC"), PLT: analyte("PLT") } } };
}

/** The pharmacy, with two medicines received straight into it. */
async function pharmacy(staff: Staff, ids: Record<string, string>, drugs: Medicines): Promise<{ pharmacy: string; stock: Setup["stock"]; drugs: Medicines }> {
  const store = (await send("POST", "/stores", staff.admin, { name: "Pharmacy", kind: "pharmacy" })).id;
  const coartem = (await send("POST", "/stock-items", staff.admin, { billableItemId: ids["AL-24"], drugCode: drugs.coartem, baseUnit: "tablet", packSize: 24 })).id;
  const paracetamol = (await send("POST", "/stock-items", staff.admin, { billableItemId: ids["PCM-500"], drugCode: drugs.paracetamol, baseUnit: "tablet", packSize: 100 })).id;
  await send("POST", "/goods-received", staff.storekeeper, {
    storeId: store,
    supplier: "KEMSA",
    supplierReference: "DN-DEV-0001",
    lines: [
      { stockItemId: coartem, batchNumber: "AL-2291", expiresOn: addDays(businessDate(), 300), units: 240, totalCostCents: 120_000 },
      { stockItemId: paracetamol, batchNumber: "PCM-0815", expiresOn: addDays(businessDate(), 700), units: 1000, totalCostCents: 50_000 },
    ],
  });
  return { pharmacy: store, stock: { coartem, paracetamol }, drugs };
}

async function setUp(staff: Staff, drugs: Medicines): Promise<Setup> {
  await catalogues(staff);
  const ids = await pricedItems(staff);
  const points = await clinics(staff, ids);
  const tests = await labTests(staff, ids);
  const stores = await pharmacy(staff, ids, drugs);
  await send("POST", "/cashier-shifts", staff.cashier, { openingFloatCents: 200_000 });
  return { ...points, tests, ...stores };
}

// ---------------------------------------------------------------------------
// Patients at every desk
// ---------------------------------------------------------------------------

interface Person { givenName: string; middleNames?: string; familyName: string; sex: "female" | "male"; dateOfBirth: string; phone?: string }

async function register(staff: Staff, p: Person): Promise<string> {
  return (await send("POST", "/patients", staff.clerk, {
    ...p,
    ...(p.phone ? {} : { noPhoneReason: "no_phone" }),
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  })).id;
}

/** A visit opened at the front desk: the patient joins triage. */
async function arrives(staff: Staff, p: Person): Promise<{ patientId: string; visit: string }> {
  const patientId = await register(staff, p);
  const visit = (await send("POST", "/encounters", staff.clerk, { patientId, kind: "opd" })).id;
  return { patientId, visit };
}

async function liveEntry(staff: Staff, visit: string): Promise<string> {
  return (await send("GET", `/encounters/${visit}`, staff.nurse)).queue.entryId;
}

/** Triage takes the vital signs and sends the patient to the clinic, whose fee is charged as they join. */
async function triaged(staff: Staff, setup: Setup, visit: string, readings: Record<string, number>, priority: "urgent" | "routine"): Promise<void> {
  const entry = await liveEntry(staff, visit);
  await send("POST", `/queue-entries/${entry}/serve`, staff.nurse);
  await send("POST", `/encounters/${visit}/observations`, staff.nurse, { readings: Object.entries(readings).map(([code, value]) => ({ code, value })) });
  await send("POST", `/queue-entries/${entry}/finish`, staff.nurse, { nextServicePointId: setup.generalClinic, priority });
}

/** The doctor sees the patient, writes a note and orders what is given; finishing sends them on their way. */
async function seen(staff: Staff, visit: string, complaint: string, then: { tests?: string[]; medicines?: { drugCode: string; doseAmount: string; frequency: string; durationDays: number }[] }) {
  const entry = await liveEntry(staff, visit);
  await send("POST", `/queue-entries/${entry}/serve`, staff.doctor);
  await send("POST", `/encounters/${visit}/notes`, staff.doctor, { kind: "consultation", presentingComplaint: complaint, plan: then.tests ? "Tests, then review" : "Treat and review if no better" });
  const order = then.tests ? await send("POST", `/encounters/${visit}/orders`, staff.doctor, { items: then.tests.map(labTestId => ({ labTestId })) }) : null;
  const prescription = then.medicines ? await send("POST", `/encounters/${visit}/prescriptions`, staff.doctor, { items: then.medicines }) : null;
  await send("POST", `/queue-entries/${entry}/finish`, staff.doctor, {});
  return { order, prescription };
}

/** The cashier bills what is due and takes it in cash. */
async function pays(staff: Staff, patientId: string, visit: string): Promise<void> {
  const invoice = await send("POST", `/encounters/${visit}/bill-now`, staff.cashier);
  await send("POST", "/payments", staff.cashier, { patientId, method: "cash", amountCents: invoice.totalCents, invoiceId: invoice.id });
}

const born = (years: number, month = "06-15") => `${Number(businessDate().slice(0, 4)) - years}-${month}`;

/** Waiting at triage, at the clinic, and booked for later today. */
async function earlyInTheVisit(staff: Staff, setup: Setup): Promise<void> {
  await arrives(staff, { givenName: "Samuel", familyName: "Mutua", sex: "male", dateOfBirth: born(4, "02-03") });
  await arrives(staff, { givenName: "Esther", familyName: "Wanjiku", sex: "female", dateOfBirth: born(67, "09-21") });
  const amina = await arrives(staff, { givenName: "Amina", familyName: "Njeri", sex: "female", dateOfBirth: born(29), phone: "+254700000101" });
  await triaged(staff, setup, amina.visit, { temperature: 38.4, pulse: 104, respiratory_rate: 20, bp_systolic: 118, bp_diastolic: 76, weight: 62 }, "urgent");
  const peter = await register(staff, { givenName: "Peter", familyName: "Otieno", sex: "male", dateOfBirth: born(52, "11-02") });
  await send("POST", "/appointments", staff.clerk, { patientId: peter, servicePointId: setup.generalClinic, date: businessDate(), smsReminders: false });
  // Found by a search for "amina", beside the one who is here today.
  await register(staff, { givenName: "Amina", middleNames: "Wambui", familyName: "Karanja", sex: "female", dateOfBirth: born(61, "01-30") });
  await register(staff, { givenName: "Aminah", familyName: "Hassan", sex: "female", dateOfBirth: born(8, "04-12") });
}

/** At the lab: one to collect, one to verify, and one back at the clinic with her results. */
async function atTheLab(staff: Staff, setup: Setup): Promise<void> {
  const { mrdt, fbc } = setup.tests;
  const james = await arrives(staff, { givenName: "James", familyName: "Omondi", sex: "male", dateOfBirth: born(30, "07-07") });
  await triaged(staff, setup, james.visit, { temperature: 37.9, pulse: 92 }, "routine");
  await seen(staff, james.visit, "Tired for two weeks", { tests: [fbc.id] });

  const john = await arrives(staff, { givenName: "John", familyName: "Kariuki", sex: "male", dateOfBirth: born(41, "03-18") });
  await triaged(staff, setup, john.visit, { temperature: 38.9, pulse: 98 }, "routine");
  const forJohn = (await seen(staff, john.visit, "Fever and chills", { tests: [mrdt.id] })).order;
  const johnSample = await send("POST", `/orders/${forJohn.id}/specimens`, staff.labTech, { specimenType: "blood" });
  await send("POST", `/specimens/${johnSample.id}/results`, staff.labTech, { orderItemId: forJohn.items[0].id, values: [{ analyteId: mrdt.analyte, value: "Negative" }] });

  const mary = await arrives(staff, { givenName: "Mary", familyName: "Chebet", sex: "female", dateOfBirth: born(35, "12-01") });
  await triaged(staff, setup, mary.visit, { temperature: 38.2, pulse: 101 }, "urgent");
  await pays(staff, mary.patientId, mary.visit);
  const forMary = (await seen(staff, mary.visit, "Fever, headache and joint pains for three days", { tests: [mrdt.id, fbc.id] })).order;
  const marySample = await send("POST", `/orders/${forMary.id}/specimens`, staff.labTech, { specimenType: "blood" });
  const itemOf = (testId: string) => forMary.items.find((i: { labTestId: string }) => i.labTestId === testId).id;
  const malaria = await send("POST", `/specimens/${marySample.id}/results`, staff.labTech, { orderItemId: itemOf(mrdt.id), values: [{ analyteId: mrdt.analyte, value: "Positive" }] });
  const count = await send("POST", `/specimens/${marySample.id}/results`, staff.labTech, { orderItemId: itemOf(fbc.id), values: [{ analyteId: fbc.analytes.HB, value: 10.9 }, { analyteId: fbc.analytes.WBC, value: 11.8 }, { analyteId: fbc.analytes.PLT, value: 142 }] });
  // Verified by a second person: the last of them sends her back to the clinic.
  await send("POST", `/lab-results/${malaria.id}/verify`, staff.labSupervisor, {});
  await send("POST", `/lab-results/${count.id}/verify`, staff.labSupervisor, {});
}

/** At the pharmacy: one prescription to prepare, and one prepared, unpaid, to hand over. */
async function atThePharmacy(staff: Staff, setup: Setup): Promise<void> {
  const brian = await arrives(staff, { givenName: "Brian", familyName: "Kiplagat", sex: "male", dateOfBirth: born(34, "08-25") });
  await triaged(staff, setup, brian.visit, { temperature: 37.2, pulse: 80 }, "routine");
  await pays(staff, brian.patientId, brian.visit);
  await seen(staff, brian.visit, "Headache since yesterday", { medicines: [{ drugCode: setup.drugs.paracetamol, doseAmount: "2", frequency: "tds", durationDays: 3 }] });

  const ruth = await arrives(staff, { givenName: "Ruth", familyName: "Akinyi", sex: "female", dateOfBirth: born(26, "05-09") });
  await triaged(staff, setup, ruth.visit, { temperature: 38.0, pulse: 96 }, "routine");
  const { prescription } = await seen(staff, ruth.visit, "Malaria positive at a clinic this morning", { medicines: [{ drugCode: setup.drugs.coartem, doseAmount: "4", frequency: "bd", durationDays: 3 }] });
  await send("POST", "/dispenses", staff.pharmacist, { orderId: prescription.id, storeId: setup.pharmacy, lines: [{ orderItemId: prescription.items[0].id, stockItemId: setup.stock.coartem }] });
}

export interface Seeded {
  facilityId: string;
  password: string;
  staff: { desk: StaffKey; name: string; email: string; roles: readonly Role[] }[];
}

/** Seeds a development database with a made-up hospital at work. Refuses a database seeded already. */
export async function seedDevelopment(): Promise<Seeded> {
  await assertSafeToSeed();
  const drugs = await medicines();
  const { facilityId, staff } = await facilityAndStaff();
  const setup = await setUp(staff, drugs);
  await earlyInTheVisit(staff, setup);
  await atTheLab(staff, setup);
  await atThePharmacy(staff, setup);
  return {
    facilityId,
    password: SEED_PASSWORD,
    staff: (Object.entries(SEED_STAFF) as [StaffKey, Member][]).map(([desk, m]) => ({ desk, name: m.name, email: m.email, roles: m.roles })),
  };
}
