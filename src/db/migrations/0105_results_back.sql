CREATE TABLE "lab_result_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"lab_result_id" uuid NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lab_result_reviews_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "lab_result_reviews_result_key" UNIQUE("lab_result_id")
);
--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "come_back_with_results" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "returned_with_results" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_result_reviews" ADD CONSTRAINT "lab_result_reviews_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_reviews" ADD CONSTRAINT "lab_result_reviews_result_fk" FOREIGN KEY ("facility_id","lab_result_id") REFERENCES "public"."lab_results"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_reviews" ADD CONSTRAINT "lab_result_reviews_reviewed_by_fk" FOREIGN KEY ("facility_id","reviewed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_come_back_when_done" CHECK (NOT "queue_entries"."come_back_with_results" OR "queue_entries"."status" = 'done');