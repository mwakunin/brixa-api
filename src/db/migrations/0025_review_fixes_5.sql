ALTER TABLE "invoice_adjustments" DROP CONSTRAINT "invoice_adjustments_decision";--> statement-breakpoint
ALTER TABLE "price_changes" DROP CONSTRAINT "price_changes_decision";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_decision";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_payout";--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_decision" CHECK (("invoice_adjustments"."status" = 'pending' AND "invoice_adjustments"."decided_by" IS NULL AND "invoice_adjustments"."decided_at" IS NULL)
      OR ("invoice_adjustments"."status" IN ('approved', 'rejected') AND "invoice_adjustments"."decided_by" IS NOT NULL AND "invoice_adjustments"."decided_at" IS NOT NULL
          AND "invoice_adjustments"."decided_by" <> "invoice_adjustments"."requested_by")
      OR ("invoice_adjustments"."status" = 'withdrawn' AND "invoice_adjustments"."decided_by" IS NOT NULL AND "invoice_adjustments"."decided_by" = "invoice_adjustments"."requested_by" AND "invoice_adjustments"."decided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_decision" CHECK (("price_changes"."status" = 'pending' AND "price_changes"."decided_by" IS NULL AND "price_changes"."decided_at" IS NULL)
      OR ("price_changes"."status" IN ('approved', 'rejected') AND "price_changes"."decided_by" IS NOT NULL AND "price_changes"."decided_at" IS NOT NULL
          AND "price_changes"."decided_by" <> "price_changes"."requested_by")
      OR ("price_changes"."status" = 'withdrawn' AND "price_changes"."decided_by" IS NOT NULL AND "price_changes"."decided_by" = "price_changes"."requested_by" AND "price_changes"."decided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decision" CHECK (("refunds"."status" = 'pending' AND "refunds"."decided_by" IS NULL AND "refunds"."decided_at" IS NULL)
      OR ("refunds"."status" IN ('approved', 'rejected') AND "refunds"."decided_by" IS NOT NULL AND "refunds"."decided_at" IS NOT NULL
          AND "refunds"."decided_by" <> "refunds"."requested_by")
      OR ("refunds"."status" = 'withdrawn' AND "refunds"."decided_by" IS NOT NULL AND "refunds"."decided_by" = "refunds"."requested_by" AND "refunds"."decided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payout" CHECK (("refunds"."paid_at" IS NULL AND "refunds"."paid_by" IS NULL AND "refunds"."method" IS NULL AND "refunds"."reference" IS NULL
        AND "refunds"."cashier_shift_id" IS NULL AND "refunds"."document_id" IS NULL)
      OR ("refunds"."status" = 'approved' AND "refunds"."paid_at" IS NOT NULL AND "refunds"."paid_by" IS NOT NULL AND "refunds"."document_id" IS NOT NULL
        AND "refunds"."method" IS NOT NULL
        AND (("refunds"."method" = 'cash' AND "refunds"."reference" IS NULL AND "refunds"."cashier_shift_id" IS NOT NULL)
          OR ("refunds"."method" = 'card' AND "refunds"."reference" IS NOT NULL AND length(btrim("refunds"."reference")) > 0 AND "refunds"."cashier_shift_id" IS NOT NULL)
          OR ("refunds"."method" IN ('bank', 'mpesa') AND "refunds"."reference" IS NOT NULL AND length(btrim("refunds"."reference")) > 0 AND "refunds"."cashier_shift_id" IS NULL))));