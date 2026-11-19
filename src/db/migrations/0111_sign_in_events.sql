CREATE TABLE "sign_in_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"user_id" text,
	"actor_id" text,
	"factor" text,
	"note" text,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "sign_in_events_event_known" CHECK ("sign_in_events"."event" IN ('password_failed', 'password_accepted', 'signed_in', 'code_failed', 'locked', 'refused_locked', 'signed_out', 'password_reset', 'password_changed', 'two_factor_enabled', 'two_factor_disabled', 'backup_codes_renewed', 'two_factor_reset', 'log_exported')),
	CONSTRAINT "sign_in_events_factor_known" CHECK ("sign_in_events"."factor" IN ('password', 'totp', 'backup_code')),
	CONSTRAINT "sign_in_events_reset_by_someone_else" CHECK ("sign_in_events"."event" <> 'two_factor_reset' OR ("sign_in_events"."actor_id" IS NOT NULL AND "sign_in_events"."actor_id" <> "sign_in_events"."user_id" AND "sign_in_events"."note" IS NOT NULL)),
	CONSTRAINT "sign_in_events_export_has_actor" CHECK ("sign_in_events"."event" <> 'log_exported' OR "sign_in_events"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sign_in_events" ADD CONSTRAINT "sign_in_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_events" ADD CONSTRAINT "sign_in_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_events_at_index" ON "sign_in_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sign_in_events_user_id_at_index" ON "sign_in_events" USING btree ("user_id","at");