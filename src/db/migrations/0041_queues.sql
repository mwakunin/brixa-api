CREATE TABLE "queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"joined_by" uuid NOT NULL,
	"serving_at" timestamp with time zone,
	"served_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "queue_entries_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "queue_entries_status_known" CHECK ("queue_entries"."status" IN ('waiting', 'serving', 'done', 'left', 'cancelled')),
	CONSTRAINT "queue_entries_lifecycle" CHECK (("queue_entries"."status" = 'waiting' AND "queue_entries"."serving_at" IS NULL AND "queue_entries"."served_by" IS NULL AND "queue_entries"."ended_at" IS NULL AND "queue_entries"."ended_by" IS NULL)
      OR ("queue_entries"."status" = 'serving' AND "queue_entries"."serving_at" IS NOT NULL AND "queue_entries"."served_by" IS NOT NULL AND "queue_entries"."ended_at" IS NULL AND "queue_entries"."ended_by" IS NULL)
      OR ("queue_entries"."status" = 'done' AND "queue_entries"."serving_at" IS NOT NULL AND "queue_entries"."served_by" IS NOT NULL AND "queue_entries"."ended_at" IS NOT NULL)
      OR ("queue_entries"."status" = 'left' AND "queue_entries"."serving_at" IS NULL AND "queue_entries"."served_by" IS NULL AND "queue_entries"."ended_at" IS NOT NULL)
      OR ("queue_entries"."status" = 'cancelled' AND "queue_entries"."serving_at" IS NULL AND "queue_entries"."served_by" IS NULL AND "queue_entries"."ended_at" IS NOT NULL AND "queue_entries"."ended_by" IS NOT NULL)),
	CONSTRAINT "queue_entries_in_order" CHECK (("queue_entries"."serving_at" IS NULL OR "queue_entries"."serving_at" >= "queue_entries"."joined_at")
      AND ("queue_entries"."ended_at" IS NULL OR "queue_entries"."ended_at" >= coalesce("queue_entries"."serving_at", "queue_entries"."joined_at")))
);
--> statement-breakpoint
CREATE TABLE "service_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_points_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "service_points_facility_id_name_key" UNIQUE("facility_id","name"),
	CONSTRAINT "service_points_kind_known" CHECK ("service_points"."kind" IN ('triage', 'consultation')),
	CONSTRAINT "service_points_name_present" CHECK (length(btrim("service_points"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "encounters" DROP CONSTRAINT "encounters_lifecycle";--> statement-breakpoint
ALTER TABLE "job_failures" DROP CONSTRAINT "job_failures_job_known";--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_service_point_fk" FOREIGN KEY ("facility_id","service_point_id") REFERENCES "public"."service_points"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_joined_by_fk" FOREIGN KEY ("facility_id","joined_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_served_by_fk" FOREIGN KEY ("facility_id","served_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_ended_by_fk" FOREIGN KEY ("facility_id","ended_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_points" ADD CONSTRAINT "service_points_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_one_live_per_encounter" ON "queue_entries" USING btree ("encounter_id") WHERE "queue_entries"."status" IN ('waiting', 'serving');--> statement-breakpoint
CREATE INDEX "queue_entries_live_index" ON "queue_entries" USING btree ("facility_id","service_point_id","joined_at") WHERE "queue_entries"."status" IN ('waiting', 'serving');--> statement-breakpoint
CREATE INDEX "queue_entries_encounter_index" ON "queue_entries" USING btree ("facility_id","encounter_id","joined_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed'));--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_lifecycle" CHECK (("encounters"."status" = 'open' AND "encounters"."ended_at" IS NULL AND "encounters"."closed_by" IS NULL AND "encounters"."cancel_reason" IS NULL)
      OR ("encounters"."status" = 'closed' AND "encounters"."ended_at" IS NOT NULL AND "encounters"."cancel_reason" IS NULL)
      OR ("encounters"."status" = 'cancelled' AND "encounters"."ended_at" IS NOT NULL AND "encounters"."closed_by" IS NOT NULL
          AND "encounters"."cancel_reason" IS NOT NULL AND length(btrim("encounters"."cancel_reason")) > 0));--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_job_known" CHECK ("job_failures"."job" IN ('bed_day_accrual', 'reconciliation', 'visit_close'));