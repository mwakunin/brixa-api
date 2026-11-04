-- Row-level security for printed documents, the same shape as 0001 and 0003:
-- ENABLE and FORCE, one policy for every command with USING and WITH CHECK,
-- no DELETE for the runtime role (CLAUDE.md §4, rule 5).

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- Issued once, then only ever voided: the runtime role may write the two void
-- columns and nothing else (rules 19, 20).
GRANT SELECT, INSERT ON "documents" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("voided_at", "void_reason") ON "documents" TO hospital_app;
--> statement-breakpoint

-- And for every role, the owner included: an issued document is frozen. It
-- may be voided once, which sets the void columns and changes nothing else; a
-- voided document never changes again; and no document is ever deleted, so
-- its number stays accounted for. TRUNCATE (the test harness) fires no row
-- trigger. A correction is a new document, never an edit.
CREATE FUNCTION documents_frozen() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an issued document is never deleted; void it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided document cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.verification_code IS DISTINCT FROM OLD.verification_code
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
  THEN
    RAISE EXCEPTION 'an issued document is frozen; only voiding it changes it'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER documents_frozen
  BEFORE UPDATE OR DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_frozen();
