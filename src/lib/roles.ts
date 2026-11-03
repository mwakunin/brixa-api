import type { MembershipRole } from "@/db/schema";

/**
 * The membership roles as a runtime list, for request and response schemas.
 *
 * The column's type and its CHECK are the source of truth (db/schema.ts,
 * cross-checked by enum-checks.test.ts). The two assertions below make this
 * list fail to compile if it gains a value the column lacks, or misses one.
 */
export const MEMBERSHIP_ROLES = [
  "facility_admin",
  "auditor",
  "records_clerk",
  "doctor",
  "clinical_officer",
  "nurse",
  "ward_nurse",
  "lab_tech",
  "lab_supervisor",
  "pharmacist",
  "pharm_tech",
  "storekeeper",
  "cashier",
  "billing_clerk",
  "claims_officer",
  "finance_manager",
] as const satisfies readonly MembershipRole[];

type Missing = Exclude<MembershipRole, (typeof MEMBERSHIP_ROLES)[number]>;
// A compile error here names a role the column allows and this list omits.
const _complete: [Missing] extends [never] ? true : Missing = true;
void _complete;
