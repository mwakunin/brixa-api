CREATE TABLE "idempotent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"request" text NOT NULL,
	"body_hash" text NOT NULL,
	"status" integer,
	"answer" text,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotent_requests_key_shape" CHECK ("idempotent_requests"."key" ~ '^[A-Za-z0-9._:-]{8,200}$')
);
--> statement-breakpoint
ALTER TABLE "idempotent_requests" ADD CONSTRAINT "idempotent_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotent_requests" ADD CONSTRAINT "idempotent_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotent_requests_key" ON "idempotent_requests" USING btree ("facility_id","user_id","key");--> statement-breakpoint
CREATE INDEX "idempotent_requests_age" ON "idempotent_requests" USING btree ("facility_id","user_id","created_at");