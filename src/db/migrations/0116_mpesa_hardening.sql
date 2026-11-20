CREATE TABLE "mpesa_callback_replays" (
	"exchange_id" uuid PRIMARY KEY NOT NULL,
	"facility_id" uuid NOT NULL,
	"replayed_by" uuid NOT NULL,
	"replayed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "mpesa_callback_replays_outcome_known" CHECK ("mpesa_callback_replays"."outcome" IN ('paid', 'queued', 'failed', 'unusable'))
);
--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD COLUMN "previous_callback_token" text;--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD COLUMN "previous_token_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD COLUMN "callback_token_rotated_at" timestamp with time zone;--> statement-breakpoint
-- The replays' foreign key needs the pair unique first.
ALTER TABLE "gateway_exchanges" ADD CONSTRAINT "gateway_exchanges_facility_id_id_key" UNIQUE("facility_id","id");--> statement-breakpoint
ALTER TABLE "mpesa_callback_replays" ADD CONSTRAINT "mpesa_callback_replays_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_callback_replays" ADD CONSTRAINT "mpesa_callback_replays_exchange_fk" FOREIGN KEY ("facility_id","exchange_id") REFERENCES "public"."gateway_exchanges"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_callback_replays" ADD CONSTRAINT "mpesa_callback_replays_replayed_by_fk" FOREIGN KEY ("facility_id","replayed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_settings_shortcode_key" ON "mpesa_settings" USING btree ("shortcode");--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_previousCallbackToken_unique" UNIQUE("previous_callback_token");--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_previous_token_shape" CHECK ("mpesa_settings"."previous_callback_token" ~ '^[A-Za-z0-9_-]{43}$');--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_previous_token_rotated" CHECK ("mpesa_settings"."previous_callback_token" IS NULL OR "mpesa_settings"."callback_token_rotated_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_previous_token_until_has_token" CHECK ("mpesa_settings"."previous_token_until" IS NULL OR "mpesa_settings"."previous_callback_token" IS NOT NULL);