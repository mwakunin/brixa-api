CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"roles" text[] NOT NULL,
	"invited_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "invitations_roles_known" CHECK ("invitations"."roles" <@ ARRAY['facility_admin', 'auditor', 'records_clerk', 'doctor', 'clinical_officer', 'nurse', 'ward_nurse', 'lab_tech', 'lab_supervisor', 'pharmacist', 'pharm_tech', 'storekeeper', 'cashier', 'billing_clerk', 'claims_officer', 'finance_manager']::text[]),
	CONSTRAINT "invitations_roles_not_empty" CHECK (cardinality("invitations"."roles") > 0),
	CONSTRAINT "invitations_status_known" CHECK ("invitations"."status" IN ('pending', 'accepted', 'revoked')),
	CONSTRAINT "invitations_email_lowercase" CHECK ("invitations"."email" = lower("invitations"."email")),
	CONSTRAINT "invitations_acceptance_matches_status" CHECK (("invitations"."status" = 'accepted' AND "invitations"."accepted_at" IS NOT NULL AND "invitations"."accepted_user_id" IS NOT NULL)
      OR ("invitations"."status" <> 'accepted' AND "invitations"."accepted_at" IS NULL AND "invitations"."accepted_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prefix" text NOT NULL,
	"padding" integer DEFAULT 4 NOT NULL,
	"reset_period" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_facility_id_kind_key" UNIQUE("facility_id","kind"),
	CONSTRAINT "number_series_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient')),
	CONSTRAINT "number_series_reset_period_known" CHECK ("number_series"."reset_period" IN ('never', 'yearly', 'daily')),
	CONSTRAINT "number_series_prefix_shape" CHECK ("number_series"."prefix" ~ '^[A-Za-z0-9/-]{1,12}$'),
	CONSTRAINT "number_series_padding_range" CHECK ("number_series"."padding" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "number_series_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "number_series_counters_series_id_period_key_key" UNIQUE("series_id","period_key"),
	CONSTRAINT "number_series_counters_next_value_positive" CHECK ("number_series_counters"."next_value" >= 1),
	CONSTRAINT "number_series_counters_period_key_shape" CHECK ("number_series_counters"."period_key" ~ '^(all|[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})$')
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "outbox_operation_known" CHECK ("outbox"."operation" IN ('invitation.send')),
	CONSTRAINT "outbox_status_known" CHECK ("outbox"."status" IN ('pending', 'done', 'failed')),
	CONSTRAINT "outbox_attempts_nonnegative" CHECK ("outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_series_fk" FOREIGN KEY ("facility_id","series_id") REFERENCES "public"."number_series"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending_per_email" ON "invitations" USING btree ("facility_id","email") WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_pending_index" ON "outbox" USING btree ("available_at") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_facility_id_operation_subject_id_index" ON "outbox" USING btree ("facility_id","operation","subject_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked'));