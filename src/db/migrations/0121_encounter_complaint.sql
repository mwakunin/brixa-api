ALTER TABLE "encounters" ADD COLUMN "complaint" text;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "complaint_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "complaint_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_complaint_recorded_by_fk" FOREIGN KEY ("facility_id","complaint_recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_complaint_recorded" CHECK (num_nonnulls("encounters"."complaint", "encounters"."complaint_recorded_at", "encounters"."complaint_recorded_by") IN (0, 3)
      AND ("encounters"."complaint" IS NULL OR length(btrim("encounters"."complaint")) > 0));