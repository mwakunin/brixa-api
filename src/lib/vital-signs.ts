/**
 * The vital signs a nurse or clinician records, in one unit each, with the
 * range a real reading can fall in (P3, slice 2).
 *
 * The ranges catch typing slips (a temperature of 367, a weight in grams),
 * not illness: a value outside one is refused, while a value inside it is
 * stored however abnormal. Telling normal from abnormal is a separate,
 * age-dependent question and is not answered here.
 *
 * Plain data with no imports: `db/schema.ts` builds the observations CHECK
 * from it, so the service and the database cannot disagree. Codes are this
 * system's own; mapping them to LOINC waits for DHA's vital-sign profiles
 * (AfyaConnect), rather than guessing a code now.
 */
export const VITAL_SIGNS = {
  temperature: { label: "Temperature", unit: "°C", min: 25, max: 45 },
  pulse: { label: "Pulse", unit: "/min", min: 20, max: 300 },
  respiratory_rate: { label: "Respiratory rate", unit: "/min", min: 2, max: 90 },
  bp_systolic: { label: "Blood pressure, systolic", unit: "mmHg", min: 40, max: 300 },
  bp_diastolic: { label: "Blood pressure, diastolic", unit: "mmHg", min: 20, max: 200 },
  spo2: { label: "Oxygen saturation", unit: "%", min: 40, max: 100 },
  weight: { label: "Weight", unit: "kg", min: 0.3, max: 400 },
  height: { label: "Height", unit: "cm", min: 20, max: 250 },
  muac: { label: "Mid-upper arm circumference", unit: "cm", min: 5, max: 60 },
  blood_glucose: { label: "Blood glucose", unit: "mmol/L", min: 0.5, max: 60 },
  pain_score: { label: "Pain score", unit: "/10", min: 0, max: 10 },
} as const;

export type VitalSign = keyof typeof VITAL_SIGNS;

export const VITAL_SIGN_CODES = Object.keys(VITAL_SIGNS) as [VitalSign, ...VitalSign[]];
