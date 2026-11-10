ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "licence_profession" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "licence_number" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "licence_expires_on" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "licence_profession" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "licence_number" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "licence_expires_on" date;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed'));--> statement-breakpoint
-- Rows from before practising licences. A clinical membership or invitation
-- written before this migration has no licence, so the two
-- `*_licence_iff_clinical` CHECKs below are added NOT VALID: they hold for
-- every row written or changed from now on, and leave the rows already there
-- in place. Such a member cannot act clinically (`requireClinicalRole` finds
-- no licence) until the facility admin records one, which makes the row
-- valid. A pending clinical invitation without a licence could never be
-- accepted, since its membership would break the CHECK, so it is revoked
-- here, with an audit entry, for the admin to send again with the licence.
-- Once no such row is left, `VALIDATE CONSTRAINT` makes both CHECKs whole.
INSERT INTO "audit_log" ("facility_id", "actor_id", "action", "entity_type", "entity_id", "summary")
SELECT "facility_id", NULL, 'invitation.revoked', 'invitation', "id",
  'Revoked by migration 0040: a clinical role now needs a practising licence; invite again with it'
FROM "invitations"
WHERE "status" = 'pending' AND "roles" && ARRAY['doctor', 'clinical_officer', 'nurse', 'ward_nurse', 'lab_tech', 'lab_supervisor', 'pharmacist', 'pharm_tech']::text[];--> statement-breakpoint
UPDATE "invitations" SET "status" = 'revoked'
WHERE "status" = 'pending' AND "roles" && ARRAY['doctor', 'clinical_officer', 'nurse', 'ward_nurse', 'lab_tech', 'lab_supervisor', 'pharmacist', 'pharm_tech']::text[];--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_licence_profession_known" CHECK ("invitations"."licence_profession" IN ('medical_practitioner', 'clinical_officer', 'nurse', 'laboratory', 'pharmacy'));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_licence_iff_clinical" CHECK (("invitations"."roles" && ARRAY['doctor', 'clinical_officer', 'nurse', 'ward_nurse', 'lab_tech', 'lab_supervisor', 'pharmacist', 'pharm_tech']::text[]) = ("invitations"."licence_number" IS NOT NULL)
        AND ("invitations"."licence_number" IS NULL) = ("invitations"."licence_expires_on" IS NULL)
        AND ("invitations"."licence_number" IS NULL) = ("invitations"."licence_profession" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_licence_number_shape" CHECK ("invitations"."licence_number" IS NULL OR "invitations"."licence_number" ~ '^[A-Z0-9][A-Z0-9/-]{0,29}$');--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_licence_profession_known" CHECK ("memberships"."licence_profession" IN ('medical_practitioner', 'clinical_officer', 'nurse', 'laboratory', 'pharmacy'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_licence_iff_clinical" CHECK (("memberships"."roles" && ARRAY['doctor', 'clinical_officer', 'nurse', 'ward_nurse', 'lab_tech', 'lab_supervisor', 'pharmacist', 'pharm_tech']::text[]) = ("memberships"."licence_number" IS NOT NULL)
        AND ("memberships"."licence_number" IS NULL) = ("memberships"."licence_expires_on" IS NULL)
        AND ("memberships"."licence_number" IS NULL) = ("memberships"."licence_profession" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_licence_number_shape" CHECK ("memberships"."licence_number" IS NULL OR "memberships"."licence_number" ~ '^[A-Z0-9][A-Z0-9/-]{0,29}$');