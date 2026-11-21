-- The emergency area (after the staff walkthrough, decided 2026-11-21): the
-- facility admin marks one clinic, through the runtime role. Each change is
-- audited as `service_point.updated`, which exists.

GRANT UPDATE ("is_emergency_area") ON "service_points" TO hospital_app;
