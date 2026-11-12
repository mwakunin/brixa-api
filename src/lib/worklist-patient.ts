import { patientNumbers, patients } from "@/db/schema";

import { ageInYears } from "./dates";

/** The patient a lab list names, so whoever works from it knows whose sample or result it is. */
export interface WorklistPatient {
  id: string;
  name: string;
  opNumber: string | null;
  sex: (typeof patients.$inferSelect)["sex"];
  ageYears: number;
}

/** The columns `patientOf` reads, for a query joining `patients` and their outpatient number. */
export const patientColumns = {
  patientId: patients.id,
  givenName: patients.givenName,
  middleNames: patients.middleNames,
  familyName: patients.familyName,
  sex: patients.sex,
  dateOfBirth: patients.dateOfBirth,
  opNumber: patientNumbers.number,
};

export function patientOf(r: { patientId: string; givenName: string; middleNames: string | null; familyName: string; sex: WorklistPatient["sex"]; dateOfBirth: string; opNumber: string | null }, today?: string): WorklistPatient {
  return {
    id: r.patientId,
    name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "),
    opNumber: r.opNumber,
    sex: r.sex,
    ageYears: ageInYears(r.dateOfBirth, today),
  };
}
