CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" text NOT NULL,
	"verification_code" text NOT NULL,
	"content" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "documents_verificationCode_unique" UNIQUE("verification_code"),
	CONSTRAINT "documents_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "documents_facility_id_kind_number_key" UNIQUE("facility_id","kind","number"),
	CONSTRAINT "documents_kind_known" CHECK ("documents"."kind" IN ('receipt')),
	CONSTRAINT "documents_verification_code_shape" CHECK ("documents"."verification_code" ~ '^[A-Za-z0-9_-]{27}$'),
	CONSTRAINT "documents_void_has_reason" CHECK (("documents"."voided_at" IS NULL AND "documents"."void_reason" IS NULL)
      OR ("documents"."voided_at" IS NOT NULL AND length(btrim("documents"."void_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_by_fk" FOREIGN KEY ("facility_id","issued_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'receipt'));